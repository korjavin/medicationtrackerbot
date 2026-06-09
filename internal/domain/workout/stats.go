package workout

import (
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// WeekActivity is one bucket of the weekly activity heatmap in Stats. Its json
// tags reproduce, byte-for-byte, the anonymous struct the HTTP handler
// historically emitted inside weekly_activity.
type WeekActivity struct {
	Week      string `json:"week"`
	Completed int    `json:"completed"`
	Skipped   int    `json:"skipped"`
}

// Stats is the GetStats response. Its json tags reproduce, byte-for-byte, the
// anonymous struct handleGetWorkoutStats historically emitted. Two nil-vs-empty
// distinctions are load-bearing and deliberately preserved:
//   - WeeklyActivity stays nil (marshals to JSON null) when no session falls in
//     the 12-week window — the legacy handler declared it with `var` and only
//     appended, so an empty heatmap is null, not [].
//   - TopExercises is whatever ListExerciseStats returns; its read error is
//     swallowed (legacy `exerciseStats, _ := ...`), so a failed read marshals to
//     null as well.
type Stats struct {
	TotalSessions     int                  `json:"total_sessions"`
	CompletedSessions int                  `json:"completed_sessions"`
	SkippedSessions   int                  `json:"skipped_sessions"`
	CompletionRate    float64              `json:"completion_rate"`
	ActiveWeeks       int                  `json:"active_weeks"`
	TopExercises      []store.ExerciseStat `json:"top_exercises"`
	WeeklyActivity    []WeekActivity       `json:"weekly_activity"`
}

// GetStats computes the user's 30-day session counts, completion rate, a 12-week
// completed/skipped activity heatmap (bucketed by ISO Monday), and the top
// exercises by aggregate volume. It reads up to the last 500 sessions, enough to
// cover both windows. Day boundaries are derived from the service's injectable
// Now clock (the legacy handler called time.Now() inline), which makes the time
// windows testable for the first time.
func (s *Service) GetStats(userID int64) (*Stats, error) {
	// Fetch enough sessions for streak + 30-day stats
	sessions, err := s.store.ListHistory(userID, 500)
	if err != nil {
		return nil, err
	}

	now := s.Now()
	since30 := now.AddDate(0, 0, -30)
	cutoff12w := now.AddDate(0, 0, -84)

	// 30-day counts
	totalSessions := 0
	completedSessions := 0
	skippedSessions := 0

	// Weekly activity heatmap (last 12 weeks)
	weekMap := make(map[string]*WeekActivity)
	mondayOf := func(t time.Time) string {
		d := t
		for d.Weekday() != time.Monday {
			d = d.AddDate(0, 0, -1)
		}
		return d.Format("2006-01-02")
	}

	for _, session := range sessions {
		// 30-day stats
		if !session.ScheduledDate.Before(since30) {
			switch session.Status {
			case "completed":
				completedSessions++
				totalSessions++
			case "skipped":
				skippedSessions++
				totalSessions++
			}
		}

		// Weekly heatmap
		if !session.ScheduledDate.Before(cutoff12w) {
			week := mondayOf(session.ScheduledDate)
			if _, ok := weekMap[week]; !ok {
				weekMap[week] = &WeekActivity{Week: week}
			}
			switch session.Status {
			case "completed":
				weekMap[week].Completed++
			case "skipped":
				weekMap[week].Skipped++
			}
		}
	}

	// Sort weekly activity chronologically
	var weekKeys []string
	for w := range weekMap {
		weekKeys = append(weekKeys, w)
	}
	sort.Strings(weekKeys)
	var weeklyActivity []WeekActivity
	activeWeeks := 0
	for _, w := range weekKeys {
		activity := *weekMap[w]
		weeklyActivity = append(weeklyActivity, activity)
		if activity.Completed > 0 {
			activeWeeks++
		}
	}

	// Exercise stats from DB. The read error is intentionally swallowed to
	// match the legacy handler: a failed read leaves TopExercises nil (null).
	exerciseStats, _ := s.store.ListExerciseStats(userID)

	completionRate := 0.0
	if totalSessions > 0 {
		completionRate = float64(completedSessions) / float64(totalSessions) * 100
	}

	return &Stats{
		TotalSessions:     totalSessions,
		CompletedSessions: completedSessions,
		SkippedSessions:   skippedSessions,
		CompletionRate:    completionRate,
		ActiveWeeks:       activeWeeks,
		TopExercises:      exerciseStats,
		WeeklyActivity:    weeklyActivity,
	}, nil
}
