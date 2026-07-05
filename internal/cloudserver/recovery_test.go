package cloudserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/descope/virtualwebauthn"
)

// newTestRecoveryHandler mirrors newTestDeviceHandler: wires WebAuthn +
// envelope + recovery routes onto one mux, so the test drives the real
// enroll->set-recovery->redeem->rotate contract end to end.
func newTestRecoveryHandler(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	envelopeAPI := NewEnvelopeAPI(store, "test-session-secret-at-least-32-bytes-long")
	recoveryAPI := NewRecoveryAPI(store)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	envelopeAPI.RegisterRoutes(mux)
	recoveryAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), mux), host, claimToken
}

// setRecoveryVerifier uploads the "recovery" envelope + verifier for the
// session's account through the atomic recovery-material endpoint, mirroring
// signup.js's renderEmergencyKit upload call.
func setRecoveryVerifier(t *testing.T, h http.Handler, host string, session *http.Cookie, verifier []byte) {
	t.Helper()
	body, _ := json.Marshal(recoveryMaterialRequest{
		Envelope: envelopeWire{V: 1, Nonce: []byte("nonce-bytes-1234"), CT: []byte("recovery-ct-bytes"), MAC: []byte("mac-bytes")},
		Verifier: verifier,
	})
	req := httptest.NewRequest(http.MethodPut, "/api/recovery-material", bytes.NewReader(body))
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT /api/recovery-material status = %d, body %q", rec.Code, rec.Body.String())
	}
}

func postRecover(h http.Handler, host string, verifier []byte) *httptest.ResponseRecorder {
	body, _ := json.Marshal(recoveryVerifierRequest{Verifier: verifier})
	req := httptest.NewRequest(http.MethodPost, "/api/recover", bytes.NewReader(body))
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestRecoveryAPI_RedemptionHappyPath guards the recovery contract: a valid
// verifier returns the recovery envelope plus an enrollment token that gates
// a real passkey registration, minting a session the same way device
// transfer does.
func TestRecoveryAPI_RedemptionHappyPath(t *testing.T) {
	h, host, claimToken := newTestRecoveryHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	verifier := []byte("recovery-verifier-bytes")
	setRecoveryVerifier(t, h, host, session, verifier)

	rec := postRecover(h, host, verifier)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/recover status = %d, body %q", rec.Code, rec.Body.String())
	}
	var resp recoverResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal recover response: %v", err)
	}
	if resp.EnrollmentToken == "" || string(resp.Envelope.CT) != "recovery-ct-bytes" {
		t.Fatalf("unexpected recover response: %+v", resp)
	}

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, resp.EnrollmentToken)
	if code != http.StatusOK {
		t.Fatalf("register/begin via recovery enrollment token status = %d, want 200", code)
	}
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	finishRec := finishRegistration(t, h, host, challengeCookie, response)
	if finishRec.Code != http.StatusOK {
		t.Fatalf("register/finish via recovery enrollment token status = %d, body %q", finishRec.Code, finishRec.Body.String())
	}
	sessionSet := false
	for _, c := range finishRec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			sessionSet = true
		}
	}
	if !sessionSet {
		t.Fatalf("no session cookie set on recovery enrollment-token register/finish")
	}
}

// TestRecoveryAPI_RateLimited guards the 5-attempts-per-hour contract: the
// 6th wrong attempt within the window is rejected even though it would
// otherwise still be a "wrong verifier" case.
func TestRecoveryAPI_RateLimited(t *testing.T) {
	h, host, claimToken := newTestRecoveryHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	verifier := []byte("recovery-verifier-bytes")
	setRecoveryVerifier(t, h, host, session, verifier)

	wrong := []byte("wrong-verifier-bytes")
	for i := 0; i < 5; i++ {
		rec := postRecover(h, host, wrong)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("attempt %d status = %d, want 403", i+1, rec.Code)
		}
	}
	rec := postRecover(h, host, wrong)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("6th attempt status = %d, want 429", rec.Code)
	}
	// Even the correct verifier is now rejected until the window clears.
	rec = postRecover(h, host, verifier)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("correct verifier while rate-limited status = %d, want 429", rec.Code)
	}
}

// TestRecoveryAPI_OldVerifierRejectedAfterRotation guards the forced-rotation
// contract: once the recovery code has been redeemed and the verifier
// rotated (SetRecoveryVerifier overwrite, mirroring the client's forced
// rotation step), the old verifier no longer redeems.
func TestRecoveryAPI_OldVerifierRejectedAfterRotation(t *testing.T) {
	h, host, claimToken := newTestRecoveryHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	oldVerifier := []byte("old-recovery-verifier-bytes")
	setRecoveryVerifier(t, h, host, session, oldVerifier)

	rec := postRecover(h, host, oldVerifier)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/recover status = %d, body %q", rec.Code, rec.Body.String())
	}

	// Forced rotation: the client uploads a new verifier for the same
	// account over the still-valid session (established at signup).
	newVerifier := []byte("new-recovery-verifier-bytes")
	setRecoveryVerifier(t, h, host, session, newVerifier)

	rec = postRecover(h, host, oldVerifier)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("redeeming the old (burned) verifier after rotation status = %d, want 403", rec.Code)
	}

	rec = postRecover(h, host, newVerifier)
	if rec.Code != http.StatusOK {
		t.Fatalf("redeeming the new verifier status = %d, want 200, body %q", rec.Code, rec.Body.String())
	}
}
