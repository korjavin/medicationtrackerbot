package gamification

// streak_derive_test.go is the one integration test this plan calls for
// (gamification-6, Task 2): the derived streak is a pure fold over the
// ledger, so a late import into an already-missed week repairs the streak on
// the very next read — the regression the transactional advanceStreak could
// never fix. It runs the real service against a real SQLite-backed
// gamstore.Repo (not the in-memory memGam fake scoreday_test.go uses
// elsewhere in this package) so the WeeklyHPSums SQL is exercised for real.

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// newRealGam opens an in-memory SQLite DB, mounts the schema, and returns a
// real gamstore.Repo.
func newRealGam(t *testing.T) *gamstore.Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return gamstore.New(d)
}

func TestGetSummary_DerivedStreak_RepairsOnLateImport(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1
	gam := newRealGam(t)

	// Week N: one honest log — the only ledger activity so far.
	weekNDay := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC) // a Monday
	if err := gam.UpsertLedger(ctx, userID, []gamstore.LedgerEntry{
		{Day: weekNDay, Ring: "adherence", SourceMetric: "meds", Kind: "integrity_floor", HP: 2},
	}); err != nil {
		t.Fatalf("seed week N: %v", err)
	}

	// "Now" sits two weeks later: week N+1 is fully in the past with zero
	// activity — a genuine missed week, not one still in progress.
	now := weekNDay.AddDate(0, 0, 14)
	svc := New(fakeMed{}, fakeBP{}, fakeWeight{}, fakeVitals{}, fakeFood{}, fakeDiary{}, fakeWorkout{}, gam, fakeSettings{enabled: true})
	svc.now = func() time.Time { return now }

	sum, err := svc.GetSummary(ctx, userID)
	if err != nil {
		t.Fatalf("GetSummary (before repair): %v", err)
	}
	// Week N (met) banks one freeze; week N+1 (missed) auto-spends it — the
	// streak survives via the freeze instead of resetting, but the freeze is gone.
	if sum.CurrentStreak != 1 {
		t.Errorf("current streak before repair = %d, want 1 (preserved by freeze)", sum.CurrentStreak)
	}
	if sum.Freezes != 0 {
		t.Errorf("freezes before repair = %d, want 0 (auto-spent on the missed week)", sum.Freezes)
	}

	// The persisted transactional state must not reflect any of this: no
	// ScoreDay call ever ran for either week, so gamification_state was never
	// written. GetSummary's streak comes entirely from the ledger fold.
	if st, err := gam.GetState(ctx, userID); err != nil {
		t.Fatalf("GetState: %v", err)
	} else if st.CurrentStreak != 0 {
		t.Errorf("persisted current_streak = %d, want 0 (no ScoreDay ever ran)", st.CurrentStreak)
	}

	// Late import: a Mi Band backup lands one honest log inside week N+1. This
	// is the only mutation — no explicit "repair the streak" step exists.
	weekN1Day := weekNDay.AddDate(0, 0, 8) // the following Monday, still < now
	sched := weekN1Day.Add(8 * time.Hour)
	svc.med = fakeMed{logs: []store.IntakeLog{
		{Status: "TAKEN", ScheduledAt: sched, TakenAt: &sched},
	}}
	RescoreInstants(ctx, svc, userID, []time.Time{weekN1Day})

	sum2, err := svc.GetSummary(ctx, userID)
	if err != nil {
		t.Fatalf("GetSummary (after repair): %v", err)
	}
	if sum2.CurrentStreak != 2 {
		t.Errorf("current streak after late import = %d, want 2 (week N+1 now met)", sum2.CurrentStreak)
	}
	if sum2.Freezes == 0 {
		t.Errorf("freezes after late import = 0, want > 0 (week N+1 re-earned one)")
	}
	if sum2.LongestStreak != 2 {
		t.Errorf("longest streak after late import = %d, want 2", sum2.LongestStreak)
	}
}
