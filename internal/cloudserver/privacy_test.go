package cloudserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The public privacy policy (bd med-9u3s) is the base host's /privacy, rendered
// from docs/privacy-policy.md under the base host's unchanged strict CSP.
func TestRouter_PrivacyPage(t *testing.T) {
	h := New("app.example.com", setupStore(t), testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	req := httptest.NewRequest(http.MethodGet, "/privacy", nil)
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	if csp, want := rec.Header().Get("Content-Security-Policy"), cspPolicy("connect-src 'self'", ""); csp != want {
		t.Errorf("CSP = %q, want the base default %q", csp, want)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"<h1>MyHealthBot — Privacy Policy</h1>",
		"<h2>8. Your rights, and deleting your data</h2>",
		"<table>",
		"<strong>Your health records are end-to-end encrypted.</strong>",
		`<a href="mailto:dev@myhealthbot.ai">`,
		"Last updated 2026-",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q", want)
		}
	}
	// Repo-relative links would 404 on this host; their text stays, the link goes.
	if strings.Contains(body, `href="cloud-mode.md`) {
		t.Error("relative cloud-mode.md link was not unwrapped")
	}
	if strings.Contains(body, "<script") {
		t.Error("privacy page must not carry script")
	}
}
