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
// an enrollment token (from a claimed transfer slot) instead of a signup
// claim token.
func beginRegistrationWithEnrollmentToken(t *testing.T, h http.Handler, host, enrollmentToken string) (*virtualwebauthn.AttestationOptions, *http.Cookie, int) {
	t.Helper()
	body, _ := json.Marshal(registerBeginRequest{EnrollmentToken: enrollmentToken})
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", bytes.NewReader(body))
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
// end to end: an already-enrolled account opens a transfer slot, the slot is
// claimed (rotating in a fresh enrollment token), and that token gates a
// second credential's registration in place of the signup claim token. Reuse
// of the same enrollment token must fail — it is single-use, consumed
// atomically at register/finish (RedeemTransferToken).
func TestWebAuthnRegistration_ViaEnrollmentToken(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	transferAPI := NewTransferAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	transferAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), mux)

	session := registerAndGetSession(t, h, host, claimToken)

	createBody, _ := json.Marshal(createTransferRequest{CT: []byte("dek-ciphertext-bytes")})
	createReq := httptest.NewRequest(http.MethodPost, "/api/transfer", bytes.NewReader(createBody))
	createReq.Host = host
	createReq.AddCookie(session)
	createRec := httptest.NewRecorder()
	h.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("POST /api/transfer status = %d, body %q", createRec.Code, createRec.Body.String())
	}
	var created createTransferResponse
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}

	claimReq := httptest.NewRequest(http.MethodPost, "/api/transfer/"+created.SlotID+"/claim", nil)
	claimReq.Host = host
	claimRec := httptest.NewRecorder()
	h.ServeHTTP(claimRec, claimReq)
	if claimRec.Code != http.StatusOK {
		t.Fatalf("claim status = %d, body %q", claimRec.Code, claimRec.Body.String())
	}
	var claimed claimTransferResponse
	if err := json.Unmarshal(claimRec.Body.Bytes(), &claimed); err != nil {
		t.Fatalf("unmarshal claim response: %v", err)
	}

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, claimed.EnrollmentToken)
	if code != http.StatusOK {
		t.Fatalf("register/begin via enrollment token status = %d, want 200", code)
	}

	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	rec := finishRegistration(t, h, host, challengeCookie, response)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/finish via enrollment token status = %d, body %q", rec.Code, rec.Body.String())
	}

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
	if err != nil {
		t.Fatalf("CredentialsByAccount: %v", err)
	}
	if len(creds) != 2 {
		t.Fatalf("expected 2 stored credentials (original + transferred device), got %d", len(creds))
	}

	// Reuse of the same enrollment token must fail — RedeemTransferToken
	// deleted the slot on the first successful finish.
	_, _, reuseCode := beginRegistrationWithEnrollmentToken(t, h, host, claimed.EnrollmentToken)
	if reuseCode != http.StatusForbidden {
		t.Fatalf("register/begin reusing a redeemed enrollment token status = %d, want 403", reuseCode)
	}
}
