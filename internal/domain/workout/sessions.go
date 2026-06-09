package workout

import (
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// SessionView is one element of the ListSessions response. Its json tags
// reproduce, byte-for-byte, the anonymous EnrichedSession the HTTP handler
// historically emitted: the raw session object plus group/variant names and
// per-session exercise counts/volume. Session is stored as a value (matching
// the legacy handler, which assigned the range copy directly).
type SessionView struct {
	Session     store.WorkoutSession `json:"session"`
	GroupName   string               `json:"group_name"`
	VariantName string               `json:"variant_name"`
	Exercises   int                  `json:"exercises_count"`
	Completed   int                  `json:"exercises_completed"`
	TotalVolume float64              `json:"total_volume"` // Total weight lifted (sets * reps * weight)
}

// SessionDetails is the GetSessionDetails response: a single session with its
// exercise logs. The json tags reproduce the legacy handler's anonymous struct.
type SessionDetails struct {
	Session *store.WorkoutSession      `json:"session"`
	Logs    []store.WorkoutExerciseLog `json:"logs"`
}

// ListSessions returns the user's recent workout sessions (newest first, up to
// limit), enriched with group/variant names and per-session exercise counts and
// total volume. Ad-hoc sessions (group_id == -1) are labelled "Ad-hoc" and take
// their "variant" name from their biggest completed exercise by volume; their
// exercise count comes from the placeholder logs rather than a variant. The
// returned slice is always non-nil so an empty history marshals to `[]`.
func (s *Service) ListSessions(userID int64, limit int) ([]SessionView, error) {
	sessions, err := s.store.ListHistory(userID, limit)
	if err != nil {
		return nil, err
	}

	views := make([]SessionView, 0, len(sessions))
	for _, session := range sessions {
		group, _ := s.store.GetGroup(session.GroupID)
		variant, _ := s.store.GetVariant(session.VariantID)
		logs, _ := s.store.ListExerciseLogs(session.ID)
		exercises, _ := s.store.ListExercisesByVariant(session.VariantID)

		groupName := "Unknown"
		variantName := "Unknown"
		if session.GroupID == -1 {
			groupName = "Ad-hoc"
			// Find the biggest exercise by volume (sets * reps * weight).
			// For bodyweight exercises (nil WeightKg) use sets*reps as a proxy volume.
			bestName := ""
			bestVol := -1.0
			for _, log := range logs {
				if log.Status == "completed" {
					vol := 0.0
					if log.SetsCompleted != nil && log.RepsCompleted != nil && log.WeightKg != nil {
						vol = float64(*log.SetsCompleted) * float64(*log.RepsCompleted) * (*log.WeightKg)
					} else if log.SetsCompleted != nil && log.RepsCompleted != nil {
						vol = float64(*log.SetsCompleted) * float64(*log.RepsCompleted)
					}
					if vol > bestVol {
						bestVol = vol
						bestName = log.ExerciseName
					}
				}
			}
			variantName = bestName
		} else {
			if group != nil {
				groupName = group.Name
			}
			if variant != nil {
				variantName = variant.Name
			}
		}

		completedCount := 0
		totalVolume := 0.0
		for _, log := range logs {
			if log.Status == "completed" {
				completedCount++
				// Calculate volume: sets * reps * weight
				if log.SetsCompleted != nil && log.RepsCompleted != nil && log.WeightKg != nil {
					volume := float64(*log.SetsCompleted) * float64(*log.RepsCompleted) * (*log.WeightKg)
					totalVolume += volume
				}
			}
		}

		exerciseCount := len(exercises)
		if session.GroupID == -1 {
			exerciseCount = len(logs)
		}
		views = append(views, SessionView{
			Session:     session,
			GroupName:   groupName,
			VariantName: variantName,
			Exercises:   exerciseCount,
			Completed:   completedCount,
			TotalVolume: totalVolume,
		})
	}

	return views, nil
}

// GetSessionDetails returns a single session plus its exercise logs. Returns
// (nil, nil) when the session is missing or cannot be loaded — the handler maps
// that to a 404, matching the legacy "err != nil || session == nil" branch. A
// non-nil error is reserved for a logs-read failure (legacy 500).
func (s *Service) GetSessionDetails(sessionID int64) (*SessionDetails, error) {
	session, err := s.store.GetSession(sessionID)
	if err != nil || session == nil {
		return nil, nil
	}

	logs, err := s.store.ListExerciseLogs(sessionID)
	if err != nil {
		return nil, err
	}

	return &SessionDetails{Session: session, Logs: logs}, nil
}
