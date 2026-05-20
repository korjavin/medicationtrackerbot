//go:build mobile

package auth

import "net/http"

// LocalUserResolver is the mobile-build UserResolver. There is no Telegram
// initData, no OIDC session, and no allowlist enforcement — the mobile app
// embeds the server on localhost and trusts itself. Every request resolves to
// a single fixed user identity supplied at construction time. The Capacitor
// wrapper is the auth boundary; HTTP-level auth would only add ceremony.
type LocalUserResolver struct {
	user User
}

// NewLocalUserResolver returns a resolver that always resolves to the supplied
// user. cmd/bot/main_mobile.go constructs one with the configured local user
// ID (default 1, or read from a --user-id argv flag).
func NewLocalUserResolver(user User) *LocalUserResolver {
	return &LocalUserResolver{user: user}
}

// Resolve always returns the configured user. The request is ignored.
func (r *LocalUserResolver) Resolve(_ *http.Request) (*User, error) {
	u := r.user
	return &u, nil
}
