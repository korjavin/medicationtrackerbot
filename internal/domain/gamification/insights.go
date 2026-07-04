package gamification

// insights.go is the first real personal insight (design §8 tier 3, Plan
// gamification-9): sleep→next-morning-BP. It is deliberately the only insight
// in this plan — the honesty-gate + read-model pattern here (min pairs per
// bucket, a noise floor below which "no effect" is itself the reported
// finding, insufficient-data as an explicit third state) is the template
// future insights (tier 4+) follow, not a general correlation framework.
//
// Computed on read from the existing sleep + BP logs — no new tables, same
// invariant as the Health Score (wellbeing.go). Gated on the feature flag AND
// the user's unlocked insight tier (§8 principle #5: tiers gate depth of
// analysis, never raw data or safety alerts) — below tier 3 the response
// carries no numbers at all, just {Locked:true, UnlocksAtLevel}.

import (
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// sleepBPInsightTier is the insight tier this file's card unlocks at (tier 3 —
// level 5 by DefaultConfig's InsightTierLevels).
const sleepBPInsightTier = 3

// Sleep→BP insight statuses (SleepBPInsight.Status). All three are terminal,
// honest results — "no effect found" and "not enough data yet" render as
// insight cards in their own right, not as errors or blank states.
const (
	InsightStatusEffect           = "effect"
	InsightStatusNoEffect         = "no_effect"
	InsightStatusInsufficientData = "insufficient_data"
)

// SleepBPInsight is the sleep→next-morning-BP correlation result: each night
// over the trailing WindowDays paired with the first systolic reading before
// the local morning cutoff, bucketed into short (below ShortThresholdHours)
// vs in-band nights.
type SleepBPInsight struct {
	Status              string  `json:"status"`
	ShortThresholdHours float64 `json:"short_threshold_hours"`
	DeltaSystolic       float64 `json:"delta_systolic,omitempty"`
	NShort              int     `json:"n_short"`
	NInBand             int     `json:"n_in_band"`
	Needed              int     `json:"needed,omitempty"`
	WindowDays          int     `json:"window_days"`
}

// InsightsView is the GET /api/gamification/insights read model. Gate-off (the
// feature flag) yields {Enabled:false}; below the unlock tier yields
// {Enabled:true, Locked:true, UnlocksAtLevel}. Neither carries SleepBP.
type InsightsView struct {
	Enabled        bool            `json:"enabled"`
	Locked         bool            `json:"locked,omitempty"`
	UnlocksAtLevel int             `json:"unlocks_at_level,omitempty"`
	SleepBP        *SleepBPInsight `json:"sleep_bp,omitempty"`
	GoodDay        *GoodDayInsight `json:"good_day,omitempty"`
}

// GetInsights returns the tier-gated insights read model. Gate-off yields
// {Enabled:false}. Below tier 3 the top-level Locked/UnlocksAtLevel gate
// SleepBP (unchanged from before the good-day insight existed); GoodDay
// carries its own Locked/UnlocksAtLevel for its higher tier-4 gate, so it is
// present (locked) even while SleepBP is unlocked.
func (s *service) GetInsights(ctx context.Context, userID int64) (InsightsView, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return InsightsView{}, err
	}
	if !enabled {
		return InsightsView{Enabled: false}, nil
	}

	tier, err := s.GetInsightTier(ctx, userID)
	if err != nil {
		return InsightsView{}, err
	}

	view := InsightsView{Enabled: true}
	if tier < sleepBPInsightTier {
		view.Locked = true
		view.UnlocksAtLevel = insightUnlockLevel(sleepBPInsightTier, s.cfg)
	}
	if tier < goodDayInsightTier {
		view.GoodDay = &GoodDayInsight{
			Locked:         true,
			UnlocksAtLevel: insightUnlockLevel(goodDayInsightTier, s.cfg),
		}
	}
	if tier < sleepBPInsightTier && tier < goodDayInsightTier {
		return view, nil
	}

	cfg, err := s.effectiveConfig(ctx, userID)
	if err != nil {
		return InsightsView{}, err
	}
	if tier >= sleepBPInsightTier {
		insight, err := s.computeSleepBPInsight(ctx, userID, cfg)
		if err != nil {
			return InsightsView{}, err
		}
		view.SleepBP = &insight
	}
	if tier >= goodDayInsightTier {
		gd, err := s.computeGoodDayInsight(ctx, userID, cfg)
		if err != nil {
			return InsightsView{}, err
		}
		view.GoodDay = &gd
	}
	return view, nil
}

// insightUnlockLevel returns the level at which the given insight tier
// unlocks (tier 1 is always unlocked; tier N>=2 unlocks at
// cfg.InsightTierLevels[N-2]). Returns 0 if the tier is out of range for cfg.
func insightUnlockLevel(tier int, cfg scoring.Config) int {
	idx := tier - 2
	if idx < 0 || idx >= len(cfg.InsightTierLevels) {
		return 0
	}
	return cfg.InsightTierLevels[idx]
}

// computeSleepBPInsight pairs each night's sleep duration (over the trailing
// cfg.InsightWindowDays) with the next morning's first systolic reading before
// cfg.InsightMorningCutoffHour local time, buckets nights below
// cfg.SleepHours.Low as "short" vs the rest as "in-band", and applies the
// honesty gate (min pairs per bucket, then a noise floor).
func (s *service) computeSleepBPInsight(ctx context.Context, userID int64, cfg scoring.Config) (SleepBPInsight, error) {
	windowDays := cfg.InsightWindowDays
	today := utcMidnight(s.now())
	start := today.AddDate(0, 0, -(windowDays - 1))

	sleepLogs, err := s.vitals.ListSleepLogs(ctx, userID, start.AddDate(0, 0, -1))
	if err != nil {
		return SleepBPInsight{}, err
	}
	byDay := make(map[string]float64, len(sleepLogs))
	for _, sl := range sleepLogs {
		// First-seen wins so a day with a nap + main sleep resolves to the same
		// session loadSleep picks (it breaks on the first match; ListSleepLogs is
		// start_time DESC) — the two duration reads must not disagree.
		if _, ok := byDay[sl.Day]; !ok {
			byDay[sl.Day] = sleepDurationHours(sl)
		}
	}

	// Widen the BP lower bound by a day for the same reason loadSleep widens the
	// sleep query: firstMorningSystolic matches by *local* day, so an east-of-UTC
	// user's first-window-day morning reading has a measured_at before start's UTC
	// midnight. The local-day + hour filter still bounds the result correctly.
	readings, err := s.bp.ListReadings(ctx, userID, start.AddDate(0, 0, -1))
	if err != nil {
		return SleepBPInsight{}, err
	}
	loc := s.insightLocation()
	cutoffHour := cfg.InsightMorningCutoffHour

	var sumShort, sumInBand float64
	var nShort, nInBand int
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		dayStr := d.Format("2006-01-02")
		duration, ok := byDay[dayStr]
		if !ok {
			continue
		}
		systolic, ok := firstMorningSystolic(readings, dayStr, cutoffHour, loc)
		if !ok {
			continue
		}
		if duration < cfg.SleepHours.Low {
			sumShort += systolic
			nShort++
		} else {
			sumInBand += systolic
			nInBand++
		}
	}

	out := SleepBPInsight{
		ShortThresholdHours: cfg.SleepHours.Low,
		NShort:              nShort,
		NInBand:             nInBand,
		WindowDays:          windowDays,
	}
	minPairs := cfg.InsightMinPairsPerBucket
	if nShort < minPairs || nInBand < minPairs {
		out.Status = InsightStatusInsufficientData
		out.Needed = minPairs
		return out, nil
	}

	delta := sumShort/float64(nShort) - sumInBand/float64(nInBand)
	out.DeltaSystolic = delta
	if math.Abs(delta) < cfg.InsightNoiseFloorMmHg {
		out.Status = InsightStatusNoEffect
	} else {
		out.Status = InsightStatusEffect
	}
	return out, nil
}

// firstMorningSystolic returns the earliest reading on the local calendar day
// dayStr with a local hour before cutoffHour, or false if none qualifies.
func firstMorningSystolic(readings []store.BloodPressure, dayStr string, cutoffHour int, loc *time.Location) (float64, bool) {
	var best *store.BloodPressure
	for i := range readings {
		r := &readings[i]
		if r.IgnoreCalc {
			continue // match the BP stats convention (wellbeing.go, GetDailyWeightedStats)
		}
		local := r.MeasuredAt.In(loc)
		if local.Format("2006-01-02") != dayStr || local.Hour() >= cutoffHour {
			continue
		}
		if best == nil || r.MeasuredAt.Before(best.MeasuredAt) {
			best = r
		}
	}
	if best == nil {
		return 0, false
	}
	return float64(best.Systolic), true
}

// insightLocation resolves the user's current timezone for the morning
// cutoff, falling back to UTC when no TZStore is wired, the lookup errors, or
// no timezone has been recorded yet.
func (s *service) insightLocation() *time.Location {
	if s.tz == nil {
		return time.UTC
	}
	tzStr, err := s.tz.GetCurrent()
	if err != nil {
		slog.Warn("insight tz lookup failed, using UTC for morning cutoff", "error", err)
		return time.UTC
	}
	if tzStr == "" {
		return time.UTC // no timezone recorded yet — expected on a fresh install
	}
	loc, err := time.LoadLocation(tzStr)
	if err != nil {
		slog.Warn("insight tz parse failed, using UTC for morning cutoff", "tz", tzStr, "error", err)
		return time.UTC
	}
	return loc
}
