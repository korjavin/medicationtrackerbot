package gamification

// scoreday.go is the daily scoring + persistence path (Task 7): ScoreDay loads
// one user-day's rows from each narrow per-domain store, maps them onto the pure
// scoring engine's input structs, runs the scorers against the user's effective
// Config (recommended defaults overlaid with their target overrides), and writes
// the resulting HP awards plus the recomputed cached state through the
// gamification repo. The state recompute folds the weekly-cadence streak forward
// (Task 8): see advanceStreak in streak.go.
//
// Mapping scope decisions for the MVP single-day path (each documented at its
// loader): improvement-vs-baseline (HR/stress) and sleep-timing regularity need
// a trailing personal baseline and are left "unknown" so the scorers fall back to
// their absolute bands; weight is scored as maintenance around a trailing
// average; weekly activity minutes come from completed workout-session durations.

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// Tunable windows for the trailing-window loaders. Kept here (not in
// scoring.Config) because they shape how the service reads history, not the
// science of a single day's score.
const (
	movementWeekDays    = 7   // rolling window for WHO weekly-activity progress
	weightLookbackDays  = 14  // trailing window for the maintenance band center
	workoutHistoryLimit = 500 // plenty to cover the movement week window
	diaryDayLimit       = 100 // cap on entries counted for one day's Mind floor
)

// Target-override metric keys (gamification_targets.metric_key). Only band-shaped
// metrics that map cleanly onto a scoring.Config Band are overridable in the MVP;
// unknown keys are ignored by the resolver for forward compatibility.
const (
	TargetKeyBPSystolic  = "bp_systolic"
	TargetKeyBPDiastolic = "bp_diastolic"
	TargetKeyRestingHR   = "resting_hr"
	TargetKeyStress      = "stress"
	TargetKeySleepHours  = "sleep_hours"
	TargetKeySteps       = "steps"
)

// ScoreDay computes the day's HP awards and the recomputed state and persists
// both atomically. It short-circuits to a no-op when the feature flag is off so
// transports/backfill can call it unconditionally. day is normalized to
// UTC-midnight; re-scoring the same day with the same data is idempotent (the
// ledger's UNIQUE key + INSERT OR REPLACE).
func (s *service) ScoreDay(ctx context.Context, userID int64, day time.Time) error {
	enabled, err := s.gate(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	cfg, err := s.effectiveConfig(ctx, userID)
	if err != nil {
		return err
	}

	start := utcMidnight(day)
	end := start.AddDate(0, 0, 1)

	awards, err := s.scoreDayAwards(ctx, userID, start, end, cfg)
	if err != nil {
		return err
	}
	entries := awardsToEntries(userID, start, awards)

	st, err := s.recomputeState(ctx, userID, start, entries, cfg)
	if err != nil {
		return err
	}

	_, err = s.gam.ApplyDayScore(ctx, userID, entries, st)
	return err
}

// scoreDayAwards loads each domain's rows for [start, end) and runs its scorer,
// concatenating the awards. A load error from any domain aborts the day (partial
// scoring would silently understate HP).
func (s *service) scoreDayAwards(ctx context.Context, userID int64, start, end time.Time, cfg scoring.Config) ([]scoring.Award, error) {
	var awards []scoring.Award

	adh, err := s.loadAdherence(ctx, userID, start, end)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreAdherence(adh, cfg)...)

	bpDay, err := s.loadBP(ctx, userID, start, end)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreBP(bpDay, cfg)...)

	va, err := s.loadVitalsAuto(ctx, userID, start, end)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreVitalsAuto(va, cfg)...)

	sleep, err := s.loadSleep(ctx, userID, start)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreSleep(sleep, cfg)...)

	mov, err := s.loadMovement(ctx, userID, start, end)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreMovement(mov, cfg)...)

	nour, err := s.loadNourishment(ctx, userID, start)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreNourishment(nour, cfg)...)

	wt, err := s.loadWeight(ctx, userID, start, end, cfg)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreWeight(wt, cfg)...)

	mind, err := s.loadMind(ctx, userID, start, end)
	if err != nil {
		return nil, err
	}
	awards = append(awards, scoring.ScoreMind(mind, cfg)...)

	return awards, nil
}

// recomputeState builds the new cached state for the user after this day's awards
// land. Lifetime HP is the prior ledger sum minus this day's old awards plus the
// new ones (correct because re-scoring the same data reproduces the same UNIQUE
// keys, so old rows are fully replaced). Level and insight tier are recomputed
// but never allowed to decrease (§7). The weekly-cadence streak is folded forward
// via advanceStreak (§9). LastScoredDay only advances forward.
func (s *service) recomputeState(ctx context.Context, userID int64, start time.Time, entries []gamstore.LedgerEntry, cfg scoring.Config) (gamstore.State, error) {
	prev, err := s.gam.GetState(ctx, userID)
	if err != nil {
		return gamstore.State{}, err
	}

	dayKey := start.Unix()
	oldDay, err := s.gam.ListLedger(ctx, userID, dayKey, dayKey)
	if err != nil {
		return gamstore.State{}, err
	}
	curSum, err := s.gam.SumHP(ctx, userID)
	if err != nil {
		return gamstore.State{}, err
	}

	lifetime := curSum - sumLedgerHP(oldDay) + sumLedgerHP(entries)
	if lifetime < 0 {
		lifetime = 0
	}

	level := scoring.LevelForLifetimeHP(lifetime, cfg)
	if level < prev.Level {
		level = prev.Level // levels never decrease
	}
	tier := scoring.InsightTierForLevel(level, cfg)
	if tier < prev.InsightTier {
		tier = prev.InsightTier
	}

	st := prev
	st.UserID = userID
	st.LifetimeHP = lifetime
	st.Level = level
	st.InsightTier = tier

	// Fold the weekly-cadence streak forward (§9): crossing into a later week
	// finalizes the intervening weeks — the week just left counts as met, fully
	// skipped weeks are misses that spend a banked freeze (else reset). Never
	// negative; re-scoring the same or an earlier day is a no-op (idempotent).
	st.CurrentStreak, st.LongestStreak, st.Freezes = s.advanceStreak(ctx, userID, prev, start, cfg)

	if prev.LastScoredDay == nil || start.After(*prev.LastScoredDay) {
		d := start
		st.LastScoredDay = &d
	}
	return st, nil
}

// ----- effective config (recommendations overlaid with user overrides) -------

// effectiveConfig returns the user's scoring Config: a copy of the service's
// recommended defaults with each gamification_targets override merged onto the
// matching band. Targets store only what the user changed; unset Low/High/Falloff
// fields keep the recommended value.
func (s *service) effectiveConfig(ctx context.Context, userID int64) (scoring.Config, error) {
	cfg := s.cfg
	targets, err := s.gam.ListTargets(ctx, userID)
	if err != nil {
		return scoring.Config{}, err
	}
	for _, t := range targets {
		applyTarget(&cfg, t)
	}
	return cfg, nil
}

// applyTarget overlays one band-shaped override onto cfg. Unknown metric keys are
// ignored (forward-compatible with overrides this MVP doesn't yet honor).
func applyTarget(cfg *scoring.Config, t gamstore.Target) {
	switch t.MetricKey {
	case TargetKeyBPSystolic:
		cfg.BPSystolic = bandFromTarget(cfg.BPSystolic, t)
	case TargetKeyBPDiastolic:
		cfg.BPDiastolic = bandFromTarget(cfg.BPDiastolic, t)
	case TargetKeyRestingHR:
		cfg.RestingHR = bandFromTarget(cfg.RestingHR, t)
	case TargetKeyStress:
		cfg.StressBand = bandFromTarget(cfg.StressBand, t)
	case TargetKeySleepHours:
		cfg.SleepHours = bandFromTarget(cfg.SleepHours, t)
	case TargetKeySteps:
		cfg.StepsBand = bandFromTarget(cfg.StepsBand, t)
	}
}

// bandFromTarget returns base with only the override's set (non-nil) fields
// applied, so a one-sided override (e.g. only Low) keeps the recommended High and
// Falloff.
func bandFromTarget(base scoring.Band, t gamstore.Target) scoring.Band {
	b := base
	if t.LowVal != nil {
		b.Low = *t.LowVal
	}
	if t.HighVal != nil {
		b.High = *t.HighVal
	}
	if t.Falloff != nil {
		b.Falloff = *t.Falloff
	}
	return b
}

// ----- per-domain loaders ----------------------------------------------------

// loadAdherence maps the day's scheduled-dose history onto AdherenceDay. TAKEN
// doses carry their minutes-late (negative = early → 0); SKIPPED are honest skips
// (floor only, excluded from the outcome); MISSED drag the outcome down. PENDING
// doses are ignored so a not-yet-resolved day is never penalized.
func (s *service) loadAdherence(ctx context.Context, userID int64, start, end time.Time) (scoring.AdherenceDay, error) {
	logs, err := s.med.ListIntakeHistory(ctx, userID, start, end)
	if err != nil {
		return scoring.AdherenceDay{}, err
	}
	var doses []scoring.Dose
	for _, l := range logs {
		switch l.Status {
		case "TAKEN":
			mins := 0
			if l.TakenAt != nil {
				if d := l.TakenAt.Sub(l.ScheduledAt); d > 0 {
					mins = int(d.Minutes())
				}
			}
			doses = append(doses, scoring.Dose{Status: scoring.DoseTaken, MinutesLate: mins})
		case "SKIPPED":
			doses = append(doses, scoring.Dose{Status: scoring.DoseSkippedWithReason})
		case "MISSED":
			doses = append(doses, scoring.Dose{Status: scoring.DoseMissed})
		}
	}
	return scoring.AdherenceDay{Doses: doses}, nil
}

// loadBP filters the user's readings to the day and maps systolic/diastolic to
// floats for the two-sided BP scorer.
func (s *service) loadBP(ctx context.Context, userID int64, start, end time.Time) (scoring.BPDay, error) {
	readings, err := s.bp.ListReadings(ctx, userID, start)
	if err != nil {
		return scoring.BPDay{}, err
	}
	var out scoring.BPDay
	for _, r := range readings {
		if inDay(r.MeasuredAt, start, end) {
			out.Readings = append(out.Readings, scoring.BPReading{
				Systolic:  float64(r.Systolic),
				Diastolic: float64(r.Diastolic),
			})
		}
	}
	return out, nil
}

// loadVitalsAuto maps the day's auto-captured streams: resting HR proxied by the
// day's minimum HR sample, SpO₂ and stress by their daily means. Baselines are
// left zero (unknown) so the scorer uses its absolute bands — improvement-vs-self
// needs a trailing personal baseline that the single-day path does not compute.
func (s *service) loadVitalsAuto(ctx context.Context, userID int64, start, end time.Time) (scoring.VitalsAutoDay, error) {
	hr, err := s.vitals.ListHeart(ctx, userID, start, end)
	if err != nil {
		return scoring.VitalsAutoDay{}, err
	}
	spo2, err := s.vitals.ListSpO2(ctx, userID, start, end)
	if err != nil {
		return scoring.VitalsAutoDay{}, err
	}
	stress, err := s.vitals.ListStress(ctx, userID, start, end)
	if err != nil {
		return scoring.VitalsAutoDay{}, err
	}

	var out scoring.VitalsAutoDay
	if len(hr) > 0 {
		min := hr[0].Value
		for _, h := range hr[1:] {
			if h.Value < min {
				min = h.Value
			}
		}
		out.HasRestingHR = true
		out.RestingHR = float64(min)
	}
	if len(spo2) > 0 {
		sum := 0
		for _, v := range spo2 {
			sum += v.Value
		}
		out.HasSpO2 = true
		out.SpO2 = float64(sum) / float64(len(spo2))
	}
	if len(stress) > 0 {
		sum := 0
		for _, v := range stress {
			sum += v.Value
		}
		out.HasStress = true
		out.Stress = float64(sum) / float64(len(stress))
	}
	return out, nil
}

// loadSleep maps the night attributed to this calendar day onto SleepDay.
// Duration comes from total_minutes when present, else the start→end span.
// Regularity is left unknown (no personal onset baseline in the single-day path).
func (s *service) loadSleep(ctx context.Context, userID int64, start time.Time) (scoring.SleepDay, error) {
	logs, err := s.vitals.ListSleepLogs(ctx, userID, start)
	if err != nil {
		return scoring.SleepDay{}, err
	}
	dayStr := start.Format("2006-01-02")
	var out scoring.SleepDay
	for _, sl := range logs {
		if sl.Day != dayStr {
			continue
		}
		out.Logged = true
		if sl.TotalMinutes != nil {
			out.DurationHours = float64(*sl.TotalMinutes) / 60
		} else {
			out.DurationHours = sl.EndTime.Sub(sl.StartTime).Hours()
		}
		break
	}
	return out, nil
}

// loadMovement maps the day's steps + workout activity. Steps come from the
// day_stats row; a completed workout on the day flags the activity floor; the
// weekly WHO-progress outcome accumulates completed-session durations over the
// trailing movement week.
func (s *service) loadMovement(ctx context.Context, userID int64, start, end time.Time) (scoring.MovementDay, error) {
	stats, err := s.vitals.ListDayStats(ctx, userID, start)
	if err != nil {
		return scoring.MovementDay{}, err
	}
	dayStr := start.Format("2006-01-02")
	var out scoring.MovementDay
	for _, st := range stats {
		if st.Day == dayStr {
			out.HasSteps = true
			out.Steps = float64(st.Steps)
			break
		}
	}

	hist, err := s.workout.ListHistory(userID, workoutHistoryLimit)
	if err != nil {
		return scoring.MovementDay{}, err
	}
	weekStart := start.AddDate(0, 0, -(movementWeekDays - 1))
	var weekMin float64
	for _, ws := range hist {
		if ws.Status != "completed" {
			continue
		}
		at := sessionInstant(ws)
		if inDay(at, start, end) {
			out.WorkoutLogged = true
		}
		if !at.Before(weekStart) && at.Before(end) && ws.StartedAt != nil && ws.CompletedAt != nil {
			if d := ws.CompletedAt.Sub(*ws.StartedAt); d > 0 {
				weekMin += d.Minutes()
			}
		}
	}
	if weekMin > 0 {
		out.HasActivity = true
		out.WeeklyActivityMinutes = weekMin
	}
	return out, nil
}

// loadNourishment maps the day's food totals + the user's calorie/protein targets
// onto NourishmentDay. Vegetable servings and an explicit calorie floor are not
// tracked in the data model yet (left zero → those sub-scores are skipped); the
// two-sided calorie band already prevents rewarding under-eating.
func (s *service) loadNourishment(ctx context.Context, userID int64, start time.Time) (scoring.NourishmentDay, error) {
	logs, err := s.food.ListLogs(ctx, userID, start, 1)
	if err != nil {
		return scoring.NourishmentDay{}, err
	}
	stats, err := s.food.GetStats(ctx, userID, start, 1)
	if err != nil {
		return scoring.NourishmentDay{}, err
	}
	targets, err := s.food.GetTargets(ctx)
	if err != nil {
		return scoring.NourishmentDay{}, err
	}

	var out scoring.NourishmentDay
	out.Logged = len(logs) > 0
	if stats != nil {
		out.Calories = float64(stats.Calories)
		out.Protein = float64(stats.Protein)
	}
	out.CalorieTarget = float64(targets.Calories)
	out.ProteinTarget = float64(targets.Protein)
	return out, nil
}

// loadWeight maps the day's weigh-in onto WeightDay in maintenance mode: the band
// is centered on the trailing average of prior readings (± the configured
// falloff), rewarding stability. With no prior readings the outcome is skipped
// and only the weigh-in floor is granted. (Goal-pace mode is supported by the
// scorer and can be wired once a per-user goal/start-weight feed is available.)
func (s *service) loadWeight(ctx context.Context, userID int64, start, end time.Time, cfg scoring.Config) (scoring.WeightDay, error) {
	logs, err := s.weight.ListLogs(ctx, userID, start.AddDate(0, 0, -weightLookbackDays))
	if err != nil {
		return scoring.WeightDay{}, err
	}

	var out scoring.WeightDay
	var priorSum float64
	var priorN int
	dayFound := false
	for _, l := range logs {
		if inDay(l.MeasuredAt, start, end) {
			if !dayFound { // logs are DESC; first match is the latest reading that day
				out.Logged = true
				out.Weight = l.Weight
				dayFound = true
			}
			continue
		}
		if l.MeasuredAt.Before(start) {
			priorSum += l.Weight
			priorN++
		}
	}
	if !out.Logged {
		return out, nil
	}
	if priorN > 0 {
		avg := priorSum / float64(priorN)
		out.Mode = scoring.ModeWeightMaintenance
		out.BandLow = avg - cfg.WeightMaintenanceFalloff
		out.BandHigh = avg + cfg.WeightMaintenanceFalloff
	}
	return out, nil
}

// loadMind counts the day's diary entries for the Mind floor. The reflection
// "noticing" bonus needs prompt-engagement tracking the data model lacks, so it
// is left off (mood value is never read — §6.8).
func (s *service) loadMind(ctx context.Context, userID int64, start, end time.Time) (scoring.MindDay, error) {
	notes, err := s.diary.List(ctx, userID, start, end, diaryDayLimit, 0)
	if err != nil {
		return scoring.MindDay{}, err
	}
	return scoring.MindDay{JournaledEntries: len(notes)}, nil
}

// ----- helpers ---------------------------------------------------------------

// awardsToEntries lifts the pure scorer awards into store ledger rows by stamping
// the user and the day; the repo stamps created_at and normalizes day_unix.
func awardsToEntries(userID int64, day time.Time, awards []scoring.Award) []gamstore.LedgerEntry {
	out := make([]gamstore.LedgerEntry, 0, len(awards))
	for _, a := range awards {
		out = append(out, gamstore.LedgerEntry{
			UserID:       userID,
			Day:          day,
			Ring:         a.Ring,
			SourceMetric: a.SourceMetric,
			Kind:         a.Kind,
			HP:           a.HP,
			Detail:       a.Detail,
		})
	}
	return out
}

// sumLedgerHP totals the HP across a slice of ledger entries.
func sumLedgerHP(entries []gamstore.LedgerEntry) int {
	sum := 0
	for _, e := range entries {
		sum += e.HP
	}
	return sum
}

// sessionInstant returns the instant a workout session is attributed to:
// completion time when set, else the scheduled date.
func sessionInstant(ws store.WorkoutSession) time.Time {
	if ws.CompletedAt != nil {
		return *ws.CompletedAt
	}
	return ws.ScheduledDate
}

// inDay reports whether t falls in the half-open [start, end) day window.
func inDay(t, start, end time.Time) bool {
	return !t.Before(start) && t.Before(end)
}

// utcMidnight truncates any instant to its UTC-midnight day key, matching the
// store's day_unix normalization so ledger reads/writes line up.
func utcMidnight(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
}
