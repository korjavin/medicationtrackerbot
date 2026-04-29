package proxy

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
	"sync/atomic"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
)

// Mode controls whether write operations are allowed.
type Mode string

const (
	ModeReadOnly Mode = "read_only"
	ModeWrite    Mode = "write"
)

// CallTrace records the outcome of a single proxied operation call.
type CallTrace struct {
	OperationID string `json:"operation_id"`
	Risk        string `json:"risk"`
	Status      int    `json:"status"`
	DurationMS  int64  `json:"duration_ms"`
	Error       string `json:"error,omitempty"`
}

// RunConfig holds per-run constraints for the proxy.
type RunConfig struct {
	Mode           Mode
	MaxAPICalls    int
	TopicAllowlist []string // nil or empty means all topics allowed
}

// BridgeRequest mirrors the shape expected by the backend bridge endpoint.
type BridgeRequest struct {
	OperationID string            `json:"operation_id"`
	Params      map[string]string `json:"params,omitempty"`
	Body        json.RawMessage   `json:"body,omitempty"`
}

// BridgeResponse mirrors the envelope returned by the backend bridge.
type BridgeResponse struct {
	Status        int               `json:"status"`
	Body          json.RawMessage   `json:"body"`
	HeadersSubset map[string]string `json:"headers_subset"`
	DurationMS    int64             `json:"duration_ms"`
	Truncated     bool              `json:"truncated,omitempty"`
}

// CallResult is the full result of a proxy call.
type CallResult struct {
	Trace    CallTrace
	Response *BridgeResponse
}

// Proxy is an in-process component that validates and forwards API calls to the
// backend bridge endpoint on behalf of the script executor.
type Proxy struct {
	reg        *registry.Registry
	bridgeURL  string
	hmacSecret string
	httpClient *http.Client

	callCount atomic.Int64
}

// New creates a Proxy that forwards calls to bridgeURL, signing requests with hmacSecret.
func New(reg *registry.Registry, bridgeURL, hmacSecret string) *Proxy {
	return &Proxy{
		reg:        reg,
		bridgeURL:  bridgeURL,
		hmacSecret: hmacSecret,
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

// NewWithHTTPClient creates a Proxy with a custom HTTP client (useful in tests).
func NewWithHTTPClient(reg *registry.Registry, bridgeURL, hmacSecret string, client *http.Client) *Proxy {
	return &Proxy{
		reg:        reg,
		bridgeURL:  bridgeURL,
		hmacSecret: hmacSecret,
		httpClient: client,
	}
}

// CallError represents a proxy-level rejection before the bridge is contacted.
type CallError struct {
	Code    string
	Message string
}

func (e *CallError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

const (
	ErrUnknownOperation = "unknown_operation"
	ErrWriteBlocked     = "write_blocked"
	ErrMaxCallsExceeded = "max_calls_exceeded"
	ErrTopicNotAllowed  = "topic_not_allowed"
)

// Call performs a single operation call subject to run constraints.
// It returns a CallResult (always populated on success) or a *CallError for
// proxy-level rejections, or a plain error for transport/encoding failures.
func (p *Proxy) Call(ctx context.Context, cfg RunConfig, operationID string, params map[string]string, body json.RawMessage) (*CallResult, error) {
	op := p.reg.Get(operationID)
	if op == nil {
		slog.Warn("[Proxy] unknown operation", "operation_id", operationID)
		return nil, &CallError{Code: ErrUnknownOperation, Message: fmt.Sprintf("operation %q not found in registry", operationID)}
	}

	if cfg.Mode == ModeReadOnly && op.Risk == registry.RiskWrite {
		slog.Warn("[Proxy] write blocked in read-only mode", "operation_id", operationID)
		return nil, &CallError{Code: ErrWriteBlocked, Message: fmt.Sprintf("operation %q is a write operation; write mode required", operationID)}
	}

	if cfg.MaxAPICalls > 0 {
		count := p.callCount.Add(1)
		if int(count) > cfg.MaxAPICalls {
			p.callCount.Add(-1)
			slog.Warn("[Proxy] max API calls exceeded", "operation_id", operationID, "max", cfg.MaxAPICalls, "count", count)
			return nil, &CallError{Code: ErrMaxCallsExceeded, Message: fmt.Sprintf("max API calls (%d) exceeded", cfg.MaxAPICalls)}
		}
	}

	if len(cfg.TopicAllowlist) > 0 {
		allowed := false
		for _, t := range cfg.TopicAllowlist {
			if t == op.Topic {
				allowed = true
				break
			}
		}
		if !allowed {
			p.callCount.Add(-1) // undo the increment
			slog.Warn("[Proxy] topic not in allowlist", "operation_id", operationID, "topic", op.Topic)
			return nil, &CallError{Code: ErrTopicNotAllowed, Message: fmt.Sprintf("topic %q not in allowlist", op.Topic)}
		}
	}

	bridgeReq := BridgeRequest{
		OperationID: operationID,
		Params:      params,
		Body:        body,
	}
	reqBody, err := json.Marshal(bridgeReq)
	if err != nil {
		return nil, fmt.Errorf("marshal bridge request: %w", err)
	}

	sig := sign(reqBody, p.hmacSecret)

	start := time.Now()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.bridgeURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, fmt.Errorf("build HTTP request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Signature", sig)

	resp, err := p.httpClient.Do(httpReq)
	durationMS := time.Since(start).Milliseconds()
	if err != nil {
		trace := CallTrace{
			OperationID: operationID,
			Risk:        string(op.Risk),
			Status:      0,
			DurationMS:  durationMS,
			Error:       err.Error(),
		}
		return &CallResult{Trace: trace}, fmt.Errorf("bridge HTTP call: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read bridge response: %w", err)
	}

	trace := CallTrace{
		OperationID: operationID,
		Risk:        string(op.Risk),
		Status:      resp.StatusCode,
		DurationMS:  durationMS,
	}

	if resp.StatusCode != http.StatusOK {
		trace.Error = fmt.Sprintf("bridge returned %d: %s", resp.StatusCode, string(respBytes))
		slog.Warn("[Proxy] bridge non-200", "operation_id", operationID, "status", resp.StatusCode)
		return &CallResult{Trace: trace}, nil
	}

	var bridgeResp BridgeResponse
	if err := json.Unmarshal(respBytes, &bridgeResp); err != nil {
		return nil, fmt.Errorf("decode bridge response: %w", err)
	}

	slog.Info("[Proxy] call completed",
		"operation_id", operationID,
		"risk", op.Risk,
		"status", bridgeResp.Status,
		"duration_ms", durationMS,
	)

	return &CallResult{Trace: trace, Response: &bridgeResp}, nil
}

// ResetCallCount resets the per-proxy API call counter. Intended for tests.
func (p *Proxy) ResetCallCount() {
	p.callCount.Store(0)
}

func sign(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
