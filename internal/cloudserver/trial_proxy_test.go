package cloudserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTrialTestHandler mirrors cmd/cloud/main.go's wiring for the trial proxy
// so the tests drive the real subdomain-routing + session + proxy contract.
func newTrialTestHandler(t *testing.T, cfg TrialConfig) (http.Handler, string, string) {
	h, _, host, claimToken := newTrialTestHandlerAPI(t, cfg)
	return h, host, claimToken
}

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

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, ""), trialAPI, host, claimToken
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
		var b strings.Builder
		buf := make([]byte, 64<<10)
		for {
			n, err := r.Body.Read(buf)
			b.Write(buf[:n])
			if err != nil {
				break
			}
		}
		gotBody = b.String()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"content":"parsed"}}]}`))
	}))
	defer upstream.Close()

	cfg := TrialConfig{
		OpenAIAPIKey: trialKey, OpenAIURL: upstream.URL, OpenAIModel: "trial-model",
		VisionAPIKey: visionKey, VisionURL: upstream.URL, VisionModel: "trial-vision-model",
		RatePerMinute: 100,
	}
	h, host, claimToken := newTrialTestHandler(t, cfg)
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
}

func TestTrialProxy_UpstreamErrorSanitized(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":{"message":"bad key sk-trial-secret-key"}}`))
	}))
	defer upstream.Close()

	cfg := TrialConfig{OpenAIAPIKey: "sk-trial-secret-key", OpenAIURL: upstream.URL, OpenAIModel: "m", VisionAPIKey: "sk-trial-secret-key", VisionURL: upstream.URL, VisionModel: "m", RatePerMinute: 100}
	h, host, claimToken := newTrialTestHandler(t, cfg)
	session := registerAndGetSession(t, h, host, claimToken)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want upstream 401 passed through", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "upstream_error") || strings.Contains(rec.Body.String(), "sk-trial") {
		t.Fatalf("upstream error body not sanitized: %q", rec.Body.String())
	}
}

func TestTrialProxy_NotConfigured503(t *testing.T) {
	h, host, claimToken := newTrialTestHandler(t, TrialConfig{RatePerMinute: 100})
	session := registerAndGetSession(t, h, host, claimToken)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, session)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "trial_not_configured") {
		t.Fatalf("body = %q, want trial_not_configured", rec.Body.String())
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
	h2, host2, claimToken2 := newTrialTestHandler(t, TrialConfig{ElevenLabsAPIKey: trialKey, RatePerMinute: 100})
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

func TestTrialProxy_Unauthenticated401(t *testing.T) {
	cfg := TrialConfig{OpenAIAPIKey: "sk-trial", OpenAIURL: "http://unused.invalid", OpenAIModel: "m", RatePerMinute: 100}
	h, host, _ := newTrialTestHandler(t, cfg)

	rec := postTrialChat(h, host, "/api/trial/openai/chat/completions", `{"messages":[]}`, nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
