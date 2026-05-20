//go:build !mobile

package auth

import (
	"log/slog"
	"net/http"
)

// ValidateInitDataFunc validates a Telegram WebApp initData payload using the
// supplied bot token. Returns (valid, user, err).
type ValidateInitDataFunc func(token, initData string) (bool, *User, error)

// VerifySessionFunc verifies an OIDC session token cookie value against the
// supplied session secret. Returns (email, ok).
type VerifySessionFunc func(token, secret string) (string, bool)

// TelegramOIDCResolver is the server-mode UserResolver implementation. It
// supports both Telegram WebApp initData (header or query param) and a stateless
// OIDC session cookie. Behaviour mirrors the original AuthMiddleware logic
// exactly so server deployments see no functional change.
//
// Validation logic is injected via function values rather than imported so this
// package stays free of the server package and the mobile build can omit it
// entirely (see Task 6).
type TelegramOIDCResolver struct {
	botToken         string
	sessionSecret    string
	allowedUserID    int64
	validateInitData ValidateInitDataFunc
	verifySession    VerifySessionFunc
}

// NewTelegramOIDCResolver constructs a resolver wired to the supplied
// validators.
func NewTelegramOIDCResolver(
	botToken, sessionSecret string,
	allowedUserID int64,
	validateInitData ValidateInitDataFunc,
	verifySession VerifySessionFunc,
) *TelegramOIDCResolver {
	return &TelegramOIDCResolver{
		botToken:         botToken,
		sessionSecret:    sessionSecret,
		allowedUserID:    allowedUserID,
		validateInitData: validateInitData,
		verifySession:    verifySession,
	}
}

// Resolve mirrors the original AuthMiddleware order: OIDC session cookie first
// (treated as an admin login), then Telegram WebApp initData, then enforce
// allowedUserID.
func (r *TelegramOIDCResolver) Resolve(req *http.Request) (*User, error) {
	if cookie, err := req.Cookie("auth_session"); err == nil {
		if email, ok := r.verifySession(cookie.Value, r.sessionSecret); ok {
			return &User{
				ID:        r.allowedUserID,
				FirstName: "Admin",
				LastName:  "(OIDC)",
				Username:  email,
			}, nil
		}
		slog.Warn("AUTH Invalid session cookie", "remoteAddr", req.RemoteAddr, "cookieLen", len(cookie.Value))
	} else {
		slog.Debug("AUTH No auth_session cookie", "remoteAddr", req.RemoteAddr, "error", err)
	}

	initData := req.Header.Get("X-Telegram-Init-Data")
	if initData == "" {
		initData = req.URL.Query().Get("initData")
	}

	if initData == "" {
		slog.Warn("AUTH No auth data", "remoteAddr", req.RemoteAddr, "method", req.Method, "path", req.URL.Path)
		return nil, ErrNoAuth
	}

	valid, user, err := r.validateInitData(r.botToken, initData)
	if !valid || err != nil {
		slog.Warn("AUTH Invalid WebApp hash", "remoteAddr", req.RemoteAddr, "error", err)
		return nil, ErrInvalidAuth
	}

	if user.ID != r.allowedUserID {
		slog.Warn("AUTH Unauthorized user", "userID", user.ID, "username", user.Username, "remoteAddr", req.RemoteAddr)
		return nil, ErrUserNotAllowed
	}

	return user, nil
}
