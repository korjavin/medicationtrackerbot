package workout

import (
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// GetRotationState returns the rotation state for a group, or (nil, nil) when no
// rotation state exists or it cannot be read. The handler maps the nil case to a
// 404, matching the legacy "err != nil || state == nil" branch — a read error is
// therefore swallowed rather than surfaced.
func (s *Service) GetRotationState(groupID int64) (*store.WorkoutRotationState, error) {
	state, err := s.store.GetRotationState(groupID)
	if err != nil || state == nil {
		return nil, nil
	}
	return state, nil
}

// InitializeRotation sets a group's rotation to begin at the given starting
// variant (INSERT OR REPLACE in the store). Errors propagate so the handler can
// return a 500.
func (s *Service) InitializeRotation(groupID, startingVariantID int64) error {
	return s.store.InitializeRotation(groupID, startingVariantID)
}
