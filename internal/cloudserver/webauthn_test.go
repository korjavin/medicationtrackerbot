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
	req := httptest.NewRequest(http.MethodPost, "/api/webauthn/register/finish", strings.NewReader(response))
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(challengeCookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func newTestWebAuthnHandler(store *cloudstore.Repo) (http.Handler, *WebAuthnAPI) {
	api := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	return New("localhost", store, testFS(), api.Routes()), api
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
	protected := RequireSession("test-session-secret-at-least-32-bytes-long", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	protected := RequireSession("test-session-secret-at-least-32-bytes-long", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
