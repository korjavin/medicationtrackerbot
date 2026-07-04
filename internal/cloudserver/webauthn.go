package cloudserver

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// webauthnStore is the subset of *cloudstore.Repo the registration and login
// ceremonies need.
type webauthnStore interface {
	ClaimAndAddCredential(ctx context.Context, subdomain string, tokenHash []byte, cred cloudstore.Credential, env cloudstore.Envelope, now time.Time) (*cloudstore.Account, error)
	CredentialsByAccount(ctx context.Context, accountID string) ([]cloudstore.Credential, error)
	TouchCredential(ctx context.Context, credentialID []byte, signCount uint32, assertedAt time.Time) error
}

// WebAuthnAPI holds the account-scoped WebAuthn HTTP handlers: registration
// and login.
type WebAuthnAPI struct {
	store           webauthnStore
	sessionSecret   string
	challenges      *challengeStore[registerChallenge]
	loginChallenges *challengeStore[loginChallenge]
}

// NewWebAuthnAPI builds the WebAuthn handlers. sessionSecret mints the HMAC
// session cookie (session.go) on successful registration or login.
func NewWebAuthnAPI(store webauthnStore, sessionSecret string) *WebAuthnAPI {
	return &WebAuthnAPI{
		store:           store,
		sessionSecret:   sessionSecret,
		challenges:      newChallengeStore[registerChallenge](),
		loginChallenges: newChallengeStore[loginChallenge](),
	}
}

// RegisterRoutes adds the WebAuthn ceremony routes to mux, so callers that
// need to combine several APIs' routes onto one mux (cmd/cloud) can do so
// without a second layer of muxing.
func (a *WebAuthnAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/webauthn/register/begin", a.RegisterBegin)
	mux.HandleFunc("POST /api/webauthn/register/finish", a.RegisterFinish)
	mux.HandleFunc("POST /api/webauthn/login/begin", a.LoginBegin)
	mux.HandleFunc("POST /api/webauthn/login/finish", a.LoginFinish)
}

// maxRegisterFinishBodyBytes caps the finish body, which now carries the
// WebAuthn attestation response (a few KiB) plus the first envelope.
const maxRegisterFinishBodyBytes = 64 << 10

const challengeCookieName = "cloud_webauthn_challenge"
const loginChallengeCookieName = "cloud_webauthn_login_challenge"
const challengeTTL = 5 * time.Minute

// registerChallenge is what challengeStore holds between RegisterBegin and
// RegisterFinish: the go-webauthn session data plus enough of the claim to
// consume it atomically once the ceremony verifies.
type registerChallenge struct {
	session   webauthn.SessionData
	accountID string
	tokenHash []byte
}

// loginChallenge is what challengeStore holds between LoginBegin and
// LoginFinish.
type loginChallenge struct {
	session   webauthn.SessionData
	accountID string
}

// challengeStore holds in-flight WebAuthn ceremony state keyed by a random id
// carried in a short-lived cookie.
//
// ponytail: in-memory, single-process — restart mid-ceremony just means the
// user retries. Move to the DB only if this service ever needs horizontal
// scale.
type challengeStore[T any] struct {
	mu      sync.Mutex
	entries map[string]challengeEntry[T]
}

type challengeEntry[T any] struct {
	value   T
	expires time.Time
}

func newChallengeStore[T any]() *challengeStore[T] {
	return &challengeStore[T]{entries: make(map[string]challengeEntry[T])}
}

func (s *challengeStore[T]) put(v T) (string, error) {
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
	s.entries[id] = challengeEntry[T]{value: v, expires: now.Add(challengeTTL)}
	return id, nil
}

// take returns and deletes the challenge for id — single use regardless of
// whether it turns out to already be expired.
func (s *challengeStore[T]) take(id string) (T, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	delete(s.entries, id)
	if !ok || time.Now().After(e.expires) {
		var zero T
		return zero, false
	}
	return e.value, true
}

// accountUser adapts a cloudstore.Account to webauthn.User. Registration
// leaves creds nil (the claim-gated first credential has no prior credentials
// to list); login populates it from cloudstore.CredentialsByAccount.
type accountUser struct {
	account *cloudstore.Account
	creds   []webauthn.Credential
}

func (u *accountUser) WebAuthnID() []byte                         { return []byte(u.account.ID) }
func (u *accountUser) WebAuthnName() string                       { return u.account.Subdomain }
func (u *accountUser) WebAuthnDisplayName() string                { return u.account.Subdomain }
func (u *accountUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// toWebAuthnCredentials adapts stored credentials to what go-webauthn's login
// ceremony needs to verify a signature and check the sign counter.
func toWebAuthnCredentials(stored []cloudstore.Credential) []webauthn.Credential {
	creds := make([]webauthn.Credential, len(stored))
	for i, c := range stored {
		creds[i] = webauthn.Credential{
			ID:            c.ID,
			PublicKey:     c.PublicKey,
			Authenticator: webauthn.Authenticator{SignCount: c.SignCount},
		}
	}
	return creds
}

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
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeBodyBytes)
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
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	setChallengeCookie(w, challengeCookieName, "/api/webauthn/register", challengeID)
	writeJSON(w, http.StatusOK, creation)
}

// registerFinishRequest is the finish body: the WebAuthn attestation response
// plus the first credential's DEK envelope. Bundling the envelope lets the
// server persist credential + envelope in one transaction (see
// ClaimAndAddCredential) so a reload/crash can never strand a credential with
// no envelope to unwrap its DEK — the "one transaction" first-signup upload of
// docs/cloud-crypto.md.
type registerFinishRequest struct {
	Credential json.RawMessage `json:"credential"`
	Envelope   envelopeWire    `json:"envelope"`
}

// RegisterFinish verifies the authenticator's response against the challenge
// started by RegisterBegin, then atomically invalidates the claim token and
// persists the credential + its DEK envelope — a claim can mint at most one
// credential.
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
	clearChallengeCookie(w, challengeCookieName, "/api/webauthn/register")

	challenge, ok := a.challenges.take(cookie.Value)
	if !ok || challenge.accountID != account.ID {
		http.Error(w, "challenge expired or unknown", http.StatusBadRequest)
		return
	}

	var req registerFinishRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxRegisterFinishBodyBytes)).Decode(&req); err != nil || len(req.Credential) == 0 {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.Envelope.Nonce) == 0 || len(req.Envelope.Nonce) > maxNonceLen ||
		len(req.Envelope.CT) == 0 || len(req.Envelope.CT) > maxCTLen || len(req.Envelope.MAC) > maxMACLen {
		http.Error(w, "envelope field too large or missing", http.StatusBadRequest)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		http.Error(w, "registration failed", http.StatusBadRequest)
		return
	}
	cred, err := wa.CreateCredential(&accountUser{account: account}, challenge.session, parsed)
	if err != nil {
		http.Error(w, "registration failed", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	if _, err := a.store.ClaimAndAddCredential(r.Context(), account.Subdomain, challenge.tokenHash, cloudstore.Credential{
		ID:         cred.ID,
		AccountID:  account.ID,
		PublicKey:  cred.PublicKey,
		Transports: transportsCSV(cred.Transport),
		SignCount:  cred.Authenticator.SignCount,
		CreatedAt:  now,
	}, cloudstore.Envelope{
		AccountID:     account.ID,
		CredentialRef: base64.RawURLEncoding.EncodeToString(cred.ID),
		V:             req.Envelope.V,
		Nonce:         req.Envelope.Nonce,
		CT:            req.Envelope.CT,
		MAC:           req.Envelope.MAC,
	}, now); err != nil {
		if errors.Is(err, cloudstore.ErrClaimInvalid) {
			http.Error(w, "claim already used or expired", http.StatusConflict)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, sessionCookie(NewSessionToken(account.ID, cred.ID, a.sessionSecret)))
	writeJSON(w, http.StatusOK, map[string]string{"account_id": account.ID})
}

// LoginBegin starts an assertion ceremony against the account's existing
// credentials, resolved from the subdomain host. The client adds the PRF
// eval extension itself (server never sees PRF output) — see
// docs/cloud-crypto.md's cold-unlock flow.
func (a *WebAuthnAPI) LoginBegin(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "account not resolved", http.StatusInternalServerError)
		return
	}

	creds, err := a.store.CredentialsByAccount(r.Context(), account.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	assertion, session, err := wa.BeginLogin(&accountUser{account: account, creds: toWebAuthnCredentials(creds)},
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		http.Error(w, "no credentials to authenticate with", http.StatusBadRequest)
		return
	}

	challengeID, err := a.loginChallenges.put(loginChallenge{session: *session, accountID: account.ID})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	setChallengeCookie(w, loginChallengeCookieName, "/api/webauthn/login", challengeID)
	writeJSON(w, http.StatusOK, assertion)
}

// LoginFinish verifies the assertion against the challenge started by
// LoginBegin, updates the credential's sign counter, and issues a fresh
// session cookie.
func (a *WebAuthnAPI) LoginFinish(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "account not resolved", http.StatusInternalServerError)
		return
	}

	cookie, err := r.Cookie(loginChallengeCookieName)
	if err != nil {
		http.Error(w, "missing challenge", http.StatusBadRequest)
		return
	}
	clearChallengeCookie(w, loginChallengeCookieName, "/api/webauthn/login")

	challenge, ok := a.loginChallenges.take(cookie.Value)
	if !ok || challenge.accountID != account.ID {
		http.Error(w, "challenge expired or unknown", http.StatusBadRequest)
		return
	}

	creds, err := a.store.CredentialsByAccount(r.Context(), account.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	// go-webauthn parses r.Body with no size cap of its own; bound it before the
	// unauthenticated assertion is decoded into memory.
	r.Body = http.MaxBytesReader(w, r.Body, maxRegisterFinishBodyBytes)
	cred, err := wa.FinishLogin(&accountUser{account: account, creds: toWebAuthnCredentials(creds)}, challenge.session, r)
	if err != nil {
		http.Error(w, "login failed", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	if err := a.store.TouchCredential(r.Context(), cred.ID, cred.Authenticator.SignCount, now); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, sessionCookie(NewSessionToken(account.ID, cred.ID, a.sessionSecret)))
	writeJSON(w, http.StatusOK, map[string]string{"account_id": account.ID})
}

func setChallengeCookie(w http.ResponseWriter, name, path, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     path,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(challengeTTL.Seconds()),
	})
}

func clearChallengeCookie(w http.ResponseWriter, name, path string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
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
