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
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// logCeremonyFailure surfaces go-webauthn validation failures in the server
// log — the HTTP responses are deliberately generic, so without this a real
// authenticator being rejected (flag mismatch, origin, signature) is
// undiagnosable. protocol.Error carries the useful detail in DevInfo.
func logCeremonyFailure(ceremony, accountID string, err error) {
	var pErr *protocol.Error
	if errors.As(err, &pErr) {
		slog.Warn("cloudserver: webauthn ceremony failed", "ceremony", ceremony, "account", accountID, "error", err, "devInfo", pErr.DevInfo)
		return
	}
	slog.Warn("cloudserver: webauthn ceremony failed", "ceremony", ceremony, "account", accountID, "error", err)
}

// webauthnStore is the subset of *cloudstore.Repo the registration and login
// ceremonies need.
type webauthnStore interface {
	ClaimAndAddCredential(ctx context.Context, subdomain string, tokenHash []byte, cred cloudstore.Credential, env cloudstore.Envelope, now time.Time) (*cloudstore.Account, error)
	ValidEnrollmentToken(ctx context.Context, accountID string, tokenHash []byte, now time.Time) (bool, error)
	RedeemTransferToken(ctx context.Context, accountID string, tokenHash []byte, cred cloudstore.Credential, env cloudstore.Envelope, now time.Time) error
	AddCredentialWithEnvelope(ctx context.Context, sourceCredentialID []byte, cred cloudstore.Credential, env cloudstore.Envelope) error
	CredentialsByAccount(ctx context.Context, accountID string) ([]cloudstore.Credential, error)
	TouchCredential(ctx context.Context, credentialID []byte, signCount uint32, assertedAt time.Time) error
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// WebAuthnAPI holds the account-scoped WebAuthn HTTP handlers: registration
// and login.
type WebAuthnAPI struct {
	store           webauthnStore
	sessionSecret   string
	challenges      *challengeStore[registerChallenge]
	loginChallenges *challengeStore[loginChallenge]
	// reauthChallenges is a SEPARATE store from loginChallenges so the re-auth
	// ceremony (which gates account deletion) and the login ceremony (which
	// mints a session) cannot cross-redeem each other's challenge ids. Both bind
	// the assertion to the challenge's random bytes, so sharing a store was not
	// an auth bypass — but keeping them apart makes "re-auth is not login"
	// structural rather than a matter of which cookie name was used (med-d5t.8).
	reauthChallenges *challengeStore[loginChallenge]
}

// NewWebAuthnAPI builds the WebAuthn handlers. sessionSecret mints the HMAC
// session cookie (session.go) on successful registration or login.
func NewWebAuthnAPI(store webauthnStore, sessionSecret string) *WebAuthnAPI {
	return &WebAuthnAPI{
		store:            store,
		sessionSecret:    sessionSecret,
		challenges:       newChallengeStore[registerChallenge](),
		loginChallenges:  newChallengeStore[loginChallenge](),
		reauthChallenges: newChallengeStore[loginChallenge](),
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

// registerGate identifies which of the three ways RegisterBegin authorized a
// registration ceremony, so RegisterFinish knows how to persist the result:
// consume a signup claim, redeem a device-transfer enrollment token, or (an
// already-unlocked device) just add the credential under the live session.
type registerGate int

const (
	gateClaim registerGate = iota
	gateEnrollment
	gateSession
)

// registerChallenge is what challengeStore holds between RegisterBegin and
// RegisterFinish: the go-webauthn session data plus enough of the claim to
// consume it atomically once the ceremony verifies.
type registerChallenge struct {
	session   webauthn.SessionData
	accountID string
	gate      registerGate
	tokenHash []byte
	// sessionCredentialID is the credential the session cookie was minted for,
	// remembered only for gateSession so RegisterFinish can re-check it still
	// exists — otherwise a device revoked mid-ceremony could finish within the
	// challenge TTL and mint a fresh credential, defeating its own revocation.
	sessionCredentialID []byte
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
			ID:        c.ID,
			PublicKey: c.PublicKey,
			// Flags must round-trip from registration: FinishLogin rejects
			// assertions whose BE bit differs from the stored credential, and
			// synced passkeys (Apple/Google/1Password) always assert BE=1.
			Flags:         webauthn.CredentialFlags{BackupEligible: c.BackupEligible, BackupState: c.BackupState},
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
	ClaimToken      string `json:"claim_token,omitempty"`
	EnrollmentToken string `json:"enrollment_token,omitempty"`
}

// RegisterBegin starts a registration ceremony, gated one of three ways: a
// signup claim token (first credential on a fresh account), an enrollment
// token from a claimed device-transfer slot (adding a second device), or
// plain session auth (an already-unlocked device enrolling an additional
// local passkey).
func (a *WebAuthnAPI) RegisterBegin(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "account not resolved", http.StatusInternalServerError)
		return
	}

	var req registerBeginRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	var (
		gate                registerGate
		tokenHash           []byte
		sessionCredentialID []byte
	)
	switch {
	case req.ClaimToken != "":
		hash, valid := validClaimToken(account, req.ClaimToken, time.Now().UTC())
		if !valid {
			// A NULL claim hash means either "already claimed" or "expired and
			// swept" — consumeClaimTx NULLs it in both cases. Registered
			// credentials are what tell the two apart, and the client needs the
			// difference: a claimed link must prompt unlock, not passkey creation.
			if account.ClaimTokenHash == nil {
				creds, err := a.store.CredentialsByAccount(r.Context(), account.ID)
				if err != nil {
					slog.Error("register begin: credential lookup", "error", err, "account_id", account.ID)
					http.Error(w, "server error", http.StatusInternalServerError)
					return
				}
				if len(creds) > 0 {
					writeJSON(w, http.StatusConflict, map[string]string{"error": "already_claimed"})
					return
				}
			}
			http.Error(w, "invalid or expired claim", http.StatusForbidden)
			return
		}
		gate, tokenHash = gateClaim, hash
	case req.EnrollmentToken != "":
		hash, valid := hashHexToken(req.EnrollmentToken)
		if !valid {
			http.Error(w, "invalid or expired enrollment token", http.StatusForbidden)
			return
		}
		ok, err := a.store.ValidEnrollmentToken(r.Context(), account.ID, hash, time.Now().UTC())
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "invalid or expired enrollment token", http.StatusForbidden)
			return
		}
		gate, tokenHash = gateEnrollment, hash
	default:
		session, ok := sessionForAccount(r, a.sessionSecret, account.ID)
		if !ok {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		// sessionForAccount only checks the HMAC signature + expiry, not that
		// the session's credential still exists. Mirror RequireSession's
		// revocation check here so a revoked device (credential deleted, but a
		// 30-day session cookie + in-memory DEK still in hand) can't self-enroll
		// a fresh credential and defeat its own revocation (Task 5).
		exists, err := a.store.CredentialExists(r.Context(), session.CredentialID)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !exists {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		gate, sessionCredentialID = gateSession, session.CredentialID
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
		session:             *session,
		accountID:           account.ID,
		gate:                gate,
		tokenHash:           tokenHash,
		sessionCredentialID: sessionCredentialID,
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
		logCeremonyFailure("register", account.ID, err)
		http.Error(w, "registration failed", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	credRow := cloudstore.Credential{
		ID:             cred.ID,
		AccountID:      account.ID,
		PublicKey:      cred.PublicKey,
		Transports:     transportsCSV(cred.Transport),
		SignCount:      cred.Authenticator.SignCount,
		BackupEligible: cred.Flags.BackupEligible,
		BackupState:    cred.Flags.BackupState,
		CreatedAt:      now,
	}
	envRow := cloudstore.Envelope{
		AccountID:     account.ID,
		CredentialRef: base64.RawURLEncoding.EncodeToString(cred.ID),
		V:             req.Envelope.V,
		Nonce:         req.Envelope.Nonce,
		CT:            req.Envelope.CT,
		MAC:           req.Envelope.MAC,
	}

	switch challenge.gate {
	case gateClaim:
		if _, err := a.store.ClaimAndAddCredential(r.Context(), account.Subdomain, challenge.tokenHash, credRow, envRow, now); err != nil {
			if errors.Is(err, cloudstore.ErrClaimInvalid) {
				http.Error(w, "claim already used or expired", http.StatusConflict)
				return
			}
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	case gateEnrollment:
		if err := a.store.RedeemTransferToken(r.Context(), account.ID, challenge.tokenHash, credRow, envRow, now); err != nil {
			if errors.Is(err, cloudstore.ErrTransferSlotInvalid) {
				http.Error(w, "enrollment token already used or expired", http.StatusConflict)
				return
			}
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	case gateSession:
		// The source credential's existence is re-checked inside
		// AddCredentialWithEnvelope's transaction: RegisterBegin verified it, but
		// a revocation can land inside the 5-minute challenge TTL. Doing the check
		// in the same tx as the insert (not as a separate pre-read) closes the
		// TOCTOU where a revocation commits between check and insert — otherwise a
		// device revoked mid-ceremony could finish and mint a fresh credential +
		// session, defeating its own revocation.
		if err := a.store.AddCredentialWithEnvelope(r.Context(), challenge.sessionCredentialID, credRow, envRow); err != nil {
			if errors.Is(err, cloudstore.ErrSourceCredentialRevoked) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
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
		logCeremonyFailure("login", account.ID, err)
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

// reauthChallengeCookieName carries the re-authentication challenge for an
// irreversible action (account deletion, med-d5t.8). Distinct from the login
// challenge because it is scoped to a different path — the finishing endpoint is
// not under /api/webauthn/login — and must never issue a session.
const reauthChallengeCookieName = "cloud_webauthn_reauth_challenge"

// BeginReauth issues a fresh WebAuthn assertion challenge for the caller's
// account, to gate a destructive action. It mirrors LoginBegin but scopes its
// challenge cookie to cookiePath so an endpoint outside /api/webauthn/login
// receives it, and it never mints a session. Writes the assertion JSON on
// success. cookiePath must be a prefix of both this route and the verifying
// route (e.g. "/api/account").
func (a *WebAuthnAPI) BeginReauth(w http.ResponseWriter, r *http.Request, cookiePath string) {
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
	challengeID, err := a.reauthChallenges.put(loginChallenge{session: *session, accountID: account.ID})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	setChallengeCookie(w, reauthChallengeCookieName, cookiePath, challengeID)
	writeJSON(w, http.StatusOK, assertion)
}

// VerifyReauth consumes the BeginReauth challenge and verifies the assertion in
// r.Body against the caller account's credentials. Returns true on a valid fresh
// assertion; writes the error response and returns false otherwise. It issues NO
// session — its only job is to prove the user is physically present with a
// registered passkey, so a stolen session cookie alone cannot drive the gated
// action (med-d5t.8).
func (a *WebAuthnAPI) VerifyReauth(w http.ResponseWriter, r *http.Request, cookiePath string) bool {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "account not resolved", http.StatusInternalServerError)
		return false
	}
	cookie, err := r.Cookie(reauthChallengeCookieName)
	if err != nil {
		http.Error(w, "missing challenge", http.StatusBadRequest)
		return false
	}
	clearChallengeCookie(w, reauthChallengeCookieName, cookiePath)

	challenge, ok := a.reauthChallenges.take(cookie.Value)
	if !ok || challenge.accountID != account.ID {
		http.Error(w, "challenge expired or unknown", http.StatusBadRequest)
		return false
	}
	creds, err := a.store.CredentialsByAccount(r.Context(), account.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return false
	}
	wa, err := rpForRequest(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRegisterFinishBodyBytes)
	cred, err := wa.FinishLogin(&accountUser{account: account, creds: toWebAuthnCredentials(creds)}, challenge.session, r)
	if err != nil {
		logCeremonyFailure("reauth", account.ID, err)
		http.Error(w, "reauthentication failed", http.StatusForbidden)
		return false
	}
	// Advance the sign counter like a normal login, so a cloned authenticator's
	// stale counter is still caught on the next real assertion.
	if err := a.store.TouchCredential(r.Context(), cred.ID, cred.Authenticator.SignCount, time.Now().UTC()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return false
	}
	return true
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

// hashHexToken decodes a hex-encoded token (the wire format shared by claim
// and enrollment tokens, see NewClaimToken) and returns its SHA-256 hash —
// what the store compares against.
func hashHexToken(token string) ([]byte, bool) {
	raw, err := hex.DecodeString(token)
	if err != nil {
		return nil, false
	}
	sum := sha256.Sum256(raw)
	return sum[:], true
}

// sessionForAccount checks for a valid session cookie bound to accountID,
// without requiring one — RegisterBegin falls back to this only when neither
// a claim nor an enrollment token was supplied, so an already-unlocked device
// can enroll an additional local passkey.
func sessionForAccount(r *http.Request, sessionSecret, accountID string) (Session, bool) {
	cookie, err := r.Cookie(SessionCookieName)
	if err != nil {
		return Session{}, false
	}
	sid, credID, ok := VerifySessionToken(cookie.Value, sessionSecret)
	if !ok || sid != accountID {
		return Session{}, false
	}
	return Session{AccountID: sid, CredentialID: credID}, true
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
