package gamification

// summary.go is the read model (Task 7) both HTTP (Plan 2) and the bot serve.
// GetSummary reads the cached state plus the ledger (today + a trailing period)
// and shapes them into Summary — per-ring HP, level + next-level progress,
// lifetime HP, streak, and insight tier. It is read-only and gate-aware.

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// summaryPeriodDays is the trailing window (inclusive of today) the period ring
// totals cover — a week of activity, the natural cadence for the Rings view.
const summaryPeriodDays = 7

// Summary is the gamification read model. When Enabled is false every other field
// is zero/empty: transports render a disabled state without branching on the flag
// themselves.
type Summary struct {
	Enabled bool `json:"enabled"`

	LifetimeHP  int `json:"lifetime_hp"`
	Level       int `json:"level"`
	InsightTier int `json:"insight_tier"`

	// Within-level progress toward the next level. HPIntoLevel/LevelSpanHP form a
	// fraction; HPToNextLevel is the remaining HP (0 once past the threshold).
	HPIntoLevel   int `json:"hp_into_level"`
	LevelSpanHP   int `json:"level_span_hp"`
	HPToNextLevel int `json:"hp_to_next_level"`

	CurrentStreak int `json:"current_streak"`
	LongestStreak int `json:"longest_streak"`
	Freezes       int `json:"freezes"`

	// TodayHP is the sum of TodayRings, surfaced for a quick headline.
	TodayHP     int                  `json:"today_hp"`
	TodayRings  []gamstore.RingScore `json:"today_rings"`
	PeriodDays  int                  `json:"period_days"`
	PeriodRings []gamstore.RingScore `json:"period_rings"`

	LastScoredDay *time.Time `json:"last_scored_day,omitempty"`
}

// GetSummary returns the user's gamification read model. Gate-off yields
// Summary{Enabled: false} with everything zeroed. Level math uses the service's
// base Config (per-user band overrides don't change the level curve).
func (s *service) GetSummary(ctx context.Context, userID int64) (Summary, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return Summary{}, err
	}
	if !enabled {
		return Summary{Enabled: false}, nil
	}

	st, err := s.gam.GetState(ctx, userID)
	if err != nil {
		return Summary{}, err
	}

	today := utcMidnight(s.now())
	todayKey := today.Unix()
	todayLedger, err := s.gam.ListLedger(ctx, userID, todayKey, todayKey)
	if err != nil {
		return Summary{}, err
	}
	periodStart := today.AddDate(0, 0, -(summaryPeriodDays - 1))
	periodLedger, err := s.gam.ListLedger(ctx, userID, periodStart.Unix(), todayKey)
	if err != nil {
		return Summary{}, err
	}

	cfg := s.cfg
	floor := scoring.HPToReachLevel(st.Level, cfg)
	next := scoring.HPToReachLevel(st.Level+1, cfg)

	sum := Summary{
		Enabled:       true,
		LifetimeHP:    st.LifetimeHP,
		Level:         st.Level,
		InsightTier:   st.InsightTier,
		HPIntoLevel:   st.LifetimeHP - floor,
		LevelSpanHP:   next - floor,
		HPToNextLevel: next - st.LifetimeHP,
		CurrentStreak: st.CurrentStreak,
		LongestStreak: st.LongestStreak,
		Freezes:       st.Freezes,
		PeriodDays:    summaryPeriodDays,
		TodayRings:    ringScores(todayLedger),
		PeriodRings:   ringScores(periodLedger),
		LastScoredDay: st.LastScoredDay,
	}
	if sum.HPToNextLevel < 0 {
		sum.HPToNextLevel = 0
	}
	// Level never decreases (recomputeState clamps it), but LifetimeHP is
	// recomputed from the ledger and can drop if source data is later deleted —
	// which would push HPIntoLevel below the prior level's floor. Clamp so the
	// progress fraction Plan 3 derives from HPIntoLevel/LevelSpanHP never goes
	// negative.
	if sum.HPIntoLevel < 0 {
		sum.HPIntoLevel = 0
	}
	for _, r := range sum.TodayRings {
		sum.TodayHP += r.HP
	}
	return sum, nil
}

// ringScores aggregates ledger entries into a per-ring HP total, emitting all
// five rings in canonical order (so a ring with no awards reads as 0, not
// missing) for a stable frontend layout.
func ringScores(entries []gamstore.LedgerEntry) []gamstore.RingScore {
	byRing := make(map[string]int, 5)
	for _, e := range entries {
		byRing[e.Ring] += e.HP
	}
	order := []string{
		scoring.RingAdherence,
		scoring.RingMovement,
		scoring.RingVitals,
		scoring.RingNourishment,
		scoring.RingMind,
	}
	out := make([]gamstore.RingScore, 0, len(order))
	for _, ring := range order {
		out = append(out, gamstore.RingScore{Ring: ring, HP: byRing[ring]})
	}
	return out
}
