package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	opregistry "github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

// mockRegistry implements MCPRegistry for tests.
type mockRegistry struct {
	ops map[string]*MCPOperation
}

func newMockRegistry(ops ...*MCPOperation) *mockRegistry {
	m := &mockRegistry{ops: make(map[string]*MCPOperation)}
	for _, op := range ops {
		m.ops[op.Path] = op // keyed by path here; Get is by ID in the interface
	}
	return m
}

// mockRegistryByID lets tests set up ops by operation ID.
type mockRegistryByID struct {
	ops map[string]*MCPOperation
}

func (m *mockRegistryByID) Get(id string) *MCPOperation {
	return m.ops[id]
}

func newMockRegistryByID(ops map[string]*MCPOperation) *mockRegistryByID {
	return &mockRegistryByID{ops: ops}
}

const testBridgeSecret = "bridge-test-secret"

func signBridgeBody(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// buildBridgeServer returns a Server configured for bridge tests with a fake
// internal mux that records which path was called.
func buildBridgeServer(reg MCPRegistry, internalHandler http.Handler) *Server {
	s := &Server{
		mcpAuditSecret: testBridgeSecret,
		mcpRegistry:    reg,
		internalMux:    internalHandler,
		allowedUserID:  42,
	}
	return s
}

func doPost(t *testing.T, handler http.HandlerFunc, bodyBytes []byte, sig string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/internal/mcp/bridge", bytes.NewReader(bodyBytes))
	if sig != "" {
		req.Header.Set("X-Signature", sig)
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func TestBridge_MissingSecret(t *testing.T) {
	s := &Server{
		mcpAuditSecret: "",
		mcpRegistry:    &mockRegistryByID{},
		internalMux:    http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}),
	}
	rec := doPost(t, s.handleMCPBridge, []byte("{}"), "abc")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
}

func TestBridge_MissingRegistry(t *testing.T) {
	s := &Server{
		mcpAuditSecret: testBridgeSecret,
		mcpRegistry:    nil,
		internalMux:    http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}),
	}
	body := []byte("{}")
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
}

func TestBridge_MissingSignatureHeader(t *testing.T) {
	reg := newMockRegistryByID(nil)
	s := buildBridgeServer(reg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	body := []byte(`{"operation_id":"test.op"}`)
	rec := doPost(t, s.handleMCPBridge, body, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestBridge_InvalidSignature(t *testing.T) {
	reg := newMockRegistryByID(nil)
	s := buildBridgeServer(reg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	body := []byte(`{"operation_id":"test.op"}`)
	rec := doPost(t, s.handleMCPBridge, body, "deadbeef")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestBridge_UnknownOperationID(t *testing.T) {
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"known.op": {Method: "GET", Path: "/api/known", Risk: "read"},
	})
	s := buildBridgeServer(reg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	body, _ := json.Marshal(BridgeRequest{OperationID: "unknown.op"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestBridge_IdentityCannotBeSpoofed(t *testing.T) {
	var capturedUserID int64
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, ok := r.Context().Value(UserCtxKey).(*TelegramUser); ok {
			capturedUserID = u.ID
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})

	reg := newMockRegistryByID(map[string]*MCPOperation{
		"test.get": {Method: "GET", Path: "/api/test", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)
	s.allowedUserID = 99

	body, _ := json.Marshal(BridgeRequest{OperationID: "test.get"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if capturedUserID != 99 {
		t.Errorf("expected user ID 99, got %d", capturedUserID)
	}
}

func TestBridge_NormalizedEnvelopeShape(t *testing.T) {
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"result":"ok"}`))
	})

	reg := newMockRegistryByID(map[string]*MCPOperation{
		"test.op": {Method: "GET", Path: "/api/test", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "test.op"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp BridgeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON envelope: %v", err)
	}
	if resp.Status != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.Status)
	}
	if resp.DurationMS < 0 {
		t.Errorf("negative duration_ms: %d", resp.DurationMS)
	}
	if resp.HeadersSubset["Content-Type"] != "application/json" {
		t.Errorf("expected Content-Type in headers_subset, got %v", resp.HeadersSubset)
	}
	if string(resp.Body) != `{"result":"ok"}` {
		t.Errorf("unexpected body: %s", resp.Body)
	}
}

func TestBridge_QueryParamsForwarded(t *testing.T) {
	var capturedQuery string
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	})

	reg := newMockRegistryByID(map[string]*MCPOperation{
		"workout.groups.list": {Method: "GET", Path: "/api/workout/groups", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	reqBody, _ := json.Marshal(BridgeRequest{
		OperationID: "workout.groups.list",
		Params:      map[string]string{"limit": "10"},
	})
	rec := doPost(t, s.handleMCPBridge, reqBody, signBridgeBody(reqBody, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(capturedQuery, "limit=10") {
		t.Errorf("expected limit=10 in query, got %q", capturedQuery)
	}
}

func TestBridge_ResponseBodyTruncation(t *testing.T) {
	bigBody := strings.Repeat("x", bridgeResponseBodyLimit+100)
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, bigBody)
	})

	reg := newMockRegistryByID(map[string]*MCPOperation{
		"test.big": {Method: "GET", Path: "/api/big", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "test.big"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp BridgeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	if !resp.Truncated {
		t.Error("expected Truncated=true")
	}
	// Body is encoded as a JSON string when truncated; it must be valid JSON.
	var decoded string
	if err := json.Unmarshal(resp.Body, &decoded); err != nil {
		t.Errorf("truncated body is not valid JSON string: %v", err)
	}
	if len(decoded) != bridgeResponseBodyLimit {
		t.Errorf("truncated body length mismatch: got %d, want %d", len(decoded), bridgeResponseBodyLimit)
	}
}

func TestBridge_RequestBodySizeLimit(t *testing.T) {
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"test.op": {Method: "GET", Path: "/api/test", Risk: "read"},
	})
	s := buildBridgeServer(reg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	// Build an oversized raw request (not just the JSON body field, but the whole HTTP body)
	oversized := make([]byte, bridgeRequestBodyLimit+1)
	for i := range oversized {
		oversized[i] = 'a'
	}

	req := httptest.NewRequest(http.MethodPost, "/internal/mcp/bridge", bytes.NewReader(oversized))
	req.Header.Set("X-Signature", signBridgeBody(oversized, testBridgeSecret))
	rec := httptest.NewRecorder()
	s.handleMCPBridge(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on oversized request, got %d", rec.Code)
	}
}

func TestBridge_AuditFieldsLogged(t *testing.T) {
	// This test verifies the bridge runs without panicking when slog produces audit output.
	// Full log field verification would require a custom slog handler; here we just
	// confirm a successful call completes with the expected HTTP status.
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"test.audit": {Method: "GET", Path: "/api/test", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "test.audit"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestNewRegistryAdapter(t *testing.T) {
	r := opregistry.New()
	if err := r.Register(&opregistry.Operation{
		ID:              "test.adapter",
		Topic:           "test",
		Method:          "GET",
		Path:            "/api/test",
		Risk:            opregistry.RiskRead,
		ResponseSummary: "test response",
		Description:     "test description",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	adapter := NewRegistryAdapter(r)

	op := adapter.Get("test.adapter")
	if op == nil {
		t.Fatal("expected operation, got nil")
	}
	if op.Method != "GET" || op.Path != "/api/test" || op.Risk != "read" {
		t.Errorf("unexpected operation fields: %+v", op)
	}
	if op2 := adapter.Get("nonexistent"); op2 != nil {
		t.Error("expected nil for nonexistent operation ID")
	}
}

func TestBridge_SuccessLogOmitsBodyPreview(t *testing.T) {
	// Capture slog so we can verify success paths never log a body preview.
	var logBuf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"sensitive":"value"}`))
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"safe.op": {Method: "GET", Path: "/api/safe", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "safe.op"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	out := logBuf.String()
	if strings.Contains(out, "sensitive") {
		t.Errorf("success log must not include response body preview, got: %s", out)
	}
	if !strings.Contains(out, `"operation_id":"safe.op"`) {
		t.Errorf("expected operation_id in slog, got: %s", out)
	}
}

func TestBridge_ErrorLogIncludesTruncatedPreview(t *testing.T) {
	var logBuf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	bigErr := strings.Repeat("E", bridgeBodyLogPreview*4)
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, bigErr, http.StatusInternalServerError)
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"err.op": {Method: "GET", Path: "/api/err", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "err.op"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 envelope status, got %d", rec.Code)
	}
	out := logBuf.String()
	if !strings.Contains(out, "body_preview") {
		t.Errorf("error log should include body_preview, got: %s", out)
	}
	if !strings.Contains(out, "(truncated)") {
		t.Errorf("body preview should be truncated, got: %s", out)
	}
}

func TestBridge_HMACSignatureNotLogged(t *testing.T) {
	var logBuf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"sig.op": {Method: "GET", Path: "/api/sig", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "sig.op"})
	sig := signBridgeBody(body, testBridgeSecret)
	rec := doPost(t, s.handleMCPBridge, body, sig)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	out := logBuf.String()
	if strings.Contains(out, sig) {
		t.Errorf("slog must not include the HMAC signature, got: %s", out)
	}
	if strings.Contains(out, "X-Signature") {
		t.Errorf("slog must not log X-Signature header, got: %s", out)
	}
}

func TestTruncateString_BridgeHelper(t *testing.T) {
	if got := truncateString("hello", 100); got != "hello" {
		t.Errorf("short string passthrough failed: %q", got)
	}
	if got := truncateString("hello world", 5); got != "hello...(truncated)" {
		t.Errorf("expected truncation, got %q", got)
	}
	if got := truncateString("any", 0); got != "any" {
		t.Errorf("non-positive maxLen should pass through, got %q", got)
	}
}

func TestBridge_ContextCancellation(t *testing.T) {
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"test.op": {Method: "GET", Path: "/api/test", Risk: "read"},
	})
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "test.op"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	req := httptest.NewRequest(http.MethodPost, "/internal/mcp/bridge", bytes.NewReader(body))
	req = req.WithContext(ctx)
	req.Header.Set("X-Signature", signBridgeBody(body, testBridgeSecret))
	rec := httptest.NewRecorder()
	// Should not panic even with a cancelled context
	s.handleMCPBridge(rec, req)
}
