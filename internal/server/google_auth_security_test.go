package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/oauth2"
)

// SECURITY RED TEST: oidc-callback-nil-pointer-panic
// This test is intentionally FAILING — it documents a security vulnerability.
// It will pass once the underlying code is fixed.
// Vulnerability: Nil pointer panic in OIDC callback is a Denial-of-Service vulnerability that crashes the server and exposes stack traces.
// An attacker can trigger this by requesting the callback endpoint without initiating the full OIDC flow.
// This is CRITICAL for a self-hosted health application where server availability directly impacts user access to medications and health data.
func TestOIDCCallbackMissingStateCookieNilPointerPanic(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Configure OIDC to enable the callback handler
	srv.oauthConfig = &oauth2.Config{
		ClientID:     "test-client-id",
		ClientSecret: "test-secret",
		RedirectURL:  "http://localhost:8080/auth/google/callback",
	}
	srv.oidcUserInfo = "https://www.googleapis.com/oauth2/v2/userinfo"

	// Craft a malicious request: OIDC callback with code and state parameters
	// but WITHOUT the 'oauthstate' cookie that should have been set during login initiation
	req := httptest.NewRequest(
		"GET",
		"/auth/google/callback?code=fake-auth-code&state=fake-state",
		nil,
	)
	w := httptest.NewRecorder()

	// SECURITY ASSERTION: The handler should return HTTP 400 Bad Request or similar error
	// instead of causing a nil pointer panic that crashes the server.
	// Current vulnerable code ignores the Cookie() error:
	//   oauthState, _ := r.Cookie("oauthstate")
	// Then accesses oauthState.Value without checking if oauthState is nil.
	// This will panic with: "panic: runtime error: invalid memory address or nil pointer dereference"
	//
	// The fix should check the cookie error:
	//   oauthState, err := r.Cookie("oauthstate")
	//   if err != nil {
	//       http.Error(w, "missing or invalid oauth state", http.StatusBadRequest)
	//       return
	//   }
	srv.handleOIDCCallback(w, req)

	// We assert that the response is NOT a 500 panic
	// and the server does NOT crash. A properly handled error should be 400 or 401.
	if w.Code >= 500 {
		t.Errorf("SECURITY FAILURE: Callback handler returned status %d (potential panic or crash). "+
			"Expected HTTP 400 or 401 when oauthstate cookie is missing. "+
			"Response body: %s", w.Code, w.Body.String())
	}

	// Verify a sensible error response (4xx, not 5xx or panic)
	if w.Code < 400 || w.Code >= 500 {
		t.Errorf("SECURITY FAILURE: Callback handler returned status %d. "+
			"Expected 4xx error (bad request, unauthorized, etc.). "+
			"Got: %d %s. Response: %s", w.Code, w.Code, http.StatusText(w.Code), w.Body.String())
	}
}

// SECURITY RED TEST: oidc-callback-state-mismatch
// Verify that mismatched state values are rejected safely
func TestOIDCCallbackStateMismatch(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Configure OIDC
	srv.oauthConfig = &oauth2.Config{
		ClientID:     "test-client-id",
		ClientSecret: "test-secret",
		RedirectURL:  "http://localhost:8080/auth/google/callback",
	}
	srv.oidcUserInfo = "https://www.googleapis.com/oauth2/v2/userinfo"

	// Set up request with the correct cookie but mismatched state parameter
	req := httptest.NewRequest(
		"GET",
		"/auth/google/callback?code=fake-code&state=attacker-injected-state",
		nil,
	)

	// Simulate a valid login session by setting the oauthstate cookie
	// This represents a legitimate user who started the login flow
	req.AddCookie(&http.Cookie{
		Name:  "oauthstate",
		Value: "legitimate-user-state",
	})

	w := httptest.NewRecorder()
	srv.handleOIDCCallback(w, req)

	// Assert that mismatched state is rejected (should return 401 Unauthorized)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("SECURITY FAILURE: State mismatch not rejected properly. "+
			"Expected HTTP 401 Unauthorized, got %d %s. Response: %s",
			w.Code, http.StatusText(w.Code), w.Body.String())
	}
}
