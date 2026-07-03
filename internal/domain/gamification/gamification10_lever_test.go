package gamification

// gamification10_lever_test.go is the one integration test gamification-10's
// Testing Strategy calls for (Task 5): through the real service against a real
// SQLite-backed gamstore.Repo (newRealGam, streak_derive_test.go), it guards
// the lever-ring mapping (rings API returns exactly Bedtime/Movement/
// Nourishment; Bedtime closes on in-window bedtime timing, not on a diary
// entry) and the adherence safety-net contract (silent while PDC is healthy,
// active once it drops below threshold).

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

func findRing(t *testing.T, rings []gamstore.RingScore, key string) gamstore.RingScore {
	t.Helper()
	for _, r := range rings {
		if r.Ring == key {
			return r
		}
	}
	t.Fatalf("ring %q not found in %+v", key, rings)
	return gamstore.RingScore{}
}

func TestGetSummary_RingsView_ExactlyThreeLevers(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1
	gam := newRealGam(t)
	svc := New(fakeMed{}, fakeBP{}, fakeWeight{}, fakeVitals{}, fakeFood{}, fakeDiary{}, fakeWorkout{}, gam, fakeSettings{enabled: true}, nil)
	svc.now = func() time.Time { return time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC) }

	sum, err := svc.GetSummary(ctx, userID)
	if err != nil {
		t.Fatalf("GetSummary: %v", err)
	}

	wantKeys := []string{LeverBedtime, LeverMovement, LeverNourishment}
	for _, tc := range []struct {
		name  string
		rings []gamstore.RingScore
	}{
		{"today", sum.TodayRings},
		{"period", sum.PeriodRings},
	} {
		if len(tc.rings) != len(wantKeys) {
			t.Fatalf("%s: got %d rings, want %d: %+v", tc.name, len(tc.rings), len(wantKeys), tc.rings)
		}
		for i, want := range wantKeys {
			if got := tc.rings[i].Ring; got != want {
				t.Errorf("%s: ring[%d] = %q, want %q", tc.name, i, got, want)
			}
		}
	}
}

func TestScoreDay_BedtimeRing_ClosesOnInWindowTiming_NotOnDiary(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 42
	gam := newRealGam(t)

	// 14 baseline nights plus the scored night, all at the same 22:00 bedtime —
	// zero deviation from the median, well inside the ±45min window.
	scored := time.Date(2026, 3, 20, 0, 0, 0, 0, time.UTC)
	var sleep []store.SleepLog
	for i := -bedtimeBaselineDays; i <= 0; i++ {
		d := scored.AddDate(0, 0, i)
		total := 480
		sleep = append(sleep, store.SleepLog{
			Day:          d.Format("2006-01-02"),
			StartTime:    d.AddDate(0, 0, -1).Add(22 * time.Hour),
			EndTime:      d.Add(6 * time.Hour),
			TotalMinutes: &total,
		})
	}

	svc := New(fakeMed{}, fakeBP{}, fakeWeight{}, fakeVitals{sleep: sleep}, fakeFood{}, fakeDiary{}, fakeWorkout{}, gam, fakeSettings{enabled: true}, nil)
	svc.now = func() time.Time { return scored.Add(12 * time.Hour) }

	if err := svc.ScoreDay(ctx, userID, scored); err != nil {
		t.Fatalf("ScoreDay (in-window night): %v", err)
	}
	sum, err := svc.GetSummary(ctx, userID)
	if err != nil {
		t.Fatalf("GetSummary (in-window night): %v", err)
	}
	bedtime := findRing(t, sum.TodayRings, LeverBedtime)
	if !bedtime.Closed {
		t.Errorf("bedtime ring not closed for an in-window bedtime: %+v", bedtime)
	}
	if bedtime.HP <= 0 {
		t.Errorf("bedtime ring HP = %d, want > 0", bedtime.HP)
	}

	// A day with only a diary entry (no sleep row logged at all) must not
	// close — or even award — the bedtime ring.
	diaryDay := scored.AddDate(0, 0, 1)
	svc2 := New(fakeMed{}, fakeBP{}, fakeWeight{}, fakeVitals{}, fakeFood{}, fakeDiary{notes: []store.DiaryNote{
		{UserID: userID, Content: "long day", CreatedAt: diaryDay.Add(9 * time.Hour)},
	}}, fakeWorkout{}, gam, fakeSettings{enabled: true}, nil)
	svc2.now = func() time.Time { return diaryDay.Add(12 * time.Hour) }

	if err := svc2.ScoreDay(ctx, userID, diaryDay); err != nil {
		t.Fatalf("ScoreDay (diary-only day): %v", err)
	}
	sum2, err := svc2.GetSummary(ctx, userID)
	if err != nil {
		t.Fatalf("GetSummary (diary-only day): %v", err)
	}
	bedtimeFromDiary := findRing(t, sum2.TodayRings, LeverBedtime)
	if bedtimeFromDiary.Closed || bedtimeFromDiary.HP != 0 {
		t.Errorf("bedtime ring awarded by a diary-only day: %+v", bedtimeFromDiary)
	}
}

func TestGetSummary_AdherenceAlert_ActiveBelowThreshold(t *testing.T) {
	ctx := context.Background()
	today := time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC)

	// Below-threshold PDC: 3 missed out of 14 scheduled doses (~78.6% < the
	// 90% AdherenceAlertPDCThreshold) trips the alert.
	t.Run("below threshold trips the alert", func(t *testing.T) {
		const userID int64 = 1
		gam := newRealGam(t)
		var logs []store.IntakeLog
		for i := 0; i < 14; i++ {
			sched := today.AddDate(0, 0, -i).Add(8 * time.Hour)
			status := "TAKEN"
			if i < 3 {
				status = "MISSED"
			}
			l := store.IntakeLog{MedicationID: 1, ScheduledAt: sched, Status: status}
			if status == "TAKEN" {
				l.TakenAt = &sched
			}
			logs = append(logs, l)
		}
		svc := New(fakeMed{logs: logs}, fakeBP{}, fakeWeight{}, fakeVitals{}, fakeFood{}, fakeDiary{}, fakeWorkout{}, gam, fakeSettings{enabled: true}, nil)
		svc.now = func() time.Time { return today }

		sum, err := svc.GetSummary(ctx, userID)
		if err != nil {
			t.Fatalf("GetSummary: %v", err)
		}
		if !sum.AdherenceAlert.Active {
			t.Fatalf("adherence_alert = %+v, want Active=true", sum.AdherenceAlert)
		}
		if sum.AdherenceAlert.MissedDoses != 3 {
			t.Errorf("missed_doses = %d, want 3", sum.AdherenceAlert.MissedDoses)
		}
	})

	// Healthy PDC: every scheduled dose taken keeps the alert invisible.
	t.Run("healthy PDC stays absent", func(t *testing.T) {
		const userID int64 = 2
		gam := newRealGam(t)
		var logs []store.IntakeLog
		for i := 0; i < 14; i++ {
			sched := today.AddDate(0, 0, -i).Add(8 * time.Hour)
			logs = append(logs, store.IntakeLog{MedicationID: 1, ScheduledAt: sched, Status: "TAKEN", TakenAt: &sched})
		}
		svc := New(fakeMed{logs: logs}, fakeBP{}, fakeWeight{}, fakeVitals{}, fakeFood{}, fakeDiary{}, fakeWorkout{}, gam, fakeSettings{enabled: true}, nil)
		svc.now = func() time.Time { return today }

		sum, err := svc.GetSummary(ctx, userID)
		if err != nil {
			t.Fatalf("GetSummary: %v", err)
		}
		if sum.AdherenceAlert.Active {
			t.Fatalf("adherence_alert = %+v, want Active=false", sum.AdherenceAlert)
		}
		if sum.AdherenceAlert.MissedDoses != 0 {
			t.Errorf("missed_doses = %d, want 0", sum.AdherenceAlert.MissedDoses)
		}
	})
}
