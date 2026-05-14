package settings

import (
	"context"
	"strings"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/migrations"
)

func setupSettingsRepo(t *testing.T) *Repo {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := d.Migrate(migrations.FS, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return New(d)
}

func TestFeatureFlags(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	tests := []struct {
		name       string
		getter     func(context.Context) (bool, error)
		setter     func(context.Context, bool) error
		defaultVal bool
	}{
		{"FoodIntake", r.GetFoodIntakeEnabled, r.SetFoodIntakeEnabled, false},
		{"BloodPressure", r.GetBloodPressureEnabled, r.SetBloodPressureEnabled, true},
		{"Weight", r.GetWeightEnabled, r.SetWeightEnabled, true},
		{"Medication", r.GetMedicationEnabled, r.SetMedicationEnabled, true},
		{"Workout", r.GetWorkoutEnabled, r.SetWorkoutEnabled, true},
		{"Health", r.GetHealthEnabled, r.SetHealthEnabled, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Default value
			val, err := tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s: %v", tt.name, err)
			}
			if val != tt.defaultVal {
				t.Errorf("Expected default %v for %s, got %v", tt.defaultVal, tt.name, val)
			}

			// Toggle to opposite
			if err := tt.setter(ctx, !tt.defaultVal); err != nil {
				t.Fatalf("Set %s to %v: %v", tt.name, !tt.defaultVal, err)
			}
			val, err = tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s after toggle: %v", tt.name, err)
			}
			if val != !tt.defaultVal {
				t.Errorf("Expected %v for %s after toggle", !tt.defaultVal, tt.name)
			}

			// Toggle back
			if err := tt.setter(ctx, tt.defaultVal); err != nil {
				t.Fatalf("Set %s to %v: %v", tt.name, tt.defaultVal, err)
			}
			val, err = tt.getter(ctx)
			if err != nil {
				t.Fatalf("Get %s after toggle back: %v", tt.name, err)
			}
			if val != tt.defaultVal {
				t.Errorf("Expected %v for %s after toggle back", tt.defaultVal, tt.name)
			}
		})
	}
}

func TestGetBool_RejectsUnknownColumn(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	if _, err := r.GetBool(ctx, "definitely_not_a_column"); err == nil {
		t.Fatalf("expected GetBool with unknown column to fail")
	}
	if err := r.SetBool(ctx, "definitely_not_a_column", true); err == nil {
		t.Fatalf("expected SetBool with unknown column to fail")
	}
}

// TestSettingsBoolValidation guards the SQL-injection allowlist on the
// generic GetBool/SetBool helpers. The private-helper version of this test
// lived in internal/store/store_validation_test.go before the per-domain
// split; carrying it here keeps the allowlist contract under test.
func TestSettingsBoolValidation(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	// Test valid columns
	validColumns := []string{
		"food_intake_enabled",
		"blood_pressure_enabled",
		"weight_enabled",
		"medication_enabled",
		"workout_enabled",
		"health_enabled",
	}

	for _, col := range validColumns {
		err := r.SetBool(ctx, col, true)
		if err != nil {
			t.Errorf("Expected success for setting %s, got: %v", col, err)
		}

		val, err := r.GetBool(ctx, col)
		if err != nil {
			t.Errorf("Expected success for getting %s, got: %v", col, err)
		}
		if !val {
			t.Errorf("Expected %s to be true, got false", col)
		}
	}

	// Test invalid columns (SQL Injection attempts)
	invalidColumns := []string{
		"invalid_column",
		"1; DROP TABLE settings",
		"food_intake_enabled; SELECT 1",
		"",
	}

	for _, col := range invalidColumns {
		err := r.SetBool(ctx, col, true)
		if err == nil {
			t.Errorf("Expected error for setting invalid column %q, but got nil", col)
		} else if !strings.Contains(err.Error(), "unknown settings column") {
			t.Errorf("Expected 'unknown settings column' error, got: %v", err)
		}

		_, err = r.GetBool(ctx, col)
		if err == nil {
			t.Errorf("Expected error for getting invalid column %q, but got nil", col)
		} else if !strings.Contains(err.Error(), "unknown settings column") {
			t.Errorf("Expected 'unknown settings column' error, got: %v", err)
		}
	}
}

func TestLastDownload(t *testing.T) {
	r := setupSettingsRepo(t)

	// Set a download time
	now := time.Now().Truncate(time.Second)
	err := r.UpdateLastDownload(now)
	if err != nil {
		t.Fatalf("UpdateLastDownload: %v", err)
	}

	// Retrieve it
	last, err := r.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after update: %v", err)
	}
	diff := last.Sub(now)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", now, last, diff)
	}

	// Update again
	later := now.Add(time.Hour)
	err = r.UpdateLastDownload(later)
	if err != nil {
		t.Fatalf("UpdateLastDownload again: %v", err)
	}

	last, err = r.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after second update: %v", err)
	}
	diff = last.Sub(later)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", later, last, diff)
	}
}

func TestTabOrder(t *testing.T) {
	r := setupSettingsRepo(t)
	ctx := context.Background()

	// Initial value should be empty
	order, err := r.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != "" {
		t.Fatalf("expected empty string, got %s", order)
	}

	// Update the order
	err = r.SetTabOrder(ctx, `["tab1", "tab2"]`)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	// Verify the update
	order, err = r.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != `["tab1", "tab2"]` {
		t.Fatalf("expected '[\"tab1\", \"tab2\"]', got %s", order)
	}
}
