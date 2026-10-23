package cloudserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/descope/virtualwebauthn"
)

// beginRegistrationWithEnrollmentToken mirrors beginRegistration but gates on
// an enrollment token (from an approved transfer or recovery slot) instead of
// a signup claim token.
func beginRegistrationWithEnrollmentToken(t *testing.T, h http.Handler, host, enrollmentToken string) (*virtualwebauthn.AttestationOptions, *http.Cookie, int) {
	t.Helper()
	return beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: enrollmentToken})
}

func beginRegistrationWith(t *testing.T, h http.Handler, host string, body registerBeginRequest) (*virtualwebauthn.AttestationOptions, *http.Cookie, int) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", bytes.NewReader(raw))
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		return nil, nil, rec.Code
	}

	opts, err := virtualwebauthn.ParseAttestationOptions(rec.Body.String())
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == challengeCookieName {
			return opts, c, rec.Code
		}
	}
	t.Fatalf("no challenge cookie set")
	return nil, nil, 0
}

// TestWebAuthnRegistration_ViaEnrollmentToken drives the second-device flow
// end to end: an approved transfer slot's token gates a second credential's
// registration in place of the signup claim token, mints a session, and is
// single-use (consumed atomically at register/finish by RedeemTransferToken).
func TestWebAuthnRegistration_ViaEnrollmentToken(t *testing.T) {
	h, store, account, invite := newTestTransferHandlerWithStore(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, invite)
	_, token := driveToApproved(t, h, host, session)

	rec := enrollViaToken(t, h, host, token, testConfN)
	wantCode(t, "register/finish via enrollment token", rec, http.StatusOK)
	sessionSet := false
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			sessionSet = true
		}
	}
	if !sessionSet {
		t.Fatalf("no session cookie set on enrollment-token register/finish")
	}

	creds, err := store.CredentialsByAccount(t.Context(), account.ID)
	if err != nil || len(creds) != 2 {
		t.Fatalf("expected 2 stored credentials (original + transferred device), got %d (%v)", len(creds), err)
	}

	if _, _, reuseCode := beginRegistrationWithEnrollmentToken(t, h, host, token); reuseCode != http.StatusForbidden {
		t.Fatalf("register/begin reusing a redeemed enrollment token status = %d, want 403", reuseCode)
	}
	if _, _, code := beginRegistrationWith(t, h, host, registerBeginRequest{EnrollmentToken: token, ConfN: []byte("short")}); code != http.StatusForbidden {
		t.Fatalf("register/begin with a malformed conf_n = %d, want 403", code)
	}
}
