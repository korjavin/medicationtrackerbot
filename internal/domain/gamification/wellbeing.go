package gamification

// wellbeing.go computes the two read-time score layers from Task 8
// (2026-07-02-gamification-8-health-score-strength.md): the Health Score
// composite (Oura/Whoop pattern) and per-pillar habit-strength EMAs (Loop
// Habit Tracker pattern). Both are pure derivations over the same per-domain
// repos scoreDayAwards already loads from — no new tables, no transactional
// state, so a backfill import simply changes the loaders' input set on the
// next read.

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// habitStrengthLookbackDays bounds how far back HabitStrength folds
// checkmarks. The EMA's half-life (Config.HabitStrengthHalfLifeDays, default
// 13d) means anything older than ~7 half-lives contributes a negligible
// remainder (0.5^7 ≈ 0.008 of the running score), so a bounded window reads
// indistinguishably from folding the user's entire history while keeping the
// read-time cost flat.
const habitStrengthLookbackDays = 90

// sleepBaselineMinNights is the minimum number of nights in the baseline
// window before a personal sleep-onset average is trusted for the regularity
// sub-score; below this the sleep contributor still scores on duration alone.
const sleepBaselineMinNights = 5

// HealthScoreView is the API-shaped Health Score result (Task 8): the 0-100
// composite plus its named-contributor breakdown, additive to the frozen
// Summary shape (docs/api.md#gamification). Value is nil ("not enough data")
// below Config.HealthScoreMinContributors present contributors.
type HealthScoreView struct {
	Value        *float64                `json:"value"`
	Contributors []HealthContributorView `json:"contributors"`
	Missing      []string                `json:"missing"`
}

// HealthContributorView is one named signal in the Health Score breakdown.
// Score/Weight are meaningless when Missing is true — the frontend renders a
// "no data" state for those instead of a misleading 0.
type HealthContributorView struct {
	Key     string  `json:"key"`
	Label   string  `json:"label"`
	Score   float64 `json:"score"`
	Weight  float64 `json:"weight"`
	Missing bool    `json:"missing"`
}

// StrengthView is one pillar's habit-strength EMA (Task 8): a 0..1 score
// where 1 is the steady-state strength of a habit hit every time at its own
// Frequency cadence (e.g. movement at 3x/week reaches the same 1.0 ceiling a
// daily habit does).
type StrengthView struct {
	Key       string  `json:"key"`
	Label     string  `json:"label"`
	Value     float64 `json:"value"`
	Frequency float64 `json:"frequency"`
}

// computeHealthScore builds the named contributor set from the per-domain
// repos over the configured recent/baseline windows and folds them through
// the pure composite. A load error from any one contributor aborts the whole
// score (GetSummary treats this as best-effort and degrades to "unknown" on
// error, same posture as ringProgress/goals).
func (s *service) computeHealthScore(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (HealthScoreView, error) {
	bp, err := s.healthScoreBP(ctx, userID, today, cfg)
	if err != nil {
		return HealthScoreView{}, err
	}
	sleep, err := s.healthScoreSleep(ctx, userID, today, cfg)
	if err != nil {
		return HealthScoreView{}, err
	}
	hr, err := s.healthScoreRestingHR(ctx, userID, today, cfg)
	if err != nil {
		return HealthScoreView{}, err
	}
	weight, err := s.healthScoreWeight(ctx, userID, today, cfg)
	if err != nil {
		return HealthScoreView{}, err
	}
	adherence, err := s.healthScoreAdherence(ctx, userID, today, cfg)
	if err != nil {
		return HealthScoreView{}, err
	}

	result := scoring.ComputeHealthScore(scoring.HealthScoreInput{
		Contributors: []scoring.HealthScoreContributor{bp, sleep, hr, weight, adherence},
	}, cfg)
	return toHealthScoreView(result), nil
}

// toHealthScoreView maps the pure engine's result onto the API shape.
func toHealthScoreView(r scoring.HealthScoreResult) HealthScoreView {
	view := HealthScoreView{Value: r.Score, Missing: r.Missing}
	if view.Missing == nil {
		view.Missing = []string{}
	}
	view.Contributors = make([]HealthContributorView, 0, len(r.Contributors))
	for _, c := range r.Contributors {
		view.Contributors = append(view.Contributors, HealthContributorView{
			Key: c.Key, Label: c.Label, Score: c.Value, Weight: c.Weight, Missing: !c.Present,
		})
	}
	return view
}

// healthScoreBP builds the "bp" contributor from the recent window's mean
// reading — present iff at least one non-ignored reading fell in the window.
// ListReadings only lower-bounds measured_at, so future-dated rows (a backup
// import or clock-skewed entry) are filtered against windowEnd; readings the
// user flagged ignore_calc are skipped to match the BP stats convention
// (GetDailyWeightedStats, category alerts).
func (s *service) healthScoreBP(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (scoring.HealthScoreContributor, error) {
	recentStart := today.AddDate(0, 0, -(cfg.HealthScoreWindowDays - 1))
	windowEnd := today.AddDate(0, 0, 1) // exclusive: window is [recentStart, today]
	readings, err := s.bp.ListReadings(ctx, userID, recentStart)
	if err != nil {
		return scoring.HealthScoreContributor{}, err
	}
	var sumSys, sumDia float64
	var n int
	for _, r := range readings {
		if r.IgnoreCalc || !r.MeasuredAt.Before(windowEnd) {
			continue
		}
		sumSys += float64(r.Systolic)
		sumDia += float64(r.Diastolic)
		n++
	}
	if n == 0 {
		return scoring.HealthContributorBP(0, 0, false, cfg), nil
	}
	return scoring.HealthContributorBP(sumSys/float64(n), sumDia/float64(n), true, cfg), nil
}

// healthScoreAdherence builds the "adherence" contributor as the recent
// window's Proportion of Days Covered — the fraction of days with any
// expected dose that had at least one dose taken — reusing loadAdherenceRange
// (and so the same PENDING-past-due miss-inference rule ScoreDay uses).
func (s *service) healthScoreAdherence(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (scoring.HealthScoreContributor, error) {
	recentStart := today.AddDate(0, 0, -(cfg.HealthScoreWindowDays - 1))
	byDay, err := s.loadAdherenceRange(ctx, userID, recentStart, today.AddDate(0, 0, 1))
	if err != nil {
		return scoring.HealthScoreContributor{}, err
	}
	var coveredDays, expectedDays int
	for d := recentStart; !d.After(today); d = d.AddDate(0, 0, 1) {
		ad, ok := byDay[utcMidnight(d).Unix()]
		if !ok {
			continue // no doses expected that day — not a miss, just unscored
		}
		taken, expected := takenExpected(ad)
		if expected == 0 {
			continue
		}
		expectedDays++
		if taken > 0 {
			coveredDays++
		}
	}
	if expectedDays == 0 {
		return scoring.HealthContributorAdherence(0, false, cfg), nil
	}
	return scoring.HealthContributorAdherence(float64(coveredDays)/float64(expectedDays), true, cfg), nil
}

// AdherenceAlertView is the adherence safety net (Task 3): adherence has no
// ring and no daily grading — it's a solved habit that stays invisible until
// the trailing PDC slips below Config.AdherenceAlertPDCThreshold, at which
// point Today surfaces one gentle line naming the missed-dose count.
type AdherenceAlertView struct {
	Active      bool    `json:"active"`
	PDC         float64 `json:"pdc"`
	MissedDoses int     `json:"missed_doses"`
}

// computeAdherenceAlert reuses the same loadAdherenceRange window as
// healthScoreAdherence, but grades dose-level PDC (taken doses ÷ expected
// doses) rather than day-level, so MissedDoses is a plain count of individual
// missed doses for the nudge copy ("2 missed evening doses this week").
func (s *service) computeAdherenceAlert(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (AdherenceAlertView, error) {
	recentStart := today.AddDate(0, 0, -(cfg.HealthScoreWindowDays - 1))
	byDay, err := s.loadAdherenceRange(ctx, userID, recentStart, today.AddDate(0, 0, 1))
	if err != nil {
		return AdherenceAlertView{}, err
	}
	var taken, expected int
	for d := recentStart; !d.After(today); d = d.AddDate(0, 0, 1) {
		ad, ok := byDay[utcMidnight(d).Unix()]
		if !ok {
			continue // no doses expected that day — not a miss, just unscored
		}
		t, e := takenExpected(ad)
		taken += t
		expected += e
	}
	if expected == 0 {
		return AdherenceAlertView{}, nil
	}
	pdc := float64(taken) / float64(expected)
	return AdherenceAlertView{
		Active:      pdc < cfg.AdherenceAlertPDCThreshold,
		PDC:         pdc,
		MissedDoses: expected - taken,
	}, nil
}

// healthScoreRestingHR builds the "resting_hr" contributor from the recent
// window's mean daily-minimum HR (the same proxy loadVitalsAuto uses for a
// single day) vs. the mean over the baseline window strictly before it —
// mirrors healthScoreWeight so a recent improvement isn't averaged into the
// very baseline it's graded against.
func (s *service) healthScoreRestingHR(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (scoring.HealthScoreContributor, error) {
	baselineStart := today.AddDate(0, 0, -(cfg.HealthScoreBaselineDays - 1))
	recentStart := today.AddDate(0, 0, -(cfg.HealthScoreWindowDays - 1))
	end := today.AddDate(0, 0, 1).Add(-time.Millisecond) // half-open [start,end) convention, see loadVitalsAuto

	samples, err := s.vitals.ListHeart(ctx, userID, baselineStart, end)
	if err != nil {
		return scoring.HealthScoreContributor{}, err
	}
	dailyMin := dailyMinByDay(samples)
	recentMean, recentOK := meanInRange(dailyMin, recentStart, today)
	if !recentOK {
		return scoring.HealthContributorRestingHR(0, 0, false, cfg), nil
	}
	// Baseline excludes the recent window (empty for a new user → 0 → the
	// contributor falls back to the absolute HR band, same as an unknown baseline).
	baselineMean, _ := meanInRange(dailyMin, baselineStart, recentStart.AddDate(0, 0, -1))
	return scoring.HealthContributorRestingHR(recentMean, baselineMean, true, cfg), nil
}

// healthScoreWeight builds the "weight" contributor as the recent window's
// mean reading vs. the trailing average strictly before that window — mirrors
// loadWeight's "prior readings only" rule so the personal-normal baseline is
// never contaminated by the very readings being graded against it.
func (s *service) healthScoreWeight(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (scoring.HealthScoreContributor, error) {
	baselineStart := today.AddDate(0, 0, -(cfg.HealthScoreBaselineDays - 1))
	recentStart := today.AddDate(0, 0, -(cfg.HealthScoreWindowDays - 1))
	windowEnd := today.AddDate(0, 0, 1) // exclusive: drop future-dated rows ListLogs' lower-bound admits

	logs, err := s.weight.ListLogs(ctx, userID, baselineStart)
	if err != nil {
		return scoring.HealthScoreContributor{}, err
	}
	var recentSum, priorSum float64
	var recentN, priorN int
	for _, l := range logs {
		if !l.MeasuredAt.Before(windowEnd) {
			continue // dated in the future — not part of the trailing window
		}
		if !l.MeasuredAt.Before(recentStart) {
			recentSum += l.Weight
			recentN++
		} else {
			priorSum += l.Weight
			priorN++
		}
	}
	if recentN == 0 || priorN == 0 {
		return scoring.HealthContributorWeight(0, 0, false, cfg), nil
	}
	return scoring.HealthContributorWeight(recentSum/float64(recentN), priorSum/float64(priorN), true, cfg), nil
}

// healthScoreSleep builds the "sleep" contributor from the recent window's
// mean duration and, when the baseline window has enough nights to trust a
// personal onset average, the recent nights' mean deviation from it.
func (s *service) healthScoreSleep(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (scoring.HealthScoreContributor, error) {
	baselineStart := today.AddDate(0, 0, -(cfg.HealthScoreBaselineDays - 1))
	recentStartStr := today.AddDate(0, 0, -(cfg.HealthScoreWindowDays - 1)).Format("2006-01-02")
	todayStr := today.Format("2006-01-02")

	// Widen by a day, same as loadSleep: a night is attributed to its wake-up
	// day but start_time is the evening before.
	logs, err := s.vitals.ListSleepLogs(ctx, userID, baselineStart.AddDate(0, 0, -1))
	if err != nil {
		return scoring.HealthScoreContributor{}, err
	}
	baselineStartStr := baselineStart.Format("2006-01-02")
	type night struct {
		durationHours float64
		onsetMinutes  float64
	}
	nights := map[string]night{}
	for _, sl := range logs {
		if sl.Day < baselineStartStr || sl.Day > todayStr {
			continue
		}
		dur := sl.EndTime.Sub(sl.StartTime).Hours()
		if sl.TotalMinutes != nil {
			dur = float64(*sl.TotalMinutes) / 60
		}
		nights[sl.Day] = night{durationHours: dur, onsetMinutes: sleepOnsetMinutes(sl.StartTime, sl.TimezoneOffset)}
	}

	var recentDur, recentOnsets, baselineOnsets []float64
	for day, n := range nights {
		baselineOnsets = append(baselineOnsets, n.onsetMinutes)
		if day >= recentStartStr && day <= todayStr {
			recentDur = append(recentDur, n.durationHours)
			recentOnsets = append(recentOnsets, n.onsetMinutes)
		}
	}
	if len(recentDur) == 0 {
		return scoring.HealthContributorSleep(0, 0, false, false, cfg), nil
	}

	hasRegularity := len(baselineOnsets) >= sleepBaselineMinNights
	var meanDeviation float64
	if hasRegularity {
		baselineAvgOnset := mean(baselineOnsets)
		devs := make([]float64, 0, len(recentOnsets))
		for _, o := range recentOnsets {
			devs = append(devs, math.Abs(o-baselineAvgOnset))
		}
		meanDeviation = mean(devs)
	}
	return scoring.HealthContributorSleep(mean(recentDur), meanDeviation, hasRegularity, true, cfg), nil
}

// sleepOnsetMinutes maps a bedtime instant onto minutes-since-previous-noon,
// so a typical evening bedtime (e.g. 22:00) and an after-midnight one (e.g.
// 01:00 -> 25:00) sit on the same continuous scale instead of wrapping at
// midnight. Times are stored UTC with the local wall-clock offset kept
// alongside (store.SleepLog.TimezoneOffset, JS getTimezoneOffset style:
// minutes-west-of-UTC, so local = UTC - offset); the bedtime lever grades and
// displays the user's local clock, so shift into local before extracting the
// hour — without this a non-UTC user's "Lights out" window renders and scores
// in UTC.
func sleepOnsetMinutes(t time.Time, tzOffsetMin int) float64 {
	// Legacy compatibility: rows imported before the sleepimport.go convention
	// fix hold Zepp's raw seconds-east-of-UTC (e.g. 3600 for UTC+1). A real
	// minutes-west offset never exceeds ±14h (±840 min), so a magnitude past
	// that must be seconds — normalize to minutes-west (= -secondsEast/60).
	if tzOffsetMin > 900 || tzOffsetMin < -900 {
		tzOffsetMin = -tzOffsetMin / 60
	}
	u := t.UTC().Add(time.Duration(-tzOffsetMin) * time.Minute)
	minutes := float64(u.Hour()*60 + u.Minute())
	if u.Hour() < 12 {
		minutes += 24 * 60
	}
	return minutes
}

// computeStrengths builds the three pillar habit-strength EMAs from the same
// per-domain loaders the Health Score uses.
func (s *service) computeStrengths(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) ([]StrengthView, error) {
	meds, err := s.strengthMeds(ctx, userID, today, cfg)
	if err != nil {
		return nil, err
	}
	movement, err := s.strengthMovement(ctx, userID, today, cfg)
	if err != nil {
		return nil, err
	}
	measurement, err := s.strengthMeasurement(ctx, userID, today, cfg)
	if err != nil {
		return nil, err
	}
	return []StrengthView{meds, movement, measurement}, nil
}

// strengthMeds folds each lookback day's taken/expected dose ratio into the
// EMA at daily frequency. A day with no expected doses is skipped (not a
// miss) — mirrors healthScoreAdherence's "unscored, not zero" treatment.
func (s *service) strengthMeds(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (StrengthView, error) {
	start := today.AddDate(0, 0, -(habitStrengthLookbackDays - 1))
	byDay, err := s.loadAdherenceRange(ctx, userID, start, today.AddDate(0, 0, 1))
	if err != nil {
		return StrengthView{}, err
	}
	var checkmarks []float64
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		ad, ok := byDay[utcMidnight(d).Unix()]
		if !ok {
			continue
		}
		taken, expected := takenExpected(ad)
		if expected == 0 {
			continue
		}
		checkmarks = append(checkmarks, float64(taken)/float64(expected))
	}
	return StrengthView{Key: "meds", Label: "Medication", Value: scoring.HabitStrength(checkmarks, 1, cfg), Frequency: 1}, nil
}

// takenExpected counts a day's taken and expected doses under the shared
// adherence rule: a TAKEN dose counts toward both, a MISSED dose toward
// expected only, and a skip-with-reason toward neither.
func takenExpected(ad scoring.AdherenceDay) (taken, expected int) {
	for _, dose := range ad.Doses {
		switch dose.Status {
		case scoring.DoseTaken:
			taken++
			expected++
		case scoring.DoseMissed:
			expected++
		}
	}
	return taken, expected
}

// movementWeeklyTarget / movementWindowDays define the flexible "3x per 7
// days" movement cadence; movementStrengthFrequency is the derived per-day
// frequency the EMA decay multiplier is tuned to.
const (
	movementWeeklyTarget      = 3
	movementWindowDays        = 7
	movementStrengthFrequency = float64(movementWeeklyTarget) / float64(movementWindowDays)
)

// strengthMovement folds an *implicit* daily checkmark into the EMA: each
// day's value is the share of the weekly target met in the trailing 7 days
// (min(1, workouts_in_last_7d / 3)). This is what lets a steady 3x/week
// cadence converge to ~1.0 — the same implicit-checkmark trick uhabits uses
// for non-daily habits. A raw per-day 0/1 series would instead top out at the
// completion rate (~0.43 for a perfect 3x/week), because an EMA's steady state
// is the mean of its input: the frequency parameter tunes decay speed but
// cannot rescale that mean.
func (s *service) strengthMovement(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (StrengthView, error) {
	start := today.AddDate(0, 0, -(habitStrengthLookbackDays - 1))
	end := today.AddDate(0, 0, 1)
	hist, err := s.workout.ListHistory(userID, workoutHistoryLimit)
	if err != nil {
		return StrengthView{}, err
	}
	workoutDay := map[string]bool{}
	for _, ws := range hist {
		if ws.Status != "completed" {
			continue
		}
		at := sessionInstant(ws)
		if inDay(at, start, end) {
			workoutDay[utcMidnight(at).Format("2006-01-02")] = true
		}
	}
	checkmarks := make([]float64, 0, habitStrengthLookbackDays)
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		count := 0
		for k := 0; k < movementWindowDays; k++ {
			if workoutDay[d.AddDate(0, 0, -k).Format("2006-01-02")] {
				count++
			}
		}
		checkmarks = append(checkmarks, math.Min(1, float64(count)/float64(movementWeeklyTarget)))
	}
	value := scoring.HabitStrength(checkmarks, movementStrengthFrequency, cfg)
	return StrengthView{Key: "movement", Label: "Movement", Value: value, Frequency: movementStrengthFrequency}, nil
}

// strengthMeasurement folds each lookback day's "logged anything" checkmark
// (any BP reading, weigh-in, or food log that day) into the EMA at daily
// frequency — a genuine miss on a day with no log of any kind.
func (s *service) strengthMeasurement(ctx context.Context, userID int64, today time.Time, cfg scoring.Config) (StrengthView, error) {
	start := today.AddDate(0, 0, -(habitStrengthLookbackDays - 1))
	bpReadings, err := s.bp.ListReadings(ctx, userID, start)
	if err != nil {
		return StrengthView{}, err
	}
	weightLogs, err := s.weight.ListLogs(ctx, userID, start)
	if err != nil {
		return StrengthView{}, err
	}
	foodLogs, err := s.food.ListLogs(ctx, userID, today, habitStrengthLookbackDays)
	if err != nil {
		return StrengthView{}, err
	}

	loggedDay := map[string]bool{}
	for _, r := range bpReadings {
		loggedDay[r.MeasuredAt.UTC().Format("2006-01-02")] = true
	}
	for _, l := range weightLogs {
		loggedDay[l.MeasuredAt.UTC().Format("2006-01-02")] = true
	}
	for _, l := range foodLogs {
		loggedDay[l.EatenAt.UTC().Format("2006-01-02")] = true
	}

	checkmarks := make([]float64, 0, habitStrengthLookbackDays)
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		if loggedDay[d.Format("2006-01-02")] {
			checkmarks = append(checkmarks, 1)
		} else {
			checkmarks = append(checkmarks, 0)
		}
	}
	return StrengthView{Key: "measurement", Label: "Measurement", Value: scoring.HabitStrength(checkmarks, 1, cfg), Frequency: 1}, nil
}

// ----- small numeric helpers -------------------------------------------------

// mean returns the arithmetic mean of vals, or 0 for an empty slice.
func mean(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	var sum float64
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

// median returns the middle value of vals (averaging the two middle values for
// an even-length slice), or 0 for an empty slice. Used for the bedtime-timing
// baseline (gamification-10 Task 2): a median resists a single very late night
// skewing the "usual bedtime" the way a mean would.
func median(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sorted := append([]float64(nil), vals...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

// dailyMinByDay buckets HR samples into per-UTC-day minimums — the same
// "day's minimum HR sample" resting-HR proxy loadVitalsAuto uses for a single
// day, generalized across a window.
func dailyMinByDay(samples []store.VitalsHeartLog) map[string]int {
	out := map[string]int{}
	for _, smp := range samples {
		day := smp.DateTime.UTC().Format("2006-01-02")
		if v, ok := out[day]; !ok || smp.Value < v {
			out[day] = smp.Value
		}
	}
	return out
}

// meanInRange averages the per-day values present in [start, end] (inclusive
// UTC days), reporting ok=false when none of those days have a value.
func meanInRange(dailyVals map[string]int, start, end time.Time) (float64, bool) {
	var sum float64
	var n int
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		if v, ok := dailyVals[d.Format("2006-01-02")]; ok {
			sum += float64(v)
			n++
		}
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}
