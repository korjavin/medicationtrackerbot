// Package auth contains the UserResolver abstraction for HTTP request
// authentication. The interface decouples "who is the current user?" from the
// middleware that enforces it, so different builds (server vs. mobile) can plug
// in different resolvers (Telegram WebApp + OIDC, or a single local user).
//
// Current "who is the current user?" call sites in the codebase:
//   - internal/server/auth.go:AuthMiddleware — wraps every /api/* request,
//     checks the auth_session cookie (OIDC) first, then the X-Telegram-Init-Data
//     header / ?initData= query for Telegram WebApp, and finally enforces
//     allowedUserID. The resolved user is stored in the request context under
//     server.UserCtxKey for downstream handlers.
//   - HTTP handlers across internal/server/* read the user back via
//     r.Context().Value(server.UserCtxKey).(*server.TelegramUser).
//
// TelegramOIDCResolver, defined alongside this interface, implements the
// existing server-mode behaviour exactly. Task 6 will pair it with a
// LocalUserResolver behind a //go:build mobile tag.
package auth

import (
	"errors"
	"net/http"
)

// User is the identity carried in request context after a successful resolve.
// Fields match the legacy server.TelegramUser shape so handler code that reads
// (*TelegramUser).ID continues to work via a type alias.
type User struct {
	ID        int64  `json:"id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

// UserResolver inspects an incoming HTTP request and returns the authenticated
// user, or one of the sentinel errors below.
type UserResolver interface {
	Resolve(r *http.Request) (*User, error)
}

// Sentinel errors. Middleware maps them to HTTP status codes; resolvers should
// wrap or return them so the mapping is consistent across implementations.
var (
	// ErrNoAuth means the request carried no usable auth credentials at all
	// (no session cookie, no Telegram initData). Maps to 401.
	ErrNoAuth = errors.New("no auth data")
	// ErrInvalidAuth means credentials were present but invalid (bad hash,
	// expired auth_date, tampered payload). Maps to 403.
	ErrInvalidAuth = errors.New("invalid auth")
	// ErrUserNotAllowed means credentials were valid but the resolved user
	// is not the one configured for this deployment. Maps to 403.
	ErrUserNotAllowed = errors.New("user not allowed")
)
