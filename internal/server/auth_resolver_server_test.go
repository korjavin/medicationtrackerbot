//go:build !mobile

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewDefaultResolver_DemoModeBypassesAuth(t *testing.T) {
	// With DEMO_MODE on, newDefaultResolver returns a DemoUserResolver that
	// ignores headers/cookies and resolves every request to the configured
	// allowedUserID. A request carrying no auth at all must reach the inner
	// handler with the demo user in context — the public-demo contract.
	srv := &Server{
		allowedUserID: 99,
		demoMode:      true,
	}
	mw := AuthMiddleware(newDefaultResolver(srv))

	var seen *TelegramUser
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, ok := r.Context().Value(UserCtxKey).(*TelegramUser); ok {
			seen = u
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("demo on: expected 200, got %d", w.Code)
	}
	if seen == nil {
		t.Fatal("demo on: expected demo user in ctx, got nil")
	}
	if seen.ID != 99 {
		t.Errorf("demo on: expected user ID 99, got %d", seen.ID)
	}
	if seen.FirstName != "Demo" {
		t.Errorf("demo on: expected FirstName=Demo, got %q", seen.FirstName)
	}
}

func TestNewDefaultResolver_DemoOffRequiresAuth(t *testing.T) {
	// With DEMO_MODE off, newDefaultResolver returns the production
	// Telegram+OIDC resolver. A request with no headers must 401 — the same
	// auth boundary as production.
	srv := &Server{
		botToken:      "test-bot-token",   // #nosec G101
		sessionSecret: "test-session-sec", // #nosec G101
		allowedUserID: 99,
		demoMode:      false,
	}
	mw := AuthMiddleware(newDefaultResolver(srv))

	called := false
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if called {
		t.Error("demo off: expected inner handler NOT to be called when no auth provided")
	}
	if w.Code != http.StatusUnauthorized {
		t.Errorf("demo off: expected 401, got %d", w.Code)
	}
}
