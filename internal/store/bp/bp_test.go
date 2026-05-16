package bp

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

// stubTZ implements TimezoneLookup for tests that need a non-UTC timezone.
type stubTZ struct{ tz string }

func (s stubTZ) GetCurrent() (string, error) { return s.tz, nil }

// setupBPRepo creates an in-memory DB with all migrations and a BP repo
// bound to UTC (the tz lookup returns the empty string, so
// GetDailyWeightedStats falls back to time.UTC).
func setupBPRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(d, stubTZ{tz: ""})
}

func intPtr(i int) *int { return &i }

func TestCalculateBPCategory(t *testing.T) {
	tests := []struct {
		name      string
		systolic  int
		diastolic int
		expected  string
	}{
		{"Normal low", 110, 70, "Normal"},
		{"Normal boundary systolic", 119, 79, "Normal"},
		{"Elevated lower bound", 120, 75, "Elevated"},
		{"Elevated upper bound", 129, 79, "Elevated"},
		{"Elevated not if diastolic high", 125, 80, "High BP Stage 1"},
		{"Stage 1 systolic", 130, 75, "High BP Stage 1"},
		{"Stage 1 diastolic", 115, 80, "High BP Stage 1"},
		{"Stage 1 both", 135, 85, "High BP Stage 1"},
		{"Stage 1 upper systolic", 139, 89, "High BP Stage 1"},
		{"Stage 2 systolic", 140, 75, "High BP Stage 2"},
		{"Stage 2 diastolic", 115, 90, "High BP Stage 2"},
		{"Stage 2 both", 150, 95, "High BP Stage 2"},
		{"Crisis systolic", 181, 70, "Hypertensive Crisis"},
		{"Crisis diastolic", 115, 121, "Hypertensive Crisis"},
		{"Crisis both", 185, 125, "Hypertensive Crisis"},
		{"Crisis boundary systolic", 180, 70, "High BP Stage 2"},
		{"Crisis boundary diastolic", 115, 120, "High BP Stage 2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CalculateBPCategory(tt.systolic, tt.diastolic)
			if got != tt.expected {
				t.Errorf("CalculateBPCategory(%d, %d) = %q, want %q", tt.systolic, tt.diastolic, got, tt.expected)
			}
		})
	}
}

func TestCreateReading(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()

	t.Run("auto-calculates category when empty", func(t *testing.T) {
		reading := &BloodPressure{
			UserID:     123,
			MeasuredAt: time.Now(),
			Systolic:   135,
			Diastolic:  85,
			Pulse:      intPtr(72),
		}
		id, err := r.CreateReading(ctx, reading)
		if err != nil {
			t.Fatalf("CreateReading() error = %v", err)
		}
		if id == 0 {
			t.Fatal("expected non-zero ID")
		}

		readings, err := r.ListReadings(ctx, 123, time.Time{})
		if err != nil {
			t.Fatalf("ListReadings() error = %v", err)
		}
		if len(readings) != 1 {
			t.Fatalf("expected 1 reading, got %d", len(readings))
		}
		if readings[0].Category != "High BP Stage 1" {
			t.Errorf("expected category %q, got %q", "High BP Stage 1", readings[0].Category)
		}
	})

	t.Run("IgnoreCalc preserves empty category", func(t *testing.T) {
		reading := &BloodPressure{
			UserID:     123,
			MeasuredAt: time.Now(),
			Systolic:   150,
			Diastolic:  95,
			IgnoreCalc: true,
		}
		_, err := r.CreateReading(ctx, reading)
		if err != nil {
			t.Fatalf("CreateReading() error = %v", err)
		}
		if reading.Category != "" {
			t.Errorf("expected empty category with IgnoreCalc, got %q", reading.Category)
		}
	})

	t.Run("explicit category is preserved", func(t *testing.T) {
		reading := &BloodPressure{
			UserID:     123,
			MeasuredAt: time.Now(),
			Systolic:   115,
			Diastolic:  75,
			Category:   "Custom Category",
		}
		_, err := r.CreateReading(ctx, reading)
		if err != nil {
			t.Fatalf("CreateReading() error = %v", err)
		}

		readings, err := r.ListReadings(ctx, 123, time.Time{})
		if err != nil {
			t.Fatalf("ListReadings() error = %v", err)
		}

		var found bool
		for _, rd := range readings {
			if rd.Category == "Custom Category" {
				found = true
				break
			}
		}
		if !found {
			t.Error("explicit category was not preserved")
		}
	})
}

func TestListReadings(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(456)

	now := time.Now()
	readings := []BloodPressure{
		{UserID: userID, MeasuredAt: now.Add(-3 * time.Hour), Systolic: 120, Diastolic: 80},
		{UserID: userID, MeasuredAt: now.Add(-2 * time.Hour), Systolic: 130, Diastolic: 85},
		{UserID: userID, MeasuredAt: now.Add(-1 * time.Hour), Systolic: 115, Diastolic: 75},
	}

	for i := range readings {
		_, err := r.CreateReading(ctx, &readings[i])
		if err != nil {
			t.Fatalf("failed to create reading %d: %v", i, err)
		}
	}

	t.Run("get all readings with zero time", func(t *testing.T) {
		result, err := r.ListReadings(ctx, userID, time.Time{})
		if err != nil {
			t.Fatalf("ListReadings() error = %v", err)
		}
		if len(result) != 3 {
			t.Fatalf("expected 3 readings, got %d", len(result))
		}
		if result[0].Systolic != 115 {
			t.Errorf("expected first reading systolic=115 (most recent), got %d", result[0].Systolic)
		}
		if result[2].Systolic != 120 {
			t.Errorf("expected last reading systolic=120 (oldest), got %d", result[2].Systolic)
		}
	})

	t.Run("get readings with since filter", func(t *testing.T) {
		since := now.Add(-90 * time.Minute)
		result, err := r.ListReadings(ctx, userID, since)
		if err != nil {
			t.Fatalf("ListReadings() error = %v", err)
		}
		if len(result) != 1 {
			t.Fatalf("expected 1 reading since %v, got %d", since, len(result))
		}
		if result[0].Systolic != 115 {
			t.Errorf("expected systolic=115, got %d", result[0].Systolic)
		}
	})

	t.Run("get readings for different user returns empty", func(t *testing.T) {
		result, err := r.ListReadings(ctx, 999, time.Time{})
		if err != nil {
			t.Fatalf("ListReadings() error = %v", err)
		}
		if len(result) != 0 {
			t.Errorf("expected 0 readings for non-existent user, got %d", len(result))
		}
	})
}

func TestDeleteReading(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(789)

	reading := &BloodPressure{
		UserID:     userID,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}
	id, err := r.CreateReading(ctx, reading)
	if err != nil {
		t.Fatalf("failed to create reading: %v", err)
	}

	t.Run("delete with correct user succeeds", func(t *testing.T) {
		err := r.DeleteReading(ctx, id, userID)
		if err != nil {
			t.Fatalf("DeleteReading() error = %v", err)
		}

		readings, err := r.ListReadings(ctx, userID, time.Time{})
		if err != nil {
			t.Fatalf("ListReadings() error = %v", err)
		}
		if len(readings) != 0 {
			t.Errorf("expected 0 readings after delete, got %d", len(readings))
		}
	})

	t.Run("delete with wrong user returns ErrNoRows", func(t *testing.T) {
		reading2 := &BloodPressure{
			UserID:     userID,
			MeasuredAt: time.Now(),
			Systolic:   130,
			Diastolic:  85,
		}
		id2, err := r.CreateReading(ctx, reading2)
		if err != nil {
			t.Fatalf("failed to create reading: %v", err)
		}

		err = r.DeleteReading(ctx, id2, 999)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Errorf("expected sql.ErrNoRows for wrong user, got %v", err)
		}
	})

	t.Run("delete non-existent reading returns ErrNoRows", func(t *testing.T) {
		err := r.DeleteReading(ctx, 99999, userID)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Errorf("expected sql.ErrNoRows for non-existent reading, got %v", err)
		}
	})
}

func TestImportReadings(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(321)

	t.Run("import multiple readings", func(t *testing.T) {
		now := time.Now()
		readings := []BloodPressure{
			{Systolic: 120, Diastolic: 80, MeasuredAt: now.Add(-3 * time.Hour), Category: "Normal"},
			{Systolic: 135, Diastolic: 87, MeasuredAt: now.Add(-2 * time.Hour), Category: "High BP Stage 1"},
			{Systolic: 145, Diastolic: 92, MeasuredAt: now.Add(-1 * time.Hour), Category: "High BP Stage 2"},
		}

		err := r.ImportReadings(ctx, userID, readings)
		if err != nil {
			t.Fatalf("ImportReadings() error = %v", err)
		}

		result, err := r.ListReadings(ctx, userID, time.Time{})
		if err != nil {
			t.Fatalf("ListReadings() error = %v", err)
		}
		if len(result) != 3 {
			t.Fatalf("expected 3 imported readings, got %d", len(result))
		}
	})

	t.Run("import empty slice succeeds", func(t *testing.T) {
		err := r.ImportReadings(ctx, userID, []BloodPressure{})
		if err != nil {
			t.Fatalf("ImportReadings() with empty slice error = %v", err)
		}
	})
}

func TestBPGoal(t *testing.T) {
	r := setupBPRepo(t)

	t.Run("get goal returns empty when not set", func(t *testing.T) {
		goal, err := r.GetGoal()
		if err != nil {
			t.Fatalf("GetGoal() error = %v", err)
		}
		if goal.TargetSystolic != nil || goal.TargetDiastolic != nil {
			t.Errorf("expected empty BPGoal, got systolic=%v diastolic=%v", goal.TargetSystolic, goal.TargetDiastolic)
		}
	})

	t.Run("set and get goal", func(t *testing.T) {
		err := r.SetGoal(125, 80)
		if err != nil {
			t.Fatalf("SetGoal() error = %v", err)
		}

		goal, err := r.GetGoal()
		if err != nil {
			t.Fatalf("GetGoal() error = %v", err)
		}
		if goal.TargetSystolic == nil || *goal.TargetSystolic != 125 {
			t.Errorf("expected target systolic 125, got %v", goal.TargetSystolic)
		}
		if goal.TargetDiastolic == nil || *goal.TargetDiastolic != 80 {
			t.Errorf("expected target diastolic 80, got %v", goal.TargetDiastolic)
		}
	})

	t.Run("set goal overwrites previous", func(t *testing.T) {
		err := r.SetGoal(130, 85)
		if err != nil {
			t.Fatalf("SetGoal() error = %v", err)
		}

		goal, err := r.GetGoal()
		if err != nil {
			t.Fatalf("GetGoal() error = %v", err)
		}
		if goal.TargetSystolic == nil || *goal.TargetSystolic != 130 {
			t.Errorf("expected target systolic 130, got %v", goal.TargetSystolic)
		}
		if goal.TargetDiastolic == nil || *goal.TargetDiastolic != 85 {
			t.Errorf("expected target diastolic 85, got %v", goal.TargetDiastolic)
		}
	})
}
