//go:build !mobile

package server

import "github.com/korjavin/medicationtrackerbot/internal/server/auth"

// newDefaultResolver wires the server-mode auth resolver. Default path:
// Telegram WebApp initData + OIDC session cookie + allowedUserID enforcement.
// When DEMO_MODE is on (s.demoMode == true) the server skips auth entirely and
// hands every request to the configured demo user — the public-demo
// counterpart of the mobile build's LocalUserResolver. The mobile build has a
// paired file (auth_resolver_mobile.go) that returns a single-user resolver
// for the Capacitor wrapper instead.
func newDefaultResolver(s *Server) auth.UserResolver {
	if s.demoMode {
		return auth.NewDemoUserResolver(auth.User{
			ID:        s.allowedUserID,
			FirstName: "Demo",
			Username:  "demo",
		})
	}
	return auth.NewTelegramOIDCResolver(
		s.botToken,
		s.sessionSecret,
		s.allowedUserID,
		ValidateWebAppData,
		verifySessionToken,
	)
}
