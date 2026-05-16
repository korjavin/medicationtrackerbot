package medplan_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/medplan"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func dailySchedule(times ...string) string {
	cfg := store.ScheduleConfig{Type: "daily", Times: times}
	b, _ := json.Marshal(cfg)
	return string(b)
}

func weeklySchedule(days []int, times ...string) string {
	cfg := store.ScheduleConfig{Type: "weekly", Days: days, Times: times}
	b, _ := json.Marshal(cfg)
	return string(b)
}

func asNeededSchedule() string {
	cfg := store.ScheduleConfig{Type: "as_needed"}
	b, _ := json.Marshal(cfg)
	return string(b)
}

func med(id int64, name, schedule, policy string) store.Medication {
	return store.Medication{
		ID:            id,
		Name:          name,
		Schedule:      schedule,
		TZShiftPolicy: policy,
		Archived:      false,
	}
}

// Each subtest is a self-contained scenario, not a table row, because the
// rules under test interact: a single bug in PlanDoses would otherwise
// hide behind a shared assertion helper.

func TestPlanDoses_FireMode_NoPlan(t *testing.T) {
	now := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{
			med(1, "Aspirin", dailySchedule("09:00", "21:00"), "flexible"),
		},
		UserLoc: time.UTC,
		Now:     now,
	})

	if len(out) != 1 {
		t.Fatalf("want 1 target (today's 09:00), got %d: %+v", len(out), out)
	}
	wantTime := time.Date(2024, 3, 15, 9, 0, 0, 0, time.UTC)
	if !out[0].ScheduledAt.Equal(wantTime) {
		t.Errorf("target = %v, want %v", out[0].ScheduledAt, wantTime)
	}
	if out[0].Source != medplan.SourceNormalSchedule {
		t.Errorf("source = %v, want SourceNormalSchedule", out[0].Source)
	}
}

func TestPlanDoses_FireMode_SkipsFuture(t *testing.T) {
	// 21:00 dose is two hours away — must not appear in fire mode.
	now := time.Date(2024, 3, 15, 19, 0, 0, 0, time.UTC)
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{med(1, "Aspirin", dailySchedule("21:00"), "flexible")},
		UserLoc:     time.UTC,
		Now:         now,
	})
	if len(out) != 0 {
		t.Errorf("fire-mode must not include future targets, got %+v", out)
	}
}

func TestPlanDoses_ForecastMode_PicksUpcoming(t *testing.T) {
	now := time.Date(2024, 3, 15, 8, 0, 0, 0, time.UTC)
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{
			med(1, "Aspirin", dailySchedule("09:00", "21:00"), "flexible"),
		},
		UserLoc: time.UTC,
		Now:     now,
		Window:  12 * time.Hour,
	})
	if len(out) != 1 {
		t.Fatalf("want 1 upcoming target inside 12h window, got %d: %+v", len(out), out)
	}
	want := time.Date(2024, 3, 15, 9, 0, 0, 0, time.UTC)
	if !out[0].ScheduledAt.Equal(want) {
		t.Errorf("target = %v, want %v", out[0].ScheduledAt, want)
	}
}

func TestPlanDoses_ForecastMode_DropsOutsideWindow(t *testing.T) {
	// 21:00 dose is 13h away — outside the 12h window.
	now := time.Date(2024, 3, 15, 8, 0, 0, 0, time.UTC)
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{
			med(1, "Aspirin", dailySchedule("21:00"), "flexible"),
		},
		UserLoc: time.UTC,
		Now:     now,
		Window:  12 * time.Hour,
	})
	if len(out) != 0 {
		t.Errorf("13h-away target must be outside 12h window, got %+v", out)
	}
}

// The legacy ConsumedStepTimeByMed overlap-guard tests were removed in Task
// 11 of the medication-scheduling simplification plan. The overlap guard
// itself moved out of medplan and into the medication scheduler, where it
// is now a symmetric ±minInterval dedup against intake_log rows. The
// integration tests in internal/scheduler/medication_tz_test.go (the
// "westbound" and "completed plan overlap guard" cases) pin that behaviour
// end-to-end through the scheduler tick rather than the pure planner.
//
// Track D Task 13 also removed the PendingSteps input. Pre-materialized
// step rows live as PENDING source='tz_step' intake_log rows and are
// unioned in at the scheduler and forecast layers — medplan is now purely
// normal-schedule.

func TestPlanDoses_FinishedCourseSkipped(t *testing.T) {
	now := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
	endedYesterday := now.Add(-24 * time.Hour)
	finished := med(1, "OldCourse", dailySchedule("09:00"), "flexible")
	finished.EndDate = &endedYesterday
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{finished},
		UserLoc:     time.UTC,
		Now:         now,
	})
	if len(out) != 0 {
		t.Errorf("finished course must not produce targets, got %+v", out)
	}
}

func TestPlanDoses_FutureCourseSkipped(t *testing.T) {
	now := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
	startsTomorrow := now.Add(24 * time.Hour)
	future := med(1, "Pending", dailySchedule("09:00"), "flexible")
	future.StartDate = &startsTomorrow
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{future},
		UserLoc:     time.UTC,
		Now:         now,
	})
	if len(out) != 0 {
		t.Errorf("future-start course must not produce targets, got %+v", out)
	}
}

func TestPlanDoses_AsNeededSkipped(t *testing.T) {
	now := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{med(1, "Paracetamol", asNeededSchedule(), "flexible")},
		UserLoc:     time.UTC,
		Now:         now,
		Window:      24 * time.Hour,
	})
	if len(out) != 0 {
		t.Errorf("as-needed meds must not produce targets, got %+v", out)
	}
}

func TestPlanDoses_WeeklyOnlyOnAllowedDays(t *testing.T) {
	// 2024-03-15 is a Friday (Weekday=5). cfg allows only Wednesday(3)
	// and Saturday(6) → no targets today.
	fri := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{med(1, "Weekly", weeklySchedule([]int{3, 6}, "09:00"), "flexible")},
		UserLoc:     time.UTC,
		Now:         fri,
	})
	if len(out) != 0 {
		t.Errorf("weekly med on a non-allowed weekday must not emit, got %+v", out)
	}

	// Same med checked on Saturday (Weekday=6) inside fire window — must emit.
	sat := time.Date(2024, 3, 16, 9, 5, 0, 0, time.UTC)
	out = medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{med(1, "Weekly", weeklySchedule([]int{3, 6}, "09:00"), "flexible")},
		UserLoc:     time.UTC,
		Now:         sat,
	})
	if len(out) != 1 {
		t.Errorf("weekly med on allowed weekday must emit, got %+v", out)
	}
}

func TestPlanDoses_StableSortByTimeThenMedID(t *testing.T) {
	// Two meds with simultaneous targets: sort by med ID for determinism.
	now := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
	out := medplan.PlanDoses(medplan.Inputs{
		Medications: []store.Medication{
			med(2, "B", dailySchedule("09:00"), "flexible"),
			med(1, "A", dailySchedule("09:00"), "flexible"),
		},
		UserLoc: time.UTC,
		Now:     now,
	})
	if len(out) != 2 {
		t.Fatalf("want 2 targets, got %d", len(out))
	}
	if out[0].MedicationID != 1 || out[1].MedicationID != 2 {
		t.Errorf("expected sort order (med 1, med 2), got (%d, %d)", out[0].MedicationID, out[1].MedicationID)
	}
}
