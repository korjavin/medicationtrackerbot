package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"
)

// Trial proxy limits: body cap sits above the 8 MiB photo cap aiclient.js
// enforces (base64 overhead + prompt), timeout matches aiclient.js's 90s.
const (
	maxTrialBodyBytes   = 12 << 20 // 12 MiB
	trialUpstreamTimout = 90 * time.Second
)

// TrialProxyAPI serves the operator-trial proxy routes (docs/cloud-mode.md →
// Trial provider keys). The trial key/URL/model live only server-side; the
// client sends the same OpenAI-compatible body it would send browser-direct
// and gets the upstream JSON back. SECURITY INVARIANT: nothing from the
// TrialConfig may appear in a response body, header, or log line.
type TrialProxyAPI struct {
	cfg           TrialConfig
	store         sessionStore
	sessionSecret string
	limiter       *rateLimiter
	client        *http.Client
	// elevenLabsSignedURLBase is overridable in tests.
	elevenLabsSignedURLBase string
}

// NewTrialProxyAPI builds the trial proxy handlers.
func NewTrialProxyAPI(store sessionStore, sessionSecret string, cfg TrialConfig) *TrialProxyAPI {
	perMin := cfg.RatePerMinute
	if perMin <= 0 {
		perMin = trialDefaultRatePerMin
	}
	return &TrialProxyAPI{
		cfg:                     cfg,
		store:                   store,
		sessionSecret:           sessionSecret,
		limiter:                 newRateLimiter(perMin, time.Minute),
		client:                  &http.Client{Timeout: trialUpstreamTimout},
		elevenLabsSignedURLBase: "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url",
	}
}

// RegisterRoutes adds the trial proxy routes to mux. RequireSession gives 401
// on unauthenticated requests and guarantees AccountFromContext downstream.
func (a *TrialProxyAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/trial/openai/chat/completions", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.ChatCompletions)))
	mux.Handle("GET /api/trial/elevenlabs/signed-url", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.ElevenLabsSignedURL)))
}

// rateLimit enforces the shared per-account trial limit (one limiter across
// all trial routes). On limit it writes the 429 contract (mirrors demo-mode's
// shape so existing frontend 429 handling applies) and returns false.
func (a *TrialProxyAPI) rateLimit(w http.ResponseWriter, accountID string) bool {
	if a.limiter.Allow(accountID) {
		return true
	}
	slog.Info("trial rate limited", "account", accountID)
	w.Header().Set("Retry-After", "60")
	writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "trial_rate_limit", "retry_after_seconds": 60})
	return false
}

// ElevenLabsSignedURL mints a conversation signed URL for the operator's
// shared trial agent, keeping the xi-api-key server-side (mirrors bot-mode
// internal/server.handleElevenLabsSignedURL, reimplemented here because
// cloudserver must not import internal/server).
func (a *TrialProxyAPI) ElevenLabsSignedURL(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !a.cfg.TrialVoiceConfigured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return
	}
	if !a.rateLimit(w, account.ID) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		a.elevenLabsSignedURLBase+"?agent_id="+url.QueryEscape(a.cfg.ElevenLabsAgentID), nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	req.Header.Set("xi-api-key", a.cfg.ElevenLabsAPIKey)

	resp, err := a.client.Do(req)
	if err != nil {
		slog.Warn("trial elevenlabs mint upstream failed", "account", account.ID)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	defer resp.Body.Close()
	slog.Info("trial elevenlabs mint", "account", account.ID, "status", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	var payload struct {
		SignedURL string `json:"signed_url"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&payload); err != nil || payload.SignedURL == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"signed_url": payload.SignedURL})
}

// ChatCompletions proxies an OpenAI-compatible chat request to the trial
// provider, forcing the operator's model so clients can't pick one.
func (a *TrialProxyAPI) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	key, baseURL, model := a.cfg.OpenAIAPIKey, a.cfg.OpenAIURL, a.cfg.OpenAIModel
	if r.URL.Query().Get("vision") == "1" {
		key, baseURL, model = a.cfg.VisionAPIKey, a.cfg.VisionURL, a.cfg.VisionModel
	}
	if key == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return
	}
	if !a.rateLimit(w, account.ID) {
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxTrialBodyBytes+1))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	if len(body) > maxTrialBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
		return
	}

	// Decode to force the model and reject streaming; RawMessage keeps every
	// other field byte-identical to what the client sent.
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	var stream bool
	if raw, has := payload["stream"]; has && json.Unmarshal(raw, &stream) == nil && stream {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "streaming_not_supported"})
		return
	}
	modelJSON, _ := json.Marshal(model)
	payload["model"] = modelJSON
	upstreamBody, err := json.Marshal(payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), trialUpstreamTimout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(upstreamBody))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")

	resp, err := a.client.Do(req)
	if err != nil {
		slog.Warn("trial chat proxy upstream failed", "account", account.ID)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	defer resp.Body.Close()
	slog.Info("trial chat proxy", "account", account.ID, "status", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		// Upstream error bodies can echo request auth context — sanitize.
		writeJSON(w, resp.StatusCode, map[string]string{"error": "upstream_error"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, resp.Body)
}
