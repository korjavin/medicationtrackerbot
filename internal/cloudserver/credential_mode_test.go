package cloudserver

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/descope/virtualwebauthn"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// newCredentialModeHandler wires the WebAuthn + transfer + device + envelope
// routes so the tests below drive the local-only POC contract end to end,
// with the operator POC switch on.
func newCredentialModeHandler(t *testing.T) (http.Handler, *cloudstore.Repo, string, string) {
	t.Helper()
	return newCredentialModeHandlerWithPOC(t, true)
}

// newCredentialModeHandlerWithPOC is newCredentialModeHandler with an
// explicit operator switch: false leaves the POC kill-switch off (the
// production default), so local-only finishes must be rejected and
// /api/version must not advertise the fallback.
func newCredentialModeHandlerWithPOC(t *testing.T, pocEnabled bool) (http.Handler, *cloudstore.Repo, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	secret := "test-session-secret-at-least-32-bytes-long"
	webauthnAPI := NewWebAuthnAPI(store, secret)
	webauthnAPI.SetLocalOnlyPOC(pocEnabled)
	transferAPI := NewTransferAPI(store, secret)
	deviceAPI := NewDeviceAPI(store, secret)
	envelopeAPI := NewEnvelopeAPI(store, secret)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	transferAPI.RegisterRoutes(mux)
	deviceAPI.RegisterRoutes(mux)
	envelopeAPI.RegisterRoutes(mux)

	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	h.SetLocalOnlyPOC(pocEnabled)
	return h, store, host, claimToken
}

// finishRegistrationWithMode is finishRegistration with an explicit mode and
// envelope: mode "" preserves the legacy body (PRF default), mode
// "local_only" sends no envelope.
func finishRegistrationWithMode(t *testing.T, h http.Handler, host string, challengeCookie *http.Cookie, response, mode string, env *envelopeWire) *httptest.ResponseRecorder {
	t.Helper()
	req := registerFinishRequest{Credential: json.RawMessage(response), Mode: mode}
	if env != nil {
		req.Envelope = *env
	}
	body, _ := json.Marshal(req)
	httpReq := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/finish", bytes.NewReader(body))
	httpReq.Host = host
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.AddCookie(challengeCookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httpReq)
	return rec
}

func prfTestEnvelope() *envelopeWire {
	return &envelopeWire{V: 1, Nonce: []byte("nonce-bytes-1234"), CT: []byte("ciphertext-bytes"), MAC: []byte("mac-bytes")}
}

// claimTransferSlot opens a transfer slot behind session and claims it,
// returning the fresh enrollment token that gates the new device's
// registration.
func claimTransferSlot(t *testing.T, h http.Handler, host string, session *http.Cookie) string {
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
	return claimed.EnrollmentToken
}

func requireSessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			return c
		}
	}
	t.Fatalf("no session cookie set (status %d, body %q)", rec.Code, rec.Body.String())
	return nil
}

func listDevices(t *testing.T, h http.Handler, host string, session *http.Cookie) []deviceListItem {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/devices", nil)
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/devices status = %d, body %q", rec.Code, rec.Body.String())
	}
	var devices []deviceListItem
	if err := json.Unmarshal(rec.Body.Bytes(), &devices); err != nil {
		t.Fatalf("unmarshal devices: %v", err)
	}
	return devices
}

func setRecoveryMaterial(t *testing.T, store *cloudstore.Repo, accountID string) {
	t.Helper()
	err := store.SetRecoveryMaterial(t.Context(), accountID, cloudstore.Envelope{
		AccountID:     accountID,
		CredentialRef: "recovery",
		V:             1,
		Nonce:         []byte("rec-nonce"),
		CT:            []byte("rec-ct"),
		MAC:           []byte("rec-mac"),
	}, []byte("verifier-hash-32-bytes-long!!!!!"))
	if err != nil {
		t.Fatalf("SetRecoveryMaterial: %v", err)
	}
}

// TestRegisterFinish_LocalOnlyRejectedWhenOperatorSwitchOff pins the
// server-side kill-switch: with CLOUD_LOCAL_ONLY_POC unset (the default),
// every register/finish path rejects mode:"local_only" with 400 — a crafted
// request or a stale flagged browser cannot enroll the fallback — and
// nothing is persisted.
func TestRegisterFinish_LocalOnlyRejectedWhenOperatorSwitchOff(t *testing.T) {
	h, store, host, claimToken := newCredentialModeHandlerWithPOC(t, false)
	session := registerAndGetSession(t, h, host, claimToken)
	accountID := accountIDFromSession(t, session)
	setRecoveryMaterial(t, store, accountID)

	token := claimTransferSlot(t, h, host, session)
	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code != http.StatusOK {
		t.Fatalf("register/begin status = %d, want 200", code)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("local-only finish with switch off status = %d, want 400", rec.Code)
	}

	creds, err := store.CredentialsByAccount(t.Context(), accountID)
	if err != nil {
		t.Fatalf("CredentialsByAccount: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("expected only the first credential after rejection, got %d", len(creds))
	}

	// The same deployment does not advertise the fallback either.
	versionReq := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	versionReq.Host = host
	versionRec := httptest.NewRecorder()
	h.ServeHTTP(versionRec, versionReq)
	if versionRec.Code != http.StatusOK {
		t.Fatalf("GET /api/version status = %d, want 200", versionRec.Code)
	}
	var version map[string]any
	if err := json.Unmarshal(versionRec.Body.Bytes(), &version); err != nil {
		t.Fatalf("unmarshal version: %v", err)
	}
	if version["local_only_poc"] != false {
		t.Fatalf("local_only_poc = %v with switch off, want false", version["local_only_poc"])
	}
}

// TestRegisterFinish_LocalOnlyViaEnrollmentToken is the POC's core server
// contract: a second device whose authenticator lacks PRF enrolls with an
// explicit local_only mode and NO envelope; the credential persists with its
// mode label and no new decrypting material lands server-side.
func TestRegisterFinish_LocalOnlyViaEnrollmentToken(t *testing.T) {
	h, store, host, claimToken := newCredentialModeHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	accountID := accountIDFromSession(t, session)
	setRecoveryMaterial(t, store, accountID)

	token := claimTransferSlot(t, h, host, session)
	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code != http.StatusOK {
		t.Fatalf("register/begin via enrollment token status = %d, want 200", code)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)

	rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("local-only register/finish status = %d, body %q", rec.Code, rec.Body.String())
	}
	_ = requireSessionCookie(t, rec)

	creds, err := store.CredentialsByAccount(t.Context(), accountID)
	if err != nil {
		t.Fatalf("CredentialsByAccount: %v", err)
	}
	if len(creds) != 2 {
		t.Fatalf("expected 2 credentials, got %d", len(creds))
	}
	var local *cloudstore.Credential
	for i := range creds {
		switch creds[i].Mode {
		case cloudstore.CredentialModeLocalOnly:
			if local != nil {
				t.Fatalf("expected exactly one local_only credential")
			}
			local = &creds[i]
		case cloudstore.CredentialModePRF, "":
		default:
			t.Fatalf("unexpected credential mode %q", creds[i].Mode)
		}
	}
	if local == nil {
		t.Fatalf("no local_only credential stored")
	}

	// No envelope row exists for the local-only credential: the mode label is
	// all the server holds, and ListEnvelopes shows nothing new for it.
	ref := base64.RawURLEncoding.EncodeToString(local.ID)
	if _, err := store.GetEnvelope(t.Context(), accountID, ref); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("GetEnvelope(local_only ref) err = %v, want sql.ErrNoRows", err)
	}
	envs, err := store.ListEnvelopes(t.Context(), accountID)
	if err != nil {
		t.Fatalf("ListEnvelopes: %v", err)
	}
	for _, e := range envs {
		if e.CredentialRef == ref {
			t.Fatalf("local-only credential has an envelope row, want none")
		}
	}
	// Exactly the first credential's envelope plus the seeded recovery
	// envelope — the local-only enrollment added no server-side material.
	if len(envs) != 2 {
		t.Fatalf("expected the PRF + recovery envelopes, got %d rows", len(envs))
	}
}

// TestRegisterFinish_LocalOnlyFirstCredentialRejected pins the POC boundary:
// local-only cannot bootstrap an account via the claim gate — the first
// enrollment is always PRF-backed. The rejection happens before the claim is
// consumed, so the invite stays usable for a PRF retry.
func TestRegisterFinish_LocalOnlyFirstCredentialRejected(t *testing.T) {
	h, _, host, claimToken := newCredentialModeHandler(t)

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("first-credential local-only finish status = %d, want 400", rec.Code)
	}

	// The claim survived: a PRF enrollment on the same invite still works.
	opts2, challengeCookie2 := beginRegistration(t, h, host, claimToken)
	response2 := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts2)
	rec2 := finishRegistrationWithMode(t, h, host, challengeCookie2, response2, "", prfTestEnvelope())
	if rec2.Code != http.StatusOK {
		t.Fatalf("PRF retry after local-only rejection status = %d, body %q", rec2.Code, rec2.Body.String())
	}
}

func TestRegisterFinish_LocalOnlyWithEnvelopeRejected(t *testing.T) {
	h, _, host, claimToken := newCredentialModeHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	token := claimTransferSlot(t, h, host, session)

	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code != http.StatusOK {
		t.Fatalf("register/begin status = %d, want 200", code)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, prfTestEnvelope())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("local-only with envelope status = %d, want 400", rec.Code)
	}
}

// TestRegisterFinish_LocalOnlyWithoutRecoveryRejected pins the server-side
// half of the enrollment contract: a local-only commit without usable
// recovery material is refused (409), and the refusal rolls the token redeem
// back — setting recovery material afterwards lets the SAME enrollment token
// finish successfully.
func TestRegisterFinish_LocalOnlyWithoutRecoveryRejected(t *testing.T) {
	h, store, host, claimToken := newCredentialModeHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	accountID := accountIDFromSession(t, session)
	token := claimTransferSlot(t, h, host, session)
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}

	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code != http.StatusOK {
		t.Fatalf("register/begin status = %d, want 200", code)
	}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	if rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, nil); rec.Code != http.StatusConflict {
		t.Fatalf("local-only finish without recovery status = %d, want 409", rec.Code)
	}

	setRecoveryMaterial(t, store, accountID)
	opts2, challengeCookie2, code2 := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code2 != http.StatusOK {
		t.Fatalf("register/begin after 409 status = %d, want 200 (token must survive the refusal)", code2)
	}
	response2 := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts2)
	if rec := finishRegistrationWithMode(t, h, host, challengeCookie2, response2, cloudstore.CredentialModeLocalOnly, nil); rec.Code != http.StatusOK {
		t.Fatalf("local-only finish after recovery setup status = %d, want 200", rec.Code)
	}
}

func TestRegisterFinish_InvalidModeRejected(t *testing.T) {
	h, _, host, claimToken := newCredentialModeHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	token := claimTransferSlot(t, h, host, session)

	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code != http.StatusOK {
		t.Fatalf("register/begin status = %d, want 200", code)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, "xor-split", prfTestEnvelope())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown mode status = %d, want 400", rec.Code)
	}
}

// TestRegisterFinish_LocalOnlyViaSession covers the already-unlocked device
// enrolling an additional local passkey behind plain session auth.
func TestRegisterFinish_LocalOnlyViaSession(t *testing.T) {
	h, store, host, claimToken := newCredentialModeHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	accountID := accountIDFromSession(t, session)
	setRecoveryMaterial(t, store, accountID)

	body, _ := json.Marshal(registerBeginRequest{})
	beginReq := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", bytes.NewReader(body))
	beginReq.Host = host
	beginReq.AddCookie(session)
	beginRec := httptest.NewRecorder()
	h.ServeHTTP(beginRec, beginReq)
	if beginRec.Code != http.StatusOK {
		t.Fatalf("session-gated register/begin status = %d, body %q", beginRec.Code, beginRec.Body.String())
	}
	opts, err := virtualwebauthn.ParseAttestationOptions(beginRec.Body.String())
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	var challengeCookie *http.Cookie
	for _, c := range beginRec.Result().Cookies() {
		if c.Name == challengeCookieName {
			challengeCookie = c
		}
	}
	if challengeCookie == nil {
		t.Fatalf("no challenge cookie set")
	}

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("session-gated local-only finish status = %d, body %q", rec.Code, rec.Body.String())
	}

	creds, err := store.CredentialsByAccount(t.Context(), accountID)
	if err != nil {
		t.Fatalf("CredentialsByAccount: %v", err)
	}
	if len(creds) != 2 {
		t.Fatalf("expected 2 credentials, got %d", len(creds))
	}
}

// TestDeviceList_ReportsExplicitModes pins that /api/devices reports the
// explicit mode per credential: the local-only entry carries its label with
// no envelope (expected, not an audit failure), the PRF entry its envelope.
func TestDeviceList_ReportsExplicitModes(t *testing.T) {
	h, store, host, claimToken := newCredentialModeHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	setRecoveryMaterial(t, store, accountIDFromSession(t, session))
	token := claimTransferSlot(t, h, host, session)

	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code != http.StatusOK {
		t.Fatalf("register/begin status = %d, want 200", code)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	if rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, nil); rec.Code != http.StatusOK {
		t.Fatalf("local-only finish status = %d", rec.Code)
	}

	devices := listDevices(t, h, host, session)
	if len(devices) != 2 {
		t.Fatalf("expected 2 devices, got %d", len(devices))
	}
	byMode := map[string]deviceListItem{}
	for _, d := range devices {
		byMode[d.Mode] = d
	}
	prf, ok := byMode[cloudstore.CredentialModePRF]
	if !ok || prf.Envelope == nil {
		t.Fatalf("PRF device missing or envelope-less: %+v", devices)
	}
	local, ok := byMode[cloudstore.CredentialModeLocalOnly]
	if !ok {
		t.Fatalf("local_only device missing: %+v", devices)
	}
	if local.Envelope != nil {
		t.Fatalf("local_only device carries an envelope: %+v", local.Envelope)
	}
}

func deleteDevice(t *testing.T, h http.Handler, host string, session *http.Cookie, credentialID string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/api/devices/"+credentialID, nil)
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

// enrollLocalOnlyDevice enrolls a local-only credential via the transfer-slot
// path and returns the session minted for the NEW credential. Recovery
// material is set up first: the server refuses to commit a local-only
// credential onto an account without a usable fallback.
func enrollLocalOnlyDevice(t *testing.T, h http.Handler, store *cloudstore.Repo, host string, session *http.Cookie) *http.Cookie {
	t.Helper()
	setRecoveryMaterial(t, store, accountIDFromSession(t, session))
	token := claimTransferSlot(t, h, host, session)
	opts, challengeCookie, code := beginRegistrationWithEnrollmentToken(t, h, host, token)
	if code != http.StatusOK {
		t.Fatalf("register/begin status = %d, want 200", code)
	}
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	response := virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *opts)
	rec := finishRegistrationWithMode(t, h, host, challengeCookie, response, cloudstore.CredentialModeLocalOnly, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("local-only finish status = %d, body %q", rec.Code, rec.Body.String())
	}
	return requireSessionCookie(t, rec)
}

// TestDeleteDevice_LocalOnlyGuards pins the POC's "never strand" semantics: a
// local-only credential is not an unwrap path, so removing the last PRF
// credential while only local-only credentials remain is refused unless
// usable recovery material exists.
func TestDeleteDevice_LocalOnlyGuards(t *testing.T) {
	t.Run("last PRF refused when only local-only remains and no recovery", func(t *testing.T) {
		h, store, host, claimToken := newCredentialModeHandler(t)
		session := registerAndGetSession(t, h, host, claimToken)
		// The enrollment gate refuses to commit a local-only credential
		// without recovery material, so this state is unreachable via the
		// API — construct it with a direct store insert to prove the delete
		// guard holds regardless of how it arose.
		if err := store.AddCredential(t.Context(), cloudstore.Credential{
			ID:        []byte("local-only-cred-direct"),
			AccountID: accountIDFromSession(t, session),
			PublicKey: []byte("pk"),
			Mode:      cloudstore.CredentialModeLocalOnly,
			CreatedAt: time.Now().UTC(),
		}); err != nil {
			t.Fatalf("AddCredential: %v", err)
		}

		devices := listDevices(t, h, host, session)
		var prfRef string
		for _, d := range devices {
			if d.Mode == cloudstore.CredentialModePRF {
				prfRef = d.CredentialID
			}
		}
		if prfRef == "" {
			t.Fatalf("no PRF device listed: %+v", devices)
		}
		if code := deleteDevice(t, h, host, session, prfRef); code != http.StatusConflict {
			t.Fatalf("DELETE last PRF status = %d, want 409", code)
		}
		// The refusal rolled back: both credentials still listed.
		if got := listDevices(t, h, host, session); len(got) != 2 {
			t.Fatalf("expected 2 devices after refused delete, got %d", len(got))
		}
	})

	t.Run("last PRF allowed when recovery material exists", func(t *testing.T) {
		h, store, host, claimToken := newCredentialModeHandler(t)
		session := registerAndGetSession(t, h, host, claimToken)
		localSession := enrollLocalOnlyDevice(t, h, store, host, session)

		devices := listDevices(t, h, host, session)
		var prfRef string
		for _, d := range devices {
			if d.Mode == cloudstore.CredentialModePRF {
				prfRef = d.CredentialID
			}
		}
		if code := deleteDevice(t, h, host, session, prfRef); code != http.StatusNoContent {
			t.Fatalf("DELETE last PRF with recovery status = %d, want 204", code)
		}
		// The deleted PRF credential takes its session with it (revocation
		// cascade), so the follow-up list runs on the surviving local-only
		// device's session — which proves the local-only credential still
		// authenticates API access after the last PRF credential is gone.
		remaining := listDevices(t, h, host, localSession)
		if len(remaining) != 1 || remaining[0].Mode != cloudstore.CredentialModeLocalOnly {
			t.Fatalf("expected only the local_only device left, got %+v", remaining)
		}
	})

	t.Run("local-only removal alongside a PRF credential always allowed", func(t *testing.T) {
		h, store, host, claimToken := newCredentialModeHandler(t)
		session := registerAndGetSession(t, h, host, claimToken)
		enrollLocalOnlyDevice(t, h, store, host, session)

		devices := listDevices(t, h, host, session)
		var localRef string
		for _, d := range devices {
			if d.Mode == cloudstore.CredentialModeLocalOnly {
				localRef = d.CredentialID
			}
		}
		if code := deleteDevice(t, h, host, session, localRef); code != http.StatusNoContent {
			t.Fatalf("DELETE local-only status = %d, want 204", code)
		}
		remaining := listDevices(t, h, host, session)
		if len(remaining) != 1 || remaining[0].Mode != cloudstore.CredentialModePRF {
			t.Fatalf("expected only the PRF device left, got %+v", remaining)
		}
	})
}

// TestCredentialMode_StoreRejectsWrongMode pins the store-level guard: the
// local-only insert paths refuse a credential that is not labelled local_only,
// so a caller bug cannot silently persist a PRF credential without its
// envelope.
func TestCredentialMode_StoreRejectsWrongMode(t *testing.T) {
	store := setupStore(t)
	ctx := t.Context()
	now := time.Now().UTC()
	cred := cloudstore.Credential{ID: []byte("cred-id-1"), AccountID: "acct", PublicKey: []byte("pk"), Mode: cloudstore.CredentialModePRF, CreatedAt: now}
	if err := store.RedeemTransferTokenLocalOnly(ctx, "acct", []byte("hash"), cred, now); err == nil {
		t.Fatalf("RedeemTransferTokenLocalOnly with prf credential succeeded, want error")
	}
	if err := store.AddCredentialLocalOnly(ctx, []byte("source"), cred); err == nil {
		t.Fatalf("AddCredentialLocalOnly with prf credential succeeded, want error")
	}
}

func accountIDFromSession(t *testing.T, session *http.Cookie) string {
	t.Helper()
	accountID, _, ok := VerifySessionToken(session.Value, "test-session-secret-at-least-32-bytes-long")
	if !ok {
		t.Fatalf("VerifySessionToken failed")
	}
	return accountID
}
