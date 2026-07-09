package cloudserver

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/descope/virtualwebauthn"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// setupInvite provisions an unclaimed account and returns it plus its raw
// (unhashed) claim token, mirroring what `cloud admin invite` hands the user.
// Its subdomain host (e.g. "amber-falcon-8k3q9x.localhost") is what the
// per-account RP ID is derived from server-side.
func setupInvite(t *testing.T, store *cloudstore.Repo) (*cloudstore.Account, string) {
	t.Helper()
	now := time.Now().UTC()
	inv, err := Provision(t.Context(), store, 14*24*time.Hour, now)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	return inv.Account, inv.Token
}

// beginRegistration drives POST /api/webauthn/register/begin through the
// full Handler (host routing -> account context -> WebAuthnAPI) and returns
// the parsed attestation options plus the challenge cookie for the finish call.
func beginRegistration(t *testing.T, h http.Handler, host, claimToken string) (*virtualwebauthn.AttestationOptions, *http.Cookie) {
	t.Helper()
	body, _ := json.Marshal(registerBeginRequest{ClaimToken: claimToken})
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", bytes.NewReader(body))
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/begin status = %d, body %q", rec.Code, rec.Body.String())
	}

	opts, err := virtualwebauthn.ParseAttestationOptions(rec.Body.String())
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}

	for _, c := range rec.Result().Cookies() {
		if c.Name == challengeCookieName {
			return opts, c
		}
	}
	t.Fatalf("no challenge cookie set")
	return nil, nil
}

func finishRegistration(t *testing.T, h http.Handler, host string, challengeCookie *http.Cookie, response string) *httptest.ResponseRecorder {
	t.Helper()
	// finish now carries the attestation response plus the first envelope; the
	// server stores credential + envelope in one transaction.
	body, _ := json.Marshal(registerFinishRequest{
		Credential: json.RawMessage(response),
		Envelope:   envelopeWire{V: 1, Nonce: []byte("nonce-bytes-1234"), CT: []byte("ciphertext-bytes"), MAC: []byte("mac-bytes")},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/finish", bytes.NewReader(body))
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(challengeCookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func newTestWebAuthnHandler(store *cloudstore.Repo) (http.Handler, *WebAuthnAPI) {
	api := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	api.RegisterRoutes(mux)
	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), api
}

func TestWebAuthnRegistration_FullCeremony(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	if opts.RelyingPartyID != host {
		t.Fatalf("RP ID = %q, want %q", opts.RelyingPartyID, host)
	}

	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	rec := finishRegistration(t, h, host, challengeCookie, response)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/finish status = %d, body %q", rec.Code, rec.Body.String())
	}

	sessionSet := false
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			sessionSet = true
			accountID, credID, ok := VerifySessionToken(c.Value, "test-session-secret-at-least-32-bytes-long")
			if !ok || accountID != account.ID || len(credID) == 0 {
				t.Fatalf("VerifySessionToken failed: ok=%v accountID=%q credID=%x", ok, accountID, credID)
			}
		}
	}
	if !sessionSet {
		t.Fatalf("no session cookie set on finish")
	}

	creds, err := store.CredentialsByAccount(t.Context(), account.ID)
	if err != nil {
		t.Fatalf("CredentialsByAccount: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("expected 1 stored credential, got %d", len(creds))
	}

	// The first envelope was persisted atomically with the credential — so a
	// reload immediately after finish can cold-unlock instead of dead-ending.
	envs, err := store.ListEnvelopes(t.Context(), account.ID)
	if err != nil || len(envs) != 1 {
		t.Fatalf("expected 1 envelope stored with the credential, got %d (err %v)", len(envs), err)
	}

	// The claim token is now invalidated: consuming it again must fail.
	tokenHash := sha256Sum(claimToken)
	if _, err := store.ConsumeClaimToken(t.Context(), account.Subdomain, tokenHash, time.Now().UTC()); err != cloudstore.ErrClaimInvalid {
		t.Fatalf("expected claim token to already be invalidated, got %v", err)
	}
}

func TestWebAuthnRegistration_RejectsBadOrigin(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "https://evil.example.com"}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	opts, challengeCookie := beginRegistration(t, h, host, claimToken)

	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	rec := finishRegistration(t, h, host, challengeCookie, response)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("register/finish with bad origin status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
}

func TestWebAuthnRegistration_RejectsReplayedChallenge(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)

	first := finishRegistration(t, h, host, challengeCookie, response)
	if first.Code != http.StatusOK {
		t.Fatalf("first register/finish status = %d, body %q", first.Code, first.Body.String())
	}

	replay := finishRegistration(t, h, host, challengeCookie, response)
	if replay.Code != http.StatusBadRequest {
		t.Fatalf("replayed register/finish status = %d, want 400 (body %q)", replay.Code, replay.Body.String())
	}
}

// beginLogin drives POST /api/webauthn/login/begin through the full Handler
// and returns the parsed assertion options plus the login challenge cookie.
func beginLogin(t *testing.T, h http.Handler, host string) (*virtualwebauthn.AssertionOptions, *http.Cookie) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/begin", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login/begin status = %d, body %q", rec.Code, rec.Body.String())
	}

	// Spec (docs/cloud-crypto.md): userVerification=required on all ceremonies.
	// virtualwebauthn's AssertionOptions drops the field, so assert on the raw
	// JSON that go-webauthn emitted.
	if !strings.Contains(rec.Body.String(), `"userVerification":"required"`) {
		t.Fatalf("login/begin options missing userVerification=required: %s", rec.Body.String())
	}

	opts, err := virtualwebauthn.ParseAssertionOptions(rec.Body.String())
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v", err)
	}

	for _, c := range rec.Result().Cookies() {
		if c.Name == loginChallengeCookieName {
			return opts, c
		}
	}
	t.Fatalf("no login challenge cookie set")
	return nil, nil
}

func finishLogin(t *testing.T, h http.Handler, host string, challengeCookie *http.Cookie, response string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/login/finish", strings.NewReader(response))
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(challengeCookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// registerCredential drives a full registration ceremony and returns the
// virtualwebauthn authenticator+credential a login ceremony can reuse.
func registerCredential(t *testing.T, h http.Handler, host, claimToken string) (virtualwebauthn.Authenticator, virtualwebauthn.Credential) {
	return registerCredentialWithAuthenticator(t, h, host, claimToken, virtualwebauthn.NewAuthenticator())
}

func registerCredentialWithAuthenticator(t *testing.T, h http.Handler, host, claimToken string, authenticator virtualwebauthn.Authenticator) (virtualwebauthn.Authenticator, virtualwebauthn.Credential) {
	t.Helper()
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	rec := finishRegistration(t, h, host, challengeCookie, response)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/finish status = %d, body %q", rec.Code, rec.Body.String())
	}
	authenticator.AddCredential(cred)
	return authenticator, cred
}

func TestWebAuthnLogin_FullCeremony(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	authenticator, cred := registerCredential(t, h, host, claimToken)
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}

	loginOpts, loginChallengeCookie := beginLogin(t, h, host)
	if loginOpts.RelyingPartyID != host {
		t.Fatalf("RP ID = %q, want %q", loginOpts.RelyingPartyID, host)
	}

	loginResponse := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *loginOpts)
	rec := finishLogin(t, h, host, loginChallengeCookie, loginResponse)
	if rec.Code != http.StatusOK {
		t.Fatalf("login/finish status = %d, body %q", rec.Code, rec.Body.String())
	}

	var sessionCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatalf("no session cookie set on login finish")
	}
	accountID, credID, ok := VerifySessionToken(sessionCookie.Value, "test-session-secret-at-least-32-bytes-long")
	if !ok || accountID != account.ID || len(credID) == 0 {
		t.Fatalf("VerifySessionToken failed: ok=%v accountID=%q credID=%x", ok, accountID, credID)
	}

	// The minted session must pass the auth middleware for account-scoped routes.
	protected := RequireSession(store, "test-session-secret-at-least-32-bytes-long", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, ok := SessionFromContext(r.Context())
		if !ok || s.AccountID != account.ID {
			t.Errorf("SessionFromContext: ok=%v accountID=%q", ok, s.AccountID)
		}
		w.WriteHeader(http.StatusOK)
	}))
	protReq := httptest.NewRequest(http.MethodGet, "/api/whatever", nil)
	protReq.Host = host
	protReq.AddCookie(sessionCookie)
	protReq = protReq.WithContext(withAccount(protReq.Context(), account))
	protRec := httptest.NewRecorder()
	protected.ServeHTTP(protRec, protReq)
	if protRec.Code != http.StatusOK {
		t.Fatalf("protected handler status = %d, want 200 (body %q)", protRec.Code, protRec.Body.String())
	}

	creds, err := store.CredentialsByAccount(t.Context(), account.ID)
	if err != nil {
		t.Fatalf("CredentialsByAccount: %v", err)
	}
	if len(creds) != 1 || creds[0].LastAssertedAt == nil {
		t.Fatalf("expected credential to be touched by login, got %+v", creds)
	}
}

// Synced passkeys (Apple Passwords, Google Password Manager, 1Password) set
// the backup-eligible/backup-state flags on every assertion, and go-webauthn's
// FinishLogin rejects a mismatch against the stored credential. Regression
// test for the C0a defect where flags weren't persisted (always false), which
// made unlock impossible with any consumer passkey provider.
func TestWebAuthnLogin_SyncedPasskeyBackupFlags(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	synced := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{
		BackupEligible: true,
		BackupState:    true,
	})
	authenticator, cred := registerCredentialWithAuthenticator(t, h, host, claimToken, synced)

	creds, err := store.CredentialsByAccount(t.Context(), account.ID)
	if err != nil || len(creds) != 1 {
		t.Fatalf("CredentialsByAccount: %v (n=%d)", err, len(creds))
	}
	if !creds[0].BackupEligible || !creds[0].BackupState {
		t.Fatalf("backup flags not persisted at registration: %+v", creds[0])
	}

	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	loginOpts, loginChallengeCookie := beginLogin(t, h, host)
	loginResponse := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *loginOpts)
	rec := finishLogin(t, h, host, loginChallengeCookie, loginResponse)
	if rec.Code != http.StatusOK {
		t.Fatalf("login/finish with synced passkey status = %d, body %q", rec.Code, rec.Body.String())
	}
}

func TestWebAuthnLogin_RejectsBadOrigin(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	authenticator, cred := registerCredential(t, h, host, claimToken)
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "https://evil.example.com"}

	loginOpts, loginChallengeCookie := beginLogin(t, h, host)
	loginResponse := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *loginOpts)
	rec := finishLogin(t, h, host, loginChallengeCookie, loginResponse)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("login/finish with bad origin status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
}

func TestRequireSession_RejectsMissingOrInvalidCookie(t *testing.T) {
	store := setupStore(t)
	protected := RequireSession(store, "test-session-secret-at-least-32-bytes-long", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("inner handler must not run without a valid session")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/whatever", nil)
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing cookie status = %d, want 401", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/whatever", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "garbage"})
	rec = httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("invalid cookie status = %d, want 401", rec.Code)
	}
}

// TestWebAuthnRegistration_SessionGateRejectsRevokedCredential pins the
// revocation guarantee on the register/begin session gate: a device whose
// credential was revoked, but which still holds a valid session cookie (30-day
// TTL) and its in-memory DEK, must not be able to self-enroll a fresh
// credential and undo its own revocation.
func TestWebAuthnRegistration_SessionGateRejectsRevokedCredential(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	// Enroll the first device via the claim gate and capture its session cookie.
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	rec := finishRegistration(t, h, host, challengeCookie, response)
	if rec.Code != http.StatusOK {
		t.Fatalf("register/finish status = %d, body %q", rec.Code, rec.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			sessionCookie = c
		}
	}
	if sessionCookie == nil {
		t.Fatalf("no session cookie set on finish")
	}

	// A complete recovery path (envelope + verifier) keeps an unwrap path alive
	// so revoking the sole credential is permitted (the "never strand the
	// account" invariant now blocks removing the last credential otherwise).
	if err := store.PutEnvelope(t.Context(), cloudstore.Envelope{
		AccountID: account.ID, CredentialRef: "recovery", V: 1,
		Nonce: []byte("nonce"), CT: []byte("ct"), MAC: []byte("mac"),
	}); err != nil {
		t.Fatalf("PutEnvelope(recovery): %v", err)
	}
	if err := store.SetRecoveryVerifier(t.Context(), account.ID, []byte("verifier-hash")); err != nil {
		t.Fatalf("SetRecoveryVerifier: %v", err)
	}

	// Revoke that credential out from under the still-valid session cookie.
	creds, err := store.CredentialsByAccount(t.Context(), account.ID)
	if err != nil || len(creds) != 1 {
		t.Fatalf("CredentialsByAccount: %v (len %d)", err, len(creds))
	}
	if err := store.DeleteCredentialWithEnvelope(t.Context(), account.ID, creds[0].ID); err != nil {
		t.Fatalf("DeleteCredentialWithEnvelope: %v", err)
	}

	// No claim/enrollment token -> session gate. The revoked credential no
	// longer exists, so register/begin must reject rather than start a ceremony.
	body, _ := json.Marshal(registerBeginRequest{})
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", bytes.NewReader(body))
	req.Host = host
	req.AddCookie(sessionCookie)
	rrec := httptest.NewRecorder()
	h.ServeHTTP(rrec, req)
	if rrec.Code != http.StatusUnauthorized {
		t.Fatalf("register/begin via session gate for revoked credential status = %d, want 401 (body %q)", rrec.Code, rrec.Body.String())
	}
}

// TestWebAuthnRegistration_ClaimTokenOutcomes pins the three-way response
// contract of register/begin with a claim_token — the signup wizard branches on
// it to decide between "create your passkey", "already claimed, go unlock", and
// "expired link".
func TestWebAuthnRegistration_ClaimTokenOutcomes(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	postBegin := func(token string) *httptest.ResponseRecorder {
		t.Helper()
		body, _ := json.Marshal(registerBeginRequest{ClaimToken: token})
		req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", bytes.NewReader(body))
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	if rec := postBegin(claimToken); rec.Code != http.StatusOK {
		t.Fatalf("pending invite: status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}

	if rec := postBegin(hex.EncodeToString([]byte("not-the-real-token-not-the-real"))); rec.Code != http.StatusForbidden {
		t.Fatalf("bad token: status = %d, want 403", rec.Code)
	}

	// Claim it for real, which NULLs the hash and stores a credential.
	rp := virtualwebauthn.RelyingParty{Name: "Med Tracker Cloud", ID: host, Origin: "http://" + host}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	opts, challengeCookie := beginRegistration(t, h, host, claimToken)
	response := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *opts)
	if rec := finishRegistration(t, h, host, challengeCookie, response); rec.Code != http.StatusOK {
		t.Fatalf("register/finish status = %d, body %q", rec.Code, rec.Body.String())
	}

	rec := postBegin(claimToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("claimed account: status = %d, want 409 (body %q)", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode 409 body %q: %v", rec.Body.String(), err)
	}
	if got["error"] != "already_claimed" {
		t.Fatalf("409 body = %v, want error=already_claimed", got)
	}
}

func TestWebAuthnRegistration_RejectsInvalidClaimToken(t *testing.T) {
	store := setupStore(t)
	account, _ := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestWebAuthnHandler(store)

	body, _ := json.Marshal(registerBeginRequest{ClaimToken: hex.EncodeToString([]byte("not-the-real-token-not-the-real"))})
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/begin", bytes.NewReader(body))
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("register/begin with bad claim token status = %d, want 403", rec.Code)
	}
}
