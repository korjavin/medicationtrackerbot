package seeddemo

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// runTopUp wraps the package-public TopUp so each test reads the same.
func runTopUp(t *testing.T, s *store.Store, opts TopUpOptions) *Summary {
	t.Helper()
	summary, err := TopUp(context.Background(), s, opts)
	if err != nil {
		t.Fatalf("seeddemo.TopUp: %v", err)
	}
	return summary
}

// TestTopUpEmptyDBProducesBackfill ensures the first top-up against a never-
// seeded user emits non-zero rows for the time-series streams. Daily-cadence
// streams (BP/weight/etc.) may legitimately emit 0 rows because their target
// scales with windowDays — a 1-day backfill window leaves the targets at 0.
// The time-series streams, however, run at fixed cadence and must emit.
func TestTopUpEmptyDBProducesBackfill(t *testing.T) {
	s := newTestStore(t)
	now := fixedNow

	summary := runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    now,
		Seed:   42,
	})

	// Time-series streams emit at fixed cadence; even a 1-day backfill window
	// must produce a non-trivial number of samples.
	if summary.HeartSamples == 0 {
		t.Errorf("empty-DB top-up: expected non-zero HeartSamples, got 0")
	}
	if summary.SpO2Samples == 0 {
		t.Errorf("empty-DB top-up: expected non-zero SpO2Samples, got 0")
	}
	if summary.StressSamples == 0 {
		t.Errorf("empty-DB top-up: expected non-zero StressSamples, got 0")
	}

	if got := countRows(t, s.DB(), "vitals_heart"); got != summary.HeartSamples {
		t.Errorf("HeartSamples=%d but vitals_heart count=%d", summary.HeartSamples, got)
	}
}

// TestTopUpAfterSeedAdvancesStreams seeds 90 days then advances "now" by 24h
// and asserts the resulting top-up appends new rows to each stream whose
// latest timestamp now lags more than a day.
func TestTopUpAfterSeedAdvancesStreams(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	// Capture per-stream pre-top-up state.
	pre := captureLatestState(t, s.DB(), 12345)

	advancedNow := seedNow.Add(36 * time.Hour) // 1.5 days forward
	runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    advancedNow,
		Seed:   42,
	})

	post := captureLatestState(t, s.DB(), 12345)

	// HR/SpO2/stress should always advance: their cadence (≤30 min) covers
	// the 36h gap easily.
	if !post.maxHeartTime.After(pre.maxHeartTime) {
		t.Errorf("vitals_heart did not advance: pre=%v post=%v", pre.maxHeartTime, post.maxHeartTime)
	}
	if !post.maxSpO2Time.After(pre.maxSpO2Time) {
		t.Errorf("vitals_spo2 did not advance: pre=%v post=%v", pre.maxSpO2Time, post.maxSpO2Time)
	}
	if !post.maxStressTime.After(pre.maxStressTime) {
		t.Errorf("vitals_stress did not advance: pre=%v post=%v", pre.maxStressTime, post.maxStressTime)
	}

	// Time-series counts must strictly grow.
	if post.heartCount <= pre.heartCount {
		t.Errorf("vitals_heart count did not grow: pre=%d post=%d", pre.heartCount, post.heartCount)
	}
}

// TestTopUpIsIdempotentOnSameDay runs top-up twice in a row against a seeded
// DB at the same Now. The second call must add ≤1 row per stream (the
// time-series cadence can leave one boundary sample if the second call lands
// exactly on a new interval mark; the day-after snap drops every other
// stream to zero new rows).
func TestTopUpIsIdempotentOnSameDay(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	advancedNow := seedNow.Add(36 * time.Hour)
	first := runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    advancedNow,
		Seed:   42,
	})
	if first.HeartSamples == 0 {
		t.Fatalf("first top-up unexpectedly produced no HR samples; can't test idempotency")
	}

	preSecond := captureLatestState(t, s.DB(), 12345)
	second := runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    advancedNow, // same Now → idempotent
		Seed:   42,
	})
	postSecond := captureLatestState(t, s.DB(), 12345)

	// Second tick must emit zero net new time-series rows: same Now, same
	// per-tick seed, same target timestamps → INSERT OR IGNORE dedupes.
	if second.HeartSamples != 0 {
		t.Errorf("second top-up emitted %d HR samples; expected 0 (idempotent)", second.HeartSamples)
	}
	if second.SpO2Samples != 0 {
		t.Errorf("second top-up emitted %d SpO2 samples; expected 0 (idempotent)", second.SpO2Samples)
	}
	if second.StressSamples != 0 {
		t.Errorf("second top-up emitted %d stress samples; expected 0 (idempotent)", second.StressSamples)
	}

	// Row counts must not have grown between the two calls.
	if postSecond.heartCount != preSecond.heartCount {
		t.Errorf("vitals_heart count grew between idempotent calls: %d → %d",
			preSecond.heartCount, postSecond.heartCount)
	}
}

// TestTopUpIsIdempotentForDailyStreams runs top-up twice on the same Now
// against a seeded DB and asserts the non-uniqueness-protected daily streams
// (food_log, blood_pressure_readings, diary_notes) gain zero rows on the
// second call. The day-after snap is the sole guard for these tables, so a
// regression there would silently double-insert.
func TestTopUpIsIdempotentForDailyStreams(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	advancedNow := seedNow.Add(72 * time.Hour)
	runTopUp(t, s, TopUpOptions{UserID: 12345, Now: advancedNow, Seed: 42})

	tables := []string{"food_log", "blood_pressure_readings", "weight_logs", "diary_notes", "workout_sessions", "day_stats"}
	pre := make(map[string]int, len(tables))
	for _, tbl := range tables {
		pre[tbl] = countRows(t, s.DB(), tbl)
	}

	// Second tick at same Now: no daily stream should grow.
	runTopUp(t, s, TopUpOptions{UserID: 12345, Now: advancedNow, Seed: 42})

	for _, tbl := range tables {
		got := countRows(t, s.DB(), tbl)
		if got != pre[tbl] {
			t.Errorf("%s grew across idempotent top-up: %d → %d", tbl, pre[tbl], got)
		}
	}
}

// TestTopUpStrictlyAfterLastTs verifies that every row inserted by top-up has
// a timestamp strictly greater than the per-stream lastTs the pre-state
// captured. This guards against the day-after snap drifting back into a
// previous day's samples.
func TestTopUpStrictlyAfterLastTs(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})
	pre := captureLatestState(t, s.DB(), 12345)
	advancedNow := seedNow.Add(36 * time.Hour)
	runTopUp(t, s, TopUpOptions{UserID: 12345, Now: advancedNow, Seed: 42})

	// vitals_heart: every new row's date_time must be > pre.maxHeartMillis.
	var below int
	if err := s.DB().QueryRow(
		`SELECT COUNT(*) FROM vitals_heart WHERE user_id = ? AND date_time <= ?`,
		12345, pre.maxHeartTime.UnixMilli(),
	).Scan(&below); err != nil {
		t.Fatalf("count vitals_heart at or below pre.max: %v", err)
	}
	// The pre-existing rows are <= pre.max by definition; count those too and
	// assert no growth.
	if below != pre.heartCount {
		t.Errorf("vitals_heart rows at-or-before pre.max changed: pre=%d post=%d",
			pre.heartCount, below)
	}
}

// TestTopUpMedIntakesAppendsButDoesNotDuplicateCatalog asserts that running
// top-up on a seeded DB:
//   - leaves medications.count unchanged (no new catalog rows)
//   - appends new intake_log rows for the days in the gap window
//   - never collides on (medication_id, scheduled_at_unix) on a re-run
func TestTopUpMedIntakesAppendsButDoesNotDuplicateCatalog(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})
	medsBefore := countRows(t, s.DB(), "medications")
	intakesBefore := countRows(t, s.DB(), "intake_log")

	advancedNow := seedNow.Add(72 * time.Hour) // 3 days forward
	runTopUp(t, s, TopUpOptions{UserID: 12345, Now: advancedNow, Seed: 42})

	medsAfter := countRows(t, s.DB(), "medications")
	intakesAfter := countRows(t, s.DB(), "intake_log")

	if medsAfter != medsBefore {
		t.Errorf("top-up duplicated medication catalog: before=%d after=%d", medsBefore, medsAfter)
	}
	if intakesAfter <= intakesBefore {
		t.Errorf("expected new intakes after 3-day advance: before=%d after=%d", intakesBefore, intakesAfter)
	}

	// Re-run with same Now → second call must not duplicate.
	runTopUp(t, s, TopUpOptions{UserID: 12345, Now: advancedNow, Seed: 42})
	intakesAfterSecond := countRows(t, s.DB(), "intake_log")
	if intakesAfterSecond != intakesAfter {
		t.Errorf("idempotent meds top-up changed intake_log count: %d → %d",
			intakesAfter, intakesAfterSecond)
	}
}

// TestTimeseriesTopUpFromAdvancesPastLastTs verifies the time-series ts-from
// helper offsets past the last sample so that subsequent generator calls land
// on the NEXT interval boundary, not the same one.
func TestTimeseriesTopUpFromAdvancesPastLastTs(t *testing.T) {
	now := time.Date(2026, 5, 5, 12, 0, 0, 0, time.UTC)
	last := time.Date(2026, 5, 5, 11, 30, 0, 0, time.UTC) // exactly on a 15-min boundary
	got := timeseriesTopUpFrom(last, true, now)
	if !got.After(last) {
		t.Errorf("timeseriesTopUpFrom did not advance past lastTs: got=%v lastTs=%v", got, last)
	}
	aligned := alignUpToInterval(got, 15)
	if aligned.Equal(last) {
		t.Errorf("alignUpToInterval(timeseriesTopUpFrom(lastTs)) re-emitted lastTs: %v", last)
	}
}

// TestDailyTopUpFromSnapsToDayAfter verifies the day-after snap logic.
func TestDailyTopUpFromSnapsToDayAfter(t *testing.T) {
	now := time.Date(2026, 5, 5, 12, 0, 0, 0, time.UTC)

	// not found → 1-day backfill snapped to start-of-day.
	got := dailyTopUpFrom(time.Time{}, false, now)
	want := time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("not-found: got %v, want %v", got, want)
	}

	// found at mid-day yesterday → start-of-day today.
	last := time.Date(2026, 5, 4, 15, 30, 0, 0, time.UTC)
	got = dailyTopUpFrom(last, true, now)
	want = time.Date(2026, 5, 5, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("found-yesterday: got %v, want %v", got, want)
	}

	// found today → start-of-day tomorrow (so dailyTopUpFrom.Before(now) is
	// false and the caller skips emission).
	last = time.Date(2026, 5, 5, 9, 0, 0, 0, time.UTC)
	got = dailyTopUpFrom(last, true, now)
	want = time.Date(2026, 5, 6, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("found-today: got %v, want %v", got, want)
	}
	if got.Before(now) {
		t.Errorf("found-today snap should be ≥ now so emission is skipped; got=%v now=%v", got, now)
	}
}

// TestTopUpRequiresUserID guards the most common operator misuse.
func TestTopUpRequiresUserID(t *testing.T) {
	s := newTestStore(t)
	_, err := TopUp(context.Background(), s, TopUpOptions{Now: fixedNow})
	if err == nil {
		t.Fatal("expected error from TopUp with UserID=0; got nil")
	}
}

// captureLatestState bundles per-stream latest timestamps + counts for diffing
// across top-up calls.
type latestState struct {
	maxHeartTime  time.Time
	maxSpO2Time   time.Time
	maxStressTime time.Time
	heartCount    int
	spo2Count     int
	stressCount   int
}

func captureLatestState(t *testing.T, db *sql.DB, userID int64) latestState {
	t.Helper()
	st := latestState{}

	var heartMs, spo2Ms, stressMs sql.NullInt64
	if err := db.QueryRow(
		`SELECT MAX(date_time) FROM vitals_heart WHERE user_id = ?`, userID).Scan(&heartMs); err != nil {
		t.Fatalf("max vitals_heart: %v", err)
	}
	if heartMs.Valid {
		st.maxHeartTime = time.UnixMilli(heartMs.Int64).UTC()
	}
	if err := db.QueryRow(
		`SELECT MAX(date_time) FROM vitals_spo2 WHERE user_id = ?`, userID).Scan(&spo2Ms); err != nil {
		t.Fatalf("max vitals_spo2: %v", err)
	}
	if spo2Ms.Valid {
		st.maxSpO2Time = time.UnixMilli(spo2Ms.Int64).UTC()
	}
	if err := db.QueryRow(
		`SELECT MAX(date_time) FROM vitals_stress WHERE user_id = ?`, userID).Scan(&stressMs); err != nil {
		t.Fatalf("max vitals_stress: %v", err)
	}
	if stressMs.Valid {
		st.maxStressTime = time.UnixMilli(stressMs.Int64).UTC()
	}

	if err := db.QueryRow(`SELECT COUNT(*) FROM vitals_heart WHERE user_id = ?`, userID).Scan(&st.heartCount); err != nil {
		t.Fatalf("count vitals_heart: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM vitals_spo2 WHERE user_id = ?`, userID).Scan(&st.spo2Count); err != nil {
		t.Fatalf("count vitals_spo2: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM vitals_stress WHERE user_id = ?`, userID).Scan(&st.stressCount); err != nil {
		t.Fatalf("count vitals_stress: %v", err)
	}

	return st
}

// TestTopUpDoesNotInflateFoodProductUsageCount guards the regression where
// generateFood used to call UpsertProduct on every tick — UpsertProduct bumps
// usage_count on conflict, so the demo's "most used products" ordering drifted
// at the cadence of the top-up loop. After fix, the catalog setup lives in
// ensureFoodCatalog (full-seed only); top-up loads IDs read-only.
func TestTopUpDoesNotInflateFoodProductUsageCount(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   30,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	pre := map[string]int{}
	rows, err := s.DB().Query(`SELECT name, usage_count FROM food_products WHERE user_id = ?`, 12345)
	if err != nil {
		t.Fatalf("query food_products: %v", err)
	}
	for rows.Next() {
		var name string
		var uc int
		if err := rows.Scan(&name, &uc); err != nil {
			rows.Close()
			t.Fatalf("scan: %v", err)
		}
		pre[name] = uc
	}
	rows.Close()

	// Two top-up ticks. Neither should touch usage_count for rows whose
	// food_log inserts didn't happen (i.e. nearly all catalog rows on a
	// short top-up window).
	for i := 0; i < 2; i++ {
		runTopUp(t, s, TopUpOptions{
			UserID: 12345,
			Now:    seedNow.Add(time.Duration(i+1) * time.Hour),
			Seed:   42,
		})
	}

	rows, err = s.DB().Query(`SELECT name, usage_count FROM food_products WHERE user_id = ?`, 12345)
	if err != nil {
		t.Fatalf("query food_products: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var uc int
		if err := rows.Scan(&name, &uc); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if pre[name] != uc {
			t.Errorf("food_product %q usage_count changed across top-up ticks: pre=%d post=%d", name, pre[name], uc)
		}
	}
}

// TestTopUpPreservesUserPreferences guards the regression where generateWeight
// and generateFood reset the unit preference and macro targets on every tick.
// After fix, those one-time setups run only from the full-seed orchestrator.
func TestTopUpPreservesUserPreferences(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   30,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	// Simulate a demo viewer changing both preferences via the UI.
	if err := s.Weight.SetUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetUnitPreference: %v", err)
	}
	customTargets := store.FoodTargets{Calories: 1800, Carbs: 200, Protein: 130, Fat: 60}
	if err := s.Food.SetTargets(ctx, customTargets); err != nil {
		t.Fatalf("SetTargets: %v", err)
	}

	runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    seedNow.Add(2 * time.Hour),
		Seed:   42,
	})

	unit, err := s.Weight.GetUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetUnitPreference: %v", err)
	}
	if unit != "lb" {
		t.Errorf("top-up overwrote weight unit preference: want lbs, got %s", unit)
	}
	got, err := s.Food.GetTargets(ctx)
	if err != nil {
		t.Fatalf("GetTargets: %v", err)
	}
	if got != customTargets {
		t.Errorf("top-up overwrote food targets: want %+v, got %+v", customTargets, got)
	}
}

// TestTopUpResumesWorkoutRotationFromState guards the regression where
// generateScheduledSessions reset rotationIdx to 0 on every top-up tick,
// so the next strength session always picked variant[0] (Push) regardless
// of where the seed's rotation pointer left off.
func TestTopUpResumesWorkoutRotationFromState(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   30,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	// Find the strength group and force the rotation pointer to point at
	// "Pull" (index 1). The bug would cause top-up to insert a Push session
	// next regardless.
	var groupID int64
	if err := s.DB().QueryRow(
		`SELECT id FROM workout_groups WHERE user_id = ? AND name = 'Strength'`,
		12345).Scan(&groupID); err != nil {
		t.Fatalf("lookup strength group: %v", err)
	}
	var pullVariantID int64
	if err := s.DB().QueryRow(
		`SELECT id FROM workout_variants WHERE group_id = ? AND name = 'Pull'`,
		groupID).Scan(&pullVariantID); err != nil {
		t.Fatalf("lookup Pull variant: %v", err)
	}
	if err := s.Workout.InitializeRotation(groupID, pullVariantID); err != nil {
		t.Fatalf("InitializeRotation: %v", err)
	}

	// Capture session IDs already present so we can filter to "newly added".
	preMaxID := int64(0)
	if err := s.DB().QueryRow(
		`SELECT COALESCE(MAX(id), 0) FROM workout_sessions WHERE user_id = ? AND group_id = ?`,
		12345, groupID).Scan(&preMaxID); err != nil {
		t.Fatalf("max session id: %v", err)
	}

	// Advance time enough to land on the next Mon/Wed/Fri strength day.
	runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    seedNow.Add(7 * 24 * time.Hour),
		Seed:   42,
	})

	// Read the first new session's variant_id and confirm it matches Pull.
	var firstNewVariantID int64
	err := s.DB().QueryRow(
		`SELECT variant_id FROM workout_sessions
		  WHERE user_id = ? AND group_id = ? AND id > ?
		  ORDER BY scheduled_date ASC, id ASC LIMIT 1`,
		12345, groupID, preMaxID).Scan(&firstNewVariantID)
	if err != nil {
		t.Fatalf("query first new session: %v", err)
	}
	if firstNewVariantID != pullVariantID {
		t.Errorf("top-up reset rotation: want first new session to use Pull (id=%d), got variant id=%d",
			pullVariantID, firstNewVariantID)
	}
	_ = ctx
}

// TestTopUpEmitsAllSameDayDosesAfterLatest guards the regression where
// topUpMedIntakes snapped windowStart to the day AFTER the latest dose,
// which permanently skipped later-same-day doses on multi-dose schedules
// (e.g. Metformin 08:00/20:00): a tick that ran between the two doses
// advanced the cursor past 08:00, and the next tick's day-after snap then
// jumped to tomorrow, dropping today's 20:00.
func TestTopUpEmitsAllSameDayDosesAfterLatest(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedNow := fixedNow

	// Full seed at noon: full-seed itself walks the active window through
	// `clk.anchor` (= noon), so today's 08:00 dose is created but today's
	// 20:00 dose is in the future and skipped. Top-up at 22:00 must emit
	// today's 20:00 dose.
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   30,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	// Find Metformin's id (multi-dose schedule "08:00,20:00"). The medications
	// table itself has no user_id column; ownership is tracked via intake_log.
	var metforminID int64
	if err := s.DB().QueryRow(
		`SELECT DISTINCT m.id FROM medications m
		   JOIN intake_log i ON i.medication_id = m.id
		  WHERE i.user_id = ? AND m.name = 'Metformin'`,
		12345).Scan(&metforminID); err != nil {
		t.Fatalf("lookup Metformin: %v", err)
	}

	// Confirm today's 20:00 is NOT yet present (full-seed at noon stopped at anchor).
	twentyHundredToday := time.Date(seedNow.Year(), seedNow.Month(), seedNow.Day(), 20, 0, 0, 0, time.UTC)
	var existing int
	if err := s.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE medication_id = ? AND scheduled_at_unix = ?`,
		metforminID, twentyHundredToday.Unix()).Scan(&existing); err != nil {
		t.Fatalf("pre-check 20:00 intake: %v", err)
	}
	if existing != 0 {
		t.Fatalf("pre-condition violated: full-seed already emitted today's 20:00 dose; can't test top-up gap")
	}

	// Advance to 22:00 same day and run top-up. Expectation: today's 20:00
	// dose gets emitted.
	runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    seedNow.Add(10 * time.Hour), // 12:00 + 10h = 22:00
		Seed:   42,
	})

	var after int
	if err := s.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE medication_id = ? AND scheduled_at_unix = ?`,
		metforminID, twentyHundredToday.Unix()).Scan(&after); err != nil {
		t.Fatalf("post-check 20:00 intake: %v", err)
	}
	if after != 1 {
		t.Errorf("expected today's 20:00 Metformin dose after top-up; got count=%d", after)
	}

	// Re-run same tick — must remain idempotent (the dedupe guard is now
	// scheduledAt.After(latest) without a day-after snap).
	runTopUp(t, s, TopUpOptions{
		UserID: 12345,
		Now:    seedNow.Add(10 * time.Hour),
		Seed:   42,
	})
	var idem int
	if err := s.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE medication_id = ? AND scheduled_at_unix = ?`,
		metforminID, twentyHundredToday.Unix()).Scan(&idem); err != nil {
		t.Fatalf("idempotency check: %v", err)
	}
	if idem != 1 {
		t.Errorf("idempotent top-up duplicated 20:00 dose: count=%d (want 1)", idem)
	}
	_ = ctx
}

// TestTopUpDoesNotDuplicateDiaryAcrossCalendarDays guards the regression where
// generateDiary, when invoked from TopUp on successive calendar days,
// re-emits the closest-to-anchor catalog entry (i=11, "Stomach felt off after
// dinner — likely the spicy sauce.") at a moving date. Each tick's anchor
// slides clk.start forward by one real day, so for the fixed-index entry at
// off = (count-1)*step = 77, clk.at(77, ...) advances exactly one calendar
// day per real day. With latestNote.day also advancing one day per tick, the
// day-after snap leaves a gap big enough for the next tick to insert another
// duplicate. After 3 daily ticks the diary timeline shows 3 extra copies of
// the same canned note.
//
// Fix: diary is treated as one-time scatter (full-seed only); TopUp doesn't
// re-emit it. This test simulates 3 daily ticks and asserts no diary content
// appears more than once.
func TestTopUpDoesNotDuplicateDiaryAcrossCalendarDays(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   90,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	preCount := countRows(t, s.DB(), "diary_notes")
	if preCount != len(demoDiaryEntries) {
		t.Fatalf("pre-condition: full-seed should emit %d diary notes, got %d",
			len(demoDiaryEntries), preCount)
	}

	for day := 1; day <= 3; day++ {
		runTopUp(t, s, TopUpOptions{
			UserID: 12345,
			Now:    seedNow.Add(time.Duration(day*24) * time.Hour),
			Seed:   42,
		})
	}

	// No content should appear more than once in diary_notes.
	rows, err := s.DB().Query(
		`SELECT content, COUNT(*) FROM diary_notes WHERE user_id = ? GROUP BY content HAVING COUNT(*) > 1`,
		12345)
	if err != nil {
		t.Fatalf("query diary duplicates: %v", err)
	}
	defer rows.Close()
	var dupes []string
	for rows.Next() {
		var content string
		var n int
		if err := rows.Scan(&content, &n); err != nil {
			t.Fatalf("scan dupe row: %v", err)
		}
		dupes = append(dupes, fmt.Sprintf("%q x%d", content, n))
	}
	if len(dupes) > 0 {
		t.Errorf("diary content duplicated across daily top-ups: %v", dupes)
	}
}

// TestTopUpLongCatchUpPreservesSleepCorrelation guards the regression where
// loadRecentSleepWindows was hard-capped at opts.Now - 2d, so a multi-day HR
// catch-up (bot offline for a week, then top-up) only saw sleep dips on the
// last two nights and left the older catch-up days with flat HR values. The
// fix expands the sleep load range to span every time-series stream's
// backfill start, so all regenerated samples correlate with their nightly
// sleep block.
func TestTopUpLongCatchUpPreservesSleepCorrelation(t *testing.T) {
	s := newTestStore(t)
	seedNow := fixedNow
	runSeeder(t, s, Options{
		UserID: 12345,
		Days:   30,
		Wipe:   true,
		Seed:   42,
		Now:    seedNow,
	})

	// Simulate a 7-day gap: delete every HR/SpO2/stress sample written by the
	// seeder in the last 7 days. Sleep blocks for those nights stay in place
	// so the top-up's sleep correlation logic has data to read.
	gapStart := seedNow.AddDate(0, 0, -7)
	for _, tbl := range []string{"vitals_heart", "vitals_spo2", "vitals_stress"} {
		// #nosec G202 -- table name is from a fixed in-test list.
		if _, err := s.DB().Exec("DELETE FROM "+tbl+" WHERE user_id = ? AND date_time >= ?",
			12345, gapStart.UnixMilli()); err != nil {
			t.Fatalf("clear %s gap: %v", tbl, err)
		}
	}

	runTopUp(t, s, TopUpOptions{UserID: 12345, Now: seedNow, Seed: 42})

	// For the 7-day catch-up window, partition HR samples by whether they
	// fall inside a recorded sleep_logs window. The sleep dip is ~12 bpm in
	// the generator, so sleep median should be visibly below waking median
	// across hundreds of samples.
	sleepWindows := []sleepWindow{}
	rows, err := s.DB().Query(
		`SELECT start_time, end_time FROM sleep_logs WHERE user_id = ? AND start_time >= ? AND start_time <= ?`,
		12345, gapStart, seedNow)
	if err != nil {
		t.Fatalf("query sleep_logs: %v", err)
	}
	for rows.Next() {
		var w sleepWindow
		if err := rows.Scan(&w.start, &w.end); err != nil {
			rows.Close()
			t.Fatalf("scan sleep_logs: %v", err)
		}
		sleepWindows = append(sleepWindows, sleepWindow{start: w.start.UTC(), end: w.end.UTC()})
	}
	rows.Close()
	if len(sleepWindows) < 3 {
		t.Fatalf("expected ≥ 3 sleep blocks in the 7-day gap, got %d", len(sleepWindows))
	}

	// Restrict to samples that sit at least 2 days back, since the pre-fix
	// behavior was correct for the last 2 days; the regression only affected
	// older catch-up days. Without this filter the test would pass even on
	// the buggy build.
	older := seedNow.AddDate(0, 0, -2)
	hrRows, err := s.DB().Query(
		`SELECT date_time, value FROM vitals_heart WHERE user_id = ? AND date_time >= ? AND date_time < ?`,
		12345, gapStart.UnixMilli(), older.UnixMilli())
	if err != nil {
		t.Fatalf("query vitals_heart: %v", err)
	}
	defer hrRows.Close()

	inAny := func(t time.Time) bool {
		for _, w := range sleepWindows {
			if !t.Before(w.start) && t.Before(w.end) {
				return true
			}
		}
		return false
	}
	var sleepHR, wakingHR []int
	for hrRows.Next() {
		var dtMs int64
		var value int
		if err := hrRows.Scan(&dtMs, &value); err != nil {
			t.Fatalf("scan vitals_heart: %v", err)
		}
		dt := time.UnixMilli(dtMs).UTC()
		if inAny(dt) {
			sleepHR = append(sleepHR, value)
		} else {
			wakingHR = append(wakingHR, value)
		}
	}
	if len(sleepHR) < 20 || len(wakingHR) < 20 {
		t.Fatalf("not enough HR samples in older catch-up range: sleep=%d waking=%d", len(sleepHR), len(wakingHR))
	}
	if med(sleepHR) >= med(wakingHR) {
		t.Errorf("HR catch-up lost sleep correlation in days [-7,-2]: sleep median=%d, waking median=%d",
			med(sleepHR), med(wakingHR))
	}
}

// TestLoadRecentSleepWindowsIncludesOverlapAtWindowStart guards the regression
// where loadRecentSleepWindows used `start_time >= from` containment. When a
// long catch-up's lower bound landed inside an overnight sleep block (e.g.
// last logged HR sample at 23:30 mid-sleep; sleep block 22:45→06:30 next day),
// that block's start_time (22:45) was earlier than `from` (23:30:01) and the
// block was excluded — every regenerated HR sample inside that night that sat
// past `from` then missed the sleep dip. The fix uses overlap semantics
// (end_time >= from AND start_time <= to) so any block whose wake-time lies
// inside the catch-up range is loaded regardless of when bedtime fell.
func TestLoadRecentSleepWindowsIncludesOverlapAtWindowStart(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	userID := int64(12345)

	bedtime := time.Date(2026, 5, 10, 22, 45, 0, 0, time.UTC)
	wake := time.Date(2026, 5, 11, 6, 30, 0, 0, time.UTC)
	day := time.Date(2026, 5, 10, 0, 0, 0, 0, time.UTC)
	if _, err := s.DB().ExecContext(ctx,
		`INSERT INTO sleep_logs (user_id, start_time, end_time, timezone_offset, day, deep_minutes, rem_minutes, light_minutes, awake_minutes, total_minutes)
		 VALUES (?, ?, ?, 0, ?, 90, 100, 230, 30, 450)`,
		userID, bedtime, wake, day); err != nil {
		t.Fatalf("seed sleep_logs: %v", err)
	}

	// from lands AFTER bedtime but BEFORE wake — exactly the long-catch-up
	// scenario where the last HR sample was at 23:30 mid-sleep.
	from := time.Date(2026, 5, 10, 23, 30, 1, 0, time.UTC)
	to := time.Date(2026, 5, 11, 12, 0, 0, 0, time.UTC)

	got, err := loadRecentSleepWindows(ctx, s, userID, from, to)
	if err != nil {
		t.Fatalf("loadRecentSleepWindows: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected the overlapping sleep block to be loaded; got %d windows", len(got))
	}
	if !got[0].start.Equal(bedtime.UTC()) || !got[0].end.Equal(wake.UTC()) {
		t.Errorf("loaded window mismatch: got start=%v end=%v; want start=%v end=%v",
			got[0].start, got[0].end, bedtime.UTC(), wake.UTC())
	}
}

// silence the unused-imports check when the store import is otherwise idle.
var _ = (*store.Store)(nil)
