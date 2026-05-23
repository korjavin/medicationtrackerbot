//go:build !mobile

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// These tests cover the server-build /auth/status contract: the cookie/demo
// path. The mobile build short-circuits before the cookie/demo logic via
// tryMobileAuthOverride in auth_mobile.go; that path has its own test in
// auth_mobile_test.go. Keeping these gated to !mobile avoids running them in
// a configuration where the mobile hook deliberately overrides the response.

func TestHandleAuthStatus_DemoModeReportsAuthenticated(t *testing.T) {
	// With DEMO_MODE on, /auth/status must report authenticated=true even with
	// no session cookie — otherwise the frontend checkAuth() flow falls through
	// to the Telegram/OIDC login screen and a public demo visitor never reaches
	// /api/bootstrap.
	srv := &Server{demoMode: true}

	req := httptest.NewRequest(http.MethodGet, "/auth/status", nil)
	w := httptest.NewRecorder()
	srv.handleAuthStatus(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var got struct {
		Authenticated bool   `json:"authenticated"`
		Method        string `json:"method"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Authenticated {
		t.Errorf("demo on: expected authenticated=true, got false")
	}
	if got.Method != "demo" {
		t.Errorf("demo on: expected method=demo, got %q", got.Method)
	}
}

func TestHandleAuthStatus_DemoModeOffNoCookieReportsUnauthenticated(t *testing.T) {
	// With DEMO_MODE off and no cookie, /auth/status reports authenticated=false
	// — the existing production contract that gates the login screen.
	srv := &Server{demoMode: false, sessionSecret: "test-session-sec"} // #nosec G101

	req := httptest.NewRequest(http.MethodGet, "/auth/status", nil)
	w := httptest.NewRecorder()
	srv.handleAuthStatus(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	var got struct {
		Authenticated bool   `json:"authenticated"`
		Method        string `json:"method"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Authenticated {
		t.Errorf("demo off, no cookie: expected authenticated=false, got true")
	}
}

func TestAuthStatus(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	t.Run("unauthenticated without cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/auth/status", nil)
		w := httptest.NewRecorder()

		srv.Routes().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		var payload struct {
			Authenticated bool   `json:"authenticated"`
			Method        string `json:"method"`
		}
		if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if payload.Authenticated {
			t.Fatalf("expected unauthenticated response, got %+v", payload)
		}
	})

	t.Run("authenticated with valid cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/auth/status", nil)
		req.AddCookie(&http.Cookie{
			Name:  "auth_session",
			Value: createSessionToken("admin@example.com", srv.sessionSecret),
		})
		w := httptest.NewRecorder()

		srv.Routes().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		var payload struct {
			Authenticated bool   `json:"authenticated"`
			Method        string `json:"method"`
		}
		if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if !payload.Authenticated || payload.Method != "cookie" {
			t.Fatalf("expected authenticated cookie response, got %+v", payload)
		}
	})
}
