package main

import (
	"context"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/executor"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	slog.Info("[MCP] Starting MCP Server for Health Tracker...")

	// Load configuration from environment
	cfg, err := mcp.LoadConfigFromEnv()
	if err != nil {
		slog.Error("[MCP] Configuration error", "error", err)
		os.Exit(1)
	}

	// In demo mode, shrink the per-script executor caps so even an allowed
	// mcp_execute run can't burn a large API-call / timeout budget. The
	// rate limit inside handleMCPExecute caps the number of allowed runs;
	// these knobs cap the work each run can do.
	mcp.ApplyDemoExecutorCaps(cfg)

	slog.Info("[MCP] Configuration loaded:",
		"port", cfg.Port,
		"database", cfg.DatabasePath,
		"pocketIDURL", cfg.PocketIDURL,
		"maxQueryDays", cfg.MaxQueryDays,
	)

	// Initialize store. The MCP server needs write access for goose migrations
	// on startup and for the loopback admin API that manages api_tokens. We
	// open the shared *db.DB explicitly so per-domain repositories can share
	// it as the internal/store split lands.
	sharedDB, err := storedb.Open(cfg.DatabasePath)
	if err != nil {
		slog.Error("[MCP] Failed to open database", "error", err)
		os.Exit(1)
	}
	defer sharedDB.Close()
	st, err := store.NewWithDB(sharedDB)
	if err != nil {
		slog.Error("[MCP] Failed to initialize store", "error", err)
		os.Exit(1)
	}

	slog.Info("[MCP] Database connection established")

	// Initialize audit buffer if configured
	var auditBuffer *mcp.AuditBuffer
	if cfg.AuditEndpoint != "" && cfg.AuditSecret != "" {
		auditBuffer = mcp.NewAuditBuffer(cfg.AuditEndpoint, cfg.AuditSecret)
		auditBuffer.Start(context.Background())
		slog.Info("[MCP] Audit logging enabled", "endpoint", cfg.AuditEndpoint)
	} else if cfg.AuditEndpoint != "" && cfg.AuditSecret == "" {
		slog.Warn("[MCP] Audit logging is disabled because MCP_AUDIT_SECRET is empty")
	}

	// Create and start MCP server
	server, err := mcp.NewServer(cfg, st, auditBuffer)
	if err != nil {
		slog.Error("[MCP] Failed to create server", "error", err)
		os.Exit(1)
	}

	// Wire the Python executor that backs mcp_execute. Without this the
	// mcp_execute tool short-circuits with "execution service not configured"
	// — the MVP keeps the executor in-process inside this binary.
	execSvc, err := buildExecutor(cfg, server)
	if err != nil {
		slog.Error("[MCP] Failed to build executor", "error", err)
		os.Exit(1)
	}
	if execSvc != nil {
		ctx := context.Background()
		if err := execSvc.Start(ctx); err != nil {
			slog.Error("[MCP] Failed to start executor", "error", err)
			os.Exit(1)
		}
		defer func() {
			shutdownCtx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if err := execSvc.Shutdown(shutdownCtx); err != nil {
				slog.Error("[MCP] Executor shutdown error", "error", err)
			}
		}()
		server.SetExecutor(execSvc)
		slog.Info("[MCP] Python executor wired",
			"bridge_url", cfg.ExecutorBridgeURL,
			"proxy_url", execSvc.ProxyURL(),
			"max_concurrent", cfg.ExecutorMaxConcurrent,
		)
	} else {
		slog.Warn("[MCP] mcp_execute disabled: configuration incomplete (set MCP_AUDIT_ENDPOINT/MCP_EXECUTOR_BRIDGE_URL and MCP_AUDIT_SECRET)")
	}

	slog.Info("[MCP] Server initialized, starting HTTP listener...")

	if err := server.Run(context.Background()); err != nil {
		slog.Error("[MCP] Server error", "error", err)
		os.Exit(1)
	}

	slog.Info("[MCP] Server stopped")
}

// buildExecutor returns nil when the executor cannot be configured (missing
// bridge URL or HMAC secret) so the rest of the server still starts; the
// mcp_execute tool will report "execution service not configured" until the
// operator supplies the env. Other startup paths fail fast with an error.
func buildExecutor(cfg *mcp.Config, server *mcp.Server) (*executor.Service, error) {
	if cfg.ExecutorBridgeURL == "" || cfg.AuditSecret == "" {
		return nil, nil
	}

	runnerScript := cfg.ExecutorRunnerScript
	if runnerScript == "" {
		runnerScript = "/app/python/runner/runner.py"
	}
	runnerCwd := cfg.ExecutorRunnerCwd
	if runnerCwd == "" {
		runnerCwd = filepath.Dir(filepath.Dir(runnerScript))
	}

	listenAddr := ""
	if cfg.ExecutorProxyURL != "" {
		if u, err := url.Parse(cfg.ExecutorProxyURL); err == nil && u.Host != "" {
			listenAddr = u.Host
		}
	}

	opts := executor.Options{
		Registry:      server.Registry(),
		BridgeURL:     cfg.ExecutorBridgeURL,
		HMACSecret:    cfg.AuditSecret,
		RunnerScript:  runnerScript,
		RunnerCwd:     runnerCwd,
		MaxConcurrent: cfg.ExecutorMaxConcurrent,
		ListenerAddr:  listenAddr,
		MaxQueryDays:  cfg.MaxQueryDays,
	}

	// Wire the executor's per-run AuditHook into the same AuditBuffer the
	// granular MCP tools use. Without this the deployment doc's promise that
	// write runs fan out an audit notification with the caller-provided intent
	// is just slog — there is no Telegram-side notification. The hook records
	// a synthesized AuditEvent so write runs surface in the next periodic
	// /api/mcp-audit flush. Only writes are audited (matching the documented
	// default; switch AuditAllRuns on in code if reads need fan-out too).
	if server.AuditBuffer() != nil {
		opts.Audit = newRunAudit(server.AuditBuffer())
	}

	if !strings.HasSuffix(runnerScript, ".py") {
		slog.Warn("[MCP] runner script does not look like a .py file", "path", runnerScript)
	}

	return executor.New(opts)
}

// newRunAudit returns an executor.AuditHook that records a RunSummary into
// the existing AuditBuffer so writes show up in the user-facing Telegram
// audit notification. The intent is included (truncated) in the label so the
// flushed payload tells the user *why* a script ran, not just that one did.
func newRunAudit(buf *mcp.AuditBuffer) executor.AuditHook {
	return executor.AuditHookFunc(func(_ context.Context, s executor.RunSummary) {
		now := time.Now().UTC()
		buf.Record(mcp.AuditEvent{
			DataType:  formatRunAuditLabel(s),
			StartDate: now,
			EndDate:   now,
		})
	})
}

// formatRunAuditLabel builds the DataType label shown in the Telegram audit
// notification for an executor run. Intent is truncated so a verbose script
// description doesn't blow up the notification or the buffer's merge map
// (each unique label becomes a separate flushed entry).
func formatRunAuditLabel(s executor.RunSummary) string {
	const maxLabelIntent = 80
	intent := strings.TrimSpace(s.Intent)
	if len(intent) > maxLabelIntent {
		intent = intent[:maxLabelIntent] + "…"
	}
	if intent == "" {
		return "MCP script (write)"
	}
	return "MCP script (write): " + intent
}
