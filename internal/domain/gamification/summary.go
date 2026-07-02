package gamification

// summary.go is the read model (Task 7) both HTTP (Plan 2) and the bot serve.
// GetSummary reads the cached state plus the ledger (today + a trailing period)
// and shapes them into Summary — per-ring HP, level + next-level progress,
// lifetime HP, streak, and insight tier. It is read-only and gate-aware.

import (
	"context"
	"log/slog"
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

	// HealthScore is the 0-100 Oura/Whoop-pattern composite (Task 8, see
	// wellbeing.go): a legible headline distinct from the effort-based HP/Rings
	// above, computed from named contributors over a recent window vs a personal
	// baseline. A read/degrade error zeroes it out (Value nil, no contributors) —
	// additive and never blocks the rest of Summary.
	HealthScore HealthScoreView `json:"health_score"`

	// Strengths is the habit-strength EMA per pillar (Task 8, see wellbeing.go) —
	// the continuity mechanic that replaces the weekly streak card on Journey. A
	// read/degrade error yields an empty slice.
	Strengths []StrengthView `json:"strengths"`
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

	// The current streak + freezes are a pure fold over the ledger (Task 2,
	// gamification-6), not the persisted gamification_state columns: a late
	// import into an already-scored week updates the ledger, and recomputing
	// this fresh on every read means the repair needs no explicit trigger.
	// LongestStreak still honors whatever the transactional path ever recorded —
	// history outside the trailing derivedStreakWindowWeeks fold is never lost.
	derivedStreak, derivedFreezes, derivedLongest, err := s.deriveStreak(ctx, userID, today, cfg)
	if err != nil {
		return Summary{}, err
	}
	longestStreak := st.LongestStreak
	if derivedLongest > longestStreak {
		longestStreak = derivedLongest
	}

	// Progress + Goal are best-effort enrichments layered on the cached
	// ledger/state read above: they re-read live domain data (the effective bands,
	// the per-ring membership re-score across every domain loader, the food
	// targets), so a transient read error must degrade them — open rings to 0
	// progress, all rings to no goal text — not 500 a summary that can still serve
	// cached HP/level/streak/closed-ring state. This keeps GetSummary as forgiving
	// as the best-effort ensureGamificationFresh re-score that precedes it on the
	// HTTP path. todayProgress stays a non-nil (possibly empty) map so closed today
	// rings still read full on the degraded path; only PeriodRings pass nil, which
	// ringScores treats as "no gauge" (Progress 0).
	// Progress measures against the user's *effective* bands (target overrides),
	// not the base Config the level curve uses above.
	todayProgress := map[string]float64{}
	goals := map[string]string{}
	healthScore := HealthScoreView{Missing: []string{}}
	strengths := []StrengthView{}
	if effCfg, err := s.effectiveConfig(ctx, userID); err != nil {
		slog.Warn("gamification summary: effective config load failed; rings degrade to no progress/goal", "error", err, "user_id", userID)
	} else {
		if p, err := s.ringProgress(ctx, userID, today, effCfg); err != nil {
			slog.Warn("gamification summary: ring progress recompute failed; open rings degrade to 0", "error", err, "user_id", userID)
		} else {
			todayProgress = p
		}
		if ft, err := s.food.GetTargets(ctx); err != nil {
			slog.Warn("gamification summary: food targets load failed; goals degrade to empty", "error", err, "user_id", userID)
		} else {
			goals = ringGoals(effCfg, ft)
		}
		if hs, err := s.computeHealthScore(ctx, userID, today, effCfg); err != nil {
			slog.Warn("gamification summary: health score compute failed; degrades to unknown", "error", err, "user_id", userID)
		} else {
			healthScore = hs
		}
		if st, err := s.computeStrengths(ctx, userID, today, effCfg); err != nil {
			slog.Warn("gamification summary: habit strengths compute failed; degrades to empty", "error", err, "user_id", userID)
		} else {
			strengths = st
		}
	}
	// syncPending degrades to "nothing pending" on error — same forgiving
	// posture as todayProgress/goals above: a transient read error should not
	// mislabel an open ring as still-syncing.
	syncPending := map[string]bool{}
	if sp, err := s.syncPendingRings(ctx, userID, today); err != nil {
		slog.Warn("gamification summary: sync-pending recompute failed; rings degrade to not-pending", "error", err, "user_id", userID)
	} else {
		syncPending = sp
	}

	sum := Summary{
		Enabled:       true,
		LifetimeHP:    st.LifetimeHP,
		Level:         st.Level,
		InsightTier:   st.InsightTier,
		HPIntoLevel:   st.LifetimeHP - floor,
		LevelSpanHP:   next - floor,
		HPToNextLevel: next - st.LifetimeHP,
		CurrentStreak: derivedStreak,
		LongestStreak: longestStreak,
		Freezes:       derivedFreezes,
		PeriodDays:    summaryPeriodDays,
		TodayRings:    ringScores(todayLedger, todayProgress, goals, syncPending),
		PeriodRings:   ringScores(periodLedger, nil, goals, nil),
		LastScoredDay: st.LastScoredDay,
		HealthScore:   healthScore,
		Strengths:     strengths,
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
// missing) for a stable frontend layout. progress is the day's per-ring
// range-membership gauge from ringProgress (today's rings only); pass nil for
// a period whose Progress should stay 0 (the gauge is a daily-loop affordance,
// not a weekly one). goals is the config-derived ring -> goal-text map from
// ringGoals, applied to both today's and period rings alike. syncPending is
// today's ring -> "no device-synced sample yet" map from syncPendingRings;
// pass nil for a period, whose rings always report SyncPending=false (a
// nil-map lookup returns false, so no special-casing needed here).
func ringScores(entries []gamstore.LedgerEntry, progress map[string]float64, goals map[string]string, syncPending map[string]bool) []gamstore.RingScore {
	byRing := make(map[string]int, 5)
	closed := make(map[string]bool, 5)
	for _, e := range entries {
		byRing[e.Ring] += e.HP
		// A non-floor award (outcome or consistency) means the ring was
		// "closed": the user landed in range / kept a good pattern, not just
		// logged honestly. See RingScore.Closed.
		if e.Kind != scoring.KindFloor {
			closed[e.Ring] = true
		}
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
		// progress == nil ⇒ a period ring: the arc gauge is a daily-loop affordance,
		// so PeriodRings always leave Progress 0 (the documented contract) regardless
		// of whether the week closed the ring. For today's rings (non-nil map, maybe
		// empty) Closed ⇒ full ring — the two can no longer disagree (the "closed but
		// not full" bug) — else the day's best range-membership, if known (0 when not).
		p := 0.0
		if progress != nil {
			if closed[ring] {
				p = 1.0
			} else {
				p = progress[ring]
			}
		}
		out = append(out, gamstore.RingScore{
			Ring:        ring,
			HP:          byRing[ring],
			Closed:      closed[ring],
			Progress:    p,
			Goal:        goals[ring],
			SyncPending: !closed[ring] && syncPending[ring],
		})
	}
	return out
}
