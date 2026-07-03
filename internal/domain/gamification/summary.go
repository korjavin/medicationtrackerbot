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

// Lever ring keys (gamification-10 §2.5) — the three rings surfaced to the
// user: a decision made today, not a delayed body signal. This is a
// view-layer regrouping of the five ledger Ring keys (scoring.go), not a
// ledger schema change — adherence/vitals ledger rows and the Mind ring's
// diary awards keep earning HP but produce no ring.
const (
	LeverBedtime     = "bedtime"
	LeverMovement    = scoring.RingMovement
	LeverNourishment = scoring.RingNourishment
)

// leverRing maps one lever ring onto the ledger (ring, source_metric) it reads
// from. An empty SourceMetric matches every source metric on that ledger ring.
type leverRing struct {
	Key          string
	Ring         string
	SourceMetric string
}

// leverRings is the canonical lever order the rings API returns. Bedtime reads
// only the sleep-timing award off the Mind ring — the diary floor/reflection
// awards also live on RingMind (§6.8) but keep earning HP without a ring.
var leverRings = []leverRing{
	{Key: LeverBedtime, Ring: scoring.RingMind, SourceMetric: scoring.MetricSleep},
	{Key: LeverMovement, Ring: scoring.RingMovement},
	{Key: LeverNourishment, Ring: scoring.RingNourishment},
}

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

	// AdherenceAlert is the safety-net nudge (Task 3, see wellbeing.go):
	// adherence has no ring and no daily grading, so this stays Active=false
	// (invisible) unless the trailing PDC drops below
	// Config.AdherenceAlertPDCThreshold. A read/degrade error yields the zero
	// value, i.e. inactive.
	AdherenceAlert AdherenceAlertView `json:"adherence_alert"`
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
	adherenceAlert := AdherenceAlertView{}
	if effCfg, err := s.effectiveConfig(ctx, userID); err != nil {
		slog.Warn("gamification summary: effective config load failed; rings degrade to no progress/goal", "error", err, "user_id", userID)
	} else {
		if p, err := s.ringProgress(ctx, userID, today, effCfg); err != nil {
			slog.Warn("gamification summary: ring progress recompute failed; open rings degrade to 0", "error", err, "user_id", userID)
		} else {
			todayProgress = p
		}
		bedtimeCenter, hasBedtimeCenter := 0.0, false
		if c, ok, err := s.bedtimeBaselineCenter(ctx, userID, today); err != nil {
			slog.Warn("gamification summary: bedtime baseline load failed; goal degrades to no window", "error", err, "user_id", userID)
		} else {
			bedtimeCenter, hasBedtimeCenter = c, ok
		}
		if ft, err := s.food.GetTargets(ctx); err != nil {
			slog.Warn("gamification summary: food targets load failed; goals degrade to empty", "error", err, "user_id", userID)
		} else {
			goals = ringGoals(effCfg, ft, bedtimeCenter, hasBedtimeCenter)
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
		if aa, err := s.computeAdherenceAlert(ctx, userID, today, effCfg); err != nil {
			slog.Warn("gamification summary: adherence alert compute failed; degrades to inactive", "error", err, "user_id", userID)
		} else {
			adherenceAlert = aa
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
		Enabled:        true,
		LifetimeHP:     st.LifetimeHP,
		Level:          st.Level,
		InsightTier:    st.InsightTier,
		HPIntoLevel:    st.LifetimeHP - floor,
		LevelSpanHP:    next - floor,
		HPToNextLevel:  next - st.LifetimeHP,
		CurrentStreak:  derivedStreak,
		LongestStreak:  longestStreak,
		Freezes:        derivedFreezes,
		PeriodDays:     summaryPeriodDays,
		TodayRings:     ringScores(todayLedger, todayProgress, goals, syncPending),
		PeriodRings:    ringScores(periodLedger, nil, goals, nil),
		LastScoredDay:  st.LastScoredDay,
		HealthScore:    healthScore,
		Strengths:      strengths,
		AdherenceAlert: adherenceAlert,
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

// ringScores aggregates ledger entries into the three lever rings
// (leverRings), in canonical order (so a ring with no awards reads as 0, not
// missing) for a stable frontend layout. Ledger entries whose (ring,
// source_metric) match no lever — adherence, vitals, and the Mind ring's
// diary awards — still count toward LifetimeHP elsewhere but produce no ring
// here (gamification-10 §2.5: they're a safety net or a gauge, not a daily
// lever). progress is the day's per-ledger-ring range-membership gauge from
// ringProgress (today's rings only), keyed by the ledger ring a lever reads
// from; pass nil for a period whose Progress should stay 0 (the gauge is a
// daily-loop affordance, not a weekly one). goals is the lever-key -> goal-text
// map from ringGoals, applied to both today's and period rings alike.
// syncPending is today's lever-key -> "no device-synced sample yet" map from
// syncPendingRings; pass nil for a period, whose rings always report
// SyncPending=false (a nil-map lookup returns false, so no special-casing
// needed here).
func ringScores(entries []gamstore.LedgerEntry, progress map[string]float64, goals map[string]string, syncPending map[string]bool) []gamstore.RingScore {
	hp := make(map[string]int, len(leverRings))
	closed := make(map[string]bool, len(leverRings))
	for _, e := range entries {
		for _, lv := range leverRings {
			if e.Ring != lv.Ring || (lv.SourceMetric != "" && e.SourceMetric != lv.SourceMetric) {
				continue
			}
			hp[lv.Key] += e.HP
			// A non-floor award (outcome or consistency) means the ring was
			// "closed": the user landed in range / kept a good pattern, not just
			// logged honestly. See RingScore.Closed.
			if e.Kind != scoring.KindFloor {
				closed[lv.Key] = true
			}
			break
		}
	}
	out := make([]gamstore.RingScore, 0, len(leverRings))
	for _, lv := range leverRings {
		// progress == nil ⇒ a period ring: the arc gauge is a daily-loop affordance,
		// so PeriodRings always leave Progress 0 (the documented contract) regardless
		// of whether the week closed the ring. For today's rings (non-nil map, maybe
		// empty) Closed ⇒ full ring — the two can no longer disagree (the "closed but
		// not full" bug) — else the day's best range-membership, if known (0 when not).
		p := 0.0
		if progress != nil {
			if closed[lv.Key] {
				p = 1.0
			} else {
				p = progress[lv.Ring]
			}
		}
		out = append(out, gamstore.RingScore{
			Ring:        lv.Key,
			HP:          hp[lv.Key],
			Closed:      closed[lv.Key],
			Progress:    p,
			Goal:        goals[lv.Key],
			SyncPending: !closed[lv.Key] && syncPending[lv.Key],
		})
	}
	return out
}
