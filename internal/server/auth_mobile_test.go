//go:build mobile

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// On the mobile build, /auth/status must always report authenticated:true
// with method:"local" — even with no cookie and no demo flag. The mobile
// binary uses LocalUserResolver and has no HTTP-level auth; the embedded
// Capacitor shell is the trust boundary. If this regresses, app.js falls
// through to the Telegram/OIDC login screen and the firstrun overlay never
// fires.
func TestHandleAuthStatus_MobileBuildAlwaysAuthenticated(t *testing.T) {
	srv := &Server{}

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
		t.Errorf("mobile build: expected authenticated=true, got false")
	}
	if got.Method != "local" {
		t.Errorf("mobile build: expected method=local, got %q", got.Method)
	}
}
