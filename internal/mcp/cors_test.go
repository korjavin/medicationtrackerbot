package mcp

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeNext is a stub handler that records whether it was called.
type fakeNext struct {
	called bool
	status int
	body   string
}

func (f *fakeNext) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.called = true
	status := f.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if f.body != "" {
		_, _ = io.WriteString(w, f.body)
	}
}

func TestCORSMiddleware_PreflightAllowedOrigin(t *testing.T) {
	next := &fakeNext{}
	h := CORSMiddleware("https://app.example.com", next)

	req := httptest.NewRequest(http.MethodOptions, "/mcp", nil)
	req.Header.Set("Origin", "https://app.example.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rr.Code)
	}
	if next.called {
		t.Fatal("preflight should short-circuit; next handler must not be called")
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("Allow-Origin = %q, want https://app.example.com", got)
	}
	if got := rr.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "POST") {
		t.Errorf("Allow-Methods missing POST: %q", got)
	}
	if got := rr.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") || !strings.Contains(got, "Mcp-Session-Id") {
		t.Errorf("Allow-Headers missing required values: %q", got)
	}
	if got := rr.Header().Get("Access-Control-Max-Age"); got != "600" {
		t.Errorf("Max-Age = %q, want 600", got)
	}
	if got := rr.Header().Get("Vary"); got != "Origin" {
		t.Errorf("Vary = %q, want Origin", got)
	}
}

func TestCORSMiddleware_PreflightDisallowedOrigin(t *testing.T) {
	next := &fakeNext{}
	h := CORSMiddleware("https://app.example.com", next)

	req := httptest.NewRequest(http.MethodOptions, "/mcp", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rr.Code)
	}
	if next.called {
		t.Fatal("disallowed-origin preflight should not call next handler")
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin must not get Allow-Origin header, got %q", got)
	}
}

func TestCORSMiddleware_ActualRequestAllowedOrigin(t *testing.T) {
	next := &fakeNext{body: "ok"}
	h := CORSMiddleware("https://app.example.com", next)

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0"}`))
	req.Header.Set("Origin", "https://app.example.com")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if !next.called {
		t.Fatal("actual request must reach next handler")
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("Allow-Origin = %q, want https://app.example.com", got)
	}
	if rr.Body.String() != "ok" {
		t.Errorf("body = %q, want ok", rr.Body.String())
	}
}

func TestCORSMiddleware_ActualRequestDisallowedOrigin(t *testing.T) {
	next := &fakeNext{body: "ok"}
	h := CORSMiddleware("https://app.example.com", next)

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0"}`))
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	// Non-preflight calls still pass through; the browser blocks the response.
	if !next.called {
		t.Fatal("non-preflight request must still reach next handler")
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin must not get Allow-Origin header, got %q", got)
	}
}

func TestCORSMiddleware_EmptyAllowedOriginDisablesCORS(t *testing.T) {
	next := &fakeNext{body: "ok"}
	h := CORSMiddleware("", next)

	// Preflight passes straight through to next (which would normally 405).
	req := httptest.NewRequest(http.MethodOptions, "/mcp", nil)
	req.Header.Set("Origin", "https://app.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if !next.called {
		t.Fatal("empty AppDomain must pass preflight through to next handler")
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("empty AppDomain must not write CORS headers, got %q", got)
	}
}

func TestCORSMiddleware_AllowedOriginTrailingSlashNormalized(t *testing.T) {
	// APP_DOMAIN configured with a trailing slash must still match the
	// browser's Origin header (which never carries one).
	next := &fakeNext{body: "ok"}
	h := CORSMiddleware("https://app.example.com/", next)

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://app.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if !next.called {
		t.Fatal("trailing-slash origin must still match and pass through")
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("Allow-Origin = %q, want https://app.example.com (no trailing slash)", got)
	}
}

func TestCORSMiddleware_NoOriginHeader(t *testing.T) {
	next := &fakeNext{body: "ok"}
	h := CORSMiddleware("https://app.example.com", next)

	// Same-origin or non-browser caller: no Origin header.
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0"}`))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if !next.called {
		t.Fatal("request without Origin must pass through")
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("no Origin must not get Allow-Origin header, got %q", got)
	}
}

// TestCORSMiddleware_IntegratedWithOAuthValidToken hits the full CORS + OAuth
// stack with a valid mcp_ API token from the allowed origin and verifies both
// the OAuth check succeeds (inner handler runs, returns 200) and the CORS
// Allow-Origin header is on the response.
func TestCORSMiddleware_IntegratedWithOAuthValidToken(t *testing.T) {
	const validToken = "mcp_validtoken1234567890"

	cfg := &Config{
		MCPServerURL:   "https://mcp.example.com",
		AllowedSubject: "",
	}
	tokenStore := newFakeStoreWithToken(validToken, "elevenlabs-voice-session", 7)
	oauth := NewOAuthHandler(cfg, tokenStore)
	t.Cleanup(oauth.Close)

	innerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		innerCalled = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	})
	stack := CORSMiddleware("https://app.example.com", oauth.Middleware(inner))

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call"}`))
	req.Header.Set("Origin", "https://app.example.com")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+validToken)
	rr := httptest.NewRecorder()
	stack.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%q)", rr.Code, rr.Body.String())
	}
	if !innerCalled {
		t.Fatal("inner handler must run for authorized request")
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("Allow-Origin on success = %q, want https://app.example.com", got)
	}
	if got := rr.Header().Get("Vary"); got != "Origin" {
		t.Errorf("Vary = %q, want Origin", got)
	}
	if len(tokenStore.touchedIDs) != 1 || tokenStore.touchedIDs[0] != 7 {
		t.Errorf("expected token 7 to be touched, got %v", tokenStore.touchedIDs)
	}
}

// TestCORSMiddleware_IntegratedWithOAuth verifies CORS sits in front of OAuth:
// (a) OPTIONS preflight from the allowed origin succeeds with 204 even without
//     an Authorization header (OAuth is bypassed for preflight).
// (b) An actual POST without a token from the allowed origin is rejected by
//     OAuth as 401, and CORS headers are still present on that 401 so the
//     browser surface the response status to JS.
func TestCORSMiddleware_IntegratedWithOAuth(t *testing.T) {
	cfg := &Config{
		MCPServerURL:   "https://mcp.example.com",
		AllowedSubject: "test-user",
	}
	oauth := NewOAuthHandler(cfg, nil)
	t.Cleanup(oauth.Close)

	innerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	stack := CORSMiddleware("https://app.example.com", oauth.Middleware(inner))

	// (a) Preflight from allowed origin: 204, no OAuth challenge.
	preflight := httptest.NewRequest(http.MethodOptions, "/mcp", nil)
	preflight.Header.Set("Origin", "https://app.example.com")
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	pr := httptest.NewRecorder()
	stack.ServeHTTP(pr, preflight)

	if pr.Code != http.StatusNoContent {
		t.Fatalf("preflight: expected 204, got %d (body=%q)", pr.Code, pr.Body.String())
	}
	if innerCalled {
		t.Fatal("preflight must not reach inner handler")
	}
	if got := pr.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("preflight Allow-Origin = %q", got)
	}

	// (b) Actual POST without Authorization: OAuth rejects with 401, but CORS
	// headers are still applied so the browser sees the status code.
	post := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{}`))
	post.Header.Set("Origin", "https://app.example.com")
	post.Header.Set("Content-Type", "application/json")
	pw := httptest.NewRecorder()
	stack.ServeHTTP(pw, post)

	if pw.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 from OAuth, got %d", pw.Code)
	}
	if innerCalled {
		t.Fatal("missing token must not reach inner handler")
	}
	if got := pw.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("Allow-Origin on 401 = %q, want https://app.example.com", got)
	}
}
