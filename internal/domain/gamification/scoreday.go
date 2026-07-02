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
	"encoding/json"
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
// transports can call it unconditionally. day is normalized to UTC-midnight;
// re-scoring the same day with the same data is idempotent (the ledger's UNIQUE
// key + INSERT OR REPLACE).
func (s *service) ScoreDay(ctx context.Context, userID int64, day time.Time) error {
	enabled, err := s.gate(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	return s.scoreDayLocked(ctx, userID, day)
}

// scoreDayLocked is the ungated single-day scorer: it acquires the per-user
// scoring lock and runs scoreDayCore once. ScoreDay calls it after the
// feature-flag gate. Backfill does NOT use it — it holds the lock once across the
// whole 365-day walk and calls scoreDayCore directly (see backfill.go), so the
// reset + every day's score + the completion latch commit as one atomic unit per
// user. The caller owns the gate.
//
// Serialize the whole load → recompute → write per user. The lock must span the
// domain-data loads (effectiveConfig + scoreDayAwards), not just the state
// recompute, for two independent reasons:
//
//  1. State consistency: recomputeState reads the prior ledger sum + state and
//     ApplyDayScore commits the derived state; two concurrent scores (even for
//     different days) could otherwise both read the same sum and the last writer
//     would persist a lifetime_hp/level/streak that no longer matches the ledger.
//  2. Stale-overwrite: ApplyDayScore REPLACES the whole day's ledger with the
//     awards computed from one snapshot of the domain data. If the loads sat
//     outside the lock, a backfill could load today's old data, a live same-day
//     re-score could then load + write newer data, and the backfill could finally
//     acquire the lock and replace the day with its stale awards — permanently
//     dropping the newer reading. Holding the lock from before the loads forces
//     the two calls to run start-to-finish in commit order, so the last writer
//     always scored the freshest data.
//
// The lock is per-user and per-user scoring is infrequent (a one-time 365-day
// backfill walk plus event-driven re-scores), so the added serialization is
// negligible. In-process locking suffices: the bot is a single binary over a
// file-backed SQLite DB, so there is no second writer process.
func (s *service) scoreDayLocked(ctx context.Context, userID int64, day time.Time) error {
	unlock := s.scoreMu.lock(userID)
	defer unlock()
	return s.scoreDayCore(ctx, userID, day)
}

// scoreDayCore runs one day's load → recompute → write pipeline WITHOUT taking
// the per-user scoring lock: the caller MUST already hold it (scoreDayLocked for
// a single online score, Backfill for the whole walk). Splitting the lock out is
// what lets Backfill hold one lock across all 365 days — so a concurrent live
// ScoreDay can neither interleave between days (jumping LastScoredDay into a later
// week and no-oping the streak fold for every remaining day) nor race the
// streak reset.
func (s *service) scoreDayCore(ctx context.Context, userID int64, day time.Time) error {
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

	st, changed, err := s.recomputeState(ctx, userID, start, entries, cfg)
	if err != nil {
		return err
	}
	if !changed {
		// Idempotent no-op: the recomputed ledger + state are identical to what's
		// already stored, so re-writing them would only bump timestamps and fire the
		// migration-073 change_events('gamification') triggers for nothing. With the
		// read-rescore on every gamification read (ensureGamificationFresh), an
		// unconditional write would feed an endless change-event → SSE → refetch →
		// rescore loop on an open Today/Journey screen. Skip when nothing changed.
		return nil
	}

	_, err = s.gam.ApplyDayScore(ctx, userID, start, entries, st)
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

// ringProgress returns the day's per-ring "how close to closing" gauge: the
// best range-membership r among that ring's outcome/consistency awards,
// computed by re-running the same loaders + pure scorers scoreDayAwards uses
// (no new persistence, no schema change — the scorers compute r today and
// then throw it away once it's been folded into an HP amount). A ring with no
// r-bearing award for the day (no data, or every membership rounded to 0 HP
// and was dropped by addAward) reads 0.
//
// Ponytail note: this recomputes scoreDayAwards a second time on top of the
// existing Plan-4 read-rescore; on single-user SQLite the extra pure-compute
// is negligible. If read latency ever matters, have scoreDayCore return its
// membership map alongside the awards instead of recomputing here — same
// numbers, one pass.
func (s *service) ringProgress(ctx context.Context, userID int64, day time.Time, cfg scoring.Config) (map[string]float64, error) {
	start := utcMidnight(day)
	end := start.AddDate(0, 0, 1)
	awards, err := s.scoreDayAwards(ctx, userID, start, end, cfg)
	if err != nil {
		return nil, err
	}
	progress := make(map[string]float64, 5)
	for _, a := range awards {
		r, ok := awardMembership(a)
		if ok && r > progress[a.Ring] {
			progress[a.Ring] = r
		}
	}
	return progress, nil
}

// awardMembership extracts the range-membership r an outcome/consistency
// award's Detail carries (see scoring's detailR), if any. Floor awards (whose
// Detail is "" or a log count) report ok=false.
func awardMembership(a scoring.Award) (r float64, ok bool) {
	if a.Detail == "" {
		return 0, false
	}
	var d struct {
		R *float64 `json:"r"`
	}
	if err := json.Unmarshal([]byte(a.Detail), &d); err != nil || d.R == nil {
		return 0, false
	}
	return *d.R, true
}

// syncPendingRings reports, for today only, whether the Mind and Movement
// rings are missing their device-synced sample (no sleep log for last night,
// no day_stats steps row for today) — "hasn't synced yet" rather than "the
// user failed today". It reuses the same loaders scoreDayAwards already uses
// (same day reads, no new query shapes), so a late Mi Band import that fills in
// today's rows makes this false again for free on the next read.
func (s *service) syncPendingRings(ctx context.Context, userID int64, day time.Time) (map[string]bool, error) {
	start := utcMidnight(day)
	end := start.AddDate(0, 0, 1)

	sleep, err := s.loadSleep(ctx, userID, start)
	if err != nil {
		return nil, err
	}
	mov, err := s.loadMovement(ctx, userID, start, end)
	if err != nil {
		return nil, err
	}
	return map[string]bool{
		scoring.RingMind:     !sleep.Logged,
		scoring.RingMovement: !mov.HasSteps,
	}, nil
}

// recomputeState builds the new cached state for the user after this day's awards
// land. Lifetime HP is the prior ledger sum minus this day's old awards plus the
// new ones (correct because re-scoring the same data reproduces the same UNIQUE
// keys, so old rows are fully replaced). Level and insight tier are recomputed
// but never allowed to decrease (§7). The weekly-cadence streak is folded forward
// via advanceStreak (§9) and still persisted here for backward compatibility,
// but GetSummary/GetJourney no longer read current_streak/freezes from this
// row — they recompute both from the ledger on every read via deriveStreak
// (Task 2, gamification-6), which a late import can repair and this
// transactional fold cannot. LastScoredDay only advances forward.
func (s *service) recomputeState(ctx context.Context, userID int64, start time.Time, entries []gamstore.LedgerEntry, cfg scoring.Config) (gamstore.State, bool, error) {
	prev, err := s.gam.GetState(ctx, userID)
	if err != nil {
		return gamstore.State{}, false, err
	}

	dayKey := start.Unix()
	oldDay, err := s.gam.ListLedger(ctx, userID, dayKey, dayKey)
	if err != nil {
		return gamstore.State{}, false, err
	}
	curSum, err := s.gam.SumHP(ctx, userID)
	if err != nil {
		return gamstore.State{}, false, err
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
	// negative; re-scoring the same or an earlier day is a no-op (idempotent). A
	// ledger read error aborts the whole day so the streak is never advanced off a
	// guessed-miss (which would irreversibly burn a freeze).
	st.CurrentStreak, st.LongestStreak, st.Freezes, err = s.advanceStreak(ctx, userID, prev, start, cfg)
	if err != nil {
		return gamstore.State{}, false, err
	}

	if prev.LastScoredDay == nil || start.After(*prev.LastScoredDay) {
		d := start
		st.LastScoredDay = &d
	}

	// changed reports whether persisting (st, entries) would actually alter the
	// stored ledger or state. When both are identical, the caller skips the write
	// so the change_events trigger doesn't fire on an idempotent re-score (the
	// read-rescore loop guard — see scoreDayCore). Timestamps are ignored: they are
	// the only fields a no-op write would touch.
	changed := !ledgerSameAwards(oldDay, entries) || !stateMeaningfullyEqual(prev, st)
	return st, changed, nil
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

// targetMetricKeys lists the band-shaped metrics a user may override, in display
// order. Kept in lockstep with applyTarget / bandForMetric / isKnownTargetMetric:
// the targets read model iterates it to surface every overridable band.
var targetMetricKeys = []string{
	TargetKeyBPSystolic, TargetKeyBPDiastolic, TargetKeyRestingHR,
	TargetKeyStress, TargetKeySleepHours, TargetKeySteps,
}

// bandForMetric returns the cfg Band a target metric key maps onto — the inverse
// of applyTarget's switch, used by the targets read model (EffectiveTargets) to
// surface effective and recommended band values. An unknown key returns the zero
// Band.
func bandForMetric(cfg scoring.Config, key string) scoring.Band {
	switch key {
	case TargetKeyBPSystolic:
		return cfg.BPSystolic
	case TargetKeyBPDiastolic:
		return cfg.BPDiastolic
	case TargetKeyRestingHR:
		return cfg.RestingHR
	case TargetKeyStress:
		return cfg.StressBand
	case TargetKeySleepHours:
		return cfg.SleepHours
	case TargetKeySteps:
		return cfg.StepsBand
	default:
		return scoring.Band{}
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
// (floor only, excluded from the outcome); MISSED drag the outcome down.
//
// A PENDING dose whose scheduled time has already passed (relative to now) is
// also treated as a miss. Production has no PENDING→MISSED sweep — only the demo
// seeder and the importer ever write the literal MISSED status — so a forgotten
// real dose stays PENDING forever. Were it simply ignored, an overdue dose would
// silently drop out of the outcome denominator and inflate adherence: a user who
// logs only the doses they took on time would score a perfect outcome, and the
// 365-day backfill would compute an inflated starting level. The cutoff is now,
// not the scored day's end, so a dose still due later today is never prematurely
// penalized (re-scoring on a later take corrects a same-day transient). A PENDING
// row whose slot already carries a resolved sibling (e.g. a tz_step orphan from a
// cancelled plan) is a phantom, not a forgotten dose, and is excluded; at most one
// miss is counted per overdue slot. A future-scheduled PENDING dose is unscored.
func (s *service) loadAdherence(ctx context.Context, userID int64, start, end time.Time) (scoring.AdherenceDay, error) {
	logs, err := s.med.ListIntakeHistoryByUser(ctx, userID, start, end)
	if err != nil {
		return scoring.AdherenceDay{}, err
	}
	deduped := dedupeLogicalDoses(logs)
	// Slots already carrying a resolved (acted-on) dose are accounted for; a
	// still-PENDING sibling sharing the slot must not be counted as a separate miss.
	resolved := map[slotKey]bool{}
	for _, l := range deduped {
		if intakeResolved(l) {
			resolved[slotKey{l.MedicationID, l.ScheduledAt.UTC().Unix()}] = true
		}
	}
	now := s.now()
	missedSlots := map[slotKey]bool{} // at most one miss per overdue-PENDING slot
	var doses []scoring.Dose
	for _, l := range deduped {
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
		case "PENDING":
			slot := slotKey{l.MedicationID, l.ScheduledAt.UTC().Unix()}
			if l.ScheduledAt.Before(now) && !resolved[slot] && !missedSlots[slot] {
				missedSlots[slot] = true
				doses = append(doses, scoring.Dose{Status: scoring.DoseMissed})
			}
		}
	}
	return scoring.AdherenceDay{Doses: doses}, nil
}

// slotKey identifies one logical dose slot — a (medication, scheduled-instant)
// pair. intake_log can carry more than one row per slot (a source='schedule' row
// and a source='tz_step' row materialized during a timezone transition), so the
// adherence path keys by slot to collapse and de-duplicate them.
type slotKey struct{ med, sched int64 }

// dedupeLogicalDoses collapses intake_log rows that represent the SAME logical
// dose down to one before they are scored. A (medication_id, scheduled_at_unix)
// slot can carry both a source='schedule' and a source='tz_step' row: the normal
// scheduler fired the slot at T just before the user approved a timezone-
// transition plan whose snap-to-clock step also landed at T. The medication store
// treats these as one dose — its user-action readers shadow the schedule row and
// its history readers tie-break to the tz_step row (see
// scheduleNotShadowedByTZStepGate / GetIntakeBySchedule in
// internal/store/medication/repo.go). ListIntakeHistoryByUser is a history reader
// and returns both rows, so the adherence scorer must apply the same shadowing or
// it double-counts the dose during a transition (e.g. a phantom MISSED schedule
// row scored alongside the real TAKEN tz_step row, dragging the outcome down).
//
// A schedule-family row is dropped only when a *resolved* (acted-on) tz_step
// sibling shares its slot — that is the real dose. A still-PENDING tz_step sibling
// (e.g. an orphan from a cancelled plan) does NOT shadow: it scores nothing
// anyway, and the schedule row may itself be the acted-on dose, so dropping it
// would under-count. Rows are returned in input order (scheduled_at ascending).
func dedupeLogicalDoses(logs []store.IntakeLog) []store.IntakeLog {
	shadowed := map[slotKey]bool{}
	for _, l := range logs {
		if l.Source == "tz_step" && intakeResolved(l) {
			shadowed[slotKey{l.MedicationID, l.ScheduledAt.UTC().Unix()}] = true
		}
	}
	out := make([]store.IntakeLog, 0, len(logs))
	for _, l := range logs {
		if l.Source != "tz_step" && shadowed[slotKey{l.MedicationID, l.ScheduledAt.UTC().Unix()}] {
			continue // schedule phantom shadowed by its acted-on tz_step sibling
		}
		out = append(out, l)
	}
	return out
}

// intakeResolved reports whether a dose has been acted on (its status is final),
// as opposed to a still-PENDING slot the adherence scorer ignores.
func intakeResolved(l store.IntakeLog) bool {
	switch l.Status {
	case "TAKEN", "SKIPPED", "MISSED":
		return true
	default:
		return false
	}
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
	// The vitals store uses inclusive bounds (date_time <= end), so a sample at
	// exactly next-day midnight (== end) would be attributed to both this day and
	// the next. Clip the upper bound by 1ms (storage is millisecond-resolution) to
	// keep the half-open [start, end) convention the other loaders use; the cadence
	// is anchored to 00:00 UTC, so a sample lands on this boundary every day.
	upper := end.Add(-time.Millisecond)
	hr, err := s.vitals.ListHeart(ctx, userID, start, upper)
	if err != nil {
		return scoring.VitalsAutoDay{}, err
	}
	spo2, err := s.vitals.ListSpO2(ctx, userID, start, upper)
	if err != nil {
		return scoring.VitalsAutoDay{}, err
	}
	stress, err := s.vitals.ListStress(ctx, userID, start, upper)
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
//
// A sleep session is attributed to its wake-up day (sl.Day), but its start_time
// is the prior evening's bedtime — and ListSleepLogs filters start_time >= since.
// Querying from `start` (this day's midnight) would drop the very night that
// belongs to this day (bedtime < midnight). Widen the lower bound by a day and
// let the sl.Day equality below select the right night. (Both the Mi Band import
// and the frontend store Day = the local wake-up date and start_time = the
// bedtime the evening before — see internal/domain/sleepimport.go.)
func (s *service) loadSleep(ctx context.Context, userID int64, start time.Time) (scoring.SleepDay, error) {
	logs, err := s.vitals.ListSleepLogs(ctx, userID, start.AddDate(0, 0, -1))
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
	// diary.List treats `until` as inclusive (created_at <= end), so a note at
	// exactly next-day midnight (== end) would be counted for both this day and
	// the next. Drop that single boundary instant to keep the half-open [start,
	// end) convention the other loaders use; the next day (since == end) counts it.
	count := 0
	for _, n := range notes {
		if n.CreatedAt.Equal(end) {
			continue
		}
		count++
	}
	return scoring.MindDay{JournaledEntries: count}, nil
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

// ledgerSameAwards reports whether the stored day's ledger rows carry the same
// awards as a freshly recomputed set — a multiset comparison on the award-
// identifying columns (ring/source_metric/kind) plus the value columns (hp/
// detail). Order and IDs/timestamps are ignored. Used by recomputeState to
// detect an idempotent re-score and skip the ledger rewrite.
func ledgerSameAwards(existing, computed []gamstore.LedgerEntry) bool {
	if len(existing) != len(computed) {
		return false
	}
	type key struct {
		ring, sourceMetric, kind, detail string
		hp                               int
	}
	counts := make(map[key]int, len(existing))
	for _, e := range existing {
		counts[key{e.Ring, e.SourceMetric, e.Kind, e.Detail, e.HP}]++
	}
	for _, e := range computed {
		k := key{e.Ring, e.SourceMetric, e.Kind, e.Detail, e.HP}
		counts[k]--
		if counts[k] < 0 {
			return false
		}
	}
	return true
}

// stateMeaningfullyEqual compares two cached states on every persisted field
// except updated_at (the only field an idempotent re-score would touch). Time
// pointers are compared by value so a freshly-derived LastScoredDay equal to the
// stored one counts as unchanged.
func stateMeaningfullyEqual(a, b gamstore.State) bool {
	if a.UserID != b.UserID || a.LifetimeHP != b.LifetimeHP || a.Level != b.Level ||
		a.CurrentStreak != b.CurrentStreak || a.LongestStreak != b.LongestStreak ||
		a.Freezes != b.Freezes || a.InsightTier != b.InsightTier {
		return false
	}
	return timePtrEqual(a.LastScoredDay, b.LastScoredDay) && timePtrEqual(a.BackfilledAt, b.BackfilledAt)
}

// timePtrEqual reports whether two optional instants are equal, treating two nils
// as equal and a nil/non-nil pair as unequal.
func timePtrEqual(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}
