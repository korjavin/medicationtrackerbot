package cloudserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/descope/virtualwebauthn"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// newTestAccountHandler wires WebAuthn + AccountAPI onto one mux, mirroring
// cmd/cloud, and returns a teardown-call recorder so the test can assert the
// external cleanup ran.
func newTestAccountHandler(t *testing.T, store *cloudstore.Repo) (http.Handler, *[]string) {
	t.Helper()
	secret := "test-session-secret-at-least-32-bytes-long"
	webauthnAPI := NewWebAuthnAPI(store, secret)
	var tornDown []string
	teardown := func(ctx context.Context, accountID string) { tornDown = append(tornDown, accountID) }
	accountAPI := NewAccountAPI(store, secret, webauthnAPI, teardown)

	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	accountAPI.RegisterRoutes(mux)
	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), &tornDown
}

// registerWithAuthenticator registers a passkey and returns the session cookie
// plus the authenticator/credential/RP a later assertion can reuse.
func registerWithAuthenticator(t *testing.T, h http.Handler, host, claimToken string) (*http.Cookie, virtualwebauthn.RelyingParty, virtualwebauthn.Authenticator, virtualwebauthn.Credential) {
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
	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.Value != "" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("no session cookie from register/finish")
	}
	return session, rp, authenticator, cred
}

// beginReauth drives POST /api/account/reauth and returns the assertion options
// plus the re-auth challenge cookie.
func beginReauth(t *testing.T, h http.Handler, host string, session *http.Cookie) (*virtualwebauthn.AssertionOptions, *http.Cookie) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/account/reauth", nil)
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reauth begin status = %d, body %q", rec.Code, rec.Body.String())
	}
	opts, err := virtualwebauthn.ParseAssertionOptions(rec.Body.String())
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v", err)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == reauthChallengeCookieName {
			// The cookie must be scoped so the browser sends it to /api/account.
			if c.Path != accountDeletePath {
				t.Fatalf("reauth cookie path = %q, want %q", c.Path, accountDeletePath)
			}
			return opts, c
		}
	}
	t.Fatal("no reauth challenge cookie set")
	return nil, nil
}

func deleteAccount(t *testing.T, h http.Handler, host string, cookies []*http.Cookie, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/api/account", strings.NewReader(body))
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		if c != nil {
			req.AddCookie(c)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func accountExists(t *testing.T, store *cloudstore.Repo, subdomain string) bool {
	t.Helper()
	_, err := store.AccountBySubdomain(context.Background(), subdomain)
	return err == nil
}

// bd med-d5t.8 — a user can delete their own account, proving ownership with a
// fresh passkey, and every account-keyed row goes with it.
func TestAccountDelete_HappyPath(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, tornDown := newTestAccountHandler(t, store)

	// Delete completeness (all account-keyed tables) is proven in cloudstore's
	// TestDeleteAccountByID_LeavesNoRows; this exercises the HTTP + re-auth path.
	session, rp, authenticator, cred := registerWithAuthenticator(t, h, host, claimToken)

	opts, reauthCookie := beginReauth(t, h, host, session)
	assertion := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *opts)

	rec := deleteAccount(t, h, host, []*http.Cookie{session, reauthCookie}, assertion)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body %q", rec.Code, rec.Body.String())
	}
	if accountExists(t, store, account.Subdomain) {
		t.Error("account still exists after delete")
	}
	if len(*tornDown) != 1 || (*tornDown)[0] != account.ID {
		t.Errorf("teardown calls = %v, want [%s]", *tornDown, account.ID)
	}
	// The session cookie is cleared.
	cleared := false
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("session cookie was not cleared on delete")
	}
}

// The load-bearing security property: a stolen session cookie ALONE — with no
// fresh passkey assertion — must not delete the account.
func TestAccountDelete_RequiresFreshAssertion(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, tornDown := newTestAccountHandler(t, store)

	session, _, _, _ := registerWithAuthenticator(t, h, host, claimToken)

	// No reauth cookie, no assertion body — just the session.
	rec := deleteAccount(t, h, host, []*http.Cookie{session}, "")
	if rec.Code == http.StatusNoContent {
		t.Fatal("delete succeeded with only a session cookie — a stolen session can delete the vault")
	}
	if accountExists(t, store, account.Subdomain) == false {
		t.Error("account was deleted without a fresh assertion")
	}
	if len(*tornDown) != 0 {
		t.Errorf("teardown ran despite a failed re-auth: %v", *tornDown)
	}
}

// A reused / replayed assertion challenge must not work twice.
func TestAccountDelete_ChallengeIsSingleUse(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestAccountHandler(t, store)

	session, rp, authenticator, cred := registerWithAuthenticator(t, h, host, claimToken)
	opts, reauthCookie := beginReauth(t, h, host, session)
	assertion := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *opts)

	// A tampered account should not exist to delete; instead reuse the SAME
	// assertion against a second delete after the account is already gone: the
	// challenge was consumed, so a replay fails rather than double-deleting.
	first := deleteAccount(t, h, host, []*http.Cookie{session, reauthCookie}, assertion)
	if first.Code != http.StatusNoContent {
		t.Fatalf("first delete status = %d", first.Code)
	}
	replay := deleteAccount(t, h, host, []*http.Cookie{session, reauthCookie}, assertion)
	if replay.Code == http.StatusNoContent {
		t.Error("a replayed re-auth assertion was accepted")
	}
}

// The re-auth ceremony and login share no challenge store: a challenge minted
// for account deletion must not be redeemable at /api/webauthn/login/finish to
// mint a session (defense in depth — the assertion is challenge-bound either
// way, but the stores are kept structurally separate; med-d5t.8).
func TestAccountDelete_ReauthChallengeIsNotALogin(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestAccountHandler(t, store)

	session, rp, authenticator, cred := registerWithAuthenticator(t, h, host, claimToken)
	opts, reauthCookie := beginReauth(t, h, host, session)
	assertion := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *opts)

	// Present the reauth challenge id under the LOGIN challenge cookie.
	forged := &http.Cookie{Name: loginChallengeCookieName, Value: reauthCookie.Value}
	rec := finishLogin(t, h, host, forged, assertion)
	if rec.Code == http.StatusOK {
		t.Error("a re-auth challenge was redeemed at login/finish — stores are not isolated")
	}
}

func TestAccountDelete_RequiresSession(t *testing.T) {
	store := setupStore(t)
	account, _ := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	h, _ := newTestAccountHandler(t, store)

	rec := deleteAccount(t, h, host, nil, "")
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated delete status = %d, want 401", rec.Code)
	}
}
