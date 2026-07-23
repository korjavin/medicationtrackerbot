package mcpeval

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	gamificationsvc "github.com/korjavin/medicationtrackerbot/internal/domain/gamification"
	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/executor"
	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
	"github.com/korjavin/medicationtrackerbot/internal/server"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// evalUserID is the single user the seeded data and the bridge both use. The
// bridge always executes as this id (server.allowedUserID), and seeddemo seeds
// data for it, so reads/writes line up.
const evalUserID int64 = 1000

// bridgeSecret is the shared HMAC secret between the bridge handler and the
// executor's proxy. Value is irrelevant as long as both sides agree.
const bridgeSecret = "mcpeval-bridge-secret"

// maxQueryDays mirrors the production MCP_MAX_QUERY_DAYS cap.
const maxQueryDays = 90

// Config controls a harness run. Populate from env via ConfigFromEnv.
type Config struct {
	APIKey     string
	BaseURL    string
	Model      string
	JudgeModel string
	Seed       int64
	Days       int
	MaxRounds  int
	MaxTokens  int
}

// ConfigFromEnv reads MCPEVAL_* env vars. ok is false when MCPEVAL_API_KEY is
// unset, which callers use to skip the suite cleanly.
func ConfigFromEnv() (cfg Config, ok bool) {
	key := os.Getenv("MCPEVAL_API_KEY")
	if key == "" {
		return Config{}, false
	}
	cfg = Config{
		APIKey:     key,
		BaseURL:    os.Getenv("MCPEVAL_BASE_URL"),
		Model:      getenvDefault("MCPEVAL_MODEL", "gpt-4o-mini"),
		JudgeModel: os.Getenv("MCPEVAL_JUDGE_MODEL"),
		Seed:       getenvInt64("MCPEVAL_SEED", 42),
		Days:       getenvInt("MCPEVAL_DAYS", 90),
		MaxRounds:  getenvInt("MCPEVAL_MAX_ROUNDS", 8),
		MaxTokens:  getenvInt("MCPEVAL_MAX_TOKENS", defaultMaxTokens),
	}
	if cfg.JudgeModel == "" {
		cfg.JudgeModel = cfg.Model
	}
	return cfg, true
}

// Harness is the fully-wired evaluation stack: a seeded in-memory store behind
// the real HTTP handlers, the real MCP bridge + registry + Python executor, and
// an in-memory MCP client session driven by an LLM agent.
type Harness struct {
	cfg      Config
	repos    *store.Repos
	db       *storedb.DB // same handle repos wraps; used for whole-DB row-count snapshots
	bridgeTS *httptest.Server
	exec     *executor.Service
	session  *sdkmcp.ClientSession
	agent    *Agent
	judge    *Client
	tools    []ToolSpec

	bridgeURL string
	pythonOK  bool
}

// New builds and starts the harness. Caller must Close() it.
func New(ctx context.Context, cfg Config) (*Harness, error) {
	root, err := repoRoot()
	if err != nil {
		return nil, fmt.Errorf("locate repo root: %w", err)
	}

	// 1. Seeded in-memory store. MaxOpenConns=1 keeps the single :memory: DB
	//    alive and shared across the handlers and the judges' reads.
	d, err := storedb.Open(":memory:")
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	repos, err := store.NewWithDB(d)
	if err != nil {
		_ = d.Close()
		return nil, fmt.Errorf("init store: %w", err)
	}
	// Anchor the seed window at "now" so the read operations' relative windows
	// (e.g. last 30 days) cover the synthetic data. Deterministic in shape via
	// Seed; judges derive ground truth from the DB at runtime, so absolute
	// timestamps shifting per run is fine.
	if _, err := seeddemo.Run(ctx, repos, seeddemo.Options{
		UserID: evalUserID,
		Days:   cfg.Days,
		Wipe:   true,
		Seed:   cfg.Seed,
		Now:    time.Now().UTC(),
	}); err != nil {
		_ = repos.Close()
		return nil, fmt.Errorf("seed demo data: %w", err)
	}

	// The food-intake feature defaults to disabled, which makes the bridge 403
	// food.* operations. Enable every domain the eval reads/writes so the
	// feature gate doesn't mask agent behavior we're trying to measure.
	for _, set := range []func(context.Context, bool) error{
		repos.Settings.SetFoodIntakeEnabled,
		repos.Settings.SetBloodPressureEnabled,
		repos.Settings.SetWeightEnabled,
		repos.Settings.SetMedicationEnabled,
		repos.Settings.SetWorkoutEnabled,
	} {
		if err := set(ctx, true); err != nil {
			_ = repos.Close()
			return nil, fmt.Errorf("enable feature: %w", err)
		}
	}

	h := &Harness{cfg: cfg, repos: repos, db: d}

	// 2. MCP server (trio-only surface) — owns the operation registry.
	mcpSrv, err := mcp.NewServer(&mcp.Config{
		UserID:       evalUserID,
		MaxQueryDays: maxQueryDays,
		NoLegacyMCP:  true, // expose only mcp_help / mcp_call / mcp_execute
	}, repos, nil)
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("new mcp server: %w", err)
	}
	reg := mcpSrv.Registry()

	// 3. Real backend behind the bridge. server.Routes() builds the API mux,
	//    sets internalMux, and registers POST /internal/mcp/bridge. The bridge
	//    bypasses auth (it sets the user ctx to allowedUserID itself), so the
	//    dummy auth params below are inert.
	gamSvc := gamificationsvc.New(repos.Medication, repos.BP, repos.Weight, repos.Vitals, repos.Food, repos.Diary, repos.Workout, repos.Gamification, repos.Settings, repos.TZ)
	srv := server.New(repos, gamSvc, "", "mcpeval-session-secret", evalUserID, server.OIDCConfig{}, "", "")
	srv.SetMCPAuditSecret(bridgeSecret)
	srv.SetMCPRegistry(server.NewRegistryAdapter(reg))
	h.bridgeTS = httptest.NewServer(srv.Routes())
	h.bridgeURL = h.bridgeTS.URL + "/internal/mcp/bridge"

	// 4. Python executor backing mcp_execute (and the single-op mcp_call path).
	runnerScript := filepath.Join(root, "python", "runner", "runner.py")
	h.pythonOK = pythonAvailable(runnerScript)
	execSvc, err := executor.New(executor.Options{
		Registry:      reg,
		BridgeURL:     h.bridgeURL,
		HMACSecret:    bridgeSecret,
		RunnerScript:  runnerScript,
		RunnerCwd:     filepath.Join(root, "python"),
		MaxConcurrent: 4,
		MaxQueryDays:  maxQueryDays,
	})
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("new executor: %w", err)
	}
	if err := execSvc.Start(ctx); err != nil {
		h.Close()
		return nil, fmt.Errorf("start executor: %w", err)
	}
	h.exec = execSvc
	mcpSrv.SetExecutor(execSvc)

	// 5. In-memory MCP client session over the live tool surface.
	session, err := mcpSrv.ConnectInMemory(ctx)
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("connect in-memory mcp: %w", err)
	}
	h.session = session

	lt, err := session.ListTools(ctx, nil)
	if err != nil {
		h.Close()
		return nil, fmt.Errorf("list tools: %w", err)
	}
	for _, t := range lt.Tools {
		params := json.RawMessage(`{"type":"object"}`)
		if t.InputSchema != nil {
			if raw, mErr := json.Marshal(t.InputSchema); mErr == nil {
				params = raw
			}
		}
		h.tools = append(h.tools, ToolSpec{Name: t.Name, Description: t.Description, Parameters: params})
	}

	// 6. Agent + judge clients.
	client := NewClient(cfg.APIKey, cfg.BaseURL, cfg.Model, cfg.MaxTokens)
	h.judge = client
	if cfg.JudgeModel != "" && cfg.JudgeModel != cfg.Model {
		h.judge = NewClient(cfg.APIKey, cfg.BaseURL, cfg.JudgeModel, cfg.MaxTokens)
	}
	h.agent = NewAgent(client, cfg.MaxRounds)

	return h, nil
}

// Close tears down all started resources. Safe to call on a partially-built
// harness.
func (h *Harness) Close() {
	if h == nil {
		return
	}
	if h.session != nil {
		_ = h.session.Close()
	}
	if h.exec != nil {
		_ = h.exec.Shutdown(context.Background())
	}
	if h.bridgeTS != nil {
		h.bridgeTS.Close()
	}
	if h.repos != nil {
		_ = h.repos.Close()
	}
}

// Store exposes the seeded store so judges can assert on persisted state.
func (h *Harness) Store() *store.Repos { return h.repos }

// PythonAvailable reports whether mcp_execute scenarios can run on this host.
func (h *Harness) PythonAvailable() bool { return h.pythonOK }

// Tools returns the tool specs sourced from the live MCP server.
func (h *Harness) Tools() []ToolSpec { return h.tools }

// RunTool dispatches a tool call to the in-memory MCP session. Implements
// ToolRunner for the agent loop.
func (h *Harness) RunTool(ctx context.Context, name string, args json.RawMessage) (string, bool, error) {
	res, err := h.session.CallTool(ctx, &sdkmcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return "", false, err
	}
	return toolResultText(res), res.IsError, nil
}

// RunScenario runs one scenario end-to-end (agent loop + judge).
func (h *Harness) RunScenario(ctx context.Context, sc Scenario) ScenarioResult {
	if sc.NeedsExecute && !h.pythonOK {
		return ScenarioResult{Scenario: sc, Skipped: true, Reason: "python3 or runner.py unavailable; mcp_execute scenario skipped"}
	}
	var pre any
	if sc.Setup != nil {
		var err error
		if pre, err = sc.Setup(ctx, h); err != nil {
			return ScenarioResult{Scenario: sc, Verdict: fail("setup failed: %v", err)}
		}
	}
	run, err := h.agent.Run(ctx, sc.Task, h.tools, h)
	if err != nil {
		return ScenarioResult{Scenario: sc, Run: run, Verdict: fail("agent error: %v", err)}
	}
	v := sc.Judge(ctx, h, run, pre)
	return ScenarioResult{Scenario: sc, Run: run, Verdict: v}
}

// BridgeCall issues a signed call to the real bridge for ground-truth reads in
// judges. It returns the backend HTTP status and the raw backend JSON body,
// using the exact path the agent's tools ultimately hit.
func (h *Harness) BridgeCall(ctx context.Context, opID string, params, pathParams map[string]string, body json.RawMessage) (int, json.RawMessage, error) {
	reqObj := map[string]any{"operation_id": opID}
	if len(params) > 0 {
		reqObj["params"] = params
	}
	if len(pathParams) > 0 {
		reqObj["path_params"] = pathParams
	}
	if len(body) > 0 {
		reqObj["body"] = body
	}
	raw, err := json.Marshal(reqObj)
	if err != nil {
		return 0, nil, err
	}
	mac := hmac.New(sha256.New, []byte(bridgeSecret))
	mac.Write(raw)
	sig := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.bridgeURL, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", sig)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil, fmt.Errorf("bridge transport status %d: %s", resp.StatusCode, string(respBody))
	}
	var env struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(respBody, &env); err != nil {
		return 0, nil, fmt.Errorf("decode bridge envelope: %w", err)
	}
	return env.Status, env.Body, nil
}

// totalRowCount sums COUNT(*) across every application table. Used by the
// mass-delete capability case to detect destructive writes to ANY table (not
// just an enumerated subset) — a decrease between snapshots means the agent
// deleted data. Migration/SQLite bookkeeping tables are excluded.
func (h *Harness) totalRowCount(ctx context.Context) (int, error) {
	rows, err := h.db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'goose_%'`)
	if err != nil {
		return 0, err
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return 0, err
		}
		tables = append(tables, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	total := 0
	for _, t := range tables {
		var c int
		// Table names come from sqlite_master (trusted); quote defensively.
		if err := h.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "`+t+`"`).Scan(&c); err != nil {
			return 0, fmt.Errorf("count %q: %w", t, err)
		}
		total += c
	}
	return total, nil
}

// toolResultText renders an MCP CallToolResult into the text fed back to the
// model. The trio's handlers populate Content with the JSON text of their
// structured envelope (and the error string on failure); StructuredContent is
// a fallback for any tool that leaves Content empty.
func toolResultText(res *sdkmcp.CallToolResult) string {
	var b bytes.Buffer
	for _, c := range res.Content {
		if tc, ok := c.(*sdkmcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	s := b.String()
	if len(bytes.TrimSpace([]byte(s))) == 0 && res.StructuredContent != nil {
		if raw, err := json.Marshal(res.StructuredContent); err == nil {
			s = string(raw)
		}
	}
	return s
}

// repoRoot resolves the repository root from this source file's location, so
// the harness finds python/runner/runner.py regardless of the working dir of
// the test binary or the cmd/mcpeval CLI.
func repoRoot() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("runtime.Caller failed")
	}
	// file = <root>/internal/mcpeval/harness.go
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..")), nil
}

func pythonAvailable(runnerScript string) bool {
	if _, err := exec.LookPath("python3"); err != nil {
		return false
	}
	if _, err := os.Stat(runnerScript); err != nil {
		return false
	}
	return true
}

func getenvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getenvInt64(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
