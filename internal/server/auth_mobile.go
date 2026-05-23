//go:build mobile

package server

import (
	"encoding/json"
	"net/http"
)

// tryMobileAuthOverride is the mobile-build hook for handleAuthStatus. The
// mobile binary uses LocalUserResolver: every request is already resolved to
// the local user, there is no cookie, no Telegram, no OIDC. The frontend's
// /auth/status probe must report authenticated:true so app.js skips the login
// screen and reaches /api/bootstrap → firstrun overlay. The !mobile sibling is
// a no-op that lets the cookie/demo path run.
func tryMobileAuthOverride(w http.ResponseWriter) bool {
	response := struct {
		Authenticated bool   `json:"authenticated"`
		Method        string `json:"method,omitempty"`
	}{
		Authenticated: true,
		Method:        "local",
	}
	if err := json.NewEncoder(w).Encode(response); err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
	return true
}
