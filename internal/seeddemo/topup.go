package seeddemo

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TopUpOptions configures an incremental top-up tick. Unlike Options, there is
// no Wipe — top-up is strictly additive and relies on per-stream "latest
// timestamp" queries to avoid duplicate inserts.
type TopUpOptions struct {
	UserID int64
	Now    time.Time
	Seed   int64
	// Days is the catalog scale used by trend/regime math (e.g. BP regime
	// blocks, weight glide). Defaults to 90 so the produced rows line up with
	// the dataset shape the demo expects from a 90-day full seed.
	Days int
}

// TopUp appends synthetic rows to each data stream from the latest stored
// timestamp forward to opts.Now. It never wipes. Idempotent within a calendar
// day: re-running with the same Now (rounded to the day) emits zero rows for
// streams whose "latest" already advanced and dedupes time-series via the
// (user_id, date_time) PK + INSERT OR IGNORE.
//
// Per-stream window resolution:
//   - vitals_heart / vitals_spo2 / vitals_stress: from = lastSample (cadence
//     handles sub-day advancement via alignUpToInterval).
//   - sleep_logs: emitted only when (now - lastSleepEnd) > 12h; from snaps to
//     the day after the last sleep ended so subsequent nights don't collide
//     with the prior night's row.
//   - bp / weight / food / workouts: from snaps to the day AFTER the latest
//     sample's calendar day. The day-after snap means top-up emits only on
//     whole past days, so a sample written by a previous tick never gets
//     overwritten — and an hourly tick that fires three times before midnight
//     emits the same set of rows the first time and a no-op the next two.
//   - diary: NOT topped up (one-time scatter from the full-seed path; see the
//     comment in the diary section below for the rationale).
//   - intake_log: per-medication LatestScheduledIntake advances the cursor;
//     the schedule's HH:MM doses are walked forward until now or end_date.
//
// Per-tick RNG seed is pcg(seed XOR (now.Unix()/86400)) so a re-run on the
// same calendar day produces an identical plan. Combined with the per-stream
// "latest" cursor this gives true idempotency at retry — the plan repeats but
// the day-after snap and INSERT OR IGNORE drop the duplicate writes.
func TopUp(ctx context.Context, s *store.Store, opts TopUpOptions) (*Summary, error) {
	if opts.UserID == 0 {
		return nil, fmt.Errorf("seeddemo: TopUp requires a non-zero UserID")
	}
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	opts.Now = opts.Now.UTC()
	if opts.Days <= 0 {
		opts.Days = 90
	}

	summary := &Summary{}
	rngSeed := uint64(opts.Seed) ^ uint64(opts.Now.Unix()/86400)
	rng := rand.New(rand.NewPCG(rngSeed, rngSeed^0x9E3779B97F4A7C15))

	// optsLike mirrors the Options the full-seed path threads through every
	// generator. We keep Days=90 (the demo catalog scale) so per-day trend
	// math (BP regime blocks, weight glide, exercise progression) lines up
	// with the dataset produced by `seeddemo -wipe`.
	optsLike := Options{
		UserID: opts.UserID,
		Days:   opts.Days,
		Seed:   opts.Seed,
		Now:    opts.Now,
	}
	clk := newClock(opts.Now, opts.Days)

	// --- Sleep ---
	// Sleep is emitted before time-series so loadRecentSleepWindows below picks
	// up any new sleep blocks for HR/SpO2/stress correlation.
	sleepEnd, hasSleep, err := s.Vitals.LatestSleepEnd(ctx, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest sleep: %w", err)
	}
	if shouldEmitSleep(sleepEnd, hasSleep, opts.Now) {
		from := dailyTopUpFrom(sleepEnd, hasSleep, opts.Now)
		if from.Before(opts.Now) {
			if _, err := generateSleep(ctx, s, optsLike, clk, rng, from, opts.Now, summary); err != nil {
				return nil, fmt.Errorf("top-up sleep: %w", err)
			}
		}
	}

	// --- BP ---
	bpLast, hasBP, err := s.BP.LatestReading(ctx, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest bp: %w", err)
	}
	if from := dailyTopUpFrom(bpLast, hasBP, opts.Now); from.Before(opts.Now) {
		if err := generateBP(ctx, s, optsLike, clk, rng, from, opts.Now, summary); err != nil {
			return nil, fmt.Errorf("top-up bp: %w", err)
		}
	}

	// --- Weight ---
	weightLast, hasWeight, err := latestWeightAt(ctx, s, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest weight: %w", err)
	}
	if from := dailyTopUpFrom(weightLast, hasWeight, opts.Now); from.Before(opts.Now) {
		if err := generateWeight(ctx, s, optsLike, clk, rng, from, opts.Now, summary); err != nil {
			return nil, fmt.Errorf("top-up weight: %w", err)
		}
	}

	// --- Food ---
	foodLast, hasFood, err := s.Food.LatestLog(ctx, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest food: %w", err)
	}
	if from := dailyTopUpFrom(foodLast, hasFood, opts.Now); from.Before(opts.Now) {
		if err := generateFood(ctx, s, optsLike, clk, rng, from, opts.Now, summary); err != nil {
			return nil, fmt.Errorf("top-up food: %w", err)
		}
	}

	// --- Workouts ---
	// generateWorkouts (re)creates the workout group + variant catalog inside
	// itself; that path is only safe on a wiped DB. For top-up we never want
	// duplicate groups, so we run the scheduled/ad-hoc generators against the
	// catalog that already exists for the user.
	if err := topUpWorkouts(ctx, s, optsLike, clk, rng, opts.Now, summary); err != nil {
		return nil, fmt.Errorf("top-up workouts: %w", err)
	}

	// Diary is intentionally NOT topped up. The catalog is a fixed set of 12
	// entries scattered across the full-seed's 90-day window at evenly-spaced
	// step=opts.Days/count offsets relative to clk.start (= anchor-90d). On
	// TopUp the anchor moves with real time, so each entry's computed
	// createdAt slides forward at the same rate. diary_notes has no UNIQUE
	// constraint on content, so re-emitting the catalog would insert a
	// duplicate of the most-recent canned entry every time the anchor crosses
	// a calendar boundary. Diary is one-time scatter from the full-seed path,
	// same shape as food_products and timezone_history.

	// --- Meds ---
	if err := topUpMedIntakes(ctx, s, opts.UserID, opts.Now, rng, summary); err != nil {
		return nil, fmt.Errorf("top-up meds: %w", err)
	}

	// --- Time-series vitals (HR / SpO2 / stress) ---
	// Resolve per-stream backfill starts up-front so the sleep-window load
	// range below covers the full catch-up span. A stale DB (bot offline for
	// days, or operator -topup against an aged copy) makes HR/SpO2/stress
	// backfill many days at once; without expanding the sleep load, only
	// nights inside the last 2d would dip HR / lift stress and the older
	// catch-up samples would look flat.
	heartLast, hasHeart, err := s.Vitals.LatestHeartSample(ctx, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest heart: %w", err)
	}
	spo2Last, hasSpO2, err := s.Vitals.LatestSpO2Sample(ctx, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest spo2: %w", err)
	}
	stressLast, hasStress, err := s.Vitals.LatestStressSample(ctx, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest stress: %w", err)
	}
	heartFrom := timeseriesTopUpFrom(heartLast, hasHeart, opts.Now)
	spo2From := timeseriesTopUpFrom(spo2Last, hasSpO2, opts.Now)
	stressFrom := timeseriesTopUpFrom(stressLast, hasStress, opts.Now)

	// vitalsContext carries the recent sleep windows plus the static workout
	// schedule so HR samples dip during sleep and spike during workouts exactly
	// like the full-seed path. loadRecentSleepWindows runs AFTER generateSleep,
	// so the returned set already includes any sleep blocks just inserted.
	// Floor is -2d (steady-state ticks need a small ±1d buffer for crossover),
	// but for catch-up the lower bound stretches back to the earliest stream's
	// backfill start.
	sleepLoadFrom := opts.Now.AddDate(0, 0, -2)
	for _, f := range [...]time.Time{heartFrom, spo2From, stressFrom} {
		if f.Before(sleepLoadFrom) {
			sleepLoadFrom = f
		}
	}
	recentSleeps, err := loadRecentSleepWindows(ctx, s, opts.UserID, sleepLoadFrom, opts.Now)
	if err != nil {
		return nil, fmt.Errorf("load recent sleep windows: %w", err)
	}
	vc := &vitalsContext{
		sleeps:   recentSleeps,
		workouts: computeWorkoutWindows(optsLike, clk),
	}
	tsRng := rand.New(rand.NewPCG(rngSeed^0xA5A5A5A5A5A5A5A5, rngSeed^0x5A5A5A5A5A5A5A5A))

	if heartFrom.Before(opts.Now) {
		n, err := generateHeartSamples(ctx, s, optsLike, vc, tsRng, heartFrom, opts.Now)
		if err != nil {
			return nil, fmt.Errorf("top-up heart: %w", err)
		}
		summary.HeartSamples += n
	}

	if spo2From.Before(opts.Now) {
		n, err := generateSpO2Samples(ctx, s, optsLike, vc, tsRng, spo2From, opts.Now)
		if err != nil {
			return nil, fmt.Errorf("top-up spo2: %w", err)
		}
		summary.SpO2Samples += n
	}

	if stressFrom.Before(opts.Now) {
		n, err := generateStressSamples(ctx, s, optsLike, vc, tsRng, stressFrom, opts.Now)
		if err != nil {
			return nil, fmt.Errorf("top-up stress: %w", err)
		}
		summary.StressSamples += n
	}

	// --- Day stats (steps/calories/distance) ---
	// Daily aggregates use the same dailyTopUpFrom snap as BP/weight/food: emit
	// only whole past days, so an hourly tick fires once per UTC day rollover
	// and is a no-op otherwise. Re-emitting the same calendar day is also safe
	// — ImportDayStats's UPSERT only updates when incoming values are larger
	// than stored, and the per-day sub-rng in buildDayStats makes the values
	// stable across ticks.
	dayStatLast, hasDayStat, err := s.Vitals.LatestDayStat(ctx, opts.UserID)
	if err != nil {
		return nil, fmt.Errorf("latest day_stat: %w", err)
	}
	if from := dailyTopUpFrom(dayStatLast, hasDayStat, opts.Now); from.Before(opts.Now) {
		n, err := generateDayStats(ctx, s, optsLike, vc, tsRng, from, opts.Now)
		if err != nil {
			return nil, fmt.Errorf("top-up day_stats: %w", err)
		}
		summary.DayStats += n
	}

	slog.Info("seeddemo: top-up completed",
		"user_id", opts.UserID,
		"now", opts.Now,
		"intakes", summary.Intakes,
		"bp_readings", summary.BPReadings,
		"weight_logs", summary.WeightLogs,
		"sleep_logs", summary.SleepLogs,
		"heart_samples", summary.HeartSamples,
		"spo2_samples", summary.SpO2Samples,
		"stress_samples", summary.StressSamples,
		"day_stats", summary.DayStats,
		"food_logs", summary.FoodLogs,
		"workout_sessions", summary.WorkoutSessions,
		"diary_notes", summary.DiaryNotes,
	)
	return summary, nil
}

// dailyTopUpFrom returns the window-start for a daily-cadence stream during
// top-up. It snaps to the day AFTER the latest sample's calendar day so the
// stream emits only on whole past days — never re-emits the sample at lastTs
// and never produces a future sample for a day that hasn't ended yet.
//
// When the stream is empty for the user, falls back to one day of backfill so
// the first top-up tick produces at least some visible data.
func dailyTopUpFrom(latest time.Time, found bool, now time.Time) time.Time {
	if !found {
		return startOfDayUTC(now.AddDate(0, 0, -1))
	}
	return startOfDayUTC(latest).AddDate(0, 0, 1)
}

// timeseriesTopUpFrom returns the window-start for a time-series stream
// (HR/SpO2/stress). The generator's alignUpToInterval truncates to seconds
// before rounding up, so anything sub-second past lastTs would still snap
// back to lastTs's exact boundary. A one-second offset is the minimum that
// guarantees alignUpToInterval lands on the NEXT cadence mark even when
// lastTs is itself perfectly boundary-aligned (which it always is, since
// every sample comes from the same generator path that anchors to 00:00 UTC).
//
// PK on (user_id, date_time) + INSERT OR IGNORE is the backstop for the
// rare retry / clock-skew case where two samples might race onto the same
// second.
func timeseriesTopUpFrom(latest time.Time, found bool, now time.Time) time.Time {
	if !found {
		return now.AddDate(0, 0, -1)
	}
	return latest.Add(time.Second)
}

// shouldEmitSleep reports whether enough wall-clock time has elapsed since
// the last sleep block ended to plausibly fit a new overnight. Threshold is
// 12h so a freshly seeded "woke at 7am" row isn't followed by a generator
// trying to schedule another sleep starting that same morning.
func shouldEmitSleep(lastEnd time.Time, found bool, now time.Time) bool {
	if !found {
		return true
	}
	return now.Sub(lastEnd) > 12*time.Hour
}

// latestWeightAt fetches the user's most recent weight measurement timestamp
// via the existing GetLastLog helper. Kept as a thin shim so the dailyTopUpFrom
// call site reads the same as bp/food/diary.
func latestWeightAt(ctx context.Context, s *store.Store, userID int64) (time.Time, bool, error) {
	last, err := s.Weight.GetLastLog(ctx, userID)
	if err != nil {
		return time.Time{}, false, err
	}
	if last == nil {
		return time.Time{}, false, nil
	}
	return last.MeasuredAt.UTC(), true, nil
}

// loadRecentSleepWindows reads sleep_logs rows that OVERLAP [from, to] so the
// HR/SpO2/stress generators can correlate top-up samples with sleep blocks the
// previous full-seed (or earlier top-up tick) inserted.
//
// The predicate uses overlap semantics (`end_time >= from AND start_time <=
// to`), not `start_time` containment, so a sleep block whose bedtime falls
// before `from` but whose wake-time lies inside the catch-up range is still
// loaded. This matters for long catch-ups whose first sample lands mid-sleep:
// without the overlap predicate, the night that contained the last logged HR
// sample would be excluded and the tail end of that night's regenerated
// samples (post-heartFrom but still pre-wake) would miss the sleep dip.
//
// The caller picks `from` to span every time-series stream's backfill range
// (floor at -2d for steady-state ticks, stretched back when catch-up requires
// it). Sleep is topped up before this query runs, so even a multi-day gap
// already has its sleep blocks materialized when the load fires.
func loadRecentSleepWindows(ctx context.Context, s *store.Store, userID int64, from, to time.Time) ([]sleepWindow, error) {
	rows, err := s.DB().QueryContext(ctx,
		`SELECT start_time, end_time FROM sleep_logs
		  WHERE user_id = ? AND end_time >= ? AND start_time <= ?
		  ORDER BY start_time ASC`,
		userID, from.UTC(), to.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []sleepWindow
	for rows.Next() {
		var w sleepWindow
		if err := rows.Scan(&w.start, &w.end); err != nil {
			return nil, err
		}
		out = append(out, sleepWindow{start: w.start.UTC(), end: w.end.UTC()})
	}
	return out, rows.Err()
}

// topUpMedIntakes iterates every medication owned by the user and walks each
// medication's schedule forward from its last logged dose to now, emitting
// new intake_log rows for any scheduled dose that hasn't been logged yet.
//
// The medication catalog (rows, schedules, start/end dates) is left untouched
// — per the planning decision to keep med windows fixed during top-up. Only
// new dose rows are appended.
//
// Outcome distribution mirrors the full-seed generator: doses older than the
// 2-day pending cutoff get TAKEN/SKIPPED/MISSED; newer doses stay PENDING so
// the demo's "today's meds" panel keeps a non-empty pending queue.
func topUpMedIntakes(ctx context.Context, s *store.Store, userID int64, now time.Time, rng *rand.Rand, summary *Summary) error {
	meds, err := s.Medication.List(true)
	if err != nil {
		return fmt.Errorf("list medications: %w", err)
	}
	pendingCutoff := now.AddDate(0, 0, -2)
	for _, m := range meds {
		if m.Archived {
			continue
		}
		schedule, err := m.ValidSchedule()
		if err != nil {
			// Skip meds with unparseable schedules — the demo seeder writes
			// valid JSON, so the only way to land here is operator data.
			continue
		}
		if schedule.Type != "daily" || len(schedule.Times) == 0 {
			continue
		}

		latest, hasLatest, err := s.Medication.LatestScheduledIntake(ctx, m.ID)
		if err != nil {
			return fmt.Errorf("latest scheduled intake for med %d: %w", m.ID, err)
		}

		windowEnd := now.UTC()
		if m.EndDate != nil && m.EndDate.Before(windowEnd) {
			windowEnd = *m.EndDate
		}
		windowStart := startOfDayUTC(windowEnd.AddDate(0, 0, -1))
		if hasLatest {
			// Walk forward from the START of the latest dose's day, not the
			// next day. Snapping to "day after" loses later-same-day doses on
			// multi-dose schedules: if the cursor is parked at today_08:00 for
			// a Metformin 08:00/20:00 med, today_20:00 would be permanently
			// skipped. intake_log has no UNIQUE(medication_id,
			// scheduled_at_unix) constraint (only tz_step rows have a unique
			// index per migration 067), so dedupe relies on the strict
			// scheduledAt.After(latest) guard below.
			windowStart = startOfDayUTC(latest)
		}
		if m.StartDate != nil && m.StartDate.After(windowStart) {
			windowStart = startOfDayUTC(*m.StartDate)
		}
		if !windowStart.Before(windowEnd) {
			continue
		}

		for day := windowStart; !day.After(windowEnd); day = day.AddDate(0, 0, 1) {
			for _, hhmm := range schedule.Times {
				scheduledAt, ok := timeOfDay(day, hhmm)
				if !ok {
					continue
				}
				if scheduledAt.Before(windowStart) || scheduledAt.After(windowEnd) {
					continue
				}
				if hasLatest && !scheduledAt.After(latest) {
					continue
				}
				intakeID, err := s.Medication.CreateIntake(m.ID, userID, scheduledAt)
				if err != nil {
					return fmt.Errorf("create intake for med %d at %s: %w", m.ID, scheduledAt, err)
				}
				summary.Intakes++

				if !scheduledAt.Before(pendingCutoff) {
					continue
				}
				status, takenAt := pickIntakeOutcome(rng, scheduledAt)
				if status == "PENDING" {
					continue
				}
				if err := s.Medication.UpdateIntake(intakeID, takenAt, status); err != nil {
					return fmt.Errorf("update intake %d: %w", intakeID, err)
				}
			}
		}
	}
	return nil
}

// topUpWorkouts is the workout-domain analogue of topUpMedIntakes: it reads
// existing workout_groups / workout_variants / workout_exercises for the user
// (whichever catalog rows the original wipe-and-seed planted) and feeds them
// back into the same generateScheduledSessions / generateAdHocSessions paths
// the full-seed uses, so identical row shapes get produced for the gap window.
//
// The catalog itself is never re-created — only new session and exercise-log
// rows are appended for the days in [latestSession+1, now].
func topUpWorkouts(ctx context.Context, s *store.Store, opts Options, clk *clock, rng *rand.Rand, now time.Time, summary *Summary) error {
	groups, err := loadDemoWorkoutCatalog(ctx, s, opts.UserID)
	if err != nil {
		return err
	}
	// No catalog exists yet (top-up against a never-seeded user): nothing to do.
	// Full seeding remains the path for catalog creation.
	if len(groups) == 0 {
		return nil
	}

	latestSession, hasLatest, err := s.Workout.LatestSessionForUser(ctx, opts.UserID)
	if err != nil {
		return fmt.Errorf("latest workout session: %w", err)
	}
	from := dailyTopUpFrom(latestSession, hasLatest, now)
	if !from.Before(now) {
		return nil
	}

	pendingCutoff := now.AddDate(0, 0, -2)
	for _, lg := range groups {
		spec := lg.spec
		rotationStartIdx, err := rotationStartIndex(ctx, s, lg)
		if err != nil {
			return fmt.Errorf("rotation start for %s: %w", spec.name, err)
		}
		if err := generateScheduledSessions(ctx, s, opts, clk, rng, from, now, summary, lg.group, lg.variants, spec, pendingCutoff, rotationStartIdx); err != nil {
			return fmt.Errorf("scheduled %s sessions: %w", spec.name, err)
		}
	}
	if err := generateAdHocSessions(ctx, s, opts, clk, from, now, summary); err != nil {
		return fmt.Errorf("ad-hoc sessions: %w", err)
	}
	return nil
}

// rotationStartIndex returns the index of the rotation_state's current
// variant in lg.variants so generateScheduledSessions resumes the rotation
// where the seed left off rather than restarting at variant[0] on every
// top-up tick. Non-rotating groups (or groups with no stored state) start
// at 0.
func rotationStartIndex(ctx context.Context, s *store.Store, lg loadedGroup) (int, error) {
	_ = ctx
	if !lg.spec.isRotating || len(lg.variants) == 0 {
		return 0, nil
	}
	state, err := s.Workout.GetRotationState(lg.group.ID)
	if err != nil {
		return 0, err
	}
	if state == nil {
		return 0, nil
	}
	for i, v := range lg.variants {
		if v.variant.ID == state.CurrentVariantID {
			return i, nil
		}
	}
	return 0, nil
}

// loadedGroup pairs a stored group with its variants (resolved through their
// exercise rows) and the static groupSpec the full-seed used to plant it. The
// spec is recovered by matching group name → demoStrengthGroup / demoCardioGroup
// because that's the cheapest way to recover daysOfWeek + scheduledTime without
// adding new columns to workout_groups.
type loadedGroup struct {
	group    *store.WorkoutGroup
	variants []variantWithExercises
	spec     groupSpec
}

// loadDemoWorkoutCatalog reads the workout catalog the full-seed planted and
// reshapes it into the (group, variants, spec) triples generateScheduledSessions
// expects. Groups whose names don't match the demo catalog are skipped — they
// belong to a different non-demo workflow and shouldn't get auto-appended
// sessions.
func loadDemoWorkoutCatalog(ctx context.Context, s *store.Store, userID int64) ([]loadedGroup, error) {
	specByName := map[string]groupSpec{
		demoStrengthGroup.name: demoStrengthGroup,
		demoCardioGroup.name:   demoCardioGroup,
	}

	rows, err := s.DB().QueryContext(ctx, `
		SELECT id, name, description, is_rotating, user_id, days_of_week, scheduled_time, notification_advance_minutes
		  FROM workout_groups WHERE user_id = ?
		  ORDER BY id ASC`, userID)
	if err != nil {
		return nil, fmt.Errorf("query workout_groups: %w", err)
	}
	defer rows.Close()

	var groups []*store.WorkoutGroup
	for rows.Next() {
		g := &store.WorkoutGroup{}
		var description, daysOfWeek, scheduledTime string
		if err := rows.Scan(&g.ID, &g.Name, &description, &g.IsRotating, &g.UserID, &daysOfWeek, &scheduledTime, &g.NotificationAdvanceMinutes); err != nil {
			return nil, fmt.Errorf("scan workout_group: %w", err)
		}
		g.Description = description
		g.DaysOfWeek = daysOfWeek
		g.ScheduledTime = scheduledTime
		groups = append(groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]loadedGroup, 0, len(groups))
	for _, g := range groups {
		spec, ok := specByName[g.Name]
		if !ok {
			continue
		}
		variants, err := loadDemoVariantsForGroup(ctx, s, g, spec)
		if err != nil {
			return nil, fmt.Errorf("load variants for group %d: %w", g.ID, err)
		}
		if len(variants) == 0 {
			continue
		}
		out = append(out, loadedGroup{group: g, variants: variants, spec: spec})
	}
	return out, nil
}

// loadDemoVariantsForGroup reads variants and their exercises for a single
// group, resolving exercise IDs so insertExerciseLog has everything it needs.
// Matching against spec.variants by name guarantees the exerciseSpec carries
// the same set/rep/weight numbers as the full-seed used.
//
// The two-pass shape (materialize the variant rows, close the cursor, then
// query exercises per variant) avoids holding a SQLite cursor open across a
// nested QueryContext, which can stall under the driver's connection pool
// in tight loops.
func loadDemoVariantsForGroup(ctx context.Context, s *store.Store, g *store.WorkoutGroup, spec groupSpec) ([]variantWithExercises, error) {
	specByVariant := make(map[string]variantSpec, len(spec.variants))
	for _, v := range spec.variants {
		specByVariant[v.name] = v
	}

	type pendingVariant struct {
		v     *store.WorkoutVariant
		vSpec variantSpec
	}
	var pending []pendingVariant

	rows, err := s.DB().QueryContext(ctx, `
		SELECT id, name, rotation_order
		  FROM workout_variants WHERE group_id = ?
		  ORDER BY COALESCE(rotation_order, 0) ASC, id ASC`, g.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		v := &store.WorkoutVariant{GroupID: g.ID}
		var rotation *int
		if err := rows.Scan(&v.ID, &v.Name, &rotation); err != nil {
			rows.Close()
			return nil, err
		}
		v.RotationOrder = rotation
		vSpec, ok := specByVariant[v.Name]
		if !ok {
			continue
		}
		pending = append(pending, pendingVariant{v: v, vSpec: vSpec})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	variants := make([]variantWithExercises, 0, len(pending))
	for _, p := range pending {
		exercises, err := loadDemoExercisesForVariant(ctx, s, p.v.ID, p.vSpec)
		if err != nil {
			return nil, err
		}
		variants = append(variants, variantWithExercises{variant: p.v, exercises: exercises})
	}
	return variants, nil
}

// loadDemoExercisesForVariant reads exercise rows for one variant and
// pairs each with the matching exerciseSpec from the demo catalog so the
// progression / set / rep math in insertExerciseLog has fresh inputs.
func loadDemoExercisesForVariant(ctx context.Context, s *store.Store, variantID int64, spec variantSpec) ([]storeExerciseID, error) {
	rows, err := s.DB().QueryContext(ctx, `
		SELECT id, exercise_name FROM workout_exercises
		  WHERE variant_id = ? ORDER BY order_index ASC, id ASC`, variantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	specByName := make(map[string]exerciseSpec, len(spec.exercises))
	for _, ex := range spec.exercises {
		specByName[ex.name] = ex
	}

	var out []storeExerciseID
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		exSpec, ok := specByName[name]
		if !ok {
			continue
		}
		out = append(out, storeExerciseID{id: id, spec: exSpec})
	}
	return out, rows.Err()
}

