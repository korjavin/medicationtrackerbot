package gamification

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// bpDaysService builds a service whose BP store carries one in-range reading per
// given day, so every scored day earns HP and its week counts as a met
// minimum-viable week. Days seven apart land in consecutive week buckets
// regardless of anchor, which is what the streak cadence keys on.
func bpDaysService(days []time.Time) (*service, *fullStores) {
	var readings []store.BloodPressure
	for _, d := range days {
		readings = append(readings, store.BloodPressure{MeasuredAt: d.Add(9 * time.Hour), Systolic: 115, Diastolic: 75})
	}
	fs := &fullStores{settings: fakeSettings{enabled: true}, bp: fakeBP{readings: readings}}
	return newFullService(fs), fs
}

func TestScoreDay_StreakAcrossFrozenMiss(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 21
	day0 := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	// Weeks 0,1,2 are scored (each banks a freeze); week 3 is skipped entirely;
	// week 4 is scored — the missed week 3 must auto-consume a banked freeze and
	// keep the streak alive, not reset it.
	scored := []time.Time{
		day0,
		day0.AddDate(0, 0, 7),
		day0.AddDate(0, 0, 14),
		day0.AddDate(0, 0, 28),
	}
	svc, fs := bpDaysService(scored)

	for _, d := range scored {
		if err := svc.ScoreDay(ctx, userID, d); err != nil {
			t.Fatalf("ScoreDay %v: %v", d, err)
		}
	}

	st, _ := fs.gam.GetState(ctx, userID)
	if st.CurrentStreak != 3 {
		t.Errorf("current streak = %d, want 3 (preserved across the frozen miss)", st.CurrentStreak)
	}
	if st.LongestStreak != 3 {
		t.Errorf("longest streak = %d, want 3", st.LongestStreak)
	}
	// Three met weeks bank three freezes; the missed week 3 auto-consumes one.
	if st.Freezes != 2 {
		t.Errorf("freezes = %d, want 2 (one consumed by the frozen miss)", st.Freezes)
	}
}

func TestScoreDay_StreakResetKeepsLongest(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 22
	day0 := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	// Six consecutive weekly check-ins build the streak; then a gap far beyond the
	// banked freezes resets the current streak. The longest-ever peak must survive.
	var scored []time.Time
	for i := 0; i < 6; i++ {
		scored = append(scored, day0.AddDate(0, 0, 7*i))
	}
	scored = append(scored, day0.AddDate(0, 0, 7*200)) // huge gap → certain reset
	svc, fs := bpDaysService(scored)

	for _, d := range scored {
		if err := svc.ScoreDay(ctx, userID, d); err != nil {
			t.Fatalf("ScoreDay %v: %v", d, err)
		}
	}

	st, _ := fs.gam.GetState(ctx, userID)
	if st.CurrentStreak != 0 {
		t.Errorf("current streak = %d, want 0 after a gap exceeding banked freezes", st.CurrentStreak)
	}
	if st.LongestStreak != 6 {
		t.Errorf("longest streak = %d, want 6 (peak preserved across the reset)", st.LongestStreak)
	}
}

func TestScoreDay_StreakIdempotentReScore(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 23
	day0 := time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)
	scored := []time.Time{day0, day0.AddDate(0, 0, 7), day0.AddDate(0, 0, 14)}
	svc, fs := bpDaysService(scored)

	for _, d := range scored {
		if err := svc.ScoreDay(ctx, userID, d); err != nil {
			t.Fatalf("ScoreDay %v: %v", d, err)
		}
	}
	before, _ := fs.gam.GetState(ctx, userID)

	// Re-scoring the latest day (same week) and an earlier day (out of order) must
	// leave the streak untouched — backfill/rescore safety.
	if err := svc.ScoreDay(ctx, userID, scored[len(scored)-1]); err != nil {
		t.Fatalf("re-score latest: %v", err)
	}
	if err := svc.ScoreDay(ctx, userID, scored[0]); err != nil {
		t.Fatalf("re-score earliest: %v", err)
	}
	after, _ := fs.gam.GetState(ctx, userID)

	if after.CurrentStreak != before.CurrentStreak || after.LongestStreak != before.LongestStreak || after.Freezes != before.Freezes {
		t.Errorf("re-score changed streak state: before %+v after %+v", before, after)
	}
}

func TestGetInsightTier(t *testing.T) {
	ctx := context.Background()
	cfg := scoring.DefaultConfig()

	// Gate-off → 0 regardless of any stored state (feature hidden).
	off := newFullService(&fullStores{settings: fakeSettings{enabled: false}})
	if tier, err := off.GetInsightTier(ctx, 1); err != nil || tier != 0 {
		t.Fatalf("gate-off tier = %d, err %v; want 0, nil", tier, err)
	}

	// Enabled but unscored user → default tier 1.
	gam := newMemGam()
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}, gam: gam})
	if tier, err := svc.GetInsightTier(ctx, 2); err != nil || tier != 1 {
		t.Fatalf("unscored tier = %d, err %v; want 1, nil", tier, err)
	}

	// Tier increases with level: seed two users at the lowest and highest unlock
	// levels with the tier the curve grants, and assert the climb is reflected.
	lowLevel := 1
	highLevel := cfg.InsightTierLevels[len(cfg.InsightTierLevels)-1]
	gam.state[10] = gamstore.State{UserID: 10, Level: lowLevel, InsightTier: scoring.InsightTierForLevel(lowLevel, cfg)}
	gam.state[11] = gamstore.State{UserID: 11, Level: highLevel, InsightTier: scoring.InsightTierForLevel(highLevel, cfg)}

	lowTier, err := svc.GetInsightTier(ctx, 10)
	if err != nil {
		t.Fatalf("low-level tier: %v", err)
	}
	highTier, err := svc.GetInsightTier(ctx, 11)
	if err != nil {
		t.Fatalf("high-level tier: %v", err)
	}
	if highTier <= lowTier {
		t.Errorf("tier did not increase with level: L%d→%d vs L%d→%d", lowLevel, lowTier, highLevel, highTier)
	}
}
