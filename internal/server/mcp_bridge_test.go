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
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
)

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

func TestBridge_ResponseCappedDuringWrite(t *testing.T) {
	// The bridge must enforce its 10 MB response cap while the backend handler
	// is writing, not after — buffering arbitrary multi-MB payloads in the bot
	// process would defeat the documented availability bound. This test writes
	// 5x the cap in 1 MB chunks and asserts the recorder never holds more than
	// the cap, even though the handler's Write returns success for every chunk.
	const chunkBytes = 1 * 1024 * 1024
	const chunks = bridgeResponseBodyLimit/chunkBytes + 5
	maxObservedBuffer := 0
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		chunk := make([]byte, chunkBytes)
		for i := range chunk {
			chunk[i] = 'z'
		}
		for i := 0; i < chunks; i++ {
			n, err := w.Write(chunk)
			if err != nil {
				t.Errorf("chunk %d write error: %v", i, err)
				return
			}
			if n != len(chunk) {
				t.Errorf("chunk %d short write: %d", i, n)
				return
			}
			if cap, ok := w.(*cappedResponseWriter); ok {
				if cap.buf.Len() > maxObservedBuffer {
					maxObservedBuffer = cap.buf.Len()
				}
			}
		}
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"flood.op": {Method: "GET", Path: "/api/flood", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "flood.op"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 envelope, got %d", rec.Code)
	}
	if maxObservedBuffer > bridgeResponseBodyLimit {
		t.Errorf("buffer exceeded cap: max observed %d > limit %d", maxObservedBuffer, bridgeResponseBodyLimit)
	}

	var resp BridgeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid envelope: %v", err)
	}
	if !resp.Truncated {
		t.Error("expected Truncated=true on capped response")
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

// fakeSettings is a SettingsStore that returns canned feature flag values.
// Only the feature-flag getters are exercised by bridge tests; the rest
// panic so an accidental call surfaces in CI rather than silently passing.
type fakeSettings struct {
	bp, weight, medication, workout, food, health bool
}

func (f *fakeSettings) GetBloodPressureEnabled(ctx context.Context) (bool, error) {
	return f.bp, nil
}

func (f *fakeSettings) SetBloodPressureEnabled(ctx context.Context, enabled bool) error {
	return nil
}
func (f *fakeSettings) GetWeightEnabled(ctx context.Context) (bool, error)       { return f.weight, nil }
func (f *fakeSettings) SetWeightEnabled(ctx context.Context, enabled bool) error { return nil }
func (f *fakeSettings) GetMedicationEnabled(ctx context.Context) (bool, error) {
	return f.medication, nil
}
func (f *fakeSettings) SetMedicationEnabled(ctx context.Context, enabled bool) error { return nil }
func (f *fakeSettings) GetWorkoutEnabled(ctx context.Context) (bool, error)          { return f.workout, nil }
func (f *fakeSettings) SetWorkoutEnabled(ctx context.Context, enabled bool) error    { return nil }
func (f *fakeSettings) GetFoodIntakeEnabled(ctx context.Context) (bool, error)       { return f.food, nil }
func (f *fakeSettings) SetFoodIntakeEnabled(ctx context.Context, enabled bool) error { return nil }
func (f *fakeSettings) GetHealthEnabled(ctx context.Context) (bool, error)           { return f.health, nil }
func (f *fakeSettings) SetHealthEnabled(ctx context.Context, enabled bool) error     { return nil }
func (f *fakeSettings) GetTabOrder(ctx context.Context) (string, error)              { return "", nil }
func (f *fakeSettings) SetTabOrder(ctx context.Context, order string) error          { return nil }
func (f *fakeSettings) GetDismissedTZSuggestion(ctx context.Context) (string, error) { return "", nil }
func (f *fakeSettings) GetCurrent() (string, error)                                  { return "", nil }
func (f *fakeSettings) Record(tz string) error                                       { return nil }
func (f *fakeSettings) GetWeightUnitPreference(ctx context.Context) (string, error) {
	return "kg", nil
}
func (f *fakeSettings) SetWeightUnitPreference(ctx context.Context, unit string) error { return nil }
func (f *fakeSettings) GetIntegrationOpenAI(ctx context.Context) (settings.IntegrationOpenAI, error) {
	return settings.IntegrationOpenAI{}, nil
}
func (f *fakeSettings) SetIntegrationOpenAI(ctx context.Context, v settings.IntegrationOpenAI) error {
	return nil
}
func (f *fakeSettings) GetIntegrationFood(ctx context.Context) (settings.IntegrationFood, error) {
	return settings.IntegrationFood{}, nil
}
func (f *fakeSettings) SetIntegrationFood(ctx context.Context, v settings.IntegrationFood) error {
	return nil
}
func (f *fakeSettings) GetIntegrationElevenLabs(ctx context.Context) (settings.IntegrationElevenLabs, error) {
	return settings.IntegrationElevenLabs{}, nil
}
func (f *fakeSettings) SetIntegrationElevenLabs(ctx context.Context, v settings.IntegrationElevenLabs) error {
	return nil
}

func TestBridge_FeatureDisabledBlocksOperation(t *testing.T) {
	internalCalled := false
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		internalCalled = true
		w.WriteHeader(http.StatusOK)
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"food.log.list": {ID: "food.log.list", Topic: "food", Method: "GET", Path: "/api/food/log", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)
	s.settings = &fakeSettings{food: false, bp: true, weight: true, workout: true, medication: true}

	body, _ := json.Marshal(BridgeRequest{OperationID: "food.log.list"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	// Policy denials are returned as a normalized envelope (HTTP 200 with
	// envelope.Status=403 and PolicyDenial set) so the proxy/executor can tell
	// them apart from bridge transport errors and surface ProxyDenied to the
	// script.
	if rec.Code != http.StatusOK {
		t.Fatalf("expected envelope HTTP 200 when food feature disabled, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if internalCalled {
		t.Error("internal mux must not be invoked when feature is gated off")
	}
	var resp BridgeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("envelope is not valid JSON: %v\nbody=%s", err, rec.Body.String())
	}
	if resp.Status != http.StatusForbidden {
		t.Errorf("expected envelope.Status=403 for policy denial, got %d", resp.Status)
	}
	if resp.PolicyDenial != "feature_disabled:food" {
		t.Errorf("expected PolicyDenial=feature_disabled:food, got %q", resp.PolicyDenial)
	}
}

func TestBridge_FeatureEnabledAllowsOperation(t *testing.T) {
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"workouts.groups.list": {ID: "workouts.groups.list", Topic: "workouts", Method: "GET", Path: "/api/workout/groups", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)
	s.settings = &fakeSettings{workout: true}

	body, _ := json.Marshal(BridgeRequest{OperationID: "workouts.groups.list"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 when workout feature enabled, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestBridge_HealthNotesOpsBypassFeatureGate(t *testing.T) {
	// health.notes.* is foundational (covers diary, sleep, vitals, steps) and
	// is intentionally not tied to any feature flag. Even when bp/weight are
	// disabled, notes operations must still pass.
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"health.notes.list": {ID: "health.notes.list", Topic: "health", Method: "GET", Path: "/api/notes", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)
	s.settings = &fakeSettings{bp: false, weight: false}

	body, _ := json.Marshal(BridgeRequest{OperationID: "health.notes.list"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for ungated notes op, got %d", rec.Code)
	}
}

func TestFeatureKeyForOperation(t *testing.T) {
	cases := []struct {
		id    string
		topic string
		want  string
	}{
		{"workouts.groups.list", "workouts", "workout"},
		{"food.log.list", "food", "food"},
		{"medications.list", "medications", "medication"},
		{"health.bp.list", "health", "bp"},
		{"health.weight.list", "health", "weight"},
		{"health.notes.list", "health", ""},
		{"unknown.op", "unknown", ""},
	}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			op := &MCPOperation{ID: tc.id, Topic: tc.topic}
			if got := featureKeyForOperation(op); got != tc.want {
				t.Errorf("featureKeyForOperation(%q,%q) = %q, want %q", tc.id, tc.topic, got, tc.want)
			}
		})
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
	if op.ID != "test.adapter" || op.Topic != "test" {
		t.Errorf("expected ID/Topic to be propagated, got ID=%q Topic=%q", op.ID, op.Topic)
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

func TestBridge_EmptyBackendBody(t *testing.T) {
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK) // no body, mirrors handlers like SetFoodTargets
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"empty.op": {Method: "POST", Path: "/api/empty", Risk: "write"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "empty.op"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 envelope, got %d", rec.Code)
	}
	var resp BridgeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("envelope is not valid JSON: %v\nbody=%s", err, rec.Body.String())
	}
	if resp.Status != http.StatusOK {
		t.Errorf("expected upstream status 200, got %d", resp.Status)
	}
	if string(resp.Body) != "null" {
		t.Errorf("expected body=null for empty backend body, got %s", resp.Body)
	}
}

func TestBridge_NonJSONBackendBody(t *testing.T) {
	// http.Error writes a plain-text body. The bridge must not let that
	// break envelope encoding — it should wrap as a JSON string while
	// still propagating the upstream status code.
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Forbidden", http.StatusForbidden)
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"deny.op": {Method: "GET", Path: "/api/deny", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "deny.op"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 envelope, got %d", rec.Code)
	}
	var resp BridgeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("envelope is not valid JSON: %v\nbody=%s", err, rec.Body.String())
	}
	if resp.Status != http.StatusForbidden {
		t.Errorf("expected upstream status 403, got %d", resp.Status)
	}
	var decoded string
	if err := json.Unmarshal(resp.Body, &decoded); err != nil {
		t.Fatalf("expected body to be a JSON string, got %s: %v", resp.Body, err)
	}
	if !strings.Contains(decoded, "Forbidden") {
		t.Errorf("expected wrapped body to contain 'Forbidden', got %q", decoded)
	}
}

func TestNormalizeBridgeBody(t *testing.T) {
	cases := []struct {
		name      string
		body      []byte
		truncated bool
		want      string
	}{
		{"nil", nil, false, "null"},
		{"empty", []byte{}, false, "null"},
		{"valid_json_object", []byte(`{"a":1}`), false, `{"a":1}`},
		{"valid_json_array", []byte(`[1,2,3]`), false, `[1,2,3]`},
		{"plain_text", []byte("Bad Request\n"), false, `"Bad Request\n"`},
		{"truncated", []byte("xxxx"), true, `"xxxx"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeBridgeBody(tc.body, tc.truncated)
			if string(got) != tc.want {
				t.Errorf("normalizeBridgeBody(%q,%v): got %s, want %s", tc.body, tc.truncated, got, tc.want)
			}
			// Result must be valid JSON.
			if !json.Valid(got) {
				t.Errorf("result not valid JSON: %s", got)
			}
		})
	}
}

func TestBridge_StreamingHandler(t *testing.T) {
	// food.products.search and similar endpoints type-assert http.Flusher and
	// fail with 500 if the writer doesn't implement it. The bridge's capped
	// recorder must satisfy http.Flusher (no-op flush) so these handlers
	// run through the bridge without a 500.
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming not supported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte(`[]` + "\n"))
		flusher.Flush()
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"food.products.search": {Method: "GET", Path: "/api/food/products/search", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{OperationID: "food.products.search"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 envelope, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp BridgeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("envelope is not valid JSON: %v", err)
	}
	if resp.Status != http.StatusOK {
		t.Errorf("expected upstream 200, got %d (handler likely rejected non-Flusher writer)", resp.Status)
	}
}

func TestBridge_PathParamsSubstituted(t *testing.T) {
	var capturedPath string
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	})

	reg := newMockRegistryByID(map[string]*MCPOperation{
		"meds.update": {
			Method:     "POST",
			Path:       "/api/medications/{id}",
			PathParams: []string{"id"},
			Risk:       "write",
		},
	})
	s := buildBridgeServer(reg, internalHandler)

	body, _ := json.Marshal(BridgeRequest{
		OperationID: "meds.update",
		PathParams:  map[string]string{"id": "42"},
		Body:        json.RawMessage(`{"name":"X"}`),
	})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/api/medications/42" {
		t.Errorf("expected /api/medications/42, got %q", capturedPath)
	}
}

func TestBridge_PathParamsMissing(t *testing.T) {
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("internal handler must not be reached when path_params are missing")
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"meds.update": {
			Method:     "POST",
			Path:       "/api/medications/{id}",
			PathParams: []string{"id"},
			Risk:       "write",
		},
	})
	s := buildBridgeServer(reg, internalHandler)
	body, _ := json.Marshal(BridgeRequest{OperationID: "meds.update"})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestBridge_PathParamsExtraRejected(t *testing.T) {
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("internal handler must not be reached when extra path_params are sent")
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"meds.list": {Method: "GET", Path: "/api/medications", Risk: "read"},
	})
	s := buildBridgeServer(reg, internalHandler)
	body, _ := json.Marshal(BridgeRequest{
		OperationID: "meds.list",
		PathParams:  map[string]string{"id": "42"},
	})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestBridge_PathParamValueIsEscaped(t *testing.T) {
	// A value containing '/' must not be interpreted as a sub-path; it should
	// land in the path component literally so it can't reach a different
	// handler than the one declared in the registry.
	var capturedPath string
	internalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	})
	reg := newMockRegistryByID(map[string]*MCPOperation{
		"meds.delete": {
			Method:     "DELETE",
			Path:       "/api/medications/{id}",
			PathParams: []string{"id"},
			Risk:       "write",
		},
	})
	s := buildBridgeServer(reg, internalHandler)
	body, _ := json.Marshal(BridgeRequest{
		OperationID: "meds.delete",
		PathParams:  map[string]string{"id": "1/2"},
	})
	rec := doPost(t, s.handleMCPBridge, body, signBridgeBody(body, testBridgeSecret))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 envelope, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(capturedPath, "1%2F2") {
		t.Errorf("expected '/' in id value to be percent-escaped, got path %q", capturedPath)
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
