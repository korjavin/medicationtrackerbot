package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
	Method string
	Path   string
	Risk   string
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

func (a *RegistryAdapter) Get(id string) *MCPOperation {
	op := a.r.Get(id)
	if op == nil {
		return nil
	}
	return &MCPOperation{
		Method: op.Method,
		Path:   op.Path,
		Risk:   string(op.Risk),
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
	Body        json.RawMessage   `json:"body,omitempty"`
}

// BridgeResponse is the normalized response envelope returned by the bridge.
type BridgeResponse struct {
	Status        int               `json:"status"`
	Body          json.RawMessage   `json:"body"`
	HeadersSubset map[string]string `json:"headers_subset"`
	DurationMS    int64             `json:"duration_ms"`
	Truncated     bool              `json:"truncated,omitempty"`
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

	start := time.Now()

	internalURL, err := url.Parse(op.Path)
	if err != nil {
		slog.Error("[Bridge] invalid operation path", "operation_id", req.OperationID, "path", op.Path, "error", err)
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

	rec := httptest.NewRecorder()
	s.internalMux.ServeHTTP(rec, internalReq)

	durationMS := time.Since(start).Milliseconds()

	respBody := rec.Body.Bytes()
	truncated := false
	if len(respBody) > bridgeResponseBodyLimit {
		respBody = respBody[:bridgeResponseBodyLimit]
		truncated = true
	}

	logFields := []any{
		"operation_id", req.OperationID,
		"risk", op.Risk,
		"status", rec.Code,
		"duration_ms", durationMS,
		"truncated", truncated,
	}
	// Add a small body preview only on backend errors, so success paths don't
	// leak user data. Even on errors, the preview is capped and clearly
	// labelled. Bearer tokens / HMAC headers are never logged: the bridge
	// reads the X-Signature header but never includes it in slog fields.
	if rec.Code >= 400 {
		logFields = append(logFields, "body_preview", truncateString(string(respBody), bridgeBodyLogPreview))
	}
	slog.Info("[Bridge] proxied operation", logFields...)

	headersSubset := map[string]string{}
	if ct := rec.Header().Get("Content-Type"); ct != "" {
		headersSubset["Content-Type"] = ct
	}

	// Ensure Body is always valid JSON. If truncated, encode as a JSON string so
	// the envelope remains parseable even when the backend response was cut off.
	var bodyJSON json.RawMessage
	if truncated {
		encoded, _ := json.Marshal(string(respBody))
		bodyJSON = json.RawMessage(encoded)
	} else {
		bodyJSON = json.RawMessage(respBody)
	}

	bridgeResp := BridgeResponse{
		Status:        rec.Code,
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
