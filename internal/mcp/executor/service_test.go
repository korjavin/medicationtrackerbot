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
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := proxy.BridgeResponse{
			Status: 200,
			Body:   json.RawMessage(`{"groups":[{"id":1,"name":"a"}]}`),
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
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
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeError("script_error", "ProxyDenied", "write_blocked"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusProxyDenied {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusProxyDenied, res.Status)
	}
}

func TestExecute_BackendErrorMapping(t *testing.T) {
	sp := &fakeSpawner{fn: func(_ context.Context, _ []byte) ([]byte, error) {
		return envelopeError("script_error", "BackendError", "Backend error (500)"), nil
	}}
	svc, _ := newTestService(t, sp)
	res, err := svc.Execute(context.Background(), mcp.ExecutionRequest{Script: "x", TimeoutMS: 1000})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Status != mcp.ExecuteStatusBackendAppError {
		t.Errorf("expected %q, got %q", mcp.ExecuteStatusBackendAppError, res.Status)
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
	// denies it; listener should return 403 so the helper raises ProxyDenied.
	var observedStatus int
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
