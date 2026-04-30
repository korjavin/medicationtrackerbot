// Package executor implements an MVP long-lived execution service that
// orchestrates sandboxed Python script runs for the mcp_execute MCP tool.
//
// Architecture:
//   - The service exposes Execute() which is wired into the MCP server via
//     mcp.Server.SetExecutor() so it implements mcp.ExecutionService.
//   - Each call spawns a Python sandbox subprocess (`python -m
//     runner.runner`, sourced from python/runner/runner.py) with a JSON
//     config payload on stdin and reads the run-result envelope from
//     stdout. The Spawner abstraction lets tests inject fakes that don't
//     require Python on the host.
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
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
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

	// defaultAbandonedTimeout is how long a runState may sit in the runs map
	// before the janitor considers it abandoned and prunes it. Set generously
	// past any realistic backstop.
	defaultAbandonedTimeout = 10 * time.Minute
	defaultCleanupInterval  = 1 * time.Minute

	// runnerCancelGrace is how long the spawner waits after SIGTERM for the
	// runner to clean up its child process group before escalating to SIGKILL.
	// The runner's SIGTERM handler kills tracked child PGIDs and then re-raises
	// the signal, so this only needs to cover that brief teardown.
	runnerCancelGrace = 3 * time.Second
)

// Spawner runs a single Python sandbox subprocess.
//
// Production uses execCmdSpawner (forks python3 with the runner script).
// Tests inject fakes that return canned envelopes so the service tests can
// run without Python on the host.
type Spawner interface {
	Spawn(ctx context.Context, payload []byte) ([]byte, error)
}

// RunSummary is the structured record of a finished run handed to AuditHook
// implementations. Fields are stable so external auditors can rely on them.
type RunSummary struct {
	RunID      string
	Mode       proxy.Mode
	Intent     string
	DurationMS int64
	APICalls   int
	Status     string // matches mcp.ExecuteStatus*
	ExitReason string // raw runner exit_reason; "rejected" for pre-spawn rejections
	Error      string // truncated/redacted error detail; empty on success
}

// AuditHook receives a RunSummary after every audited run. Implementations
// must be safe for concurrent use; the service may call OnRun from multiple
// goroutines.
type AuditHook interface {
	OnRun(ctx context.Context, summary RunSummary)
}

// AuditHookFunc adapts a plain function to the AuditHook interface.
type AuditHookFunc func(ctx context.Context, summary RunSummary)

func (f AuditHookFunc) OnRun(ctx context.Context, summary RunSummary) { f(ctx, summary) }

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
	// if no Spawner is provided. The spawner derives the `-m <module>`
	// argument from this path relative to RunnerCwd.
	RunnerScript string
	// RunnerCwd is the working directory passed to python. The spawner
	// invokes `python -m <module>` from this directory, so it must contain
	// the top-level package (typically the python/ directory). Defaults to
	// the parent of the runner script's package directory.
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
	// Audit, when non-nil, receives a RunSummary after every audited run.
	// Writes are always audited; reads are only audited when AuditAllRuns
	// is true.
	Audit AuditHook
	// AuditAllRuns includes read-only runs in audit fan-out. Default false
	// (only writes are audited).
	AuditAllRuns bool
	// AbandonedRunTimeout is how long a runState may persist in the runs
	// map before the janitor prunes it. Default: 10m. Set to a small value
	// in tests to exercise cleanup.
	AbandonedRunTimeout time.Duration
	// CleanupInterval controls how often the janitor scans for abandoned
	// runs. Default: 1m. Set to 0 to disable the janitor.
	CleanupInterval time.Duration
	// MaxQueryDays mirrors mcp.Config.MaxQueryDays: the per-call lookback cap
	// applied to list operations whose schema bounds the read window
	// (health.bp.list, health.weight.list, medications.history). Without it,
	// scripts can call those operations with days=0 to bypass the data window
	// the granular MCP tools enforce. 0 disables clamping (test default).
	MaxQueryDays int
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

	cleanupStop   chan struct{}
	cleanupDoneCh chan struct{}
	abandonedRuns atomic.Int64
}

// runState is the per-run record stored while a run is in flight. The
// loopback /call handler looks up runs by token to forward calls through
// the right per-run proxy and RunConfig. startedAt is consulted by the
// janitor to prune abandoned runs.
//
// proxyDenials, backendAppErrors, and backendTransport count what actually
// happened on the Go side during the run. They are read after the runner
// returns so a script that raises a helper exception class without
// matching proxy/backend evidence cannot spoof the executor's status
// mapping (e.g. constructing `medtracker.exceptions.ProxyDenied` and
// raising it without the proxy ever denying anything).
type runState struct {
	runID            string
	cfg              proxy.RunConfig
	p                *proxy.Proxy
	startedAt        time.Time
	cancel           context.CancelFunc // cancels the run's context on cleanup
	proxyDenials     atomic.Int64
	backendAppErrors atomic.Int64
	backendTransport atomic.Int64
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
	if opts.AbandonedRunTimeout <= 0 {
		opts.AbandonedRunTimeout = defaultAbandonedTimeout
	}
	if opts.CleanupInterval < 0 {
		opts.CleanupInterval = 0
	} else if opts.CleanupInterval == 0 {
		opts.CleanupInterval = defaultCleanupInterval
	}

	sp := opts.Spawner
	if sp == nil {
		if opts.RunnerScript == "" {
			return nil, errors.New("executor: RunnerScript is required when no Spawner is provided")
		}
		module, cwd, err := runnerModuleAndCwd(opts.RunnerScript, opts.RunnerCwd)
		if err != nil {
			return nil, fmt.Errorf("executor: %w", err)
		}
		sp = &execCmdSpawner{
			python: opts.PythonPath,
			module: module,
			cwd:    cwd,
		}
	}

	return &Service{
		opts:          opts,
		sem:           make(chan struct{}, opts.MaxConcurrent),
		spawner:       sp,
		runs:          make(map[string]*runState),
		cleanupStop:   make(chan struct{}),
		cleanupDoneCh: make(chan struct{}),
	}, nil
}

// Start brings up the loopback proxy listener (unless disabled). Idempotent
// at the started flag level — calling twice returns an error.
func (s *Service) Start(ctx context.Context) error {
	if !s.started.CompareAndSwap(false, true) {
		return errors.New("executor: service already started")
	}

	s.startJanitor()

	if s.opts.DisableListener {
		slog.Info("[Executor] started without loopback listener",
			"max_concurrent", s.opts.MaxConcurrent,
			"abandoned_timeout_ms", s.opts.AbandonedRunTimeout.Milliseconds(),
		)
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

	slog.Info("[Executor] started",
		"proxy_url", s.proxyURL,
		"max_concurrent", s.opts.MaxConcurrent,
		"abandoned_timeout_ms", s.opts.AbandonedRunTimeout.Milliseconds(),
	)
	return nil
}

// Shutdown stops accepting new runs and shuts the loopback listener.
// Active runs are not interrupted — callers should wait for in-flight
// Execute calls before invoking Shutdown.
func (s *Service) Shutdown(ctx context.Context) error {
	if !s.stopped.CompareAndSwap(false, true) {
		return nil
	}
	s.stopJanitor()
	if s.httpServer == nil {
		return nil
	}
	return s.httpServer.Shutdown(ctx)
}

// startJanitor launches the abandoned-run cleanup goroutine. No-op if the
// cleanup interval is zero (disabled) or the janitor was already started.
func (s *Service) startJanitor() {
	if s.opts.CleanupInterval <= 0 {
		close(s.cleanupDoneCh)
		return
	}
	go func() {
		defer close(s.cleanupDoneCh)
		ticker := time.NewTicker(s.opts.CleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-s.cleanupStop:
				return
			case <-ticker.C:
				s.cleanupAbandoned()
			}
		}
	}()
}

// stopJanitor signals the cleanup goroutine to exit and waits for it to
// finish. Safe to call when the janitor was never started or already stopped.
func (s *Service) stopJanitor() {
	select {
	case <-s.cleanupStop:
		// Already closed.
	default:
		close(s.cleanupStop)
	}
	<-s.cleanupDoneCh
}

// cleanupAbandoned removes runState entries whose startedAt is older than
// AbandonedRunTimeout. The matching run's context is cancelled to unblock
// any spawner that's still hanging. Returns the number of entries removed.
func (s *Service) cleanupAbandoned() int {
	cutoff := time.Now().Add(-s.opts.AbandonedRunTimeout)
	var (
		stale  []string
		toFree []context.CancelFunc
	)
	s.mu.Lock()
	for tok, rs := range s.runs {
		if rs.startedAt.Before(cutoff) {
			stale = append(stale, tok)
			toFree = append(toFree, rs.cancel)
		}
	}
	for _, tok := range stale {
		delete(s.runs, tok)
	}
	s.mu.Unlock()

	for _, cancel := range toFree {
		if cancel != nil {
			cancel()
		}
	}
	if len(stale) > 0 {
		s.abandonedRuns.Add(int64(len(stale)))
		slog.Warn("[Executor] pruned abandoned runs",
			"count", len(stale),
			"abandoned_timeout_ms", s.opts.AbandonedRunTimeout.Milliseconds(),
		)
	}
	return len(stale)
}

// AbandonedRunsTotal returns the cumulative number of runs the janitor has
// pruned since the service started. Intended for tests and metrics.
func (s *Service) AbandonedRunsTotal() int64 { return s.abandonedRuns.Load() }

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
		current := s.activeCount.Load()
		slog.Warn("[Executor] max concurrent runs reached",
			"max", s.opts.MaxConcurrent,
			"current", current,
			"mode", req.Mode,
			"err_code", mcp.ExecuteErrMaxConcurrent,
		)
		errMsg := fmt.Sprintf("%s: max concurrent runs (%d) reached", mcp.ExecuteErrMaxConcurrent, s.opts.MaxConcurrent)
		s.fanOutAudit(ctx, RunSummary{
			Mode:       req.Mode,
			Intent:     req.Intent,
			Status:     mcp.ExecuteStatusSandboxStartupFailure,
			ExitReason: "rejected",
			Error:      errMsg,
		})
		return &mcp.ExecutionResult{
			Status: mcp.ExecuteStatusSandboxStartupFailure,
			Error:  errMsg,
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
	p.SetMaxQueryDays(s.opts.MaxQueryDays)

	// Wall-clock backstop is established below; we register the cancel func
	// in runState so the janitor can cut off a wedged spawner if necessary.
	s.mu.Lock()
	s.runs[runToken] = &runState{runID: runID, cfg: runCfg, p: p, startedAt: time.Now()}
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
		errMsg := fmt.Sprintf("%s: %v", mcp.ExecuteErrConfigMarshal, err)
		s.logRunCompletion(runID, req, 0, 0, mcp.ExecuteStatusSandboxStartupFailure, "marshal_failed", errMsg)
		s.fanOutAudit(ctx, RunSummary{
			RunID:      runID,
			Mode:       req.Mode,
			Intent:     req.Intent,
			Status:     mcp.ExecuteStatusSandboxStartupFailure,
			ExitReason: "marshal_failed",
			Error:      errMsg,
		})
		return &mcp.ExecutionResult{
			Status: mcp.ExecuteStatusSandboxStartupFailure,
			Error:  errMsg,
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

	// Register cancel so the janitor can free a hung spawner during cleanup.
	s.mu.Lock()
	if rs, ok := s.runs[runToken]; ok {
		rs.cancel = cancel
	}
	s.mu.Unlock()

	started := time.Now()
	out, spawnErr := s.spawner.Spawn(runCtx, payloadBytes)
	duration := time.Since(started)

	apiCalls := int(p.CallCount())

	if spawnErr != nil {
		errMsg := fmt.Sprintf("%s: %v", mcp.ExecuteErrSpawnFailed, spawnErr)
		s.logRunCompletion(runID, req, duration.Milliseconds(), apiCalls, mcp.ExecuteStatusSandboxStartupFailure, "spawn_failed", errMsg)
		s.fanOutAudit(ctx, RunSummary{
			RunID:      runID,
			Mode:       req.Mode,
			Intent:     req.Intent,
			DurationMS: duration.Milliseconds(),
			APICalls:   apiCalls,
			Status:     mcp.ExecuteStatusSandboxStartupFailure,
			ExitReason: "spawn_failed",
			Error:      errMsg,
		})
		return &mcp.ExecutionResult{
			Status:   mcp.ExecuteStatusSandboxStartupFailure,
			Error:    errMsg,
			APICalls: apiCalls,
		}, nil
	}

	envelope, parseErr := parseRunnerEnvelope(out)
	if parseErr != nil {
		errMsg := fmt.Sprintf("%s: %v", mcp.ExecuteErrInvalidEnvelope, parseErr)
		s.logRunCompletion(runID, req, duration.Milliseconds(), apiCalls, mcp.ExecuteStatusSandboxStartupFailure, "invalid_envelope", errMsg)
		s.fanOutAudit(ctx, RunSummary{
			RunID:      runID,
			Mode:       req.Mode,
			Intent:     req.Intent,
			DurationMS: duration.Milliseconds(),
			APICalls:   apiCalls,
			Status:     mcp.ExecuteStatusSandboxStartupFailure,
			ExitReason: "invalid_envelope",
			Error:      errMsg,
		})
		return &mcp.ExecutionResult{
			Status:   mcp.ExecuteStatusSandboxStartupFailure,
			Error:    errMsg,
			APICalls: apiCalls,
		}, nil
	}

	// Snapshot per-run outcomes from the loopback handler so mapEnvelope can
	// distinguish a real proxy/backend failure from a script that fabricated
	// a helper exception class.
	outcomes := runOutcomes{}
	s.mu.Lock()
	if rs, ok := s.runs[runToken]; ok {
		outcomes.proxyDenials = rs.proxyDenials.Load()
		outcomes.backendAppErrors = rs.backendAppErrors.Load()
		outcomes.backendTransport = rs.backendTransport.Load()
	}
	s.mu.Unlock()

	result := mapEnvelope(envelope, apiCalls, outcomes)
	s.logRunCompletion(runID, req, duration.Milliseconds(), apiCalls, result.Status, envelope.ExitReason, result.Error)
	s.fanOutAudit(ctx, RunSummary{
		RunID:      runID,
		Mode:       req.Mode,
		Intent:     req.Intent,
		DurationMS: duration.Milliseconds(),
		APICalls:   apiCalls,
		Status:     result.Status,
		ExitReason: envelope.ExitReason,
		Error:      truncateForLog(result.Error, 256),
	})
	return result, nil
}

// logRunCompletion emits the canonical post-run slog entry. Centralizing this
// means every exit path produces the same structured fields, which keeps log
// queries consistent.
func (s *Service) logRunCompletion(runID string, req mcp.ExecutionRequest, durationMS int64, apiCalls int, status, exitReason, errMsg string) {
	slog.Info("[Executor] run completed",
		"run_id", runID,
		"mode", req.Mode,
		"duration_ms", durationMS,
		"api_calls", apiCalls,
		"status", status,
		"exit_reason", exitReason,
		"intent_present", req.Intent != "",
		"intent", truncateIntent(req.Intent),
		"error", truncateForLog(errMsg, 256),
	)
}

// fanOutAudit dispatches the run summary to the configured AuditHook subject
// to the AuditAllRuns gate. Writes are always audited; reads only when the
// flag is set. Hooks run synchronously so audit ordering is preserved across
// runs that share the service.
func (s *Service) fanOutAudit(ctx context.Context, summary RunSummary) {
	if s.opts.Audit == nil {
		return
	}
	if summary.Mode != proxy.ModeWrite && !s.opts.AuditAllRuns {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("[Executor] audit hook panic", "panic", fmt.Sprintf("%v", r), "run_id", summary.RunID)
		}
	}()
	s.opts.Audit.OnRun(ctx, summary)
}

// runnerEnvelope mirrors the JSON shape returned by python/runner/runner.py.
type runnerEnvelope struct {
	Status     string          `json:"status"`
	ExitReason string          `json:"exit_reason"`
	Result     json.RawMessage `json:"result"`
	OutputSet  bool            `json:"output_set"`
	Stdout     string          `json:"stdout"`
	Stderr     string          `json:"stderr"`
	Warnings   []string        `json:"warnings"`
	ErrorType  string          `json:"error_type"`
	ErrorMsg   string          `json:"error_message"`
	Traceback  string          `json:"traceback"`
	DurationMS int64           `json:"duration_ms"`
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

// runOutcomes is the per-run tally of what actually happened on the Go side
// (proxy denials, backend app errors, backend transport errors). It is read
// after the runner returns so mapEnvelope can refuse to surface a special
// MCP status when no matching outcome was recorded — preventing a script
// from spoofing `proxy_denied` / `backend_*` by raising the helper exception
// classes directly without going through the proxy.
type runOutcomes struct {
	proxyDenials     int64
	backendAppErrors int64
	backendTransport int64
}

// mapEnvelope translates the runner's exit_reason and Python-side error_type
// into the stable MCP execute status codes used by the response envelope.
func mapEnvelope(env runnerEnvelope, apiCalls int, outcomes runOutcomes) *mcp.ExecutionResult {
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
		res.Status = scriptErrorStatusFromType(env.ErrorType, outcomes)
		res.Error = formatScriptError(env.ErrorType, env.ErrorMsg)
	default:
		res.Status = mcp.ExecuteStatusScriptError
		res.Error = formatScriptError(env.ErrorType, env.ErrorMsg)
	}
	return res
}

// scriptErrorStatusFromType maps the Python exception class reported by the
// runner to the MCP status code that best describes the failure. The runner
// records the fully-qualified type ("<module>.<qualname>"), so user code with
// a same-named class (`class ProxyDenied(Exception)`) lives under "__main__"
// and is rejected by the type check.
//
// The exception type is still script-controllable, though: a script can
// `from medtracker.exceptions import ProxyDenied; raise ProxyDenied("x")` or
// reach in and rewrite `__module__`. To prevent spoofing the special MCP
// statuses, we require a corresponding outcome on the Go side (the proxy
// actually denied a call, or a backend error/transport-class failure was
// observed). When the runner-reported type and Go outcomes disagree, fall
// back to the generic script_error status; the original error message is
// preserved in the response so callers still see what was raised.
func scriptErrorStatusFromType(errorType string, outcomes runOutcomes) string {
	switch errorType {
	case "medtracker.exceptions.ProxyDenied":
		if outcomes.proxyDenials > 0 {
			return mcp.ExecuteStatusProxyDenied
		}
	case "medtracker.exceptions.BackendError":
		if outcomes.backendAppErrors > 0 {
			return mcp.ExecuteStatusBackendAppError
		}
	case "medtracker.exceptions.BackendTransportError",
		"medtracker.exceptions.BackendResponseTruncated",
		"medtracker.exceptions.TimeoutError":
		if outcomes.backendTransport > 0 {
			return mcp.ExecuteStatusBackendTransportError
		}
	}
	return mcp.ExecuteStatusScriptError
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
		OperationID string                     `json:"operation_id"`
		Params      map[string]json.RawMessage `json:"params"`
		Body        json.RawMessage            `json:"body"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// The bridge accepts string-valued query params, but scripts pass any JSON
	// scalar (numbers, booleans, …) through medtracker.api.call. Stringify on
	// the proxy boundary so the URL encoder downstream doesn't have to care.
	stringParams := paramsToStrings(req.Params)

	result, callErr := rs.p.Call(r.Context(), rs.cfg, req.OperationID, stringParams, req.Body)
	if callErr != nil {
		var ce *proxy.CallError
		if errors.As(callErr, &ce) {
			// Registry-level rejection (unknown op, write blocked, topic not
			// allowed, max calls). The X-MCP-Outcome header marks this as a
			// proxy denial so the helper can raise ProxyDenied; backend 4xx
			// responses lack the header and surface as BackendError instead.
			rs.proxyDenials.Add(1)
			w.Header().Set("X-MCP-Outcome", "proxy_denied")
			http.Error(w, ce.Code+": "+ce.Message, http.StatusForbidden)
			return
		}
		// Transport error talking to the bridge — script-side helper raises
		// BackendTransportError so callers can distinguish bot/bridge outages
		// from legitimate upstream 5xx responses.
		rs.backendTransport.Add(1)
		w.Header().Set("X-MCP-Outcome", "backend_transport_error")
		http.Error(w, "bridge transport error: "+callErr.Error(), http.StatusBadGateway)
		return
	}
	if result.Response == nil {
		// Bridge replied with non-200; preserve the bridge status when it's
		// in a usable HTTP range so the helper can classify properly. The
		// bridge always wraps backend responses in a 200 envelope, so a
		// non-200 here is a bridge-level failure (HMAC, config, unknown op),
		// not a backend application error — mark it as a transport-class
		// outcome.
		statusCode := result.Trace.Status
		if statusCode < 400 || statusCode >= 600 {
			statusCode = http.StatusBadGateway
		}
		rs.backendTransport.Add(1)
		w.Header().Set("X-MCP-Outcome", "backend_transport_error")
		http.Error(w, result.Trace.Error, statusCode)
		return
	}

	// PolicyDenial is set by the bridge when it refuses a call before reaching
	// the backend (e.g. a feature flag is disabled). Surface as a proxy-level
	// rejection so the script-side helper raises ProxyDenied, not BackendError
	// or BackendTransportError.
	if result.Response.PolicyDenial != "" {
		rs.proxyDenials.Add(1)
		w.Header().Set("X-MCP-Outcome", "proxy_denied")
		http.Error(w, "policy denied: "+result.Response.PolicyDenial, http.StatusForbidden)
		return
	}

	// The bridge truncates upstream bodies that exceed its per-call cap. The
	// truncated bytes are wrapped as a JSON string by the bridge, which would
	// otherwise reach the script as silently malformed data (a string where
	// a list/object was expected). Surface as a transport-class outcome with
	// a dedicated header so the helper raises BackendResponseTruncated and
	// the script does not act on partial data.
	if result.Response.Truncated {
		rs.backendTransport.Add(1)
		w.Header().Set("X-MCP-Outcome", "backend_response_truncated")
		http.Error(w, "backend response exceeded the per-call size cap and was truncated", http.StatusBadGateway)
		return
	}

	// Propagate the upstream backend status so the script's helper raises
	// ProxyDenied (4xx) or BackendError (5xx) instead of silently treating a
	// failed backend call as success.
	statusCode := result.Response.Status
	if statusCode <= 0 || statusCode >= 600 {
		statusCode = http.StatusOK
	}
	if statusCode >= 400 {
		// Upstream backend returned an error; the script-side helper raises
		// medtracker.exceptions.BackendError. Track so the executor can
		// distinguish a real backend error from a script that fabricates
		// the same exception class without any backend contact.
		rs.backendAppErrors.Add(1)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if _, err := w.Write(result.Response.Body); err != nil {
		slog.Error("[Executor] write response", "error", err)
	}
}

// paramsToStrings converts caller-supplied JSON params into the string form
// the bridge expects. JSON strings are unquoted; numbers, booleans, and null
// are written as their raw JSON tokens; nested objects/arrays fall through as
// JSON for the rare op that takes structured query params.
func paramsToStrings(params map[string]json.RawMessage) map[string]string {
	if len(params) == 0 {
		return nil
	}
	out := make(map[string]string, len(params))
	for k, raw := range params {
		out[k] = paramToString(raw)
	}
	return out
}

func paramToString(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ""
	}
	// JSON strings: drop the surrounding quotes and decode escapes.
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err == nil {
			return s
		}
	}
	return string(trimmed)
}

// execCmdSpawner is the production Spawner. It forks
// `python -m runner.runner` with the JSON config payload on stdin and reads
// the result envelope on stdout. The `-m` form ensures `from runner import
// limits` resolves regardless of how the script path was configured;
// invoking the file directly causes a circular import because Python adds
// the script's own directory to sys.path[0].
type execCmdSpawner struct {
	python string
	module string
	cwd    string
}

func (e *execCmdSpawner) Spawn(ctx context.Context, payload []byte) ([]byte, error) {
	cmd := exec.CommandContext(ctx, e.python, "-m", e.module)
	if e.cwd != "" {
		cmd.Dir = e.cwd
	}
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	// On context cancellation, send SIGTERM (not the default SIGKILL) so the
	// runner's signal handler can reap any background subprocess the user
	// script forked before the runner itself exits. WaitDelay escalates to
	// SIGKILL if the runner ignores SIGTERM. Without this, exec would SIGKILL
	// the runner directly — uncatchable, leaking the script's grandchildren
	// past the wall-clock bound.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = runnerCancelGrace
	err := cmd.Run()
	// runner.py exits with code 1 whenever the run envelope reports a script
	// error, timeout, or sandbox failure — but it still writes the envelope to
	// stdout first. Treat any stdout payload as authoritative so the upstream
	// envelope parser can classify the failure mode; only surface a spawn
	// error when the runner produced nothing.
	if stdout.Len() > 0 {
		return stdout.Bytes(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w (stderr: %s)", err, stderr.String())
	}
	return nil, fmt.Errorf("runner produced no output (stderr: %s)", stderr.String())
}

// runnerModuleAndCwd derives the `-m <module>` argument and working
// directory from the configured runner script path. The script path is
// expected to resolve to a `.py` file inside a Python package (for the
// repo's runner this is python/runner/runner.py), and cwd defaults to the
// parent package's parent so `python -m <module>` finds it on sys.path.
func runnerModuleAndCwd(script, cwd string) (string, string, error) {
	if script == "" {
		return "", "", errors.New("RunnerScript is required")
	}
	abs, err := filepath.Abs(script)
	if err != nil {
		return "", "", fmt.Errorf("resolve runner script path: %w", err)
	}
	if !strings.HasSuffix(abs, ".py") {
		return "", "", fmt.Errorf("runner script must end in .py: %q", script)
	}
	if cwd == "" {
		cwd = filepath.Dir(filepath.Dir(abs))
	}
	cwdAbs, err := filepath.Abs(cwd)
	if err != nil {
		return "", "", fmt.Errorf("resolve runner cwd: %w", err)
	}
	rel, err := filepath.Rel(cwdAbs, abs)
	if err != nil {
		return "", "", fmt.Errorf("runner script %q is not reachable from cwd %q: %w", script, cwd, err)
	}
	if strings.HasPrefix(rel, "..") {
		return "", "", fmt.Errorf("runner script %q must live under cwd %q", script, cwd)
	}
	rel = strings.TrimSuffix(rel, ".py")
	module := strings.ReplaceAll(filepath.ToSlash(rel), "/", ".")
	if module == "" {
		return "", "", fmt.Errorf("derived empty module name from script %q", script)
	}
	return module, cwdAbs, nil
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

// truncateForLog caps an arbitrary string before it lands in slog/audit. The
// runner stderr, error messages, and bridge response previews can grow large;
// keep them small enough that a noisy script can't overwhelm logs.
func truncateForLog(s string, maxLen int) string {
	if maxLen <= 0 || len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "...(truncated)"
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
