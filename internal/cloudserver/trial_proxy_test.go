package cloudserver

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTrialTestHandlerAPI mirrors cmd/cloud/main.go's wiring for the trial
// proxy so the tests drive the real subdomain-routing + session + proxy
// contract.
func newTrialTestHandlerAPI(t *testing.T, cfg TrialConfig) (http.Handler, *TrialProxyAPI, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	secret := "test-session-secret-at-least-32-bytes-long"

	webauthnAPI := NewWebAuthnAPI(store, secret)
	trialAPI := NewTrialProxyAPI(store, secret, cfg)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	trialAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), trialAPI, host, claimToken
}

func postTrialChat(h http.Handler, host, path, body string, session *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Host = host
	if session != nil {
		req.AddCookie(session)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTrialProxy_ChatCompletions(t *testing.T) {
	const trialKey = "sk-trial-secret-key"
	const visionKey = "sk-trial-vision-key"

	var gotAuth, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		// Real providers echo the resolved model in the 200 body — the proxy
		// must strip it (SECURITY INVARIANT check below relies on this).
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"model":"trial-model","choices":[{"message":{"content":"parsed"}}]}`))
	}))
	defer upstream.Close()

	cfg := TrialConfig{
		OpenAIAPIKey: trialKey, OpenAIURL: upstream.URL, OpenAIModel: "trial-model",
		VisionAPIKey: visionKey, VisionURL: upstream.URL, VisionModel: "trial-vision-model",
		RatePerMinute: 100,
	}
	h, _, host, claimToken := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claimToken)

	// Text triple: trial key + forced model go upstream, client model ignored.
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions",
		`{"model":"client-picked-model","messages":[{"role":"user","content":"hi"}]}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if gotAuth != "Bearer "+trialKey {
		t.Fatalf("upstream Authorization = %q, want trial key", gotAuth)
	}
	var forwarded map[string]any
	if err := json.Unmarshal([]byte(gotBody), &forwarded); err != nil {
		t.Fatalf("upstream body not JSON: %v", err)
	}
	if forwarded["model"] != "trial-model" {
		t.Fatalf("upstream model = %v, want forced trial-model", forwarded["model"])
	}
	if _, has := forwarded["messages"]; !has {
		t.Fatalf("messages not forwarded: %q", gotBody)
	}
	if !strings.Contains(rec.Body.String(), "parsed") {
		t.Fatalf("upstream response not passed through: %q", rec.Body.String())
	}

	// SECURITY INVARIANT: no trial config in the client response.
	for _, secret := range []string{trialKey, visionKey, "trial-model", upstream.URL} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("trial config %q leaked in response body", secret)
		}
		for name, vals := range rec.Header() {
			if strings.Contains(strings.Join(vals, " "), secret) {
				t.Fatalf("trial config %q leaked in response header %s", secret, name)
			}
		}
	}

	// ?vision=1 selects the vision triple.
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions?vision=1",
		`{"messages":[]}`, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("vision status = %d, body %q", rec.Code, rec.Body.String())
	}
	if gotAuth != "Bearer "+visionKey {
		t.Fatalf("vision upstream Authorization = %q, want vision key", gotAuth)
	}
	if !strings.Contains(gotBody, "trial-vision-model") {
		t.Fatalf("vision model not forced: %q", gotBody)
	}

	// stream:true is rejected.
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions",
		`{"stream":true,"messages":[]}`, session)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("stream:true status = %d, want 400", rec.Code)
	}

	// A JSON null body must 400, not panic (nil-map assignment).
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions", `null`, session)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_json") {
		t.Fatalf("null body: status = %d, body %q, want 400 invalid_json", rec.Code, rec.Body.String())
	}
}

func TestTrialProxy_UpstreamErrorSanitized(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":{"message":"bad key sk-trial-secret-key"}}`))
	}))
	defer upstream.Close()

	cfg := TrialConfig{OpenAIAPIKey: "sk-trial-secret-key", OpenAIURL: upstream.URL, OpenAIModel: "m", VisionAPIKey: "sk-trial-secret-key", VisionURL: upstream.URL, VisionModel: "m", RatePerMinute: 100}
	h, _, host, claimToken := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claimToken)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (upstream status never passed through)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "upstream_error") || strings.Contains(rec.Body.String(), "sk-trial") {
		t.Fatalf("upstream error body not sanitized: %q", rec.Body.String())
	}
}

func TestTrialProxy_NotConfigured503(t *testing.T) {
	h, _, host, claimToken := newTrialTestHandlerAPI(t, TrialConfig{RatePerMinute: 100})
	session := registerAndGetSession(t, h, host, claimToken)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "trial_not_configured") {
		t.Fatalf("body = %q, want trial_not_configured", rec.Body.String())
	}

	// Vision-only key without the master switch (TRIAL_OPENAI_API_KEY) must
	// also 503 — ?vision=1 must not serve while trial AI is off.
	h, _, host, claimToken = newTrialTestHandlerAPI(t, TrialConfig{VisionAPIKey: "sk-vision-only", VisionURL: "http://unused", VisionModel: "m", RatePerMinute: 100})
	session = registerAndGetSession(t, h, host, claimToken)
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions?vision=1", `{"messages":[]}`, session)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "trial_not_configured") {
		t.Fatalf("vision-only: status = %d, body %q, want 503 trial_not_configured", rec.Code, rec.Body.String())
	}
}

func TestTrialProxy_ElevenLabsSignedURL(t *testing.T) {
	const trialKey = "xi-trial-secret-key"
	const agentID = "agent-trial-42"

	var gotAPIKey, gotAgentID string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAPIKey = r.Header.Get("xi-api-key")
		gotAgentID = r.URL.Query().Get("agent_id")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"signed_url":"wss://api.elevenlabs.io/v1/convai/conversation?token=abc"}`))
	}))
	defer upstream.Close()

	cfg := TrialConfig{ElevenLabsAPIKey: trialKey, ElevenLabsAgentID: agentID, RatePerMinute: 100}
	h, trialAPI, host, claimToken := newTrialTestHandlerAPI(t, cfg)
	trialAPI.elevenLabsSignedURLBase = upstream.URL
	session := registerAndGetSession(t, h, host, claimToken)

	req := httptest.NewRequest(http.MethodGet, "/api/trial/elevenlabs/signed-url", nil)
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if gotAPIKey != trialKey {
		t.Fatalf("upstream xi-api-key = %q, want trial key", gotAPIKey)
	}
	if gotAgentID != agentID {
		t.Fatalf("upstream agent_id = %q, want %q", gotAgentID, agentID)
	}
	var payload map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if !strings.HasPrefix(payload["signed_url"], "wss://") {
		t.Fatalf("signed_url = %q", payload["signed_url"])
	}

	// SECURITY INVARIANT: key never reaches the client.
	if strings.Contains(rec.Body.String(), trialKey) {
		t.Fatalf("xi-api-key leaked in response body: %q", rec.Body.String())
	}
	for name, vals := range rec.Header() {
		if strings.Contains(strings.Join(vals, " "), trialKey) {
			t.Fatalf("xi-api-key leaked in response header %s", name)
		}
	}

	// Unconfigured (missing agent ID counts as unconfigured) → 503.
	h2, _, host2, claimToken2 := newTrialTestHandlerAPI(t, TrialConfig{ElevenLabsAPIKey: trialKey, RatePerMinute: 100})
	session2 := registerAndGetSession(t, h2, host2, claimToken2)
	req = httptest.NewRequest(http.MethodGet, "/api/trial/elevenlabs/signed-url", nil)
	req.Host = host2
	req.AddCookie(session2)
	rec = httptest.NewRecorder()
	h2.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "trial_not_configured") {
		t.Fatalf("unconfigured: status = %d, body %q, want 503 trial_not_configured", rec.Code, rec.Body.String())
	}
}

func TestTrialProxy_RateLimit(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[]}`))
	}))
	defer upstream.Close()

	cfg := TrialConfig{OpenAIAPIKey: "sk-trial", OpenAIURL: upstream.URL, OpenAIModel: "m", RatePerMinute: 2}
	store := setupStore(t)
	account1, token1 := setupInvite(t, store)
	account2, token2 := setupInvite(t, store)
	secret := "test-session-secret-at-least-32-bytes-long"

	mux := http.NewServeMux()
	NewWebAuthnAPI(store, secret).RegisterRoutes(mux)
	NewTrialProxyAPI(store, secret, cfg).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	host1 := account1.Subdomain + ".localhost"
	host2 := account2.Subdomain + ".localhost"
	session1 := registerAndGetSession(t, h, host1, token1)
	session2 := registerAndGetSession(t, h, host2, token2)

	for i := 0; i < 2; i++ {
		if rec := postTrialChat(h, host1, "/api/trial/openai/chat/completions", `{"messages":[]}`, session1); rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", i, rec.Code)
		}
	}
	rec := postTrialChat(h, host1, "/api/trial/openai/chat/completions", `{"messages":[]}`, session1)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") != "60" {
		t.Fatalf("Retry-After = %q, want 60", rec.Header().Get("Retry-After"))
	}
	if !strings.Contains(rec.Body.String(), "trial_rate_limit") || !strings.Contains(rec.Body.String(), "retry_after_seconds") {
		t.Fatalf("429 body = %q, want trial_rate_limit contract", rec.Body.String())
	}

	// A different account is unaffected by account1's exhaustion.
	if rec := postTrialChat(h, host2, "/api/trial/openai/chat/completions", `{"messages":[]}`, session2); rec.Code != http.StatusOK {
		t.Fatalf("other account status = %d, want 200, body %q", rec.Code, rec.Body.String())
	}
}

func TestTrialProxy_Unauthenticated401(t *testing.T) {
	cfg := TrialConfig{OpenAIAPIKey: "sk-trial", OpenAIURL: "http://unused.invalid", OpenAIModel: "m", RatePerMinute: 100}
	h, _, host, _ := newTrialTestHandlerAPI(t, cfg)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestTrialConfigFromEnv_TrimsTrailingSlash(t *testing.T) {
	// The proxy concatenates "/chat/completions" onto these; a trailing
	// slash in the env would produce "//" and 404 on strict routers.
	t.Setenv("TRIAL_OPENAI_API_KEY", "sk-test")
	t.Setenv("TRIAL_OPENAI_URL", "https://api.openai.com/v1/")
	t.Setenv("TRIAL_OPENAI_VISION_URL", "https://vision.example/v1//")

	cfg, err := TrialConfigFromEnv()
	if err != nil {
		t.Fatalf("TrialConfigFromEnv: %v", err)
	}
	if cfg.OpenAIURL != "https://api.openai.com/v1" {
		t.Errorf("OpenAIURL = %q, want trailing slash trimmed", cfg.OpenAIURL)
	}
	if cfg.VisionURL != "https://vision.example/v1" {
		t.Errorf("VisionURL = %q, want trailing slashes trimmed", cfg.VisionURL)
	}
}

// TestTrialProxy_ResponseFormatUnsupported pins the med-0s9 root cause: a
// trial model without json_schema support (deepseek-chat, most local models)
// answers 400, and the proxy must name that case rather than flatten it into
// upstream_error — otherwise aiclient.js can never run the fenced-prompt
// retry that bot-mode's internal/ai/openai.go gets for free from the raw body.
func TestTrialProxy_ResponseFormatUnsupported(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"message":"unknown variant response_format json_schema"}}`))
	}))
	defer upstream.Close()

	cfg := TrialConfig{OpenAIAPIKey: "sk-trial", OpenAIURL: upstream.URL, OpenAIModel: "deepseek-chat", VisionAPIKey: "sk-trial", VisionURL: upstream.URL, VisionModel: "m", RatePerMinute: 100}
	h, _, host, claimToken := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claimToken)

	// Carried response_format -> the retryable, named error.
	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[],"response_format":{"type":"json_schema"}}`, session)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	if got["error"] != "response_format_unsupported" {
		t.Errorf("error = %v, want response_format_unsupported", got["error"])
	}
	if got["upstream_status"] != float64(http.StatusBadRequest) {
		t.Errorf("upstream_status = %v, want 400", got["upstream_status"])
	}

	// Same upstream 400 WITHOUT response_format is a plain bad request — it
	// must not masquerade as a retryable json_schema rejection.
	rec = postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session)
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if got["error"] != "upstream_error" {
		t.Errorf("error = %v, want upstream_error (no response_format was sent)", got["error"])
	}
}

// TestTrialProxy_UpstreamStatusRelayed: the proxy still always answers 502,
// but the numeric upstream status rides along in the body so a bad operator
// key (401) is distinguishable from operator quota (429) and an outage (5xx).
// The status is not a TrialConfig field, so this does not widen the invariant.
func TestTrialProxy_UpstreamStatusRelayed(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusInternalServerError} {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			w.Write([]byte(`{"error":{"message":"bad key sk-trial-secret-key"}}`))
		}))

		cfg := TrialConfig{OpenAIAPIKey: "sk-trial-secret-key", OpenAIURL: upstream.URL, OpenAIModel: "m", VisionAPIKey: "sk-trial-secret-key", VisionURL: upstream.URL, VisionModel: "m", RatePerMinute: 100}
		h, _, host, claimToken := newTrialTestHandlerAPI(t, cfg)
		session := registerAndGetSession(t, h, host, claimToken)
		rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session)
		upstream.Close()

		if rec.Code != http.StatusBadGateway {
			t.Errorf("upstream %d: status = %d, want 502 (never passed through)", status, rec.Code)
		}
		var got map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("upstream %d: decode body %q: %v", status, rec.Body.String(), err)
		}
		if got["upstream_status"] != float64(status) {
			t.Errorf("upstream %d: upstream_status = %v", status, got["upstream_status"])
		}
		// SECURITY INVARIANT: the key must never ride out in the relayed body.
		if strings.Contains(rec.Body.String(), "sk-trial") {
			t.Errorf("upstream %d: body leaked the trial key: %q", status, rec.Body.String())
		}
	}
}

// TestTrialProxy_BadUpstreamURLLogs (med-eas.29.3): the one 502 path that
// logged nothing now logs — and must not leak the URL it choked on, since
// http.NewRequestWithContext's error text embeds it verbatim.
func TestTrialProxy_BadUpstreamURLLogs(t *testing.T) {
	var logBuf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	// A control character is what makes http.NewRequestWithContext fail; this
	// is the shape a typo'd TRIAL_OPENAI_URL takes (trailing newline, quotes).
	const badURL = "http://trial-secret-host.example\n/v1"
	cfg := TrialConfig{OpenAIAPIKey: "sk-trial", OpenAIURL: badURL, OpenAIModel: "m", VisionAPIKey: "sk-trial", VisionURL: badURL, VisionModel: "m", RatePerMinute: 100}
	h, _, host, claimToken := newTrialTestHandlerAPI(t, cfg)
	session := registerAndGetSession(t, h, host, claimToken)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "trial chat proxy bad upstream url") {
		t.Fatalf("silent 502: no log line emitted, got %q", logged)
	}
	if strings.Contains(logged, "trial-secret-host") {
		t.Errorf("SECURITY INVARIANT: log leaked the upstream URL: %q", logged)
	}
}

// TestTrialConfigFromEnv_RejectsMalformedURL: catch the operator's typo at
// boot instead of on a user's first AI request. The error names the env var,
// never the value (url.Parse's own error embeds it).
func TestTrialConfigFromEnv_RejectsMalformedURL(t *testing.T) {
	for _, tc := range []struct{ name, url string }{
		{"control character", "https://trial-secret-host.example/v1\n"},
		{"no scheme", "trial-secret-host.example/v1"},
		{"no host", "https:///v1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TRIAL_OPENAI_API_KEY", "sk-test")
			t.Setenv("TRIAL_OPENAI_URL", tc.url)

			_, err := TrialConfigFromEnv()
			if err == nil {
				t.Fatalf("TrialConfigFromEnv() = nil error, want rejection of %q", tc.url)
			}
			if !strings.Contains(err.Error(), "TRIAL_OPENAI_URL") {
				t.Errorf("error %q should name the env var", err)
			}
			if strings.Contains(err.Error(), "trial-secret-host") {
				t.Errorf("SECURITY INVARIANT: error leaked the URL: %q", err)
			}
		})
	}
}
