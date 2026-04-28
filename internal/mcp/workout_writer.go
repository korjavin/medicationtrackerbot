package mcp

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// WorkoutWriter sends HMAC-signed workout_log requests to the main bot's HTTP
// API and returns the bot's response body verbatim. The MCP tool handler
// passes that body through to the agent so it can act on per-exercise statuses
// without having the writer re-shape the response.
type WorkoutWriter struct {
	endpoint string
	secret   string
	client   *http.Client
}

// NewWorkoutWriter creates a WorkoutWriter with a 15-second timeout, matching
// the food writer's deadline.
func NewWorkoutWriter(endpoint, secret string) *WorkoutWriter {
	return &WorkoutWriter{
		endpoint: endpoint,
		secret:   secret,
		client:   &http.Client{Timeout: 15 * time.Second},
	}
}

// Call posts the JSON-encodable payload to the bot's workout-log endpoint and
// returns the raw response body. Application-level errors (ambiguous match,
// missing defaults, partial success) are returned with a nil error so the
// caller can hand the body to the agent verbatim. Transport, signing, and
// non-2xx HTTP errors are returned via the error return.
func (ww *WorkoutWriter) Call(ctx context.Context, payload any) (json.RawMessage, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("workout_writer: marshal payload: %w", err)
	}

	mac := hmac.New(sha256.New, []byte(ww.secret))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ww.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("workout_writer: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", sig)

	resp, err := ww.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("workout_writer: request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("workout_writer: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("workout_writer: unexpected status %d: %s",
			resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	return json.RawMessage(respBody), nil
}
