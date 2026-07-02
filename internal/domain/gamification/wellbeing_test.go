package gamification

// wellbeing_test.go is the one integration test Task 8's Testing Strategy
// calls for: the contributor-renormalization contract. It seeds only BP and
// adherence data (no sleep/HR/weight) through the real service — GetSummary,
// effectiveConfig, the healthScore* loaders, and scoring.ComputeHealthScore —
// against a real SQLite-backed gamstore.Repo (newRealGam, from
// streak_derive_test.go), and asserts the Health Score is computed from just
// the two present contributors with their weights renormalized, not diluted
// by the three absent ones scoring as 0.

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestGetSummary_HealthScore_RenormalizesOverPresentContributorsOnly(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1
	gam := newRealGam(t)

	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	recent := now.AddDate(0, 0, -3) // inside the default 14-day recent window

	svc := New(
		fakeMed{logs: []store.IntakeLog{
			{MedicationID: 1, Status: "TAKEN", ScheduledAt: recent, TakenAt: &recent},
		}},
		fakeBP{readings: []store.BloodPressure{
			{MeasuredAt: recent, Systolic: 110, Diastolic: 70}, // dead center of the default [90,120]/[60,80] bands
		}},
		fakeWeight{},
		fakeVitals{},
		fakeFood{},
		fakeDiary{},
		fakeWorkout{},
		gam,
		fakeSettings{enabled: true},
	)
	svc.now = func() time.Time { return now }

	sum, err := svc.GetSummary(ctx, userID)
	if err != nil {
		t.Fatalf("GetSummary: %v", err)
	}

	hs := sum.HealthScore
	if hs.Value == nil {
		t.Fatal("health score Value is nil, want a computed score from 2 present contributors")
	}
	// Both present contributors score full membership (BP dead-center; adherence
	// PDC 1.0 >= the 0.8 target), so the renormalized weighted mean is exactly
	// 100 — the same as if only these two contributors existed. If a missing
	// contributor were wrongly scored 0 instead of excluded, this would come out
	// diluted to 40 (2 full scores + 3 zeros, over 5).
	if *hs.Value != 100 {
		t.Errorf("health score = %v, want 100 (renormalized over present contributors only)", *hs.Value)
	}

	wantMissing := map[string]bool{"sleep": true, "resting_hr": true, "weight": true}
	if len(hs.Missing) != len(wantMissing) {
		t.Errorf("missing = %v, want exactly %v", hs.Missing, wantMissing)
	}
	for _, key := range hs.Missing {
		if !wantMissing[key] {
			t.Errorf("unexpected missing contributor %q", key)
		}
	}

	seenPresent := map[string]bool{}
	for _, c := range hs.Contributors {
		switch c.Key {
		case "bp", "adherence":
			if c.Missing {
				t.Errorf("contributor %q reported Missing=true, want present", c.Key)
			}
			if c.Score != 1 {
				t.Errorf("contributor %q score = %v, want 1", c.Key, c.Score)
			}
			seenPresent[c.Key] = true
		case "sleep", "resting_hr", "weight":
			if !c.Missing {
				t.Errorf("contributor %q reported Missing=false, want missing (no data seeded)", c.Key)
			}
		default:
			t.Errorf("unexpected contributor key %q", c.Key)
		}
	}
	if !seenPresent["bp"] || !seenPresent["adherence"] {
		t.Fatalf("expected both bp and adherence contributors present, got contributors=%+v", hs.Contributors)
	}
}
