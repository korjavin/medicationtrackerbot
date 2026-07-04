package cloudserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/descope/virtualwebauthn"
)

// newTestAPIHandler wires WebAuthn + envelope routes onto one mux, mirroring
// cmd/cloud/main.go's wiring, so the test drives the real signup->register
// ->session->envelope contract end to end.
func newTestAPIHandler(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	envelopeAPI := NewEnvelopeAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	envelopeAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), mux), host, claimToken
}

func registerAndGetSession(t *testing.T, h http.Handler, host, claimToken string) *http.Cookie {
	t.Helper()
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	rec := finishRegistration(t, h, host, challengeCookie, response)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/finish status = %d, body %q", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			return c
		}
	}
	t.Fatalf("no session cookie set on register/finish")
	return nil
}

func TestEnvelopeAPI_PutGetListAndVerifier(t *testing.T) {
	h, host, claimToken := newTestAPIHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)

	body, _ := json.Marshal(envelopeWire{V: 1, Nonce: []byte("0123456789ab"), CT: []byte("ciphertext-bytes"), MAC: []byte("mac-bytes")})
	putReq := httptest.NewRequest(http.MethodPut, "/api/envelopes/recovery", bytes.NewReader(body))
	putReq.Host = host
	putReq.AddCookie(session)
	putRec := httptest.NewRecorder()
	h.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusNoContent {
		t.Fatalf("PUT envelope status = %d, body %q", putRec.Code, putRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/envelopes/recovery", nil)
	getReq.Host = host
	getReq.AddCookie(session)
	getRec := httptest.NewRecorder()
	h.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET envelope status = %d, body %q", getRec.Code, getRec.Body.String())
	}
	var got envelopeWire
	if err := json.Unmarshal(getRec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if got.V != 1 || string(got.CT) != "ciphertext-bytes" || string(got.MAC) != "mac-bytes" {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/envelopes", nil)
	listReq.Host = host
	listReq.AddCookie(session)
	listRec := httptest.NewRecorder()
	h.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("LIST envelopes status = %d, body %q", listRec.Code, listRec.Body.String())
	}
	var list []envelopeListItem
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	// The list now holds the credential's envelope (stored atomically at
	// register/finish) plus the "recovery" envelope just uploaded.
	var recovery *envelopeListItem
	for i := range list {
		if list[i].CredentialRef == "recovery" {
			recovery = &list[i]
		}
	}
	if len(list) != 2 || recovery == nil || string(recovery.MAC) != "mac-bytes" {
		t.Fatalf("unexpected list: %+v", list)
	}

	verifierBody, _ := json.Marshal(recoveryVerifierRequest{Verifier: []byte("a-recovery-verifier")})
	verifierReq := httptest.NewRequest(http.MethodPut, "/api/recovery-verifier", bytes.NewReader(verifierBody))
	verifierReq.Host = host
	verifierReq.AddCookie(session)
	verifierRec := httptest.NewRecorder()
	h.ServeHTTP(verifierRec, verifierReq)
	if verifierRec.Code != http.StatusNoContent {
		t.Fatalf("PUT recovery-verifier status = %d, body %q", verifierRec.Code, verifierRec.Body.String())
	}
}

func TestEnvelopeAPI_RequiresSession(t *testing.T) {
	h, host, _ := newTestAPIHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/envelopes", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/envelopes without session status = %d, want 401", rec.Code)
	}
}

func TestEnvelopeAPI_RejectsInvalidCredentialRef(t *testing.T) {
	h, host, claimToken := newTestAPIHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)

	body, _ := json.Marshal(envelopeWire{V: 1, Nonce: []byte("0123456789ab"), CT: []byte("ct"), MAC: []byte("mac")})
	req := httptest.NewRequest(http.MethodPut, "/api/envelopes/not-valid-base64!!!", bytes.NewReader(body))
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("PUT envelope with invalid ref status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
}
