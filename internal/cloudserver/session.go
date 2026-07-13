package cloudserver

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SessionCookieName is the cookie carrying an account's HMAC session token,
// scoped to the subdomain host. Minted by the WebAuthn register/login finish
// handlers; verified by RequireSession for every account-scoped API route.
const SessionCookieName = "cloud_session"

const sessionTTL = 30 * 24 * time.Hour

// sessionMaxFutureSkew bounds how far in the future a token's mint timestamp
// may be and still verify. Without it, time.Since(ts) is negative for any
// future-dated timestamp and always passes the TTL check, so a clock rollback
// or a future-minted token would extend a session indefinitely. Five minutes
// absorbs ordinary clock drift between the minting and verifying processes.
const sessionMaxFutureSkew = 5 * time.Minute

// NewSessionToken mints a stateless HMAC session token for accountID +
// credentialID, mirroring internal/server/google_auth.go's
// createSessionToken shape (payload|nonce-free here since account+credential
// ids already carry enough entropy) — base64url(payload) + "." + hex(hmac).
func NewSessionToken(accountID string, credentialID []byte, secret string) string {
	payload := fmt.Sprintf("%s|%s|%d", accountID, hex.EncodeToString(credentialID), time.Now().Unix())
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(payload))
	sig := hex.EncodeToString(h.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
}

// VerifySessionToken validates token against secret and returns the account
// id + credential id it carries, if the signature is valid and the token has
// not expired.
func VerifySessionToken(token, secret string) (accountID string, credentialID []byte, ok bool) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return "", nil, false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", nil, false
	}
	h := hmac.New(sha256.New, []byte(secret))
	h.Write(payloadBytes)
	sig, err := hex.DecodeString(parts[1])
	if err != nil || !hmac.Equal(h.Sum(nil), sig) {
		return "", nil, false
	}
	payloadParts := strings.Split(string(payloadBytes), "|")
	if len(payloadParts) != 3 {
		return "", nil, false
	}
	ts, err := strconv.ParseInt(payloadParts[2], 10, 64)
	if err != nil {
		return "", nil, false
	}
	// age > sessionTTL: expired. age < -sessionMaxFutureSkew: minted too far in
	// the future (clock rollback / forged forward timestamp), which would
	// otherwise never expire.
	age := time.Since(time.Unix(ts, 0))
	if age > sessionTTL || age < -sessionMaxFutureSkew {
		return "", nil, false
	}
	credID, err := hex.DecodeString(payloadParts[1])
	if err != nil {
		return "", nil, false
	}
	return payloadParts[0], credID, true
}

// sessionCookie builds the HttpOnly/Secure/SameSite=Lax cookie carrying token,
// scoped to the whole subdomain origin (account shell + API share it).
func sessionCookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	}
}

// Session is the verified identity RequireSession attaches to a request's
// context.
type Session struct {
	AccountID    string
	CredentialID []byte
}

type sessionCtxKey struct{}

// sessionStore is the subset of *cloudstore.Repo RequireSession needs to
// check that a session token's credential hasn't been revoked since it was
// minted.
type sessionStore interface {
	CredentialExists(ctx context.Context, accountID string, credentialID []byte) (bool, error)
}

// RequireSession wraps next with session-cookie authentication for
// account-scoped "/api/*" routes: missing/invalid/expired cookies get 401.
// It also rejects a session whose account id doesn't match the account
// resolved from the request's subdomain host (router.go's AccountFromContext)
// — defense in depth against a session token replayed against another
// account's subdomain — and whose credential has since been revoked (Task 5
// device removal): session tokens carry credential_id, so checking it still
// exists here means every route inherits revocation for free rather than
// each handler re-checking it.
func RequireSession(store sessionStore, sessionSecret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		accountID, credentialID, ok := VerifySessionToken(cookie.Value, sessionSecret)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// These routes are always mounted behind the subdomain branch, which
		// resolves an account before dispatch. A missing account means the
		// middleware was reached off that path — fail closed rather than trust
		// a session token that can't be bound to this host's account.
		account, resolved := AccountFromContext(r.Context())
		if !resolved || account.ID != accountID {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		exists, err := store.CredentialExists(r.Context(), accountID, credentialID)
		if err != nil || !exists {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), sessionCtxKey{}, Session{AccountID: accountID, CredentialID: credentialID})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// SessionFromContext returns the verified session RequireSession attached to
// ctx.
func SessionFromContext(ctx context.Context) (Session, bool) {
	s, ok := ctx.Value(sessionCtxKey{}).(Session)
	return s, ok
}
