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
}

// TestEnsureBackfilled_SkipsWhenAlreadyScored proves the guard short-circuits: a
// user whose state already carries a LastScoredDay must NOT re-run the 365-day
// walk, so the (intentionally empty) ledger stays empty.
func TestEnsureBackfilled_SkipsWhenAlreadyScored(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 51
	today := time.Date(2026, 6, 25, 0, 0, 0, 0, time.UTC)

	gam := newMemGam()
	ls := today.AddDate(0, 0, -1)
	gam.state[userID] = gamstore.State{UserID: userID, Level: 1, InsightTier: 1, LastScoredDay: &ls}
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
		t.Errorf("EnsureBackfilled re-ran backfill despite prior scoring: %d rows", len(fs.gam.ledger))
	}
}
