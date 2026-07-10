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
	// budget persists the daily spend caps (bd med-d5t.5). Nil disables them,
	// which is what the older two-arg constructor leaves behind for tests that
	// only exercise the proxy's upstream behavior.
	budget trialBudgetStore
	client *http.Client
	// elevenLabsSignedURLBase is overridable in tests.
	elevenLabsSignedURLBase string
}

// trialBudgetStore is the one method the daily budgets need.
type trialBudgetStore interface {
	ConsumeTrialRequest(ctx context.Context, accountID string, now time.Time, perAccountLimit, globalLimit int) (bool, string, error)
}

// NewTrialProxyAPI builds the trial proxy handlers. cfg.RatePerMinute must be
// positive — TrialConfigFromEnv guarantees it.
func NewTrialProxyAPI(store sessionStore, sessionSecret string, cfg TrialConfig) *TrialProxyAPI {
	api := &TrialProxyAPI{
		cfg:                     cfg,
		store:                   store,
		sessionSecret:           sessionSecret,
		limiter:                 newRateLimiter(cfg.RatePerMinute, time.Minute),
		client:                  &http.Client{Timeout: trialUpstreamTimout},
		elevenLabsSignedURLBase: "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url",
	}
	// The session store is the cloudstore repo in production, which also owns
	// the persisted counters. Tests pass narrower fakes and simply run unmetered.
	if b, ok := store.(trialBudgetStore); ok {
		api.budget = b
	}
	return api
}

// consumeBudget enforces the persisted daily spend caps on the operator's own
// provider key. Fails CLOSED: a database error refuses the call rather than
// waving it through, because the thing on the other side of this check is a bill.
//
// The response names the scope (`account` vs `global`) and when it resets, and
// carries its own error code rather than overloading trial_rate_limit — "wait a
// minute" and "the shared budget is gone until tomorrow" want different actions
// from the user, and the client renders them differently.
func (a *TrialProxyAPI) consumeBudget(w http.ResponseWriter, r *http.Request, accountID string) bool {
	if a.budget == nil || (a.cfg.DailyPerAccount <= 0 && a.cfg.DailyGlobal <= 0) {
		return true
	}
	now := time.Now().UTC()
	allowed, scope, err := a.budget.ConsumeTrialRequest(r.Context(), accountID, now, a.cfg.DailyPerAccount, a.cfg.DailyGlobal)
	if err != nil {
		slog.Error("trial budget check failed", "account", accountID, "error", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "trial_budget_unavailable"})
		return false
	}
	if allowed {
		return true
	}
	resetsAt := now.Truncate(24 * time.Hour).Add(24 * time.Hour)
	slog.Warn("trial daily budget exhausted", "account", accountID, "scope", scope)
	writeJSON(w, http.StatusTooManyRequests, map[string]any{
		"error":     "trial_budget_exhausted",
		"scope":     scope,
		"resets_at": resetsAt.Format(time.RFC3339),
	})
	return false
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
		// SECURITY INVARIANT: err embeds the URL — log a fixed string only.
		slog.Warn("trial elevenlabs mint bad upstream url", "account", account.ID)
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

	// Master switch: gate both triples on TrialAIConfigured, not the
	// per-triple key — a vision-only TRIAL_OPENAI_VISION_API_KEY must not
	// serve while the operator believes trial AI is off (no meta flag).
	if !a.cfg.TrialAIConfigured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "trial_not_configured"})
		return
	}
	key, baseURL, model := a.cfg.OpenAIAPIKey, a.cfg.OpenAIURL, a.cfg.OpenAIModel
	if r.URL.Query().Get("vision") == "1" {
		key, baseURL, model = a.cfg.VisionAPIKey, a.cfg.VisionURL, a.cfg.VisionModel
	}
	if !a.rateLimit(w, account.ID) {
		return
	}
	// After the burst limiter, before any upstream call: this is the spend gate.
	if !a.consumeBudget(w, r, account.ID) {
		return
	}

	// cmd/cloud's http.Server deadlines (15s read / 45s write) would kill the
	// slow vision path before the 90s upstream timeout — extend both for this
	// route. Best effort: unsupported writers (tests) just keep the defaults.
	rc := http.NewResponseController(w)
	deadline := time.Now().Add(trialUpstreamTimout + 15*time.Second)
	_ = rc.SetReadDeadline(deadline)
	_ = rc.SetWriteDeadline(deadline)

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
	// A JSON `null` body unmarshals successfully into a nil map — reject it
	// too, or payload["model"] below panics.
	if err := json.Unmarshal(body, &payload); err != nil || payload == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	var stream bool
	if raw, has := payload["stream"]; has && json.Unmarshal(raw, &stream) == nil && stream {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "streaming_not_supported"})
		return
	}
	_, sentResponseFormat := payload["response_format"]
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
		// Only reachable with a malformed TRIAL_OPENAI_URL, which
		// TrialConfigFromEnv now rejects at boot — but a 502 that logs nothing
		// cost three rounds of diagnosis once, so never again.
		// SECURITY INVARIANT: err embeds the URL — log a fixed string only.
		slog.Warn("trial chat proxy bad upstream url", "account", account.ID, "vision", baseURL == a.cfg.VisionURL)
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
		// Always 502 (never the upstream status): 503 must stay reserved
		// for trial_not_configured and 429 for our own rate limiter, or the
		// client misreads a transient upstream outage as "add your own key".
		// The numeric status is not a TrialConfig field, so relaying it in the
		// body is safe — and it is the only thing that tells a 401 (bad
		// operator key) from a 429 (operator quota) from a 5xx (outage).
		//
		// A 400 answering a request that carried response_format means the
		// operator's model has no json_schema support (deepseek-chat, most
		// local models). Name that case so the client can retry with the
		// fenced prompt, exactly as the BYO path already does. Keyed off the
		// status plus what we sent — never the body text, which every
		// provider words differently and which we must not read back anyway.
		errCode := "upstream_error"
		if resp.StatusCode == http.StatusBadRequest && sentResponseFormat {
			errCode = "response_format_unsupported"
		}
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": errCode, "upstream_status": resp.StatusCode})
		return
	}
	// SECURITY INVARIANT: the upstream 200 echoes the forced trial model in
	// its top-level "model" field — strip it before relaying.
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxTrialBodyBytes))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(respBody, &out); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	delete(out, "model")
	sanitized, err := json.Marshal(out)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_error"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(sanitized)
}
