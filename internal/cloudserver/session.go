package cloudserver

import (
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
// handlers; verified by the auth middleware added alongside login in the
// next task.
const SessionCookieName = "cloud_session"

const sessionTTL = 30 * 24 * time.Hour

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
	if err != nil || time.Since(time.Unix(ts, 0)) > sessionTTL {
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
