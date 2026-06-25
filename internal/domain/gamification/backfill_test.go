package gamification

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// sameState compares the meaningful state fields (LastScoredDay by value, not by
// pointer identity) so idempotency assertions don't trip on a re-allocated time.
func sameState(a, b gamstore.State) bool {
	if a.LifetimeHP != b.LifetimeHP || a.Level != b.Level ||
		a.CurrentStreak != b.CurrentStreak || a.LongestStreak != b.LongestStreak ||
		a.Freezes != b.Freezes || a.InsightTier != b.InsightTier {
		return false
	}
	if (a.LastScoredDay == nil) != (b.LastScoredDay == nil) {
		return false
	}
	if a.LastScoredDay != nil && !a.LastScoredDay.Equal(*b.LastScoredDay) {
		return false
	}
	if (a.BackfilledAt == nil) != (b.BackfilledAt == nil) {
		return false
	}
	if a.BackfilledAt != nil && !a.BackfilledAt.Equal(*b.BackfilledAt) {
		return false
	}
	return true
}

// TestBackfill_CapsAt365_Idempotent seeds ~400 days of data and asserts Backfill
// scores only the most recent 365, never produces negative HP, and is a no-op on
// a second run (identical ledger row count + state).
func TestBackfill_CapsAt365_Idempotent(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 41
	today := time.Date(2026, 6, 25, 0, 0, 0, 0, time.UTC)

	// Seed ~400 days across domains: an in-range BP reading (date-accurate, the
	// primary per-day signal) on each of the last 400 calendar days, plus a couple
	// of diary notes (a second ring). The cap must clip the scored window to 365.
	const seededDays = 400
	var readings []store.BloodPressure
	for k := 0; k < seededDays; k++ {
		d := today.AddDate(0, 0, -k)
		readings = append(readings, store.BloodPressure{
			MeasuredAt: d.Add(9 * time.Hour), Systolic: 116, Diastolic: 76,
		})
	}
	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: readings},
		diary:    fakeDiary{notes: []store.DiaryNote{{Content: "reflecting"}}},
	}
	svc := newFullService(fs)
	svc.now = func() time.Time { return today.Add(12 * time.Hour) }

	if err := svc.Backfill(ctx, userID); err != nil {
		t.Fatalf("Backfill: %v", err)
	}

	// Only the most recent 365 days should carry ledger rows; none older.
	days := map[int64]bool{}
	var oldest int64 = 1 << 62
	for _, e := range fs.gam.ledger {
		if e.HP < 0 {
			t.Errorf("negative HP in ledger: %+v", e)
		}
		dk := utcMidnight(e.Day).Unix()
		days[dk] = true
		if dk < oldest {
			oldest = dk
		}
	}
	if len(days) != backfillDays {
		t.Errorf("scored %d distinct days, want %d (capped)", len(days), backfillDays)
	}
	wantOldest := today.AddDate(0, 0, -(backfillDays - 1)).Unix()
	if oldest != wantOldest {
		t.Errorf("oldest scored day_unix = %d, want %d", oldest, wantOldest)
	}

	st1, _ := fs.gam.GetState(ctx, userID)
	if st1.LifetimeHP < 0 {
		t.Errorf("lifetime HP = %d, want >= 0", st1.LifetimeHP)
	}
	if st1.LastScoredDay == nil || !st1.LastScoredDay.Equal(today) {
		t.Errorf("last scored day = %v, want %v", st1.LastScoredDay, today)
	}
	if st1.BackfilledAt == nil {
		t.Error("completed backfill did not stamp the BackfilledAt latch")
	}

	// Second run is a no-op: identical ledger row count + state.
	rows1 := len(fs.gam.ledger)
	sum1, _ := fs.gam.SumHP(ctx, userID)
	if err := svc.Backfill(ctx, userID); err != nil {
		t.Fatalf("Backfill #2: %v", err)
	}
	if got := len(fs.gam.ledger); got != rows1 {
		t.Errorf("re-backfill changed ledger row count: %d → %d", rows1, got)
	}
	if sum2, _ := fs.gam.SumHP(ctx, userID); sum2 != sum1 {
		t.Errorf("re-backfill changed lifetime HP: %d → %d", sum1, sum2)
	}
	st2, _ := fs.gam.GetState(ctx, userID)
	if !sameState(st1, st2) {
		t.Errorf("re-backfill changed state: %+v → %+v", st1, st2)
	}
}

// TestBackfill_GateOff_NoOp asserts a disabled flag leaves the ledger untouched.
func TestBackfill_GateOff_NoOp(t *testing.T) {
	ctx := context.Background()
	today := time.Date(2026, 6, 25, 0, 0, 0, 0, time.UTC)
	fs := &fullStores{
		settings: fakeSettings{enabled: false},
		bp:       fakeBP{readings: []store.BloodPressure{{MeasuredAt: today.Add(9 * time.Hour), Systolic: 116, Diastolic: 76}}},
	}
	svc := newFullService(fs)
	svc.now = func() time.Time { return today.Add(12 * time.Hour) }

	if err := svc.Backfill(ctx, 1); err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if len(fs.gam.ledger) != 0 {
		t.Errorf("gate-off Backfill wrote %d ledger rows, want 0", len(fs.gam.ledger))
	}
}

// TestEnsureBackfilled_GateOff asserts the enable-hook entry point no-ops when off.
func TestEnsureBackfilled_GateOff(t *testing.T) {
	ctx := context.Background()
	fs := &fullStores{settings: fakeSettings{enabled: false}}
	svc := newFullService(fs)

	if err := svc.EnsureBackfilled(ctx, 1); err != nil {
		t.Fatalf("EnsureBackfilled: %v", err)
	}
	if len(fs.gam.ledger) != 0 {
		t.Errorf("gate-off EnsureBackfilled wrote %d rows, want 0", len(fs.gam.ledger))
	}
}

// TestEnsureBackfilled_RunsOnFirstEnable asserts an unscored user gets backfilled.
func TestEnsureBackfilled_RunsOnFirstEnable(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 52
	today := time.Date(2026, 6, 25, 0, 0, 0, 0, time.UTC)
	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		bp: fakeBP{readings: []store.BloodPressure{
			{MeasuredAt: today.Add(9 * time.Hour), Systolic: 116, Diastolic: 76},
			{MeasuredAt: today.AddDate(0, 0, -3).Add(9 * time.Hour), Systolic: 118, Diastolic: 77},
		}},
	}
	svc := newFullService(fs)
	svc.now = func() time.Time { return today.Add(12 * time.Hour) }

	if err := svc.EnsureBackfilled(ctx, userID); err != nil {
		t.Fatalf("EnsureBackfilled: %v", err)
	}
	if len(fs.gam.ledger) == 0 {
		t.Error("EnsureBackfilled did not backfill on first enable")
	}
	st, _ := fs.gam.GetState(ctx, userID)
	if st.LastScoredDay == nil {
		t.Error("first-enable backfill left state unscored")
	}
	if st.BackfilledAt == nil {
		t.Error("first-enable backfill did not stamp the BackfilledAt latch")
	}
}

// TestEnsureBackfilled_SkipsWhenBackfilled proves the guard short-circuits on the
// dedicated latch: a user whose state already carries a BackfilledAt must NOT
// re-run the 365-day walk, so the (intentionally empty) ledger stays empty.
func TestEnsureBackfilled_SkipsWhenBackfilled(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 51
	today := time.Date(2026, 6, 25, 0, 0, 0, 0, time.UTC)

	gam := newMemGam()
	ls := today.AddDate(0, 0, -1)
	done := today.AddDate(0, 0, -2)
	gam.state[userID] = gamstore.State{UserID: userID, Level: 1, InsightTier: 1, LastScoredDay: &ls, BackfilledAt: &done}
	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: []store.BloodPressure{{MeasuredAt: today.Add(9 * time.Hour), Systolic: 116, Diastolic: 76}}},
		gam:      gam,
	}
	svc := newFullService(fs)
	svc.now = func() time.Time { return today.Add(12 * time.Hour) }

	if err := svc.EnsureBackfilled(ctx, userID); err != nil {
		t.Fatalf("EnsureBackfilled: %v", err)
	}
	if len(fs.gam.ledger) != 0 {
		t.Errorf("EnsureBackfilled re-ran backfill despite prior backfill: %d rows", len(fs.gam.ledger))
	}
}

// TestEnsureBackfilled_RunsWhenScoredButNotBackfilled is the regression guard for
// the "any scored day == done" bug: a user whose state has a LastScoredDay (e.g.
// a partial backfill that died part-way, or a live same-day score that landed
// before first enable) but NO BackfilledAt latch must still get the full
// historical replay — otherwise the remaining days are silently lost forever.
//
// It also guards the streak-reconstruction half of the same scenario: the stale
// LastScoredDay (today) sits in a later week than every backfilled day, so without
// the streak reset advanceStreak would no-op for the whole walk and the streak
// would stay stuck at its pre-backfill value (0) even though the ledger fills.
// Three consecutive weekly readings must rebuild a streak of 3.
func TestEnsureBackfilled_RunsWhenScoredButNotBackfilled(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 53
	today := time.Date(2026, 6, 25, 0, 0, 0, 0, time.UTC)

	gam := newMemGam()
	// Simulate a partial run: only today was scored (advancing LastScoredDay into
	// the current week), latch never stamped, no streak built yet.
	scored := today
	gam.state[userID] = gamstore.State{UserID: userID, Level: 1, InsightTier: 1, LastScoredDay: &scored}
	// Three fully-completed weeks of in-range readings (today-7/-14/-21) so the
	// rebuilt weekly fold reaches a streak of 3; the current week (today) is left
	// empty so it is not folded.
	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		bp: fakeBP{readings: []store.BloodPressure{
			{MeasuredAt: today.AddDate(0, 0, -7).Add(9 * time.Hour), Systolic: 116, Diastolic: 76},
			{MeasuredAt: today.AddDate(0, 0, -14).Add(9 * time.Hour), Systolic: 116, Diastolic: 76},
			{MeasuredAt: today.AddDate(0, 0, -21).Add(9 * time.Hour), Systolic: 116, Diastolic: 76},
		}},
		gam: gam,
	}
	svc := newFullService(fs)
	svc.now = func() time.Time { return today.Add(12 * time.Hour) }

	if err := svc.EnsureBackfilled(ctx, userID); err != nil {
		t.Fatalf("EnsureBackfilled: %v", err)
	}
	if len(fs.gam.ledger) == 0 {
		t.Error("EnsureBackfilled skipped the historical replay despite no BackfilledAt latch")
	}
	st, _ := fs.gam.GetState(ctx, userID)
	if st.BackfilledAt == nil {
		t.Error("backfill triggered by the guard did not stamp the BackfilledAt latch")
	}
	if st.CurrentStreak != 3 {
		t.Errorf("current streak = %d, want 3 (streak not rebuilt over the backfilled window)", st.CurrentStreak)
	}
	if st.LongestStreak != 3 {
		t.Errorf("longest streak = %d, want 3", st.LongestStreak)
	}
}
