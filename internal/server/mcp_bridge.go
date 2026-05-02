package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	opregistry "github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

const (
	// bridgeRequestBodyLimit caps the incoming bridge request body (1 MB).
	bridgeRequestBodyLimit = 1 * 1024 * 1024
	// bridgeResponseBodyLimit caps per-call backend response bodies (10 MB).
	bridgeResponseBodyLimit = 10 * 1024 * 1024
	// bridgeBodyLogPreview caps how much of a body is ever included in slog
	// audit lines. Bodies may contain user data; we keep just enough to
	// triage failures.
	bridgeBodyLogPreview = 256
)

// MCPOperation is the bridge's view of a registered operation.
type MCPOperation struct {
	ID         string
	Topic      string
	Method     string
	Path       string
	PathParams []string
	Risk       string
}

// MCPRegistry is satisfied by any type that can look up an operation by ID.
// Tests can provide a mock; production code uses NewRegistryAdapter.
type MCPRegistry interface {
	Get(id string) *MCPOperation
}

// RegistryAdapter wraps *registry.Registry to satisfy MCPRegistry.
type RegistryAdapter struct {
	r *opregistry.Registry
}

// NewRegistryAdapter wraps r so it satisfies the MCPRegistry interface.
func NewRegistryAdapter(r *opregistry.Registry) MCPRegistry {
	return &RegistryAdapter{r: r}
}

// truncateString caps an arbitrary string at maxLen runes for safe inclusion
// in slog audit lines. Used so backend bodies and free-form errors don't dump
// arbitrary payloads into logs.
func truncateString(s string, maxLen int) string {
	if maxLen <= 0 || len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "...(truncated)"
}

// featureKeyForOperation returns the SettingsStore feature key gating the
// given operation, or "" when no gate applies. Mirrors the granular MCP
// tools' ensureFeatureEnabled so that disabling a domain in settings also
// blocks executor scripts that try to call the same registered backend op.
// The "health" topic is split: bp.* and weight.* map to their own flags;
// notes.* (covers diary/sleep/vitals/steps) is foundational and ungated.
func featureKeyForOperation(op *MCPOperation) string {
	if op == nil {
		return ""
	}
	switch op.Topic {
	case "workouts":
		return "workout"
	case "food":
		return "food"
	case "medications":
		return "medication"
	case "health":
		switch {
		case strings.HasPrefix(op.ID, "health.bp."):
			return "bp"
		case strings.HasPrefix(op.ID, "health.weight."):
			return "weight"
		}
	}
	return ""
}

// isFeatureEnabled looks up the SettingsStore flag for the given feature key.
// Keys match the labels accepted by the granular MCP tools' ensureFeatureEnabled.
func isFeatureEnabled(ctx context.Context, settings SettingsStore, feature string) (bool, error) {
	switch feature {
	case "bp":
		return settings.GetBloodPressureEnabled(ctx)
	case "weight":
		return settings.GetWeightEnabled(ctx)
	case "medication":
		return settings.GetMedicationEnabled(ctx)
	case "workout":
		return settings.GetWorkoutEnabled(ctx)
	case "food":
		return settings.GetFoodIntakeEnabled(ctx)
	}
	return true, nil
}

// cappedResponseWriter wraps an in-memory recorder and stops buffering bytes
// once the body crosses “limit“. It still records status, headers, and the
// truncated flag so the outer envelope can mark the body and propagate the
// upstream HTTP code. Without this cap, a backend handler that writes 50 MB
// would buffer all 50 MB in the bot process before truncation runs.
type cappedResponseWriter struct {
	header     http.Header
	buf        bytes.Buffer
	status     int
	wroteCode  bool
	limit      int
	truncated  bool
	totalBytes int
}

func newCappedResponseWriter(limit int) *cappedResponseWriter {
	return &cappedResponseWriter{
		header: http.Header{},
		limit:  limit,
	}
}

func (c *cappedResponseWriter) Header() http.Header { return c.header }

func (c *cappedResponseWriter) WriteHeader(status int) {
	if c.wroteCode {
		return
	}
	c.wroteCode = true
	c.status = status
}

func (c *cappedResponseWriter) Write(p []byte) (int, error) {
	if !c.wroteCode {
		c.WriteHeader(http.StatusOK)
	}
	c.totalBytes += len(p)
	remaining := c.limit - c.buf.Len()
	if remaining <= 0 {
		c.truncated = true
		// Pretend we accepted the full slice so upstream encoders don't error
		// out mid-write; we've already captured the bytes that fit under the
		// cap and flagged truncation.
		return len(p), nil
	}
	if len(p) <= remaining {
		c.buf.Write(p)
		return len(p), nil
	}
	c.buf.Write(p[:remaining])
	c.truncated = true
	return len(p), nil
}

func (c *cappedResponseWriter) Status() int {
	if c.status == 0 {
		return http.StatusOK
	}
	return c.status
}

func (c *cappedResponseWriter) Body() []byte { return c.buf.Bytes() }

// Flush is a no-op required so streaming backend handlers (e.g.
// /api/food/products/search, which type-asserts http.Flusher and 500s
// otherwise) can run through the bridge. Bytes are already captured in
// c.buf as they are written; the bridge replies with the full envelope
// after the handler returns, so there is nothing to flush mid-handler.
func (c *cappedResponseWriter) Flush() {}

// normalizeBridgeBody guarantees the value placed in BridgeResponse.Body is
// valid JSON. Empty bodies become null; truncated and non-JSON bodies are
// wrapped as JSON strings. Without this, json.NewEncoder fails after the
// bridge has already written HTTP 200, swallowing the upstream status.
func normalizeBridgeBody(respBody []byte, truncated bool) json.RawMessage {
	if len(respBody) == 0 {
		return json.RawMessage("null")
	}
	if truncated {
		encoded, _ := json.Marshal(string(respBody))
		return json.RawMessage(encoded)
	}
	if json.Valid(respBody) {
		return json.RawMessage(respBody)
	}
	// Non-JSON body (typically plain-text from http.Error). Wrap so the
	// envelope is always parseable; the upstream Status field still carries
	// the actual HTTP code from the backend.
	encoded, _ := json.Marshal(string(respBody))
	return json.RawMessage(encoded)
}

func (a *RegistryAdapter) Get(id string) *MCPOperation {
	op := a.r.Get(id)
	if op == nil {
		return nil
	}
	return &MCPOperation{
		ID:         op.ID,
		Topic:      op.Topic,
		Method:     op.Method,
		Path:       op.Path,
		PathParams: append([]string(nil), op.PathParams...),
		Risk:       string(op.Risk),
	}
}

// SetMCPRegistry configures the operation registry used by the bridge handler.
func (s *Server) SetMCPRegistry(r MCPRegistry) {
	s.mcpRegistry = r
}

// BridgeRequest is the JSON payload sent by the MCP proxy to the bridge endpoint.
type BridgeRequest struct {
	OperationID string            `json:"operation_id"`
	Params      map[string]string `json:"params,omitempty"`
	PathParams  map[string]string `json:"path_params,omitempty"`
	Body        json.RawMessage   `json:"body,omitempty"`
}

// BridgeResponse is the normalized response envelope returned by the bridge.
//
// PolicyDenial, when non-empty, indicates the bridge rejected the call before
// forwarding it to the backend (e.g. a feature flag is disabled). The executor
// treats this as a proxy-level rejection so the script-side helper raises
// ProxyDenied instead of misclassifying it as a bridge transport error.
type BridgeResponse struct {
	Status        int               `json:"status"`
	Body          json.RawMessage   `json:"body"`
	HeadersSubset map[string]string `json:"headers_subset"`
	DurationMS    int64             `json:"duration_ms"`
	Truncated     bool              `json:"truncated,omitempty"`
	PolicyDenial  string            `json:"policy_denial,omitempty"`
}

// handleMCPBridge is an HMAC-protected internal endpoint that the MCP proxy uses
// to make authenticated backend calls on behalf of the script executor.
// It validates the operation ID against the registry, forwards the call to the
// internal API mux (as the configured allowed user), and returns a normalized
// response envelope.
func (s *Server) handleMCPBridge(w http.ResponseWriter, r *http.Request) {
	if s.mcpAuditSecret == "" {
		http.Error(w, "MCP bridge not configured", http.StatusServiceUnavailable)
		return
	}
	if s.mcpRegistry == nil {
		http.Error(w, "MCP registry not configured", http.StatusServiceUnavailable)
		return
	}
	if s.internalMux == nil {
		http.Error(w, "internal handler not available", http.StatusServiceUnavailable)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, bridgeRequestBodyLimit)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	signature := r.Header.Get("X-Signature")
	if signature == "" {
		http.Error(w, "missing X-Signature header", http.StatusUnauthorized)
		return
	}

	mac := hmac.New(sha256.New, []byte(s.mcpAuditSecret))
	mac.Write(body)
	expectedSig := mac.Sum(nil)
	sigBytes, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(sigBytes, expectedSig) {
		slog.Warn("[Bridge] invalid HMAC signature")
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	var req BridgeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON payload", http.StatusBadRequest)
		return
	}
	if req.OperationID == "" {
		http.Error(w, "operation_id is required", http.StatusBadRequest)
		return
	}

	op := s.mcpRegistry.Get(req.OperationID)
	if op == nil {
		slog.Warn("[Bridge] unknown operation ID", "operation_id", req.OperationID)
		http.Error(w, "unknown operation ID", http.StatusBadRequest)
		return
	}

	// Mirror the feature-gate behavior of the granular MCP tools so that
	// disabling a domain in settings also blocks executor scripts that try
	// to reach the same operations through the registry. Policy denials are
	// returned in envelope form (HTTP 200 + PolicyDenial set) so the proxy
	// and executor can distinguish them from bridge transport failures.
	if feature := featureKeyForOperation(op); feature != "" && s.settings != nil {
		enabled, err := isFeatureEnabled(r.Context(), s.settings, feature)
		if err != nil {
			slog.Error("[Bridge] feature flag lookup failed", "operation_id", req.OperationID, "feature", feature, "error", err)
			http.Error(w, "feature flag lookup failed", http.StatusInternalServerError)
			return
		}
		if !enabled {
			slog.Warn("[Bridge] feature disabled", "operation_id", req.OperationID, "feature", feature)
			msg := fmt.Sprintf("%s feature is disabled in settings", feature)
			encodedMsg, _ := json.Marshal(msg)
			bridgeResp := BridgeResponse{
				Status:        http.StatusForbidden,
				Body:          json.RawMessage(encodedMsg),
				HeadersSubset: map[string]string{"Content-Type": "application/json"},
				DurationMS:    0,
				PolicyDenial:  "feature_disabled:" + feature,
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			if encErr := json.NewEncoder(w).Encode(bridgeResp); encErr != nil {
				slog.Error("[Bridge] encode policy denial", "error", encErr)
			}
			return
		}
	}

	start := time.Now()

	resolvedPath, err := opregistry.SubstitutePath(op.Path, op.PathParams, req.PathParams)
	if err != nil {
		slog.Warn("[Bridge] path_params validation failed", "operation_id", req.OperationID, "error", err)
		http.Error(w, "invalid path_params: "+err.Error(), http.StatusBadRequest)
		return
	}

	internalURL, err := url.Parse(resolvedPath)
	if err != nil {
		slog.Error("[Bridge] invalid operation path", "operation_id", req.OperationID, "path", resolvedPath, "error", err)
		http.Error(w, "invalid operation path", http.StatusInternalServerError)
		return
	}
	q := internalURL.Query()
	for k, v := range req.Params {
		q.Set(k, v)
	}
	internalURL.RawQuery = q.Encode()

	var bodyReader io.Reader
	if len(req.Body) > 0 && string(req.Body) != "null" {
		bodyReader = strings.NewReader(string(req.Body))
	}

	internalReq, err := http.NewRequest(op.Method, internalURL.String(), bodyReader)
	if err != nil {
		slog.Error("[Bridge] failed to build internal request", "error", err)
		http.Error(w, "failed to build internal request", http.StatusInternalServerError)
		return
	}
	if bodyReader != nil {
		internalReq.Header.Set("Content-Type", "application/json")
	}

	// Always execute as the single allowed user; ignore any caller-supplied identity.
	user := &TelegramUser{ID: s.allowedUserID}
	ctx := context.WithValue(r.Context(), UserCtxKey, user)
	internalReq = internalReq.WithContext(ctx)

	rec := newCappedResponseWriter(bridgeResponseBodyLimit)
	s.internalMux.ServeHTTP(rec, internalReq)

	durationMS := time.Since(start).Milliseconds()

	respBody := rec.Body()
	truncated := rec.truncated
	status := rec.Status()

	logFields := []any{
		"operation_id", req.OperationID,
		"risk", op.Risk,
		"status", status,
		"duration_ms", durationMS,
		"truncated", truncated,
	}
	// Add a small body preview only on backend errors, so success paths don't
	// leak user data. Even on errors, the preview is capped and clearly
	// labelled. Bearer tokens / HMAC headers are never logged: the bridge
	// reads the X-Signature header but never includes it in slog fields.
	if status >= 400 {
		logFields = append(logFields, "body_preview", truncateString(string(respBody), bridgeBodyLogPreview))
	}
	slog.Info("[Bridge] proxied operation", logFields...)

	headersSubset := map[string]string{}
	if ct := rec.Header().Get("Content-Type"); ct != "" {
		headersSubset["Content-Type"] = ct
	}

	// Ensure Body is always valid JSON. Backend handlers may return:
	//   - empty bodies (handlers that just call WriteHeader) — encode as null
	//   - plain-text http.Error bodies on 4xx/5xx — encode as a JSON string
	//   - truncated bodies — encode as a JSON string
	// Without normalization, these would make json.NewEncoder fail on the
	// outer envelope after we already wrote HTTP 200, breaking status
	// propagation back to the proxy.
	bodyJSON := normalizeBridgeBody(respBody, truncated)

	bridgeResp := BridgeResponse{
		Status:        status,
		Body:          bodyJSON,
		HeadersSubset: headersSubset,
		DurationMS:    durationMS,
		Truncated:     truncated,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(bridgeResp); err != nil {
		slog.Error("[Bridge] encode response", "error", err)
	}
}
