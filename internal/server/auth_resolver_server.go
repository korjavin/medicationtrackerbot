//go:build !mobile

package server

import "github.com/korjavin/medicationtrackerbot/internal/server/auth"

// newDefaultResolver wires the server-mode auth resolver: Telegram WebApp
// initData + OIDC session cookie + allowedUserID enforcement. The mobile
// build has a paired file (auth_resolver_mobile.go) that returns a
// single-user resolver instead.
func newDefaultResolver(s *Server) auth.UserResolver {
	return auth.NewTelegramOIDCResolver(
		s.botToken,
		s.sessionSecret,
		s.allowedUserID,
		ValidateWebAppData,
		verifySessionToken,
	)
}
