//go:build mobile

package server

import "github.com/korjavin/medicationtrackerbot/internal/server/auth"

// newDefaultResolver wires the mobile-build auth resolver: a single-user
// resolver that ignores the request and always returns the configured local
// user. The Capacitor wrapper is the trust boundary; HTTP-level auth is not
// meaningful for a localhost-only embedded server.
func newDefaultResolver(s *Server) auth.UserResolver {
	return auth.NewLocalUserResolver(auth.User{
		ID:        s.allowedUserID,
		FirstName: "Local",
		Username:  "local",
	})
}
