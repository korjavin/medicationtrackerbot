package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/proxy"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

// fakeSpawner is an injectable Spawner used by every service test in this
// file. The fn closure inspects the JSON payload (run token, mode, etc.)
// and returns the runner envelope it wants the service to map.
type fakeSpawner struct {
	mu          sync.Mutex
	calls       int
	lastPayload []byte
	fn          func(ctx context.Context, payload []byte) ([]byte, error)
}

func (f *fakeSpawner) Spawn(ctx context.Context, payload []byte) ([]byte, error) {
	f.mu.Lock()
	f.calls++
	f.lastPayload = append([]byte(nil), payload...)
	f.mu.Unlock()
	return f.fn(ctx, payload)
}

func (f *fakeSpawner) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeSpawner) LastPayload() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.lastPayload...)
}

// envelopeOK builds an OK runner envelope from a JSON-encoded result value.
func envelopeOK(result string) []byte {
	return []byte(`{"status":"ok","exit_reason":"completed","result":` + result + `,"output_set":true,"stdout":"","stderr":"","warnings":[],"duration_ms":1}`)
}

func envelopeError(exitReason, errType, errMsg string) []byte {
	return []byte(fmt.Sprintf(
		`{"status":"error","exit_reason":%q,"result":null,"output_set":false,"stdout":"","stderr":"trace","warnings":[],"error_type":%q,"error_message":%q,"duration_ms":2}`,
		exitReason, errType, errMsg,
	))
}

func buildRegistry(t *testing.T) *registry.Registry {
	t.Helper()
	r := registry.New()
	if err := r.Register(
		&registry.Operation{
			ID:              "workouts.groups.list",
			Topic:           "workouts",
			Method:          "GET",
			Path:            "/api/workout/groups",
			Risk:            registry.RiskRead,
			ResponseSummary: "list of groups",
			Description:     "list groups",
		},
		&registry.Operation{
			ID:              "workouts.sessions.create",
			Topic:           "workouts",
			Method:          "POST",
			Path:            "/api/workout/sessions",
			Risk:            registry.RiskWrite,
			ResponseSummary: "created session",
			Description:     "create session",
		},
	); err != nil {
		t.Fatalf("register: %v", err)
	}
	return r
}

// newTestService constructs a Service with a fake spawner and an httptest
// stand-in for the bridge. The listener is enabled by default so we can
// also exercise the loopback /call route.
func newTestService(t *testing.T, sp Spawner, opts ...func(*Options)) (*Service, *httptest.Server) {
	t.Helper()
	return newTestServiceWith(t, sp, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := proxy.BridgeResponse{
			Status: 200,
			Body:   json.RawMessage(`{"groups":[{"id":1,"name":"a"}]}`),
		}
		_ = json.NewEncoder(w).Encode(resp)
	}, opts...)
}

// newTestServiceWithBridge wires a Service whose loopback proxy targets a
// caller-supplied bridge handler. Lets tests trigger backend application or
// transport errors so the executor's per-run outcome counters fire.
func newTestServiceWithBridge(t *testing.T, sp Spawner, bridgeHandler http.HandlerFunc, opts ...func(*Options)) (*Service, *httptest.Server) {
	t.Helper()
	return newTestServiceWith(t, sp, bridgeHandler, opts...)
}

func newTestServiceWith(t *testing.T, sp Spawner, bridgeHandler http.HandlerFunc, opts ...func(*Options)) (*Service, *httptest.Server) {
	t.Helper()
	bridge := httptest.NewServer(bridgeHandler)
	t.Cleanup(bridge.Close)

	o := Options{
		Registry:   buildRegistry(t),
		BridgeURL:  bridge.URL,
		HMACSecret: "test-secret",
		Spawner:    sp,
	}
	for _, fn := range opts {
		fn(&o)
	}
	svc, err := New(o)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := svc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		_ = svc.Shutdown(context.Background())
	})
	return svc, bridge
}

// mustField pulls a top-level string field out of the spawner payload. The
// payload is the JSON config the executor passes on stdin to the runner.
func mustField(payload []byte, key string) string {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// --- Construction / lifecycle ---

func TestNew_RequiresRegistry(t *testing.T) {
	_, err := New(Options{BridgeURL: "x", HMACSecret: "y", Spawner: &fakeSpawner{}})
	if err == nil || !strings.Contains(err.Error(), "Registry") {
		t.Fatalf("expected Registry-required error, got %v", err)
	}
}

func TestNew_RequiresBridgeURL(t *testing.T) {
	_, err := New(Options{Registry: registry.New(), HMACSecret: "y", Spawner: &fakeSpawner{}})
	if err == nil || !strings.Contains(err.Error(), "BridgeURL") {
		t.Fatalf("expected BridgeURL-required error, got %v", err)
	}
}

func TestNew_RequiresHMACSecret(t *testing.T) {
	_, err := New(Options{Registry: registry.New(), BridgeURL: "x", Spawner: &fakeSpawner{}})
	if err == nil || !strings.Contains(err.Error(), "HMACSecret") {
		t.Fatalf("expected HMACSecret-required error, got %v", err)
	}
}

func TestNew_RequiresRunnerScriptWhenNoSpawner(t *testing.T) {
	_, err := New(Options{
		Registry:   registry.New(),
		BridgeURL:  "x",
		HMACSecret: "y",
	})
	if err == nil || !strings.Contains(err.Error(), "RunnerScript") {
		t.Fatalf("expected RunnerScript-required error, got %v", err)
	}
}

func TestNew_DefaultsApplied(t *testing.T) {
	svc, err := New(Options{
		Registry:   registry.New(),
		BridgeURL:  "x",
		HMACSecret: "y",
		Spawner:    &fakeSpawner{},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if svc.opts.MaxConcurrent != DefaultMaxConcurrent {
		t.Errorf("expected default MaxConcurrent %d, got %d", DefaultMaxConcurrent, svc.opts.MaxConcurrent)
	}
	if svc.opts.PythonPath != DefaultPython {
		t.Errorf("expected default PythonPath %q, got %q", DefaultPython, svc.opts.PythonPath)
	}
}

func TestStartStop(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`1`), nil }}
	svc, _ := newTestService(t, sp)

	if err := svc.HealthCheck(); err != nil {
		t.Errorf("expected healthy after Start, got %v", err)
	}
	if svc.ProxyURL() == "" {
		t.Error("expected non-empty ProxyURL after Start")
	}

	// Listener is reachable.
	resp, err := http.Get(strings.Replace(svc.ProxyURL(), "/call", "/health", 1))
	if err != nil {
		t.Fatalf("listener health probe: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("expected 200 from /health, got %d", resp.StatusCode)
	}

	if err := svc.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
	if err := svc.HealthCheck(); err == nil {
		t.Error("expected unhealthy after Shutdown")
	}
}

func TestStart_TwiceFails(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`1`), nil }}
	svc, _ := newTestService(t, sp)
	if err := svc.Start(context.Background()); err == nil {
		t.Fatal("expected error on second Start")
	}
}

func TestExecute_BeforeStartFails(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`1`), nil }}
	svc, err := New(Options{
		Registry:   buildRegistry(t),
		BridgeURL:  "http://localhost:1",
		HMACSecret: "y",
		Spawner:    sp,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err == nil {
		t.Fatal("expected error from Execute before Start")
	}
}

func TestExecute_AfterShutdownFails(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`1`), nil }}
	svc, _ := newTestService(t, sp)
	_ = svc.Shutdown(context.Background())
	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err == nil {
		t.Fatal("expected error from Execute after Shutdown")
	}
}

// --- Successful run mapping ---

func TestExecute_SuccessMapping(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`{"hello":"world"}`), nil
	}}
	svc, _ := newTestService(t, sp)

	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "from medtracker import output\noutput({'hello':'world'})",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusOK {
		t.Errorf("expected status %q, got %q", mcp.ExecuteStatusOK, res.Status)
	}
	if string(res.Result) != `{"hello":"world"}` {
		t.Errorf("unexpected result: %s", res.Result)
	}
	if res.APICalls != 0 {
		t.Errorf("expected api_calls=0 (no proxy calls in fake), got %d", res.APICalls)
	}
}

// --- Payload contents ---

func TestExecute_PayloadContainsConfig(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp)
	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:         "x",
		Mode:           proxy.ModeWrite,
		Intent:         "edit a workout",
		TimeoutMS:      4000,
		MaxAPICalls:    20,
		TopicAllowlist: []string{"workouts"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal(sp.LastPayload(), &payload); err != nil {
		t.Fatalf("invalid payload: %v", err)
	}
	if payload["script"] != "x" {
		t.Errorf("unexpected script: %v", payload["script"])
	}
	if payload["mode"] != "write" {
		t.Errorf("unexpected mode: %v", payload["mode"])
	}
	if payload["timeout_s"].(float64) != 4.0 {
		t.Errorf("expected timeout_s=4, got %v", payload["timeout_s"])
	}
	if payload["max_api_calls"].(float64) != 20 {
		t.Errorf("expected max_api_calls=20, got %v", payload["max_api_calls"])
	}
	if topics, ok := payload["topic_allowlist"].([]any); !ok || len(topics) != 1 || topics[0] != "workouts" {
		t.Errorf("unexpected topic_allowlist: %v", payload["topic_allowlist"])
	}
	if pu, ok := payload["proxy_url"].(string); !ok || !strings.HasPrefix(pu, "http://127.0.0.1:") {
		t.Errorf("unexpected proxy_url: %v", payload["proxy_url"])
	}
	if rt, ok := payload["run_token"].(string); !ok || len(rt) < 16 {
		t.Errorf("expected non-empty run_token, got %v", payload["run_token"])
	}
	if intent, ok := payload["intent"].(string); !ok || intent != "edit a workout" {
		t.Errorf("expected intent=%q, got %v", "edit a workout", payload["intent"])
	}
}

// --- Error envelope mapping ---

func TestExecute_TimeoutMapping(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeError("timeout", "Timeout", "killed after 30s"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusTimeout {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusTimeout, res.Status)
	}
}

func TestExecute_ScriptErrorMapping(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeError("script_error", "ValueError", "bad input"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusScriptError {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusScriptError, res.Status)
	}
	if !strings.Contains(res.Error, "ValueError") {
		t.Errorf("expected error to mention ValueError: %q", res.Error)
	}
}

func TestExecute_ProxyDeniedMapping(t *testing.T) {
	// A real proxy denial triggers the outcome counter; the runner reports
	// medtracker.exceptions.ProxyDenied; the executor maps to proxy_denied.
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		// Trigger a genuine proxy denial: call a write op in read_only mode.
		// The proxy returns *CallError, the loopback handler increments the
		// per-run proxyDenials counter.
		_, _, _ = loopbackCallStatus(ctx, mustField(payload, "proxy_url"), mustField(payload, "run_token"),
			"workouts.sessions.create", nil, map[string]any{"x": 1})
		return envelopeError("script_error", "medtracker.exceptions.ProxyDenied", "write_blocked"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", Mode: proxy.ModeReadOnly, TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusProxyDenied {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusProxyDenied, res.Status)
	}
}

func TestExecute_BackendErrorMapping(t *testing.T) {
	// Real backend application error: bridge returns 200 envelope wrapping a
	// non-2xx upstream status. Loopback handler counts this as a backend app
	// error; runner reports medtracker.exceptions.BackendError.
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		_, _, _ = loopbackCallStatus(ctx, mustField(payload, "proxy_url"), mustField(payload, "run_token"),
			"workouts.groups.list", nil, nil)
		return envelopeError("script_error", "medtracker.exceptions.BackendError", "Backend error (500)"), nil
	}}
	svc, _ := newTestServiceWithBridge(t, sp, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{Status: 500, Body: json.RawMessage(`{"error":"upstream"}`)})
	})
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusBackendAppError {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusBackendAppError, res.Status)
	}
}

func TestExecute_BackendTransportErrorMapping(t *testing.T) {
	// Bridge unreachable: proxy returns transport error → loopback handler
	// counts a backend transport outcome → mapping returns
	// backend_transport_error for the helper exception class.
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		_, _, _ = loopbackCallStatus(ctx, mustField(payload, "proxy_url"), mustField(payload, "run_token"),
			"workouts.groups.list", nil, nil)
		return envelopeError("script_error", "medtracker.exceptions.BackendTransportError", "Backend transport error (502)"), nil
	}}
	svc, _ := newTestServiceWithBridge(t, sp, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bridge down", http.StatusBadGateway)
	})
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusBackendTransportError {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusBackendTransportError, res.Status)
	}
}

func TestExecute_BackendResponseTruncatedMapping(t *testing.T) {
	// Bridge truncates the upstream body at its per-call cap: loopback handler
	// counts a backend transport outcome and tags X-MCP-Outcome=backend_response_truncated.
	// Runner reports medtracker.exceptions.BackendResponseTruncated → mapping
	// must return backend_transport_error so callers see a transport-class
	// failure rather than a generic script_error.
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		_, _, _ = loopbackCallStatus(ctx, mustField(payload, "proxy_url"), mustField(payload, "run_token"),
			"workouts.groups.list", nil, nil)
		return envelopeError("script_error", "medtracker.exceptions.BackendResponseTruncated", "Backend response truncated (502)"), nil
	}}
	svc, _ := newTestServiceWithBridge(t, sp, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{
			Status:    http.StatusOK,
			Body:      json.RawMessage(`"<truncated bytes>"`),
			Truncated: true,
		})
	})
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusBackendTransportError {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusBackendTransportError, res.Status)
	}
}

func TestExecute_UserClassDoesNotSpoofMapping(t *testing.T) {
	// A user script that defines `class ProxyDenied(Exception): pass` and
	// raises it must not be reclassified as a helper-raised proxy denial.
	// The runner records the fully-qualified type, so a user class lives
	// under "__main__" / "<module>.ProxyDenied" rather than
	// "medtracker.exceptions.ProxyDenied".
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeError("script_error", "ProxyDenied", "spoofed"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusScriptError {
		t.Errorf("user-defined ProxyDenied must surface as script error, got %q", res.Status)
	}
}

func TestExecute_HelperExceptionWithoutOutcomeNotSpoofable(t *testing.T) {
	// A script can `from medtracker.exceptions import ProxyDenied; raise ProxyDenied("x")`
	// or rewrite __module__ on a user class. The runner reports the fully
	// qualified helper type, but the proxy never recorded a denial — the
	// executor must fall back to script_error rather than letting the script
	// fabricate a proxy_denied / backend_* MCP status.
	cases := []struct {
		name      string
		errorType string
	}{
		{"proxy_denied_spoof", "medtracker.exceptions.ProxyDenied"},
		{"backend_error_spoof", "medtracker.exceptions.BackendError"},
		{"backend_transport_spoof", "medtracker.exceptions.BackendTransportError"},
		{"backend_response_truncated_spoof", "medtracker.exceptions.BackendResponseTruncated"},
		{"timeout_spoof", "medtracker.exceptions.TimeoutError"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
				return envelopeError("script_error", tc.errorType, "fabricated"), nil
			}}
			svc, _ := newTestService(t, sp)
			res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}
			if res.Status != mcp.ExecuteStatusScriptError {
				t.Errorf("%s without matching proxy outcome must map to script_error, got %q", tc.errorType, res.Status)
			}
			// The original exception type/message must still be visible to
			// callers via the error field.
			if !strings.Contains(res.Error, tc.errorType) {
				t.Errorf("error message must preserve exception type %q, got %q", tc.errorType, res.Error)
			}
		})
	}
}

func TestExecute_SandboxStartupFailureMapping(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeError("sandbox_startup_failure", "OSError", "no such file"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusSandboxStartupFailure {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusSandboxStartupFailure, res.Status)
	}
}

func TestExecute_ResultTooLargeMapping(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeError("result_too_large", "ResultTooLarge", "size 1234 exceeds limit"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusScriptError {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusScriptError, res.Status)
	}
	if !strings.Contains(res.Error, "result_too_large") {
		t.Errorf("expected error to mention result_too_large: %q", res.Error)
	}
}

// --- Run isolation: spawner errors don't crash the service ---

func TestExecute_SpawnFailure_DoesNotCrashService(t *testing.T) {
	var phase atomic.Int32
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		if phase.Add(1) == 1 {
			return nil, errors.New("python missing")
		}
		return envelopeOK(`"recovered"`), nil
	}}
	svc, _ := newTestService(t, sp)

	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute (1): %v", err)
	}
	if res.Status != mcp.ExecuteStatusSandboxStartupFailure {
		t.Errorf("first run: expected %q, got %q", mcp.ExecuteStatusSandboxStartupFailure, res.Status)
	}

	res, err = svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute (2): %v", err)
	}
	if res.Status != mcp.ExecuteStatusOK {
		t.Errorf("second run: expected %q after recovery, got %q", mcp.ExecuteStatusOK, res.Status)
	}

	if svc.ActiveRuns() != 0 {
		t.Errorf("expected ActiveRuns=0 after both runs, got %d", svc.ActiveRuns())
	}
}

func TestExecute_InvalidEnvelopeReturnsStartupFailure(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return []byte("not json at all"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusSandboxStartupFailure {
		t.Errorf("expected %q for invalid envelope, got %q", mcp.ExecuteStatusSandboxStartupFailure, res.Status)
	}
}

// --- Run isolation: each run gets a fresh proxy / unique token ---

func TestExecute_RunIsolation_UniqueTokens(t *testing.T) {
	// Capture the run_token from each spawn payload and verify they differ.
	var seen sync.Map
	var dup atomic.Bool
	sp := &fakeSpawner{fn: func(_ context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token, _ := p["run_token"].(string)
		if _, loaded := seen.LoadOrStore(token, struct{}{}); loaded {
			dup.Store(true)
		}
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp)

	for i := 0; i < 10; i++ {
		_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
		if err != nil {
			t.Fatalf("Execute %d: %v", i, err)
		}
	}
	if dup.Load() {
		t.Error("expected each run to get a unique run_token, found duplicate")
	}
}

func TestExecute_RunStateCleanedAfterRun(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeOK(`null`), nil
	}}
	svc, _ := newTestService(t, sp)

	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	svc.mu.Lock()
	count := len(svc.runs)
	svc.mu.Unlock()
	if count != 0 {
		t.Errorf("expected runs map empty after Execute, got %d entries", count)
	}
}

// --- Max concurrency ---

func TestExecute_MaxConcurrentRespected(t *testing.T) {
	releaseCh := make(chan struct{})
	startedCh := make(chan struct{}, 4)

	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		startedCh <- struct{}{}
		<-releaseCh
		return envelopeOK(`null`), nil
	}}

	svc, _ := newTestService(t, sp, func(o *Options) { o.MaxConcurrent = 1 })

	// Start a long-running run in the background.
	resultCh := make(chan *mcp.ExecutionResult, 1)
	go func() {
		res, _ := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 10_000})
		resultCh <- res
	}()

	// Wait for the spawner to actually start the first run.
	select {
	case <-startedCh:
	case <-time.After(2 * time.Second):
		close(releaseCh)
		t.Fatal("first run never started")
	}

	// A second run launched while the first is in flight must be rejected
	// immediately with a sandbox_startup_failure.
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "y", TimeoutMS: 10_000})
	if err != nil {
		close(releaseCh)
		t.Fatalf("second Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusSandboxStartupFailure {
		close(releaseCh)
		t.Errorf("expected %q for over-cap run, got %q", mcp.ExecuteStatusSandboxStartupFailure, res.Status)
	}
	if !strings.Contains(res.Error, "max concurrent") {
		close(releaseCh)
		t.Errorf("expected error to mention max concurrent, got %q", res.Error)
	}

	close(releaseCh)
	<-resultCh
}

// --- Loopback /call listener routing ---

func TestLoopbackCall_RoutesThroughProxyToBridge(t *testing.T) {
	// Bridge that echoes the operation_id in the response.
	var bridgeHits atomic.Int32
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bridgeHits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		var br proxy.BridgeRequest
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &br)
		resp := proxy.BridgeResponse{
			Status: 200,
			Body:   json.RawMessage(`{"echoed":"` + br.OperationID + `"}`),
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(bridge.Close)

	// Spawner pulls the run token out of the payload and immediately calls
	// the loopback proxy as if it were the script. This covers the full
	// runner→listener→proxy→bridge round trip.
	var capturedBody []byte
	var capturedStatus int
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		body := []byte(`{"operation_id":"workouts.groups.list"}`)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Run-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		capturedBody, _ = io.ReadAll(resp.Body)
		capturedStatus = resp.StatusCode
		return envelopeOK(`null`), nil
	}}

	o := Options{
		Registry:   buildRegistry(t),
		BridgeURL:  bridge.URL,
		HMACSecret: "test-secret",
		Spawner:    sp,
	}
	svc, err := New(o)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := svc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = svc.Shutdown(context.Background()) })

	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:      "x",
		Mode:        proxy.ModeReadOnly,
		TimeoutMS:   5000,
		MaxAPICalls: 10,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusOK {
		t.Fatalf("unexpected status: %q", res.Status)
	}
	if bridgeHits.Load() != 1 {
		t.Errorf("expected 1 bridge hit, got %d", bridgeHits.Load())
	}
	if capturedStatus != 200 {
		t.Errorf("expected /call to return 200, got %d (body: %s)", capturedStatus, capturedBody)
	}
	if !strings.Contains(string(capturedBody), "workouts.groups.list") {
		t.Errorf("expected bridge body forwarded, got %s", capturedBody)
	}
	if res.APICalls != 1 {
		t.Errorf("expected api_calls=1 after one proxy call (max=10), got %d", res.APICalls)
	}
}

func TestLoopbackCall_UnknownTokenRejected(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`null`), nil }}
	svc, _ := newTestService(t, sp)

	body := strings.NewReader(`{"operation_id":"workouts.groups.list"}`)
	req, _ := http.NewRequest(http.MethodPost, svc.ProxyURL(), body)
	req.Header.Set("X-Run-Token", "not-a-real-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestLoopbackCall_ProxyDeniedReturns403(t *testing.T) {
	// Spawner forwards a write op while the run is in read_only mode — proxy
	// denies it; listener should return 403 with X-MCP-Outcome: proxy_denied
	// so the helper raises ProxyDenied (not BackendError).
	var observedStatus int
	var observedOutcome string
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		body := []byte(`{"operation_id":"workouts.sessions.create"}`)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
		req.Header.Set("X-Run-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		observedStatus = resp.StatusCode
		observedOutcome = resp.Header.Get("X-MCP-Outcome")
		return envelopeOK(`null`), nil
	}}

	svc, _ := newTestService(t, sp)
	_, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if observedStatus != http.StatusForbidden {
		t.Errorf("expected 403 for proxy-denied write in read_only mode, got %d", observedStatus)
	}
	if observedOutcome != "proxy_denied" {
		t.Errorf("expected X-MCP-Outcome=proxy_denied for proxy denial, got %q", observedOutcome)
	}
}

func TestLoopbackCall_NonStringParamsAccepted(t *testing.T) {
	// Scripts pass JSON numbers/booleans through medtracker.api.call without
	// stringifying. The /call handler must accept them and forward stringified
	// values to the bridge.
	var capturedParams map[string]string
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var br proxy.BridgeRequest
		_ = json.Unmarshal(body, &br)
		capturedParams = br.Params
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{Status: 200, Body: json.RawMessage(`null`)})
	}))
	t.Cleanup(bridge.Close)

	var observedStatus int
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		// Numbers, booleans, and strings — all valid JSON scalars a script
		// may pass through medtracker.api.call.
		body := []byte(`{"operation_id":"workouts.groups.list","params":{"group_id":42,"flag":true,"name":"Gym A"}}`)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Run-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		observedStatus = resp.StatusCode
		return envelopeOK(`null`), nil
	}}

	svc, _ := newTestService(t, sp, func(o *Options) { o.BridgeURL = bridge.URL })
	if _, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if observedStatus != http.StatusOK {
		t.Fatalf("expected 200 from /call, got %d", observedStatus)
	}
	if capturedParams["group_id"] != "42" {
		t.Errorf("expected group_id=42, got %q", capturedParams["group_id"])
	}
	if capturedParams["flag"] != "true" {
		t.Errorf("expected flag=true, got %q", capturedParams["flag"])
	}
	if capturedParams["name"] != "Gym A" {
		t.Errorf("expected name=Gym A, got %q", capturedParams["name"])
	}
}

func TestLoopbackCall_PropagatesUpstreamBackendStatus(t *testing.T) {
	// When the backend returns a 4xx/5xx response, the bridge wraps it in a
	// BridgeResponse envelope with HTTP 200; the executor must surface that
	// upstream status to the runner. The X-MCP-Outcome header MUST NOT be set
	// for backend errors so the helper raises BackendError (not ProxyDenied).
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{
			Status: http.StatusBadRequest,
			Body:   json.RawMessage(`{"error":"invalid input"}`),
		})
	}))
	t.Cleanup(bridge.Close)

	var observedStatus int
	var observedBody []byte
	var observedOutcome string
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		body := []byte(`{"operation_id":"workouts.groups.list"}`)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
		req.Header.Set("X-Run-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		observedStatus = resp.StatusCode
		observedOutcome = resp.Header.Get("X-MCP-Outcome")
		observedBody, _ = io.ReadAll(resp.Body)
		return envelopeOK(`null`), nil
	}}

	svc, _ := newTestService(t, sp, func(o *Options) { o.BridgeURL = bridge.URL })
	if _, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if observedStatus != http.StatusBadRequest {
		t.Errorf("expected upstream 400 to propagate, got %d (body: %s)", observedStatus, observedBody)
	}
	if observedOutcome != "" {
		t.Errorf("backend 4xx must not set X-MCP-Outcome (would mask as proxy_denied), got %q", observedOutcome)
	}
	if !strings.Contains(string(observedBody), "invalid input") {
		t.Errorf("expected upstream body forwarded, got %s", observedBody)
	}
}

func TestLoopbackCall_BridgeTransportErrorSetsOutcomeHeader(t *testing.T) {
	// Bridge unreachable: the loopback /call must set
	// X-MCP-Outcome: backend_transport_error so the helper can raise a
	// distinct BackendTransportError instead of conflating with an upstream
	// 5xx via plain BackendError.
	var observedStatus int
	var observedOutcome string
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		body := []byte(`{"operation_id":"workouts.groups.list"}`)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
		req.Header.Set("X-Run-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		observedStatus = resp.StatusCode
		observedOutcome = resp.Header.Get("X-MCP-Outcome")
		return envelopeOK(`null`), nil
	}}

	// Point BridgeURL at a closed port so proxy.Call returns a transport error.
	svc, _ := newTestService(t, sp, func(o *Options) { o.BridgeURL = "http://127.0.0.1:1" })
	if _, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if observedStatus != http.StatusBadGateway {
		t.Errorf("expected 502 from /call on bridge transport failure, got %d", observedStatus)
	}
	if observedOutcome != "backend_transport_error" {
		t.Errorf("expected X-MCP-Outcome=backend_transport_error, got %q", observedOutcome)
	}
}

func TestLoopbackCall_PolicyDenialFromBridge(t *testing.T) {
	// Bridge wraps a feature-flag rejection as an envelope (HTTP 200 with
	// envelope.PolicyDenial set). The executor must surface this as a
	// proxy_denied outcome — not backend_transport_error — so the helper
	// raises ProxyDenied instead of misclassifying a policy denial as a
	// bridge outage.
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{
			Status:       http.StatusForbidden,
			Body:         json.RawMessage(`"food feature is disabled in settings"`),
			PolicyDenial: "feature_disabled:food",
		})
	}))
	t.Cleanup(bridge.Close)

	var observedStatus int
	var observedOutcome string
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		body := []byte(`{"operation_id":"workouts.groups.list"}`)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
		req.Header.Set("X-Run-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		observedStatus = resp.StatusCode
		observedOutcome = resp.Header.Get("X-MCP-Outcome")
		return envelopeOK(`null`), nil
	}}

	svc, _ := newTestService(t, sp, func(o *Options) { o.BridgeURL = bridge.URL })
	if _, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if observedStatus != http.StatusForbidden {
		t.Errorf("expected 403 from /call on bridge policy denial, got %d", observedStatus)
	}
	if observedOutcome != "proxy_denied" {
		t.Errorf("expected X-MCP-Outcome=proxy_denied for bridge policy denial, got %q", observedOutcome)
	}
}

func TestLoopbackCall_TruncatedResponseSurfacesAsTransportError(t *testing.T) {
	// When the bridge truncates the upstream body at its 10 MB cap, the body
	// is already wrapped as a JSON string; passing it to the script silently
	// would mask partial data as a successful response. The executor must
	// surface this with a dedicated outcome so the helper raises
	// BackendResponseTruncated instead of returning a string where a
	// list/object was expected.
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(proxy.BridgeResponse{
			Status:    http.StatusOK,
			Body:      json.RawMessage(`"<truncated bytes>"`),
			Truncated: true,
		})
	}))
	t.Cleanup(bridge.Close)

	var observedStatus int
	var observedOutcome string
	sp := &fakeSpawner{fn: func(ctx context.Context, payload []byte) ([]byte, error) {
		var p map[string]any
		_ = json.Unmarshal(payload, &p)
		token := p["run_token"].(string)
		proxyURL := p["proxy_url"].(string)

		body := []byte(`{"operation_id":"workouts.groups.list"}`)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, proxyURL, strings.NewReader(string(body)))
		req.Header.Set("X-Run-Token", token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		observedStatus = resp.StatusCode
		observedOutcome = resp.Header.Get("X-MCP-Outcome")
		return envelopeOK(`null`), nil
	}}

	svc, _ := newTestService(t, sp, func(o *Options) { o.BridgeURL = bridge.URL })
	if _, err := svc.Execute(context.Background(), mcp.ExecutionRequest{
		Script:    "x",
		Mode:      proxy.ModeReadOnly,
		TimeoutMS: 5000,
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if observedStatus != http.StatusBadGateway {
		t.Errorf("expected 502 from /call on truncated bridge response, got %d", observedStatus)
	}
	if observedOutcome != "backend_response_truncated" {
		t.Errorf("expected X-MCP-Outcome=backend_response_truncated, got %q", observedOutcome)
	}
}

func TestLoopbackCall_NonPostRejected(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`null`), nil }}
	svc, _ := newTestService(t, sp)

	resp, err := http.Get(svc.ProxyURL())
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected 405 for GET, got %d", resp.StatusCode)
	}
}

// --- Disabled listener variant ---

func TestStart_DisableListener_NoBind(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) { return envelopeOK(`null`), nil }}
	svc, err := New(Options{
		Registry:        buildRegistry(t),
		BridgeURL:       "http://127.0.0.1:1",
		HMACSecret:      "y",
		Spawner:         sp,
		DisableListener: true,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := svc.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = svc.Shutdown(context.Background()) })
	if svc.ProxyURL() != "" {
		t.Errorf("expected empty ProxyURL with disabled listener, got %q", svc.ProxyURL())
	}
	if err := svc.HealthCheck(); err != nil {
		t.Errorf("expected healthy with disabled listener, got %v", err)
	}
}
