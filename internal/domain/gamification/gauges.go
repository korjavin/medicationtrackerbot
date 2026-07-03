package gamification

// gauges.go computes the three gauge-trend reads (gamification-11 §Overview):
// weight becomes trend velocity + acceleration (Hacker's-Diet-style EMA, so a
// single heavy day can't move it), BP becomes a rolling in-range share (14d/
// 30d vs a 60d baseline), and resting HR becomes a 14d-vs-60d baseline delta.
// All three are pure derivations over the same per-domain repos other reads
// use — no new tables, no persisted state — so a late backup import re-enters
// the EMA/shares automatically on the next read, same invariant as the Health
// Score (wellbeing.go). Every gauge reports insufficient_data honestly below
// its configured minimum sample count instead of guessing from thin data.

import (
	"context"
	"math"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// GaugeStatus values shared by all three gauges.
const (
	GaugeStatusOK               = "ok"
	GaugeStatusInsufficientData = "insufficient_data"
)

// weightTrendSparklineDays bounds WeightGaugeView.TrendHistory — long enough
// for the Journey panel's sparkline to read as a trend line, short enough to
// stay a cheap read-side slice (not a Config knob: it has no scoring effect).
const weightTrendSparklineDays = 60

// Weight pace-status values (WeightGaugeView.PaceStatus). NoGoal is not a
// judgment — a user who hasn't set a goal simply gets the trend, no verdict.
const (
	PaceStatusNoGoal         = "no_goal"
	PaceStatusOnPace         = "on_pace"
	PaceStatusTooSlow        = "too_slow"
	PaceStatusTooFast        = "too_fast"
	PaceStatusWrongDirection = "wrong_direction"
)

// Weight acceleration values (WeightGaugeView.Acceleration) — the magnitude of
// the trend's velocity now vs WeightVelocityWindowDays ago, deadbanded so
// "holding" is the default and noise doesn't flap the headline.
const (
	AccelerationSpeedingUp = "speeding_up"
	AccelerationHolding    = "holding"
	AccelerationSlowing    = "slowing"
)

// GaugesView is the GET /api/gamification/gauges read model. Gate-off (the
// feature flag) yields {Enabled:false}.
type GaugesView struct {
	Enabled   bool               `json:"enabled"`
	Weight    WeightGaugeView    `json:"weight"`
	BP        BPGaugeView        `json:"bp"`
	RestingHR RestingHRGaugeView `json:"resting_hr"`
}

// WeightGaugeView is the smoothed-trend headline: velocity (%bodyweight/week,
// signed — negative is losing), pace status vs the user's goal direction+rate
// (no goal → PaceStatusNoGoal, trend-only), and acceleration vs
// cfg.GaugeWeightVelocityWindowDays ago.
type WeightGaugeView struct {
	Status             string    `json:"status"`
	TrendWeight        float64   `json:"trend_weight,omitempty"`
	VelocityPctPerWeek float64   `json:"velocity_pct_per_week,omitempty"`
	PaceStatus         string    `json:"pace_status,omitempty"`
	Acceleration       string    `json:"acceleration,omitempty"`

	// TrendHistory is the last weightTrendSparklineDays of the same EMA trend
	// line (oldest first) — the Journey gauges panel's sparkline (gamification-
	// 11 §Task4). Not used by scoring; purely a read-side convenience so the
	// frontend doesn't need to refetch raw weight logs to draw the line it's
	// already been told the headline for.
	TrendHistory []float64 `json:"trend_history,omitempty"`

	// GoalDirection (-1 lose, +1 gain, 0 = no goal) is the sign weightPaceStatus
	// resolved PaceStatus from. Internal only (json:"-") — reused by the weekly
	// gauge award (gamification-11 §Task2, weeklyGaugeAwards) so it doesn't
	// re-fetch the goal or re-derive the sign; not part of the read API.
	GoalDirection int `json:"-"`
}

// BPGaugeView is the rolling in-range share against the effective personal
// band (cfg.BPSystolic/BPDiastolic, after target overrides): 14d and 30d
// shares alongside the 60d baseline share, each with its reading count so the
// UI can gauge confidence.
type BPGaugeView struct {
	Status           string  `json:"status"`
	Share14d         float64 `json:"share_14d,omitempty"`
	Share30d         float64 `json:"share_30d,omitempty"`
	BaselineShare60d float64 `json:"baseline_share_60d,omitempty"`
	Count14d         int     `json:"count_14d"`
	Count30d         int     `json:"count_30d"`
	Count60d         int     `json:"count_60d"`
}

// RestingHRGaugeView is the 14d mean vs the strictly-prior 60d baseline mean —
// the same daily-minimum-HR proxy the Health Score's resting-HR contributor
// uses (healthScoreRestingHR), read as a trend instead of a graded score.
type RestingHRGaugeView struct {
	Status            string  `json:"status"`
	Recent14dMean     float64 `json:"recent_14d_mean,omitempty"`
	Baseline60dMean   float64 `json:"baseline_60d_mean,omitempty"`
	DeltaFromBaseline float64 `json:"delta_from_baseline,omitempty"`
}

// GetGauges returns the gauge-trend read model. Gate-off yields
// {Enabled:false}.
func (s *service) GetGauges(ctx context.Context, userID int64) (GaugesView, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return GaugesView{}, err
	}
	if !enabled {
		return GaugesView{Enabled: false}, nil
	}

	cfg, err := s.effectiveConfig(ctx, userID)
	if err != nil {
		return GaugesView{}, err
	}
	today := utcMidnight(s.now())

	weight, err := s.computeWeightGauge(ctx, userID, today, cfg)
	if err != nil {
		return GaugesView{}, err
	}
	bp, err := s.computeBPGauge(ctx, userID, today, cfg)
	if err != nil {
		return GaugesView{}, err
	}
	hr, err := s.computeRestingHRGauge(ctx, userID, today, cfg)
	if err != nil {
		return GaugesView{}, err
	}

	return GaugesView{Enabled: true, Weight: weight, BP: bp, RestingHR: hr}, nil
}

// computeWeightGauge folds a day-indexed EMA (trend_d = trend_{d-1} +
// α·(weight_d − trend_{d-1}), gaps carried forward) over the trailing
// cfg.GaugeWeightLookbackDays, then reads velocity as the smoothed change over
// the last cfg.GaugeWeightVelocityWindowDays in %bodyweight/week, and
// acceleration as that velocity vs the same window ending
// GaugeWeightVelocityWindowDays ago. Below cfg.GaugeWeightMinHistoryDays of
// logged history, the trend is not trusted and the gauge reports
// insufficient_data instead of a distorted number.
func (s *service) computeWeightGauge(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (WeightGaugeView, error) {
	start := today.AddDate(0, 0, -(cfg.GaugeWeightLookbackDays - 1))
	logs, err := s.weight.ListLogs(ctx, userID, start)
	if err != nil {
		return WeightGaugeView{}, err
	}

	// ListLogs is measured_at DESC, so first-seen per day is that day's latest
	// reading (same convention as insights.go's sleep-day dedupe).
	windowEnd := today.AddDate(0, 0, 1)
	byDay := make(map[string]float64, len(logs))
	var earliest time.Time
	for _, l := range logs {
		if !l.MeasuredAt.Before(windowEnd) {
			continue // future-dated — not part of the trailing window
		}
		day := l.MeasuredAt.UTC().Format("2006-01-02")
		if _, ok := byDay[day]; !ok {
			byDay[day] = l.Weight
		}
		if earliest.IsZero() || l.MeasuredAt.Before(earliest) {
			earliest = l.MeasuredAt
		}
	}
	if earliest.IsZero() || int(today.Sub(utcMidnight(earliest)).Hours()/24) < cfg.GaugeWeightMinHistoryDays {
		return WeightGaugeView{Status: GaugeStatusInsufficientData}, nil
	}

	trend := make(map[string]float64, cfg.GaugeWeightLookbackDays+1)
	var current float64
	have := false
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		if w, ok := byDay[key]; ok {
			if !have {
				current = w
				have = true
			} else {
				current = current + cfg.GaugeWeightEMAAlpha*(w-current)
			}
		}
		trend[key] = current
	}

	trendHistoryStart := start
	if cutoff := today.AddDate(0, 0, -(weightTrendSparklineDays - 1)); cutoff.After(trendHistoryStart) {
		trendHistoryStart = cutoff
	}
	trendHistory := make([]float64, 0, weightTrendSparklineDays)
	for d := trendHistoryStart; !d.After(today); d = d.AddDate(0, 0, 1) {
		trendHistory = append(trendHistory, trend[d.Format("2006-01-02")])
	}

	velocityDays := cfg.GaugeWeightVelocityWindowDays
	nowTrend := trend[today.Format("2006-01-02")]
	pastTrend := trend[today.AddDate(0, 0, -velocityDays).Format("2006-01-02")]
	velocity := pctChangePerWeek(nowTrend, pastTrend, velocityDays)

	prevNowTrend := pastTrend
	prevPastTrend := trend[today.AddDate(0, 0, -2*velocityDays).Format("2006-01-02")]
	prevVelocity := pctChangePerWeek(prevNowTrend, prevPastTrend, velocityDays)

	goal, err := s.weight.GetGoal(ctx, userID)
	if err != nil {
		return WeightGaugeView{}, err
	}
	paceStatus, direction := weightPaceStatus(velocity, nowTrend, goal, cfg)

	return WeightGaugeView{
		Status:             GaugeStatusOK,
		TrendWeight:        nowTrend,
		VelocityPctPerWeek: velocity,
		PaceStatus:         paceStatus,
		Acceleration:       weightAcceleration(velocity, prevVelocity, cfg),
		GoalDirection:      direction,
		TrendHistory:       trendHistory,
	}, nil
}

// pctChangePerWeek converts a trend-line change over windowDays into a signed
// %bodyweight/week rate — the same units as WeightSafePaceMinPct/MaxPct, so
// velocity compares directly against the safe-pace ceiling.
func pctChangePerWeek(now, past float64, windowDays int) float64 {
	if past == 0 {
		return 0
	}
	pctChange := (now - past) / past * 100
	return pctChange * 7 / float64(windowDays)
}

// weightPaceStatus grades the signed velocity against the user's goal
// direction using the same safe-pace band ScoreWeight's dormant goal mode
// already scores by (WeightSafePaceMinPct/MaxPct) — one definition of "safe
// pace" for both this read and the weekly award (ScoreWeightWeekly,
// gamification-11 §Task2). No goal set is not a judgment: it yields
// PaceStatusNoGoal, trend-only, direction 0. direction (-1 lose, +1 gain) is
// returned alongside the status so the weekly award can reuse it without
// re-fetching the goal or re-deriving the sign.
func weightPaceStatus(velocityPctPerWeek, currentTrend float64, goal *store.WeightGoal, cfg scoring.Config) (status string, direction int) {
	if goal == nil || goal.Goal == nil || *goal.Goal == currentTrend {
		return PaceStatusNoGoal, 0
	}
	direction = 1
	if *goal.Goal < currentTrend {
		direction = -1
	}
	toward := velocityPctPerWeek * float64(direction) // positive = progress toward goal
	switch {
	case toward < 0:
		return PaceStatusWrongDirection, direction
	case toward < cfg.WeightSafePaceMinPct:
		return PaceStatusTooSlow, direction
	case toward > cfg.WeightSafePaceMaxPct:
		return PaceStatusTooFast, direction
	default:
		return PaceStatusOnPace, direction
	}
}

// weightAcceleration compares the trend's speed (magnitude, not direction) now
// vs one velocity-window ago: a deadband keeps "holding" the default state so
// noise doesn't flap the headline between speeding/slowing (Technical Details).
func weightAcceleration(velocityNow, velocityPrev float64, cfg scoring.Config) string {
	delta := math.Abs(velocityNow) - math.Abs(velocityPrev)
	switch {
	case delta > cfg.GaugeWeightAccelerationDeadbandPctPerWeek:
		return AccelerationSpeedingUp
	case delta < -cfg.GaugeWeightAccelerationDeadbandPctPerWeek:
		return AccelerationSlowing
	default:
		return AccelerationHolding
	}
}

// computeBPGauge shares are strict band-membership (Low/High, ignoring
// Falloff) — "share of readings in the personal band" is a count-in-band
// ratio, not the graded credit ScoreBP's Membership gives a single day.
// Below cfg.GaugeBPMinBaselineReadings readings in the 60d baseline, the
// gauge reports insufficient_data rather than a share built on noise.
func (s *service) computeBPGauge(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (BPGaugeView, error) {
	baselineStart := today.AddDate(0, 0, -(cfg.GaugeBPBaselineWindowDays - 1))
	midStart := today.AddDate(0, 0, -(cfg.GaugeBPMidWindowDays - 1))
	recentStart := today.AddDate(0, 0, -(cfg.GaugeBPRecentWindowDays - 1))
	windowEnd := today.AddDate(0, 0, 1)

	readings, err := s.bp.ListReadings(ctx, userID, baselineStart)
	if err != nil {
		return BPGaugeView{}, err
	}

	var n14, in14, n30, in30, n60, in60 int
	for _, r := range readings {
		if r.IgnoreCalc || !r.MeasuredAt.Before(windowEnd) {
			continue
		}
		inBand := cfg.BPSystolic.Low <= float64(r.Systolic) && float64(r.Systolic) <= cfg.BPSystolic.High &&
			cfg.BPDiastolic.Low <= float64(r.Diastolic) && float64(r.Diastolic) <= cfg.BPDiastolic.High

		n60++
		if inBand {
			in60++
		}
		if !r.MeasuredAt.Before(midStart) {
			n30++
			if inBand {
				in30++
			}
		}
		if !r.MeasuredAt.Before(recentStart) {
			n14++
			if inBand {
				in14++
			}
		}
	}

	if n60 < cfg.GaugeBPMinBaselineReadings {
		return BPGaugeView{Status: GaugeStatusInsufficientData}, nil
	}

	view := BPGaugeView{Status: GaugeStatusOK, Count14d: n14, Count30d: n30, Count60d: n60, BaselineShare60d: float64(in60) / float64(n60)}
	if n14 > 0 {
		view.Share14d = float64(in14) / float64(n14)
	}
	if n30 > 0 {
		view.Share30d = float64(in30) / float64(n30)
	}
	return view, nil
}

// computeRestingHRGauge mirrors healthScoreRestingHR's daily-minimum-HR proxy
// and windowing, but reports the trend rather than a graded score. Below
// cfg.GaugeRestingHRMinBaselineDays days of data in the baseline window, the
// gauge reports insufficient_data — a trend "vs baseline" is meaningless
// without a trustworthy baseline.
func (s *service) computeRestingHRGauge(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (RestingHRGaugeView, error) {
	baselineStart := today.AddDate(0, 0, -(cfg.GaugeRestingHRBaselineWindowDays - 1))
	recentStart := today.AddDate(0, 0, -(cfg.GaugeRestingHRRecentWindowDays - 1))
	end := today.AddDate(0, 0, 1).Add(-time.Millisecond) // half-open [start,end) convention, see wellbeing.go's healthScoreRestingHR

	samples, err := s.vitals.ListHeart(ctx, userID, baselineStart, end)
	if err != nil {
		return RestingHRGaugeView{}, err
	}
	dailyMin := dailyMinByDay(samples)

	recentMean, recentOK := meanInRange(dailyMin, recentStart, today)
	if !recentOK {
		return RestingHRGaugeView{Status: GaugeStatusInsufficientData}, nil
	}

	baselineEnd := recentStart.AddDate(0, 0, -1)
	baselineDays := 0
	for d := baselineStart; !d.After(baselineEnd); d = d.AddDate(0, 0, 1) {
		if _, ok := dailyMin[d.Format("2006-01-02")]; ok {
			baselineDays++
		}
	}
	if baselineDays < cfg.GaugeRestingHRMinBaselineDays {
		return RestingHRGaugeView{Status: GaugeStatusInsufficientData}, nil
	}

	baselineMean, _ := meanInRange(dailyMin, baselineStart, baselineEnd)
	return RestingHRGaugeView{
		Status:            GaugeStatusOK,
		Recent14dMean:     recentMean,
		Baseline60dMean:   baselineMean,
		DeltaFromBaseline: recentMean - baselineMean,
	}, nil
}
