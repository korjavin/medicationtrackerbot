package tzreschedule_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// helper: parse "HH:MM" schedule JSON
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

var baseNow = time.Date(2026, 1, 15, 10, 0, 0, 0, time.UTC)

func med(id int64, name, schedule, policy string) store.Medication {
	return store.Medication{
		ID:            id,
		Name:          name,
		Schedule:      schedule,
		TZShiftPolicy: policy,
		Archived:      false,
	}
}

func TestGeneratePlan_NoChangeWhenOffsetsEqual(t *testing.T) {
	// Berlin in January: UTC+1. Vienna in January: UTC+1. Same offset → no steps.
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(1, "Metformin", dailySchedule("08:00", "20:00"), "flexible"),
		},
		OldTZ: "Europe/Berlin",
		NewTZ: "Europe/Vienna",
		Now:   baseNow,
	}
	steps, summary, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(steps) != 0 {
		t.Errorf("expected 0 steps, got %d (offsets are equal)", len(steps))
	}
	if summary.Direction != "no-change" {
		t.Errorf("expected no-change direction, got %q", summary.Direction)
	}
}

func TestGeneratePlan_AsNeededSkipped(t *testing.T) {
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(2, "Paracetamol", asNeededSchedule(), "strict"),
		},
		OldTZ: "Europe/Berlin",
		NewTZ: "Asia/Tokyo", // UTC+9 vs UTC+1 → +8h
		Now:   baseNow,
	}
	steps, _, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(steps) != 0 {
		t.Errorf("as-needed meds should be skipped, got %d steps", len(steps))
	}
}

func TestGeneratePlan_WeeklySkippedForFlexible(t *testing.T) {
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(3, "VitaminD", weeklySchedule([]int{0, 3}, "09:00"), "flexible"),
		},
		OldTZ: "Europe/Berlin",
		NewTZ: "Asia/Tokyo",
		Now:   baseNow,
	}
	steps, _, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(steps) != 0 {
		t.Errorf("weekly med with flexible policy should be skipped, got %d steps", len(steps))
	}
}

func TestGeneratePlan_WeeklyIncludedForStrict(t *testing.T) {
	// Weekly med with strict policy should generate steps.
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(4, "WeeklyMed", weeklySchedule([]int{1}, "09:00"), "strict"),
		},
		OldTZ: "Europe/London",    // UTC+0 in Jan
		NewTZ: "America/New_York", // UTC-5 in Jan → delta = -5h
		Now:   baseNow,
	}
	steps, summary, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.Direction != "westbound" {
		t.Errorf("expected westbound, got %q", summary.Direction)
	}
	if len(steps) == 0 {
		t.Error("expected steps for weekly med with strict policy")
	}
}

func TestGeneratePlan_FlexibleSingleStep(t *testing.T) {
	// Flexible: entire +6h shift in one step.
	lastIntake := baseNow.Add(-8 * time.Hour) // 8h ago
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(5, "Lisinopril", dailySchedule("08:00"), "flexible"),
		},
		OldTZ:                   "Europe/London", // UTC+0 Jan
		NewTZ:                   "Asia/Dhaka",    // UTC+6 Jan → +6h eastbound
		Now:                     baseNow,
		LastIntakePerMedication: map[int64]time.Time{5: lastIntake},
	}
	steps, summary, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.Direction != "eastbound" {
		t.Errorf("expected eastbound, got %q", summary.Direction)
	}
	if len(steps) != 1 {
		t.Errorf("flexible policy: expected 1 step, got %d", len(steps))
	}
}

func TestGeneratePlan_MediumEastbound6h(t *testing.T) {
	// Medium policy, +6h offset: max 3h/step → 2 steps.
	lastIntake := baseNow.Add(-12 * time.Hour)
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(6, "Metoprolol", dailySchedule("08:00"), "medium"),
		},
		OldTZ:                   "Europe/London",
		NewTZ:                   "Asia/Dhaka", // UTC+6
		Now:                     baseNow,
		LastIntakePerMedication: map[int64]time.Time{6: lastIntake},
	}
	steps, summary, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.Direction != "eastbound" {
		t.Errorf("expected eastbound, got %q", summary.Direction)
	}
	if len(steps) != 2 {
		t.Errorf("medium policy +6h: expected 2 steps, got %d", len(steps))
	}
}

func TestGeneratePlan_StrictEastbound6h(t *testing.T) {
	// Strict policy, +6h offset: max 2h/step → 3 steps.
	lastIntake := baseNow.Add(-12 * time.Hour)
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(7, "Warfarin", dailySchedule("08:00"), "strict"),
		},
		OldTZ:                   "Europe/London",
		NewTZ:                   "Asia/Dhaka", // UTC+6
		Now:                     baseNow,
		LastIntakePerMedication: map[int64]time.Time{7: lastIntake},
	}
	steps, _, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(steps) != 3 {
		t.Errorf("strict policy +6h: expected 3 steps, got %d", len(steps))
	}
}

func TestGeneratePlan_StrictWestbound6h(t *testing.T) {
	// Strict policy, -6h offset (westbound): max 2h/step → 3 steps.
	lastIntake := baseNow.Add(-12 * time.Hour)
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(8, "Amlodipine", dailySchedule("08:00"), "strict"),
		},
		OldTZ:                   "Asia/Dhaka",    // UTC+6
		NewTZ:                   "Europe/London", // UTC+0 → -6h westbound
		Now:                     baseNow,
		LastIntakePerMedication: map[int64]time.Time{8: lastIntake},
	}
	steps, summary, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.Direction != "westbound" {
		t.Errorf("expected westbound, got %q", summary.Direction)
	}
	if len(steps) != 3 {
		t.Errorf("strict policy -6h: expected 3 steps, got %d", len(steps))
	}
}

func TestGeneratePlan_HardConstraintMinInterval(t *testing.T) {
	// Eastbound with strict: each step interval must be >= 70% of nominal.
	// For a 24h interval, min = 16.8h.
	lastIntake := baseNow.Add(-24 * time.Hour)
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(9, "Digoxin", dailySchedule("08:00"), "strict"),
		},
		OldTZ:                   "Europe/London",
		NewTZ:                   "Asia/Dhaka", // +6h
		Now:                     baseNow,
		LastIntakePerMedication: map[int64]time.Time{9: lastIntake},
	}
	steps, _, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(steps) == 0 {
		t.Fatal("expected steps")
	}
	nomInterval := 24 * time.Hour
	minInterval := tzreschedule.MinDoseInterval(24.0, tzreschedule.PolicyStrict)
	// Check consecutive step gaps.
	prevAt := lastIntake
	for _, s := range steps {
		gap := s.ScheduledAt.Sub(prevAt)
		if gap < minInterval {
			t.Errorf("step %d: gap %v < min interval %v (%.0f%% of %v)", s.StepNumber, gap, minInterval, 70.0, nomInterval)
		}
		prevAt = s.ScheduledAt
	}
}

func TestGeneratePlan_HardConstraintMaxInterval(t *testing.T) {
	// Westbound with flexible: gap should never exceed 200% of nominal interval.
	lastIntake := baseNow.Add(-24 * time.Hour)
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(10, "Ramipril", dailySchedule("08:00"), "flexible"),
		},
		OldTZ:                   "Asia/Dhaka",    // UTC+6
		NewTZ:                   "Europe/London", // UTC+0 → -6h
		Now:                     baseNow,
		LastIntakePerMedication: map[int64]time.Time{10: lastIntake},
	}
	steps, _, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	maxInterval := tzreschedule.MaxDoseInterval(24.0, tzreschedule.PolicyFlexible)
	prevAt := lastIntake
	for _, s := range steps {
		gap := s.ScheduledAt.Sub(prevAt)
		if gap > maxInterval {
			t.Errorf("step %d: gap %v > max interval %v", s.StepNumber, gap, maxInterval)
		}
		prevAt = s.ScheduledAt
	}
}

func TestGeneratePlan_ArchivedMedSkipped(t *testing.T) {
	archivedMed := med(11, "OldMed", dailySchedule("08:00"), "strict")
	archivedMed.Archived = true
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{archivedMed},
		OldTZ:       "Europe/London",
		NewTZ:       "Asia/Dhaka",
		Now:         baseNow,
	}
	steps, _, err := tzreschedule.GeneratePlan(input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(steps) != 0 {
		t.Errorf("archived meds should be skipped, got %d steps", len(steps))
	}
}

func TestInputsJSON_Roundtrip(t *testing.T) {
	input := tzreschedule.PlanInput{
		Medications: []store.Medication{
			med(1, "TestMed", dailySchedule("09:00"), "medium"),
		},
		OldTZ: "Europe/Berlin",
		NewTZ: "Asia/Tokyo",
		Now:   baseNow,
		LastIntakePerMedication: map[int64]time.Time{
			1: baseNow.Add(-8 * time.Hour),
		},
	}
	s1, err := tzreschedule.InputsJSON(input)
	if err != nil {
		t.Fatalf("InputsJSON: %v", err)
	}
	s2, err := tzreschedule.InputsJSON(input)
	if err != nil {
		t.Fatalf("InputsJSON second call: %v", err)
	}
	if s1 != s2 {
		t.Errorf("InputsJSON is not deterministic: %q vs %q", s1, s2)
	}
}

func TestPolicyConstants(t *testing.T) {
	tests := []struct {
		name         string
		policy       tzreschedule.Policy
		expectMax    time.Duration
		intervalH    float64
		expectMinPct float64
		expectMaxPct float64
	}{
		{"flexible", tzreschedule.PolicyFlexible, 24 * time.Hour, 24.0, 0.60, 2.00},
		{"medium", tzreschedule.PolicyMedium, 3 * time.Hour, 24.0, 0.65, 1.75},
		{"strict", tzreschedule.PolicyStrict, 2 * time.Hour, 24.0, 0.70, 1.50},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			max := tzreschedule.MaxShiftPerDose(tc.policy)
			if max != tc.expectMax {
				t.Errorf("MaxShiftPerDose: got %v, want %v", max, tc.expectMax)
			}
			base := time.Duration(tc.intervalH * float64(time.Hour))
			minI := tzreschedule.MinDoseInterval(tc.intervalH, tc.policy)
			maxI := tzreschedule.MaxDoseInterval(tc.intervalH, tc.policy)
			expectedMin := time.Duration(float64(base) * tc.expectMinPct)
			expectedMax := time.Duration(float64(base) * tc.expectMaxPct)
			if minI != expectedMin {
				t.Errorf("MinDoseInterval: got %v, want %v", minI, expectedMin)
			}
			if maxI != expectedMax {
				t.Errorf("MaxDoseInterval: got %v, want %v", maxI, expectedMax)
			}
		})
	}
}

func TestNormalizePolicy(t *testing.T) {
	if tzreschedule.NormalizePolicy("") != tzreschedule.PolicyFlexible {
		t.Error("empty string should default to flexible")
	}
	if tzreschedule.NormalizePolicy("unknown") != tzreschedule.PolicyFlexible {
		t.Error("unknown string should default to flexible")
	}
	if tzreschedule.NormalizePolicy("medium") != tzreschedule.PolicyMedium {
		t.Error("'medium' should return PolicyMedium")
	}
	if tzreschedule.NormalizePolicy("strict") != tzreschedule.PolicyStrict {
		t.Error("'strict' should return PolicyStrict")
	}
}
