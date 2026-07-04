package cloudserver

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// registerStore is the subset of *cloudstore.Repo the registration ceremony
// needs.
type registerStore interface {
	AddCredential(ctx context.Context, cred cloudstore.Credential) error
	ConsumeClaimToken(ctx context.Context, subdomain string, tokenHash []byte, now time.Time) (*cloudstore.Account, error)
}

// WebAuthnAPI holds the account-scoped WebAuthn HTTP handlers — registration
// in this plan; login joins it in a follow-up task behind the same Routes mux.
type WebAuthnAPI struct {
	store         registerStore
	sessionSecret string
	challenges    *challengeStore
}

// NewWebAuthnAPI builds the WebAuthn handlers. sessionSecret mints the HMAC
// session cookie (session.go) on successful registration.
func NewWebAuthnAPI(store registerStore, sessionSecret string) *WebAuthnAPI {
	return &WebAuthnAPI{store: store, sessionSecret: sessionSecret, challenges: newChallengeStore()}
}

// Routes returns the account-scoped WebAuthn mux, mounted under the
// subdomain branch of cloudserver.Handler as its "/api/*" handler.
func (a *WebAuthnAPI) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/webauthn/register/begin", a.RegisterBegin)
	mux.HandleFunc("POST /api/webauthn/register/finish", a.RegisterFinish)
	return mux
}

const challengeCookieName = "cloud_webauthn_challenge"
const challengeTTL = 5 * time.Minute

// registerChallenge is what challengeStore holds between RegisterBegin and
// RegisterFinish: the go-webauthn session data plus enough of the claim to
// consume it atomically once the ceremony verifies.
type registerChallenge struct {
	session   webauthn.SessionData
	accountID string
	tokenHash []byte
	expires   time.Time
}

// challengeStore holds in-flight WebAuthn ceremony state keyed by a random id
// carried in a short-lived cookie.
//
// ponytail: in-memory, single-process — restart mid-ceremony just means the
// user retries. Move to the DB only if this service ever needs horizontal
// scale.
type challengeStore struct {
	mu      sync.Mutex
	entries map[string]registerChallenge
}

func newChallengeStore() *challengeStore {
	return &challengeStore{entries: make(map[string]registerChallenge)}
}

func (s *challengeStore) put(c registerChallenge) (string, error) {
	id, err := randomToken(16)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, e := range s.entries {
		if now.After(e.expires) {
			delete(s.entries, k)
		}
	}
	s.entries[id] = c
	return id, nil
}

// take returns and deletes the challenge for id — single use regardless of
// whether it turns out to already be expired.
func (s *challengeStore) take(id string) (registerChallenge, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.entries[id]
	delete(s.entries, id)
	if !ok || time.Now().After(c.expires) {
		return registerChallenge{}, false
	}
	return c, true
}

// accountUser adapts a cloudstore.Account to webauthn.User for the
// registration ceremony. C0a only ever registers an account's first
// credential (gated by the claim token, with no prior credentials to list);
// later credentials registering behind a session would populate
// WebAuthnCredentials from cloudstore.CredentialsByAccount.
type accountUser struct {
	account *cloudstore.Account
}

func (u *accountUser) WebAuthnID() []byte                         { return []byte(u.account.ID) }
func (u *accountUser) WebAuthnName() string                       { return u.account.Subdomain }
func (u *accountUser) WebAuthnDisplayName() string                { return u.account.Subdomain }
func (u *accountUser) WebAuthnCredentials() []webauthn.Credential { return nil }

// rpForRequest builds a per-subdomain webauthn.WebAuthn scoped to r's host —
// see docs/cloud-crypto.md "RP ID": the per-user instance host gives
// per-account credential isolation for free.
func rpForRequest(r *http.Request) (*webauthn.WebAuthn, error) {
	rpID := stripPort(r.Host)
	return webauthn.New(&webauthn.Config{
		RPID:          rpID,
		RPDisplayName: "Med Tracker Cloud",
		RPOrigins:     []string{schemeForHost(rpID) + "://" + r.Host},
	})
}

// schemeForHost reports the scheme browsers use to reach host. *.localhost is
// a secure context over plain HTTP (docs/cloud-mode.md's local dev loop);
// every other host is served over HTTPS behind Traefik.
func schemeForHost(host string) string {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return "http"
	}
	return "https"
}

type registerBeginRequest struct {
	ClaimToken string `json:"claim_token"`
}

// RegisterBegin starts the first-credential registration ceremony for an
// unclaimed account. It requires the claim token from the invite URL
// fragment — the only place that token exists outside the server's hash.
func (a *WebAuthnAPI) RegisterBegin(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "account not resolved", http.StatusInternalServerError)
		return
	}

	var req registerBeginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ClaimToken == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	tokenHash, ok := validClaimToken(account, req.ClaimToken, time.Now().UTC())
	if !ok {
		http.Error(w, "invalid or expired claim", http.StatusForbidden)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	creation, session, err := wa.BeginRegistration(&accountUser{account: account},
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithExtensions(protocol.AuthenticationExtensions{"prf": map[string]any{}}),
	)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	challengeID, err := a.challenges.put(registerChallenge{
		session:   *session,
		accountID: account.ID,
		tokenHash: tokenHash,
		expires:   time.Now().Add(challengeTTL),
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     challengeCookieName,
		Value:    challengeID,
		Path:     "/api/webauthn/register",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(challengeTTL.Seconds()),
	})
	writeJSON(w, http.StatusOK, creation)
}

// RegisterFinish verifies the authenticator's response against the challenge
// started by RegisterBegin, then atomically invalidates the claim token and
// persists the credential — a claim can mint at most one credential.
func (a *WebAuthnAPI) RegisterFinish(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "account not resolved", http.StatusInternalServerError)
		return
	}

	cookie, err := r.Cookie(challengeCookieName)
	if err != nil {
		http.Error(w, "missing challenge", http.StatusBadRequest)
		return
	}
	clearChallengeCookie(w)

	challenge, ok := a.challenges.take(cookie.Value)
	if !ok || challenge.accountID != account.ID {
		http.Error(w, "challenge expired or unknown", http.StatusBadRequest)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	cred, err := wa.FinishRegistration(&accountUser{account: account}, challenge.session, r)
	if err != nil {
		http.Error(w, "registration failed", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	if _, err := a.store.ConsumeClaimToken(r.Context(), account.Subdomain, challenge.tokenHash, now); err != nil {
		if errors.Is(err, cloudstore.ErrClaimInvalid) {
			http.Error(w, "claim already used or expired", http.StatusConflict)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	if err := a.store.AddCredential(r.Context(), cloudstore.Credential{
		ID:         cred.ID,
		AccountID:  account.ID,
		PublicKey:  cred.PublicKey,
		Transports: transportsCSV(cred.Transport),
		SignCount:  cred.Authenticator.SignCount,
		CreatedAt:  now,
	}); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, sessionCookie(NewSessionToken(account.ID, cred.ID, a.sessionSecret)))
	writeJSON(w, http.StatusOK, map[string]string{"account_id": account.ID})
}

func clearChallengeCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     challengeCookieName,
		Value:    "",
		Path:     "/api/webauthn/register",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// validClaimToken checks token against account's stored claim (constant-time
// compare, not-expired) and returns the stored hash for the atomic consume in
// RegisterFinish.
func validClaimToken(account *cloudstore.Account, token string, now time.Time) ([]byte, bool) {
	if account.ClaimTokenHash == nil || account.ClaimExpiresAt == nil {
		return nil, false
	}
	if now.After(*account.ClaimExpiresAt) {
		return nil, false
	}
	raw, err := hex.DecodeString(token)
	if err != nil {
		return nil, false
	}
	sum := sha256.Sum256(raw)
	if subtle.ConstantTimeCompare(sum[:], account.ClaimTokenHash) != 1 {
		return nil, false
	}
	return account.ClaimTokenHash, true
}

func transportsCSV(t []protocol.AuthenticatorTransport) string {
	if len(t) == 0 {
		return ""
	}
	strs := make([]string, len(t))
	for i, x := range t {
		strs[i] = string(x)
	}
	return strings.Join(strs, ",")
}
