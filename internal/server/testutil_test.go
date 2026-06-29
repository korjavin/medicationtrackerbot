package server

import (
	gamificationsvc "github.com/korjavin/medicationtrackerbot/internal/domain/gamification"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// newServer wraps New for tests, building the gamification service from the store.
// All test-internal New() calls should use this to avoid repeating the svc constructor.
func newServer(s *store.Store, botToken, sessionSecret string, allowedUserID int64, oidc OIDCConfig, botUsername, vapidPublicKey string) *Server {
	gamSvc := gamificationsvc.New(s.Medication, s.BP, s.Weight, s.Vitals, s.Food, s.Diary, s.Workout, s.Gamification, s.Settings)
	return New(s, gamSvc, botToken, sessionSecret, allowedUserID, oidc, botUsername, vapidPublicKey)
}
