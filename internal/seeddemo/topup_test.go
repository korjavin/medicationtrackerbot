package seeddemo

import (
	"context"
	"database/sql"
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

	tables := []string{"food_log", "blood_pressure_readings", "weight_logs", "diary_notes", "workout_sessions"}
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

// TestTopUpMillisecondSeedAvoidsCollision verifies the time-series ts-from
// helper offsets by exactly 1ms past the last sample so that subsequent
// generator calls land on the NEXT interval boundary, not the same one.
func TestTopUpMillisecondSeedAvoidsCollision(t *testing.T) {
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

// silence the unused-imports check when the store import is otherwise idle.
var _ = (*store.Store)(nil)
