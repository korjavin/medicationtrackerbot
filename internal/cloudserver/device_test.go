package cloudserver

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/descope/virtualwebauthn"
)

// newTestDeviceHandler mirrors cmd/cloud/main.go's wiring for the WebAuthn +
// transfer + device routes, so the test drives the real
// enroll->transfer->claim->revoke contract end to end.
func newTestDeviceHandler(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	transferAPI := NewTransferAPI(store, "test-session-secret-at-least-32-bytes-long")
	deviceAPI := NewDeviceAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	transferAPI.RegisterRoutes(mux)
	deviceAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux), host, claimToken
}

// enrollSecondDevice drives the device-transfer + enrollment-token
// registration ceremony (Task 2/3/4) to add a second credential to the
// account behind session, returning its own session cookie.
func enrollSecondDevice(t *testing.T, h http.Handler, host string, session *http.Cookie) *http.Cookie {
	t.Helper()

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
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			return c
		}
	}
	t.Fatalf("no session cookie set on second-device register/finish")
	return nil
}

// TestDeviceAPI_RevocationCascade guards the security-relevant cleanup: after
// revoking a device, its credential and envelope are gone, and its own
// session token — minted before the revocation — is rejected on every
// subsequent request (RequireSession's CredentialExists check).
func TestDeviceAPI_RevocationCascade(t *testing.T) {
	h, host, claimToken := newTestDeviceHandler(t)
	firstSession := registerAndGetSession(t, h, host, claimToken)
	secondSession := enrollSecondDevice(t, h, host, firstSession)

	listReq := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	listReq.Host = host
	listReq.AddCookie(firstSession)
	listRec := httptest.NewRecorder()
	h.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET /api/devices status = %d, body %q", listRec.Code, listRec.Body.String())
	}
	var devices []deviceListItem
	if err := json.Unmarshal(listRec.Body.Bytes(), &devices); err != nil {
		t.Fatalf("unmarshal devices: %v", err)
	}
	if len(devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(devices))
	}

	// Find the second device's credential_id — the one whose session we're
	// about to revoke.
	var secondCredentialID string
	for _, d := range devices {
		if d.Envelope == nil {
			t.Fatalf("device %+v missing envelope", d)
		}
		if _, err := base64.RawURLEncoding.DecodeString(d.CredentialID); err != nil {
			t.Fatalf("credential_id not valid base64url: %v", err)
		}
	}
	// Identify the second device by asserting with its session first, then
	// revoking whichever credential is NOT the first session's.
	_, firstCredID, ok := VerifySessionToken(firstSession.Value, "test-session-secret-at-least-32-bytes-long")
	if !ok {
		t.Fatalf("could not verify first session token")
	}
	firstCredentialRef := base64.RawURLEncoding.EncodeToString(firstCredID)
	for _, d := range devices {
		if d.CredentialID != firstCredentialRef {
			secondCredentialID = d.CredentialID
		}
	}
	if secondCredentialID == "" {
		t.Fatalf("could not identify second device among %+v", devices)
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/api/devices/"+secondCredentialID, nil)
	delReq.Host = host
	delReq.AddCookie(firstSession)
	delRec := httptest.NewRecorder()
	h.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/devices status = %d, body %q", delRec.Code, delRec.Body.String())
	}

	// Credential + envelope gone: the device list now has exactly one entry.
	listReq2 := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	listReq2.Host = host
	listReq2.AddCookie(firstSession)
	listRec2 := httptest.NewRecorder()
	h.ServeHTTP(listRec2, listReq2)
	if listRec2.Code != http.StatusOK {
		t.Fatalf("GET /api/devices after revoke status = %d, body %q", listRec2.Code, listRec2.Body.String())
	}
	var remaining []deviceListItem
	if err := json.Unmarshal(listRec2.Body.Bytes(), &remaining); err != nil {
		t.Fatalf("unmarshal remaining devices: %v", err)
	}
	if len(remaining) != 1 || remaining[0].CredentialID != firstCredentialRef {
		t.Fatalf("expected only the first device to remain, got %+v", remaining)
	}

	// The revoked device's own session token must now be rejected.
	staleReq := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	staleReq.Host = host
	staleReq.AddCookie(secondSession)
	staleRec := httptest.NewRecorder()
	h.ServeHTTP(staleRec, staleReq)
	if staleRec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked device's session status = %d, want 401", staleRec.Code)
	}

	// The remaining device's own session is unaffected.
	stillOKReq := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	stillOKReq.Host = host
	stillOKReq.AddCookie(firstSession)
	stillOKRec := httptest.NewRecorder()
	h.ServeHTTP(stillOKRec, stillOKReq)
	if stillOKRec.Code != http.StatusOK {
		t.Fatalf("remaining device's session status = %d, want 200", stillOKRec.Code)
	}
}

// TestDeviceAPI_RefusesToStrandAccount guards the "never strand an account"
// rule: deleting the only remaining credential is rejected unless a recovery
// envelope exists.
func TestDeviceAPI_RefusesToStrandAccount(t *testing.T) {
	h, host, claimToken := newTestDeviceHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)

	listReq := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	listReq.Host = host
	listReq.AddCookie(session)
	listRec := httptest.NewRecorder()
	h.ServeHTTP(listRec, listReq)
	var devices []deviceListItem
	if err := json.Unmarshal(listRec.Body.Bytes(), &devices); err != nil {
		t.Fatalf("unmarshal devices: %v", err)
	}
	if len(devices) != 1 {
		t.Fatalf("expected exactly 1 device, got %d", len(devices))
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/api/devices/"+devices[0].CredentialID, nil)
	delReq.Host = host
	delReq.AddCookie(session)
	delRec := httptest.NewRecorder()
	h.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusConflict {
		t.Fatalf("DELETE last device without recovery envelope status = %d, want 409 (body %q)", delRec.Code, delRec.Body.String())
	}
}
