package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"time"
)

// elevenLabsSignedURLBase is overridable in tests.
var elevenLabsSignedURLBase = "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url"

// handleElevenLabsSignedURL proxies a signed-URL request to ElevenLabs so the
// API key never reaches the browser. The frontend hands the returned URL to
// the <elevenlabs-convai> widget.
func (s *Server) handleElevenLabsSignedURL(w http.ResponseWriter, r *http.Request) {
	apiKey := os.Getenv("ELEVENLABS_API_KEY")
	agentID := os.Getenv("ELEVENLABS_AGENT_ID")
	if apiKey == "" || agentID == "" {
		http.Error(w, "ElevenLabs agent is not configured", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	q := url.Values{}
	q.Set("agent_id", agentID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, elevenLabsSignedURLBase+"?"+q.Encode(), nil)
	if err != nil {
		slog.Error("elevenlabs: build request", "error", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	req.Header.Set("xi-api-key", apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Error("elevenlabs: request failed", "error", err)
		http.Error(w, "Failed to reach ElevenLabs API", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
		slog.Error("elevenlabs: non-200 response", "status", resp.StatusCode, "body", string(body))
		http.Error(w, "ElevenLabs API request failed", http.StatusBadGateway)
		return
	}

	var payload struct {
		SignedURL string `json:"signed_url"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&payload); err != nil {
		slog.Error("elevenlabs: decode response", "error", err)
		http.Error(w, "Invalid ElevenLabs response", http.StatusBadGateway)
		return
	}
	if payload.SignedURL == "" {
		slog.Error("elevenlabs: empty signed_url in response")
		http.Error(w, "Invalid ElevenLabs response", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(map[string]string{"signed_url": payload.SignedURL}); err != nil {
		slog.Error("encode response", "error", err)
	}
}
