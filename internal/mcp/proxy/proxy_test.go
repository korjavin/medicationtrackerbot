package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

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
		&registry.Operation{
			ID:              "food.logs.list",
			Topic:           "food",
			Method:          "GET",
			Path:            "/api/food/logs",
			Risk:            registry.RiskRead,
			ResponseSummary: "list of food logs",
			Description:     "list food logs",
		},
	); err != nil {
		t.Fatalf("register: %v", err)
	}
	return r
}

func fakeBridgeServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func successBridge(t *testing.T) *httptest.Server {
	return fakeBridgeServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resp := BridgeResponse{
			Status:        200,
			Body:          json.RawMessage(`{"ok":true}`),
			HeadersSubset: map[string]string{"Content-Type": "application/json"},
			DurationMS:    5,
		}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			t.Errorf("encode bridge response: %v", err)
		}
	})
}

func newProxy(reg *registry.Registry, bridgeURL string) *Proxy {
	return NewWithHTTPClient(reg, bridgeURL, "test-secret", http.DefaultClient)
}

func TestProxy_UnknownOperationRejected(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	_, err := p.Call(context.Background(), RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10}, "nonexistent.op", nil, nil)
	if err == nil {
		t.Fatal("expected error for unknown operation")
	}
	callErr, ok := err.(*CallError)
	if !ok {
		t.Fatalf("expected *CallError, got %T: %v", err, err)
	}
	if callErr.Code != ErrUnknownOperation {
		t.Errorf("expected code %q, got %q", ErrUnknownOperation, callErr.Code)
	}
}

func TestProxy_WriteBlockedInReadOnly(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	_, err := p.Call(context.Background(), RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10}, "workouts.sessions.create", nil, nil)
	if err == nil {
		t.Fatal("expected error for write in read-only mode")
	}
	callErr, ok := err.(*CallError)
	if !ok {
		t.Fatalf("expected *CallError, got %T: %v", err, err)
	}
	if callErr.Code != ErrWriteBlocked {
		t.Errorf("expected code %q, got %q", ErrWriteBlocked, callErr.Code)
	}
}

func TestProxy_WriteAllowedInWriteMode(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	result, err := p.Call(context.Background(), RunConfig{Mode: ModeWrite, MaxAPICalls: 10}, "workouts.sessions.create", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Trace.OperationID != "workouts.sessions.create" {
		t.Errorf("unexpected operation_id: %s", result.Trace.OperationID)
	}
	if result.Trace.Risk != "write" {
		t.Errorf("expected risk=write, got %s", result.Trace.Risk)
	}
}

func TestProxy_MaxCallsEnforced(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	cfg := RunConfig{Mode: ModeReadOnly, MaxAPICalls: 2}

	for i := 0; i < 2; i++ {
		_, err := p.Call(context.Background(), cfg, "workouts.groups.list", nil, nil)
		if err != nil {
			t.Fatalf("call %d unexpectedly failed: %v", i+1, err)
		}
	}

	_, err := p.Call(context.Background(), cfg, "workouts.groups.list", nil, nil)
	if err == nil {
		t.Fatal("expected error after max calls exceeded")
	}
	callErr, ok := err.(*CallError)
	if !ok {
		t.Fatalf("expected *CallError, got %T: %v", err, err)
	}
	if callErr.Code != ErrMaxCallsExceeded {
		t.Errorf("expected code %q, got %q", ErrMaxCallsExceeded, callErr.Code)
	}
}

func TestProxy_TopicAllowlistEnforced(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	cfg := RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10, TopicAllowlist: []string{"workouts"}}

	// workouts topic allowed
	_, err := p.Call(context.Background(), cfg, "workouts.groups.list", nil, nil)
	if err != nil {
		t.Fatalf("expected workouts topic to be allowed: %v", err)
	}

	// food topic not in allowlist
	_, err = p.Call(context.Background(), cfg, "food.logs.list", nil, nil)
	if err == nil {
		t.Fatal("expected error for topic not in allowlist")
	}
	callErr, ok := err.(*CallError)
	if !ok {
		t.Fatalf("expected *CallError, got %T: %v", err, err)
	}
	if callErr.Code != ErrTopicNotAllowed {
		t.Errorf("expected code %q, got %q", ErrTopicNotAllowed, callErr.Code)
	}
}

func TestProxy_TopicAllowlistEmpty_AllTopicsAllowed(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	cfg := RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10, TopicAllowlist: nil}

	_, err := p.Call(context.Background(), cfg, "food.logs.list", nil, nil)
	if err != nil {
		t.Fatalf("expected food topic allowed when allowlist is nil: %v", err)
	}
}

func TestProxy_TraceFieldsPopulated(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	result, err := p.Call(context.Background(), RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10}, "workouts.groups.list", map[string]string{"limit": "5"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Trace.OperationID != "workouts.groups.list" {
		t.Errorf("unexpected operation_id: %s", result.Trace.OperationID)
	}
	if result.Trace.Risk != "read" {
		t.Errorf("expected risk=read, got %s", result.Trace.Risk)
	}
	if result.Trace.Status != 200 {
		t.Errorf("expected status=200, got %d", result.Trace.Status)
	}
	if result.Trace.DurationMS < 0 {
		t.Errorf("negative duration_ms: %d", result.Trace.DurationMS)
	}
	if result.Trace.Error != "" {
		t.Errorf("unexpected error in trace: %s", result.Trace.Error)
	}
	if result.Response == nil {
		t.Fatal("expected non-nil response")
	}
	if result.Response.Status != 200 {
		t.Errorf("expected bridge response status 200, got %d", result.Response.Status)
	}
}

func TestProxy_HMACSignatureForwarded(t *testing.T) {
	reg := buildRegistry(t)
	var capturedSig string
	srv := fakeBridgeServer(t, func(w http.ResponseWriter, r *http.Request) {
		capturedSig = r.Header.Get("X-Signature")
		w.Header().Set("Content-Type", "application/json")
		resp := BridgeResponse{Status: 200, Body: json.RawMessage(`{}`)}
		json.NewEncoder(w).Encode(resp)
	})

	p := NewWithHTTPClient(reg, srv.URL, "my-secret", http.DefaultClient)
	_, err := p.Call(context.Background(), RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10}, "workouts.groups.list", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedSig == "" {
		t.Error("expected X-Signature header to be forwarded")
	}
}

func TestProxy_BridgeNon200_TraceHasError(t *testing.T) {
	reg := buildRegistry(t)
	srv := fakeBridgeServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal server error", http.StatusInternalServerError)
	})

	p := newProxy(reg, srv.URL)
	result, err := p.Call(context.Background(), RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10}, "workouts.groups.list", nil, nil)
	if err != nil {
		t.Fatalf("unexpected transport error: %v", err)
	}
	if result.Trace.Status != 500 {
		t.Errorf("expected status=500, got %d", result.Trace.Status)
	}
	if result.Trace.Error == "" {
		t.Error("expected error in trace for non-200 bridge response")
	}
}

func TestProxy_BridgeNon200_BodyTruncatedInTrace(t *testing.T) {
	reg := buildRegistry(t)
	bigBody := strings.Repeat("X", maxBridgeBodyLogLen*4)
	srv := fakeBridgeServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, bigBody, http.StatusInternalServerError)
	})

	p := newProxy(reg, srv.URL)
	result, err := p.Call(context.Background(), RunConfig{Mode: ModeReadOnly, MaxAPICalls: 10}, "workouts.groups.list", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Trace.Error, "(truncated)") {
		t.Errorf("expected trace error to be truncated, got %q", result.Trace.Error)
	}
	// trace.Error: "bridge returned 500: " + maxBridgeBodyLogLen + "...(truncated)"
	if len(result.Trace.Error) > maxBridgeBodyLogLen+128 {
		t.Errorf("trace error length %d should be bounded near maxBridgeBodyLogLen=%d", len(result.Trace.Error), maxBridgeBodyLogLen)
	}
}

func TestTruncateForLog_ProxyHelper(t *testing.T) {
	if got := truncateForLog("abcd", 100); got != "abcd" {
		t.Errorf("short string passthrough failed: %q", got)
	}
	if got := truncateForLog("abcdefghij", 4); got != "abcd...(truncated)" {
		t.Errorf("expected truncation, got %q", got)
	}
}

func TestProxy_MaxAPICalls_Zero_Unlimited(t *testing.T) {
	reg := buildRegistry(t)
	srv := successBridge(t)

	p := newProxy(reg, srv.URL)
	cfg := RunConfig{Mode: ModeReadOnly, MaxAPICalls: 0} // 0 means unlimited

	for i := 0; i < 5; i++ {
		_, err := p.Call(context.Background(), cfg, "workouts.groups.list", nil, nil)
		if err != nil {
			t.Fatalf("call %d failed (MaxAPICalls=0 should be unlimited): %v", i+1, err)
		}
	}
}
