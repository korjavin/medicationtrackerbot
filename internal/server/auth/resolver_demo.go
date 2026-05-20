package auth

import "net/http"

// DemoUserResolver is the runtime-flag counterpart to LocalUserResolver. The
// server build wires it in when DEMO_MODE=1 so a publicly browseable demo
// deployment can serve every visitor as a single fixed user without auth.
// Unlike LocalUserResolver (which is gated behind //go:build mobile), this
// resolver is tag-free so the same binary that ships to real deployments can
// flip into demo mode at boot.
type DemoUserResolver struct {
	user User
}

// NewDemoUserResolver returns a resolver that always resolves to the supplied
// user. cmd/bot/main_server.go constructs one with cfg.AllowedUserID (the same
// ID the operator targeted with cmd/seeddemo to populate the demo DB).
func NewDemoUserResolver(user User) *DemoUserResolver {
	return &DemoUserResolver{user: user}
}

// Resolve always returns the configured user. The request is ignored — demo
// mode advertises "no auth" as a feature.
func (r *DemoUserResolver) Resolve(_ *http.Request) (*User, error) {
	u := r.user
	return &u, nil
}
