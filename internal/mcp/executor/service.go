// Package executor implements an MVP long-lived execution service that
// orchestrates sandboxed Python script runs for the mcp_execute MCP tool.
//
// Architecture:
//   - The service exposes Execute() which is wired into the MCP server via
//     mcp.Server.SetExecutor() so it implements mcp.ExecutionService.
//   - Each call spawns a Python sandbox subprocess (the runner from
//     python/runner/runner.py) with a JSON config payload on stdin and
//     reads the run-result envelope from stdout. The Spawner abstraction
//     lets tests inject fakes that don't require Python on the host.
//   - A loopback HTTP listener accepts /call requests from the runner
//     subprocess, validates the run token, and forwards each call through
//     a per-run proxy.Proxy (registry validation + HMAC bridge call).
//   - A bounded semaphore enforces a max concurrent run cap; runs over the
//     cap are rejected synchronously with a sandbox_startup_failure status.
//
// Per-run isolation:
//   - Each run gets a fresh proxy.Proxy instance, so call counters don't
//     leak between runs.
//   - The run token is unique per run and is removed from the routing map
//     when Execute returns, even on panic.
//   - The script never sees the bridge HMAC secret; it only knows the
//     loopback proxy URL and its own run token.
package executor

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

// Defaults applied when Options leaves a value zero. The registry/bridge
// fields have no useful default and must be supplied by the caller.
const (
	DefaultMaxConcurrent  = 4
	DefaultPython         = "python3"
	defaultListenerAddr   = "127.0.0.1:0"
	defaultProxyTimeout   = 60 * time.Second
	defaultRequestSizeMax = 2 * 1024 * 1024 // 2 MiB request body cap on /call
)

// Spawner runs a single Python sandbox subprocess.
//
// Production uses execCmdSpawner (forks python3 with the runner script).
// Tests inject fakes that return canned envelopes so the service tests can
// run without Python on the host.
type Spawner interface {
	Spawn(ctx context.Context, payload []byte) ([]byte, error)
}

// Options configures a Service. Required: Registry, BridgeURL, HMACSecret.
// All other fields fall back to sensible defaults.
type Options struct {
	// Registry is the operation registry used by the per-run proxy to
	// validate operation IDs and risk classification.
	Registry *registry.Registry
	// BridgeURL is the HTTPS URL of the backend bridge endpoint.
	BridgeURL string
	// HMACSecret is the shared secret used to sign bridge requests.
	HMACSecret string
	// HTTPClient is used by per-run proxies to talk to the bridge. Optional.
	HTTPClient *http.Client
	// PythonPath is the python executable. Default: "python3".
	PythonPath string
	// RunnerScript is the absolute path to python/runner/runner.py. Required
	// if no Spawner is provided.
	RunnerScript string
	// RunnerCwd is the working directory passed to python (so `from runner
	// import limits` resolves). Typically the python/ directory.
	RunnerCwd string
	// MaxConcurrent caps simultaneous runs. Default: 4.
	MaxConcurrent int
	// Spawner overrides the default exec-based spawner. Tests use this.
	Spawner Spawner
	// ListenerAddr is the bind address for the loopback proxy listener.
	// Default: "127.0.0.1:0" (kernel-assigned ephemeral port).
	ListenerAddr string
	// DisableListener skips starting the loopback proxy. Tests that don't
	// exercise the runner-side proxy path can set this to true.
	DisableListener bool
}

// Service is the long-lived execution service.
type Service struct {
	opts    Options
	sem     chan struct{}
	spawner Spawner

	listener   net.Listener
	httpServer *http.Server
	proxyURL   string

	mu   sync.Mutex
	runs map[string]*runState

	activeCount atomic.Int64
	started     atomic.Bool
	stopped     atomic.Bool
}

// runState is the per-run record stored while a run is in flight. The
// loopback /call handler looks up runs by token to forward calls through
// the right per-run proxy and RunConfig.
type runState struct {
	runID string
	cfg   proxy.RunConfig
	p     *proxy.Proxy
}

// Compile-time check that Service satisfies the MCP execution interface.
var _ mcp.ExecutionService = (*Service)(nil)

// New constructs a Service. Call Start before issuing Execute requests.
func New(opts Options) (*Service, error) {
	if opts.Registry == nil {
		return nil, errors.New("executor: Registry is required")
	}
	if opts.BridgeURL == "" {
		return nil, errors.New("executor: BridgeURL is required")
	}
	if opts.HMACSecret == "" {
		return nil, errors.New("executor: HMACSecret is required")
	}
	if opts.MaxConcurrent <= 0 {
		opts.MaxConcurrent = DefaultMaxConcurrent
	}
	if opts.PythonPath == "" {
		opts.PythonPath = DefaultPython
	}
	if opts.ListenerAddr == "" {
		opts.ListenerAddr = defaultListenerAddr
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: defaultProxyTimeout}
	}

	sp := opts.Spawner
	if sp == nil {
		if opts.RunnerScript == "" {
			return nil, errors.New("executor: RunnerScript is required when no Spawner is provided")
		}
		sp = &execCmdSpawner{
			python: opts.PythonPath,
			script: opts.RunnerScript,
			cwd:    opts.RunnerCwd,
		}
	}

	return &Service{
		opts:    opts,
		sem:     make(chan struct{}, opts.MaxConcurrent),
		spawner: sp,
		runs:    make(map[string]*runState),
	}, nil
}

// Start brings up the loopback proxy listener (unless disabled). Idempotent
// at the started flag level — calling twice returns an error.
func (s *Service) Start(ctx context.Context) error {
	if !s.started.CompareAndSwap(false, true) {
		return errors.New("executor: service already started")
	}

	if s.opts.DisableListener {
		slog.Info("[Executor] started without loopback listener", "max_concurrent", s.opts.MaxConcurrent)
		return nil
	}

	ln, err := net.Listen("tcp", s.opts.ListenerAddr)
	if err != nil {
		s.started.Store(false)
		return fmt.Errorf("executor: listen on %s: %w", s.opts.ListenerAddr, err)
	}
	s.listener = ln

	mux := http.NewServeMux()
	mux.HandleFunc("/call", s.handleCall)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	s.httpServer = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	addr := ln.Addr().String()
	s.proxyURL = fmt.Sprintf("http://%s/call", addr)

	go func() {
		if err := s.httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("[Executor] listener error", "error", err)
		}
	}()

	slog.Info("[Executor] started", "proxy_url", s.proxyURL, "max_concurrent", s.opts.MaxConcurrent)
	return nil
}

// Shutdown stops accepting new runs and shuts the loopback listener.
// Active runs are not interrupted — callers should wait for in-flight
// Execute calls before invoking Shutdown.
func (s *Service) Shutdown(ctx context.Context) error {
	if !s.stopped.CompareAndSwap(false, true) {
		return nil
	}
	if s.httpServer == nil {
		return nil
	}
	return s.httpServer.Shutdown(ctx)
}

// HealthCheck returns nil if the service can accept new runs.
func (s *Service) HealthCheck() error {
	if s.stopped.Load() {
		return errors.New("service stopped")
	}
	if !s.started.Load() {
		return errors.New("service not started")
	}
	if !s.opts.DisableListener && s.listener == nil {
		return errors.New("listener not bound")
	}
	return nil
}

// ProxyURL returns the loopback URL the runner should use as
// MEDTRACKER_PROXY_URL. Empty when the listener is disabled.
func (s *Service) ProxyURL() string { return s.proxyURL }

// ActiveRuns returns the number of in-flight runs.
func (s *Service) ActiveRuns() int { return int(s.activeCount.Load()) }

// Execute is the MCP-facing entry point. It enforces per-run constraints,
// spawns the sandbox subprocess, and maps the runner envelope to the
// MCP execution result envelope.
func (s *Service) Execute(ctx context.Context, req mcp.ExecutionRequest) (*mcp.ExecutionResult, error) {
	if s.stopped.Load() {
		return nil, errors.New("executor: service stopped")
	}
	if !s.started.Load() {
		return nil, errors.New("executor: service not started")
	}

	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	default:
		slog.Warn("[Executor] max concurrent runs reached", "max", s.opts.MaxConcurrent)
		return &mcp.ExecutionResult{
			Status: mcp.ExecuteStatusSandboxStartupFailure,
			Error:  fmt.Sprintf("max concurrent runs (%d) reached", s.opts.MaxConcurrent),
		}, nil
	}

	s.activeCount.Add(1)
	defer s.activeCount.Add(-1)

	runID := newToken(8)
	runToken := newToken(24)

	runCfg := proxy.RunConfig{
		Mode:           req.Mode,
		MaxAPICalls:    req.MaxAPICalls,
		TopicAllowlist: req.TopicAllowlist,
	}
	p := proxy.NewWithHTTPClient(s.opts.Registry, s.opts.BridgeURL, s.opts.HMACSecret, s.opts.HTTPClient)

	s.mu.Lock()
	s.runs[runToken] = &runState{runID: runID, cfg: runCfg, p: p}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.runs, runToken)
		s.mu.Unlock()
	}()

	timeoutS := float64(req.TimeoutMS) / 1000.0
	if timeoutS <= 0 {
		timeoutS = 30.0
	}

	payload := map[string]any{
		"script":          req.Script,
		"proxy_url":       s.proxyURL,
		"run_token":       runToken,
		"mode":            string(req.Mode),
		"timeout_s":       timeoutS,
		"max_api_calls":   req.MaxAPICalls,
		"topic_allowlist": req.TopicAllowlist,
		"intent":          req.Intent,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return &mcp.ExecutionResult{
			Status: mcp.ExecuteStatusSandboxStartupFailure,
			Error:  fmt.Sprintf("marshal run config: %v", err),
		}, nil
	}

	// Hard wall-clock backstop: a few seconds beyond the runner's own timeout.
	// The runner kills its child on its own timeout; this protects against
	// the runner itself hanging.
	backstop := time.Duration(req.TimeoutMS)*time.Millisecond + 10*time.Second
	if backstop < 15*time.Second {
		backstop = 15 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, backstop)
	defer cancel()

	started := time.Now()
	out, spawnErr := s.spawner.Spawn(runCtx, payloadBytes)
	duration := time.Since(started)

	apiCalls := int(p.CallCount())

	slog.Info("[Executor] run completed",
		"run_id", runID,
		"mode", req.Mode,
		"duration_ms", duration.Milliseconds(),
		"api_calls", apiCalls,
		"intent_present", req.Intent != "",
		"intent", truncateIntent(req.Intent),
	)

	if spawnErr != nil {
		return &mcp.ExecutionResult{
			Status:   mcp.ExecuteStatusSandboxStartupFailure,
			Error:    fmt.Sprintf("spawn failed: %v", spawnErr),
			APICalls: apiCalls,
		}, nil
	}

	envelope, parseErr := parseRunnerEnvelope(out)
	if parseErr != nil {
		return &mcp.ExecutionResult{
			Status:   mcp.ExecuteStatusSandboxStartupFailure,
			Error:    fmt.Sprintf("invalid runner envelope: %v", parseErr),
			APICalls: apiCalls,
		}, nil
	}

	return mapEnvelope(envelope, apiCalls), nil
}

// runnerEnvelope mirrors the JSON shape returned by python/runner/runner.py.
type runnerEnvelope struct {
	Status      string          `json:"status"`
	ExitReason  string          `json:"exit_reason"`
	Result      json.RawMessage `json:"result"`
	OutputSet   bool            `json:"output_set"`
	Stdout      string          `json:"stdout"`
	Stderr      string          `json:"stderr"`
	Warnings    []string        `json:"warnings"`
	ErrorType   string          `json:"error_type"`
	ErrorMsg    string          `json:"error_message"`
	Traceback   string          `json:"traceback"`
	DurationMS  int64           `json:"duration_ms"`
}

func parseRunnerEnvelope(b []byte) (runnerEnvelope, error) {
	b = bytes.TrimSpace(b)
	var env runnerEnvelope
	if len(b) == 0 {
		return env, errors.New("empty runner output")
	}
	if err := json.Unmarshal(b, &env); err != nil {
		return env, err
	}
	return env, nil
}

// mapEnvelope translates the runner's exit_reason and Python-side error_type
// into the stable MCP execute status codes used by the response envelope.
func mapEnvelope(env runnerEnvelope, apiCalls int) *mcp.ExecutionResult {
	res := &mcp.ExecutionResult{
		APICalls: apiCalls,
		Stdout:   env.Stdout,
		Stderr:   env.Stderr,
		Warnings: env.Warnings,
	}

	switch env.ExitReason {
	case "completed":
		res.Status = mcp.ExecuteStatusOK
		res.Result = env.Result
	case "timeout":
		res.Status = mcp.ExecuteStatusTimeout
		res.Error = env.ErrorMsg
	case "sandbox_startup_failure":
		res.Status = mcp.ExecuteStatusSandboxStartupFailure
		res.Error = env.ErrorMsg
	case "result_too_large":
		res.Status = mcp.ExecuteStatusScriptError
		res.Error = "result_too_large: " + env.ErrorMsg
	case "script_error":
		res.Status = scriptErrorStatusFromType(env.ErrorType)
		res.Error = formatScriptError(env.ErrorType, env.ErrorMsg)
	default:
		res.Status = mcp.ExecuteStatusScriptError
		res.Error = formatScriptError(env.ErrorType, env.ErrorMsg)
	}
	return res
}

// scriptErrorStatusFromType maps the Python exception class name reported
// by the runner to the MCP status code that best describes the failure.
// Helper-raised exceptions (ProxyDenied, BackendError) are surfaced as
// distinct status codes so callers can handle them specifically.
func scriptErrorStatusFromType(errorType string) string {
	switch errorType {
	case "ProxyDenied":
		return mcp.ExecuteStatusProxyDenied
	case "BackendError":
		return mcp.ExecuteStatusBackendAppError
	case "TimeoutError":
		return mcp.ExecuteStatusBackendTransportError
	default:
		return mcp.ExecuteStatusScriptError
	}
}

func formatScriptError(errorType, errorMsg string) string {
	if errorType == "" {
		return errorMsg
	}
	if errorMsg == "" {
		return errorType
	}
	return errorType + ": " + errorMsg
}

// handleCall is the loopback proxy handler. The runner's medtracker.api.call
// helper POSTs here with the run token in the X-Run-Token header; we look up
// the run, forward the call through the per-run proxy, and translate the
// outcome back into HTTP status codes the helper expects.
func (s *Service) handleCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	token := r.Header.Get("X-Run-Token")
	if token == "" {
		http.Error(w, "missing X-Run-Token", http.StatusUnauthorized)
		return
	}

	s.mu.Lock()
	rs, ok := s.runs[token]
	s.mu.Unlock()
	if !ok {
		http.Error(w, "unknown run token", http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, defaultRequestSizeMax))
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}

	var req struct {
		OperationID string            `json:"operation_id"`
		Params      map[string]string `json:"params"`
		Body        json.RawMessage   `json:"body"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	result, callErr := rs.p.Call(r.Context(), rs.cfg, req.OperationID, req.Params, req.Body)
	if callErr != nil {
		var ce *proxy.CallError
		if errors.As(callErr, &ce) {
			// Registry-level rejection — surfaces as ProxyDenied to the script.
			http.Error(w, ce.Code+": "+ce.Message, http.StatusForbidden)
			return
		}
		// Transport error talking to the bridge — surfaces as BackendError.
		http.Error(w, "bridge transport error: "+callErr.Error(), http.StatusBadGateway)
		return
	}
	if result.Response == nil {
		// Bridge replied with non-200; preserve the bridge status when it's
		// in a usable HTTP range so the helper can classify properly.
		statusCode := result.Trace.Status
		if statusCode < 400 || statusCode >= 600 {
			statusCode = http.StatusBadGateway
		}
		http.Error(w, result.Trace.Error, statusCode)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(result.Response.Body); err != nil {
		slog.Error("[Executor] write response", "error", err)
	}
}

// execCmdSpawner is the production Spawner. It forks `python <runner.py>`
// with the JSON config payload on stdin and reads the result envelope on
// stdout.
type execCmdSpawner struct {
	python string
	script string
	cwd    string
}

func (e *execCmdSpawner) Spawn(ctx context.Context, payload []byte) ([]byte, error) {
	cmd := exec.CommandContext(ctx, e.python, e.script)
	if e.cwd != "" {
		cmd.Dir = e.cwd
	}
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil && stdout.Len() == 0 {
		return nil, fmt.Errorf("%w (stderr: %s)", err, stderr.String())
	}
	return stdout.Bytes(), err
}

// truncateIntent caps the freeform intent string before it lands in audit
// logs. Intent is caller-supplied, so we keep enough to be useful for review
// without unbounded payload size. The cap is generous; intent is meant to be
// a human-readable sentence, not a paragraph.
func truncateIntent(intent string) string {
	const maxIntentAuditLen = 200
	if len(intent) <= maxIntentAuditLen {
		return intent
	}
	return intent[:maxIntentAuditLen] + "..."
}

func newToken(nbytes int) string {
	buf := make([]byte, nbytes)
	if _, err := rand.Read(buf); err != nil {
		// Cryptographic RNG failure is fatal for the run token, but we
		// don't want to crash the service. Fall back to a timestamped
		// token (still unique per call) and log the failure.
		slog.Error("[Executor] crypto rand failed", "error", err)
		return fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
