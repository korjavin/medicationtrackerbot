package gamification

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// ----- per-domain read fakes -------------------------------------------------
//
// Each fake satisfies one narrow store interface and returns canned rows; an
// unset fake returns empty (the zero value) so a test only wires the domains it
// exercises. ScoreDay touches every store, so a full set is constructed below.

type fakeMed struct{ logs []store.IntakeLog }

func (f fakeMed) ListIntakeHistoryByUser(context.Context, int64, time.Time, time.Time) ([]store.IntakeLog, error) {
	return f.logs, nil
}

type fakeBP struct{ readings []store.BloodPressure }

func (f fakeBP) ListReadings(context.Context, int64, time.Time) ([]store.BloodPressure, error) {
	return f.readings, nil
}

type fakeWeight struct {
	logs []store.WeightLog
	goal *store.WeightGoal
}

func (f fakeWeight) ListLogs(context.Context, int64, time.Time) ([]store.WeightLog, error) {
	return f.logs, nil
}
func (f fakeWeight) GetGoal(context.Context, int64) (*store.WeightGoal, error) { return f.goal, nil }

type fakeVitals struct {
	dayStats []store.DayStat
	sleep    []store.SleepLog
	hr       []store.VitalsHeartLog
	spo2     []store.VitalsSpO2Log
	stress   []store.VitalsStressLog
}

func (f fakeVitals) ListDayStats(context.Context, int64, time.Time) ([]store.DayStat, error) {
	return f.dayStats, nil
}

// ListSleepLogs mirrors the real repo's SQL filter (start_time >= since) so the
// loader's day-window handling is exercised faithfully — a fake that ignored
// `since` would hide the sleep-attribution bug where a night's bedtime precedes
// the scored day's midnight.
func (f fakeVitals) ListSleepLogs(_ context.Context, _ int64, since time.Time) ([]store.SleepLog, error) {
	if since.IsZero() {
		return f.sleep, nil
	}
	var out []store.SleepLog
	for _, sl := range f.sleep {
		if !sl.StartTime.Before(since) {
			out = append(out, sl)
		}
	}
	return out, nil
}
func (f fakeVitals) ListHeart(context.Context, int64, time.Time, time.Time) ([]store.VitalsHeartLog, error) {
	return f.hr, nil
}
func (f fakeVitals) ListSpO2(context.Context, int64, time.Time, time.Time) ([]store.VitalsSpO2Log, error) {
	return f.spo2, nil
}
func (f fakeVitals) ListStress(context.Context, int64, time.Time, time.Time) ([]store.VitalsStressLog, error) {
	return f.stress, nil
}

type fakeFood struct {
	logs    []store.FoodLog
	stats   *store.FoodStats
	targets store.FoodTargets
}

func (f fakeFood) ListLogs(context.Context, int64, time.Time, int) ([]store.FoodLog, error) {
	return f.logs, nil
}
func (f fakeFood) GetStats(context.Context, int64, time.Time, int) (*store.FoodStats, error) {
	return f.stats, nil
}
func (f fakeFood) GetTargets(context.Context) (store.FoodTargets, error) { return f.targets, nil }

type fakeDiary struct{ notes []store.DiaryNote }

func (f fakeDiary) List(context.Context, int64, time.Time, time.Time, int, int64) ([]store.DiaryNote, error) {
	return f.notes, nil
}

type fakeWorkout struct {
	history []store.WorkoutSession
}

func (f fakeWorkout) ListHistory(int64, int) ([]store.WorkoutSession, error) { return f.history, nil }

// ----- in-memory gamification store fake -------------------------------------
//
// memGam is a real (if simple) implementation of GamStore: it stores targets,
// ledger rows, and state in maps so ScoreDay actually persists and GetSummary can
// read it back, exercising the full round trip. The ledger replace key mirrors
// the production UNIQUE (user, day_unix, ring, source_metric, kind).

type memGam struct {
	targets    map[int64][]gamstore.Target
	ledger     []gamstore.LedgerEntry
	state      map[int64]gamstore.State
	applyCalls int // ApplyDayScore invocations — guards the no-op-on-unchanged skip
}

func newMemGam() *memGam {
	return &memGam{
		targets: map[int64][]gamstore.Target{},
		state:   map[int64]gamstore.State{},
	}
}

func ledgerKey(userID int64, day time.Time, ring, metric, kind string) string {
	return time.Date(day.UTC().Year(), day.UTC().Month(), day.UTC().Day(), 0, 0, 0, 0, time.UTC).
		Format("2006-01-02") + "|" + ring + "|" + metric + "|" + kind
}

func (m *memGam) ListTargets(_ context.Context, userID int64) ([]gamstore.Target, error) {
	return m.targets[userID], nil
}
func (m *memGam) UpsertTarget(_ context.Context, userID int64, t gamstore.Target) (*gamstore.Target, error) {
	for i := range m.targets[userID] {
		if m.targets[userID][i].MetricKey == t.MetricKey {
			m.targets[userID][i] = t
			return &t, nil
		}
	}
	m.targets[userID] = append(m.targets[userID], t)
	return &t, nil
}
func (m *memGam) DeleteTarget(_ context.Context, userID int64, metricKey string) error {
	rows := m.targets[userID]
	for i := range rows {
		if rows[i].MetricKey == metricKey {
			m.targets[userID] = append(rows[:i], rows[i+1:]...)
			return nil
		}
	}
	return sql.ErrNoRows
}

func (m *memGam) UpsertLedger(_ context.Context, userID int64, entries []gamstore.LedgerEntry) error {
	for _, e := range entries {
		key := ledgerKey(userID, e.Day, e.Ring, e.SourceMetric, e.Kind)
		replaced := false
		for i := range m.ledger {
			ex := m.ledger[i]
			if ex.UserID == userID && ledgerKey(userID, ex.Day, ex.Ring, ex.SourceMetric, ex.Kind) == key {
				e.UserID = userID
				m.ledger[i] = e
				replaced = true
				break
			}
		}
		if !replaced {
			e.UserID = userID
			m.ledger = append(m.ledger, e)
		}
	}
	return nil
}

func (m *memGam) ListLedger(_ context.Context, userID, since, until int64) ([]gamstore.LedgerEntry, error) {
	var out []gamstore.LedgerEntry
	for _, e := range m.ledger {
		if e.UserID != userID {
			continue
		}
		dk := utcMidnight(e.Day).Unix()
		if dk >= since && dk <= until {
			out = append(out, e)
		}
	}
	return out, nil
}

func (m *memGam) SumHP(_ context.Context, userID int64) (int, error) {
	sum := 0
	for _, e := range m.ledger {
		if e.UserID == userID {
			sum += e.HP
		}
	}
	return sum, nil
}

func (m *memGam) GetState(_ context.Context, userID int64) (gamstore.State, error) {
	if st, ok := m.state[userID]; ok {
		return st, nil
	}
	return gamstore.State{UserID: userID, Level: 1, InsightTier: 1}, nil
}

func (m *memGam) UpsertState(_ context.Context, userID int64, st gamstore.State) (*gamstore.State, error) {
	st.UserID = userID
	m.state[userID] = st
	return &st, nil
}

// MarkBackfilled mirrors the real repo's in-place, set-once latch UPDATE: it
// stamps BackfilledAt on the existing state row without touching the other
// columns, and only when the latch is still nil — a redundant call leaves an
// already-stamped latch unchanged (the `backfilled_at_unix IS NULL` guard).
func (m *memGam) MarkBackfilled(_ context.Context, userID int64, at time.Time) error {
	st := m.state[userID]
	st.UserID = userID
	if st.BackfilledAt == nil {
		v := at.UTC()
		st.BackfilledAt = &v
	}
	m.state[userID] = st
	return nil
}

func (m *memGam) ApplyDayScore(ctx context.Context, userID int64, day time.Time, entries []gamstore.LedgerEntry, st gamstore.State) (*gamstore.State, error) {
	m.applyCalls++
	// Mirror the real repo: replace the whole day. Drop the user's existing rows
	// for `day` before inserting so a shrunk re-score leaves no orphan awards.
	dk := utcMidnight(day).Unix()
	var kept []gamstore.LedgerEntry
	for _, e := range m.ledger {
		if e.UserID == userID && utcMidnight(e.Day).Unix() == dk {
			continue
		}
		kept = append(kept, e)
	}
	m.ledger = kept
	if err := m.UpsertLedger(ctx, userID, entries); err != nil {
		return nil, err
	}
	return m.UpsertState(ctx, userID, st)
}

// fullStores wires a complete fake set; tests mutate the fields they care about.
type fullStores struct {
	med      fakeMed
	bp       fakeBP
	weight   fakeWeight
	vitals   fakeVitals
	food     fakeFood
	diary    fakeDiary
	workout  fakeWorkout
	gam      *memGam
	settings fakeSettings
}

func newFullService(fs *fullStores) *service {
	if fs.gam == nil {
		fs.gam = newMemGam()
	}
	return New(fs.med, fs.bp, fs.weight, fs.vitals, fs.food, fs.diary, fs.workout, fs.gam, fs.settings)
}

// ringHP sums the ledger HP for one ring on one day (helper for assertions).
func (m *memGam) ringHP(userID int64, day time.Time, ring string) int {
	sum := 0
	for _, e := range m.ledger {
		if e.UserID == userID && utcMidnight(e.Day).Equal(utcMidnight(day)) && e.Ring == ring {
			sum += e.HP
		}
	}
	return sum
}

// ----- tests -----------------------------------------------------------------

func TestScoreDay_SeededDay(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 7
	day := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	sched := day.Add(8 * time.Hour)

	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		med: fakeMed{logs: []store.IntakeLog{
			{Status: "TAKEN", ScheduledAt: sched, TakenAt: ptrTime(sched)}, // on time
			{Status: "MISSED", ScheduledAt: sched},
		}},
		bp: fakeBP{readings: []store.BloodPressure{
			{MeasuredAt: day.Add(9 * time.Hour), Systolic: 115, Diastolic: 75}, // in range
		}},
	}
	svc := newFullService(fs)

	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay: %v", err)
	}

	cfg := scoring.DefaultConfig()
	// Adherence: floor 1 taken*FloorHP + outcome scaleHP(max, takenSum/expected=1/2).
	wantAdh := cfg.FloorHP + scaleHPExpected(cfg.AdherenceOutcomeMaxHP, 0.5)
	if got := fs.gam.ringHP(userID, day, scoring.RingAdherence); got != wantAdh {
		t.Errorf("adherence HP = %d, want %d", got, wantAdh)
	}
	// BP lives in the Vitals ring: floor + full outcome (membership 1).
	wantVitals := cfg.FloorHP + cfg.BPOutcomeMaxHP
	if got := fs.gam.ringHP(userID, day, scoring.RingVitals); got != wantVitals {
		t.Errorf("vitals HP = %d, want %d", got, wantVitals)
	}

	st, _ := fs.gam.GetState(ctx, userID)
	wantLifetime := wantAdh + wantVitals
	if st.LifetimeHP != wantLifetime {
		t.Errorf("lifetime HP = %d, want %d", st.LifetimeHP, wantLifetime)
	}
	if st.Level != scoring.LevelForLifetimeHP(wantLifetime, cfg) {
		t.Errorf("level = %d, want %d", st.Level, scoring.LevelForLifetimeHP(wantLifetime, cfg))
	}
	if st.LastScoredDay == nil || !st.LastScoredDay.Equal(day) {
		t.Errorf("last scored day = %v, want %v", st.LastScoredDay, day)
	}
}

// TestScoreDay_SleepAttributedToWakeDay guards against the sleep-attribution
// regression: a real night's start_time is the prior evening's bedtime while its
// Day field is the wake-up date. Since ListSleepLogs filters start_time >= since,
// scoring day D must widen its read window below D-midnight or the night that
// belongs to D is silently dropped and the Mind ring's sleep HP never lands.
func TestScoreDay_SleepAttributedToWakeDay(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 21
	day := time.Date(2026, 6, 22, 0, 0, 0, 0, time.UTC)
	// Bedtime 22:30 the prior evening, 8h sleep (squarely in the 7-9h band).
	bedtime := day.AddDate(0, 0, -1).Add(22*time.Hour + 30*time.Minute)
	total := 480
	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		vitals: fakeVitals{sleep: []store.SleepLog{{
			StartTime:    bedtime,
			EndTime:      bedtime.Add(time.Duration(total) * time.Minute),
			Day:          day.Format("2006-01-02"),
			TotalMinutes: &total,
		}}},
	}
	svc := newFullService(fs)

	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay: %v", err)
	}

	cfg := scoring.DefaultConfig()
	// Mind ring: sleep floor + full duration outcome (8h → membership 1).
	want := cfg.FloorHP + cfg.SleepOutcomeMaxHP
	if got := fs.gam.ringHP(userID, day, scoring.RingMind); got != want {
		t.Errorf("sleep Mind-ring HP = %d, want %d (night dropped by start_time window?)", got, want)
	}
}

// TestScoreDay_AdherenceDedupesTZStepPhantom guards against double-counting a
// single logical dose that was materialized twice during a timezone transition:
// a phantom MISSED source='schedule' row and the real TAKEN source='tz_step' row
// at the same (medication_id, scheduled_at). The adherence scorer must collapse
// them to one taken dose (the tz_step sibling shadows the schedule phantom, as the
// medication store's own readers do), not score a taken+missed pair.
func TestScoreDay_AdherenceDedupesTZStepPhantom(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 31
	day := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	sched := day.Add(8 * time.Hour)

	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		med: fakeMed{logs: []store.IntakeLog{
			{ID: 1, MedicationID: 7, Status: "MISSED", ScheduledAt: sched, Source: "schedule"},
			{ID: 2, MedicationID: 7, Status: "TAKEN", ScheduledAt: sched, TakenAt: ptrTime(sched), Source: "tz_step"},
		}},
	}
	svc := newFullService(fs)
	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay: %v", err)
	}

	cfg := scoring.DefaultConfig()
	// One on-time TAKEN dose: floor + full outcome (membership 1, ratio 1.0). The
	// phantom MISSED row must be dropped, not counted as a second expected dose.
	want := cfg.FloorHP + scaleHPExpected(cfg.AdherenceOutcomeMaxHP, 1.0)
	if got := fs.gam.ringHP(userID, day, scoring.RingAdherence); got != want {
		t.Errorf("adherence HP = %d, want %d (tz_step phantom not deduped — dose double-counted?)", got, want)
	}
}

// TestScoreDay_AdherencePendingTZStepDoesNotShadow is the inverse guard: a still-
// PENDING tz_step sibling (e.g. an orphan from a cancelled plan) scores nothing
// and must NOT shadow the real acted-on schedule row, or a genuine dose vanishes.
func TestScoreDay_AdherencePendingTZStepDoesNotShadow(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 32
	day := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	sched := day.Add(8 * time.Hour)

	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		med: fakeMed{logs: []store.IntakeLog{
			{ID: 1, MedicationID: 7, Status: "TAKEN", ScheduledAt: sched, TakenAt: ptrTime(sched), Source: "schedule"},
			{ID: 2, MedicationID: 7, Status: "PENDING", ScheduledAt: sched, Source: "tz_step"}, // orphan, never acted on
		}},
	}
	svc := newFullService(fs)
	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay: %v", err)
	}

	cfg := scoring.DefaultConfig()
	want := cfg.FloorHP + scaleHPExpected(cfg.AdherenceOutcomeMaxHP, 1.0)
	if got := fs.gam.ringHP(userID, day, scoring.RingAdherence); got != want {
		t.Errorf("adherence HP = %d, want %d (PENDING tz_step wrongly shadowed the real dose?)", got, want)
	}
}

// TestScoreDay_AdherenceOverduePendingCountsAsMiss guards the production gap that
// nothing ever sweeps a forgotten dose from PENDING to MISSED (only the demo
// seeder / importer write MISSED). A dose still PENDING after its scheduled time
// has passed must drag the adherence outcome down exactly as an explicit MISSED
// would — otherwise logging only the doses taken on time scores a perfect outcome
// and the 365-day backfill computes an inflated starting level. A future-scheduled
// PENDING dose (still due) must stay unscored.
func TestScoreDay_AdherenceOverduePendingCountsAsMiss(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 33
	day := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	taken := day.Add(8 * time.Hour)
	overdue := day.Add(12 * time.Hour) // before the injected now → a forgotten dose
	future := day.Add(20 * time.Hour)  // after the injected now → still due

	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		med: fakeMed{logs: []store.IntakeLog{
			{ID: 1, MedicationID: 7, Status: "TAKEN", ScheduledAt: taken, TakenAt: ptrTime(taken), Source: "schedule"},
			{ID: 2, MedicationID: 8, Status: "PENDING", ScheduledAt: overdue, Source: "schedule"},
			{ID: 3, MedicationID: 9, Status: "PENDING", ScheduledAt: future, Source: "schedule"},
		}},
	}
	svc := newFullService(fs)
	// now sits between the overdue dose (12:00) and the future dose (20:00).
	svc.now = func() time.Time { return day.Add(15 * time.Hour) }
	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay: %v", err)
	}

	cfg := scoring.DefaultConfig()
	// One on-time TAKEN + one overdue-PENDING-as-miss → outcome ratio 1/2 = 0.5;
	// the future PENDING is unscored. Floor is one (only the TAKEN earns a floor; a
	// miss earns none).
	want := cfg.FloorHP + scaleHPExpected(cfg.AdherenceOutcomeMaxHP, 0.5)
	if got := fs.gam.ringHP(userID, day, scoring.RingAdherence); got != want {
		t.Errorf("adherence HP = %d, want %d (overdue PENDING not counted as miss, or future PENDING penalized?)", got, want)
	}
}

func TestScoreDay_Idempotent(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 3
	day := time.Date(2026, 6, 18, 0, 0, 0, 0, time.UTC)

	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: []store.BloodPressure{{MeasuredAt: day.Add(time.Hour), Systolic: 118, Diastolic: 78}}},
	}
	svc := newFullService(fs)

	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay #1: %v", err)
	}
	rows1 := len(fs.gam.ledger)
	sum1, _ := fs.gam.SumHP(ctx, userID)

	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay #2: %v", err)
	}
	if got := len(fs.gam.ledger); got != rows1 {
		t.Errorf("re-score changed ledger row count: %d → %d", rows1, got)
	}
	if sum2, _ := fs.gam.SumHP(ctx, userID); sum2 != sum1 {
		t.Errorf("re-score changed lifetime HP: %d → %d", sum1, sum2)
	}
}

// TestScoreDay_UnchangedSkipsWrite guards the read-rescore loop fix: re-scoring a
// day whose source data is unchanged must NOT persist (ApplyDayScore), because in
// production an unconditional write fires the change_events('gamification') trigger
// on every read, feeding an endless change-event → SSE → refetch → rescore loop on
// an open Today/Journey screen. A real change (added data) must still write.
func TestScoreDay_UnchangedSkipsWrite(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 31
	day := time.Date(2026, 6, 22, 0, 0, 0, 0, time.UTC)
	gam := newMemGam()

	bp := fakeBP{readings: []store.BloodPressure{{MeasuredAt: day.Add(time.Hour), Systolic: 118, Diastolic: 78}}}
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}, bp: bp, gam: gam})

	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay #1: %v", err)
	}
	if gam.applyCalls != 1 {
		t.Fatalf("first score: applyCalls = %d, want 1", gam.applyCalls)
	}

	// Re-score with identical data → no write (the loop guard).
	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay #2: %v", err)
	}
	if gam.applyCalls != 1 {
		t.Errorf("unchanged re-score wrote anyway: applyCalls = %d, want 1", gam.applyCalls)
	}

	// A real delta — a diary note adds a Mind-ring award that wasn't there — must
	// still write (new service, shared ledger, mirrors the existing data-change tests).
	svc2 := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		bp:       bp,
		diary:    fakeDiary{notes: []store.DiaryNote{{Content: "felt ok"}}},
		gam:      gam,
	})
	if err := svc2.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay #3: %v", err)
	}
	if gam.applyCalls != 2 {
		t.Errorf("changed re-score skipped the write: applyCalls = %d, want 2", gam.applyCalls)
	}
}

// TestScoreDay_DataReduction_RemovesOrphanAwards guards the whole-day-replace
// invariant: when a day is re-scored with less source data than before (here the
// BP reading disappears), the previously-written awards must not orphan in the
// ledger, and the cached lifetime_hp must stay consistent with SumHP(ledger).
func TestScoreDay_DataReduction_RemovesOrphanAwards(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 11
	day := time.Date(2026, 6, 19, 0, 0, 0, 0, time.UTC)
	gam := newMemGam()

	// First score: a BP reading produces Vitals floor + outcome.
	svc1 := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: []store.BloodPressure{{MeasuredAt: day.Add(time.Hour), Systolic: 115, Diastolic: 75}}},
		gam:      gam,
	})
	if err := svc1.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay #1: %v", err)
	}
	if got := gam.ringHP(userID, day, scoring.RingVitals); got == 0 {
		t.Fatalf("expected non-zero vitals HP after first score")
	}

	// Second score of the SAME day with the BP reading removed (shared gam).
	svc2 := newFullService(&fullStores{settings: fakeSettings{enabled: true}, gam: gam})
	if err := svc2.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay #2: %v", err)
	}

	if got := gam.ringHP(userID, day, scoring.RingVitals); got != 0 {
		t.Errorf("orphan vitals HP after data removed: %d, want 0", got)
	}
	sum, _ := gam.SumHP(ctx, userID)
	st, _ := gam.GetState(ctx, userID)
	if sum != 0 {
		t.Errorf("SumHP = %d after all data removed, want 0", sum)
	}
	if st.LifetimeHP != sum {
		t.Errorf("cached lifetime_hp (%d) diverged from SumHP (%d)", st.LifetimeHP, sum)
	}
}

func TestScoreDay_GateOff_NoOp(t *testing.T) {
	ctx := context.Background()
	fs := &fullStores{
		settings: fakeSettings{enabled: false},
		bp:       fakeBP{readings: []store.BloodPressure{{MeasuredAt: time.Now(), Systolic: 115, Diastolic: 75}}},
	}
	svc := newFullService(fs)

	if err := svc.ScoreDay(ctx, 1, time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("ScoreDay: %v", err)
	}
	if len(fs.gam.ledger) != 0 {
		t.Errorf("gate-off wrote %d ledger rows, want 0", len(fs.gam.ledger))
	}
}

func TestGetSummary_GateOff_Empty(t *testing.T) {
	ctx := context.Background()
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: false}})

	sum, err := svc.GetSummary(ctx, 1)
	if err != nil {
		t.Fatalf("GetSummary: %v", err)
	}
	if sum.Enabled {
		t.Error("gate-off summary marked enabled")
	}
	if sum.LifetimeHP != 0 || sum.Level != 0 || len(sum.TodayRings) != 0 {
		t.Errorf("gate-off summary not empty: %+v", sum)
	}
}

func TestGetSummary_AfterScore(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 9
	day := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)

	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: []store.BloodPressure{{MeasuredAt: day.Add(time.Hour), Systolic: 115, Diastolic: 75}}},
		diary:    fakeDiary{notes: []store.DiaryNote{{Content: "felt ok"}}},
	}
	svc := newFullService(fs)
	// Pin "today" to the scored day so the summary's today window matches.
	svc.now = func() time.Time { return day.Add(20 * time.Hour) }

	if err := svc.ScoreDay(ctx, userID, day); err != nil {
		t.Fatalf("ScoreDay: %v", err)
	}
	sum, err := svc.GetSummary(ctx, userID)
	if err != nil {
		t.Fatalf("GetSummary: %v", err)
	}
	if !sum.Enabled {
		t.Fatal("summary not enabled")
	}
	if sum.TodayHP == 0 {
		t.Error("expected non-zero today HP")
	}
	if sum.LifetimeHP != sum.TodayHP {
		t.Errorf("lifetime (%d) should equal today HP (%d) for a single scored day", sum.LifetimeHP, sum.TodayHP)
	}
	if len(sum.TodayRings) != 5 {
		t.Fatalf("expected all 5 rings, got %d", len(sum.TodayRings))
	}
	// Vitals (BP) and Mind (diary) rings should be non-zero; others zero today.
	got := map[string]int{}
	for _, r := range sum.TodayRings {
		got[r.Ring] = r.HP
	}
	if got[scoring.RingVitals] == 0 {
		t.Error("expected non-zero vitals ring")
	}
	if got[scoring.RingMind] == 0 {
		t.Error("expected non-zero mind ring")
	}
	if sum.Level < 1 {
		t.Errorf("level = %d, want >= 1", sum.Level)
	}
	if sum.LevelSpanHP <= 0 {
		t.Errorf("level span = %d, want > 0", sum.LevelSpanHP)
	}
}

func TestEffectiveConfig_MergesOverrides(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 5

	gam := newMemGam()
	low, high, fall := 6.5, 8.5, 0.5
	gam.targets[userID] = []gamstore.Target{
		{MetricKey: TargetKeySleepHours, LowVal: &low, HighVal: &high, Falloff: &fall},
		{MetricKey: TargetKeySteps, LowVal: ptrFloat(9000)}, // one-sided: only Low overridden
	}
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}, gam: gam})

	cfg, err := svc.effectiveConfig(ctx, userID)
	if err != nil {
		t.Fatalf("effectiveConfig: %v", err)
	}
	if cfg.SleepHours.Low != low || cfg.SleepHours.High != high || cfg.SleepHours.Falloff != fall {
		t.Errorf("sleep band not merged: %+v", cfg.SleepHours)
	}
	def := scoring.DefaultConfig()
	if cfg.StepsBand.Low != 9000 {
		t.Errorf("steps low override not applied: %v", cfg.StepsBand.Low)
	}
	if cfg.StepsBand.High != def.StepsBand.High || cfg.StepsBand.Falloff != def.StepsBand.Falloff {
		t.Errorf("steps high/falloff should keep defaults: %+v", cfg.StepsBand)
	}
}

// ----- test helpers ----------------------------------------------------------

func ptrTime(t time.Time) *time.Time { return &t }
func ptrFloat(f float64) *float64    { return &f }

// scaleHPExpected mirrors the scoring package's scaleHP rounding for assertions.
func scaleHPExpected(maxHP int, r float64) int {
	v := float64(maxHP) * r
	return int(v + 0.5)
}
