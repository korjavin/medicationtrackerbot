package store

import (
	"context"
	"testing"
	"time"
)

func setupSettingsTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestFeatureFlags(t *testing.T) {
	db := setupSettingsTestStore(t)
	ctx := context.Background()

	tests := []struct {
		name       string
		getter     func(context.Context) (bool, error)
		setter     func(context.Context, bool) error
		defaultVal bool
	}{
		{"FoodIntake", db.GetFoodIntakeEnabled, db.SetFoodIntakeEnabled, false},
		{"BloodPressure", db.GetBloodPressureEnabled, db.SetBloodPressureEnabled, true},
		{"Weight", db.GetWeightEnabled, db.SetWeightEnabled, true},
		{"Medication", db.GetMedicationEnabled, db.SetMedicationEnabled, true},
		{"Workout", db.GetWorkoutEnabled, db.SetWorkoutEnabled, true},
		{"Health", db.GetHealthEnabled, db.SetHealthEnabled, true},
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

func TestLastDownload(t *testing.T) {
	db := setupSettingsTestStore(t)

	// Set a download time
	now := time.Now().Truncate(time.Second)
	err := db.UpdateLastDownload(now)
	if err != nil {
		t.Fatalf("UpdateLastDownload: %v", err)
	}

	// Retrieve it
	last, err := db.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after update: %v", err)
	}
	diff := last.Sub(now)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", now, last, diff)
	}

	// Update again
	later := now.Add(time.Hour)
	err = db.UpdateLastDownload(later)
	if err != nil {
		t.Fatalf("UpdateLastDownload again: %v", err)
	}

	last, err = db.GetLastDownload()
	if err != nil {
		t.Fatalf("GetLastDownload after second update: %v", err)
	}
	diff = last.Sub(later)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("Expected %v, got %v (diff: %v)", later, last, diff)
	}
}

func TestStore_TabOrder(t *testing.T) {
	s := setupSettingsTestStore(t)
	defer s.Close()
	ctx := context.Background()

	// Initial value should be empty
	order, err := s.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != "" {
		t.Fatalf("expected empty string, got %s", order)
	}

	// Update the order
	err = s.SetTabOrder(ctx, `["tab1", "tab2"]`)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	// Verify the update
	order, err = s.GetTabOrder(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if order != `["tab1", "tab2"]` {
		t.Fatalf("expected '[\"tab1\", \"tab2\"]', got %s", order)
	}
}

func TestStore_WeightUnitPreference_DefaultIsKg(t *testing.T) {
	s := setupSettingsTestStore(t)
	ctx := context.Background()

	unit, err := s.GetWeightUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if unit != "kg" {
		t.Fatalf("expected default 'kg', got %q", unit)
	}
}

func TestStore_WeightUnitPreference_SetAndGet(t *testing.T) {
	s := setupSettingsTestStore(t)
	ctx := context.Background()

	if err := s.SetWeightUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference(lb): %v", err)
	}
	unit, err := s.GetWeightUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if unit != "lb" {
		t.Fatalf("expected 'lb', got %q", unit)
	}

	if err := s.SetWeightUnitPreference(ctx, "kg"); err != nil {
		t.Fatalf("SetWeightUnitPreference(kg): %v", err)
	}
	unit, err = s.GetWeightUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetWeightUnitPreference after set kg: %v", err)
	}
	if unit != "kg" {
		t.Fatalf("expected 'kg', got %q", unit)
	}
}

func TestStore_WeightUnitPreference_RejectsInvalid(t *testing.T) {
	s := setupSettingsTestStore(t)
	ctx := context.Background()

	cases := []string{"", "lbs", "KG", "pounds", "stone", "g"}
	for _, c := range cases {
		if err := s.SetWeightUnitPreference(ctx, c); err == nil {
			t.Errorf("expected SetWeightUnitPreference(%q) to fail, got nil", c)
		}
	}

	// Confirm preference unchanged after invalid attempts.
	unit, err := s.GetWeightUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if unit != "kg" {
		t.Fatalf("expected default 'kg' to be preserved, got %q", unit)
	}
}

func TestStore_WeightUnitPreference_PersistsAcrossReads(t *testing.T) {
	s := setupSettingsTestStore(t)
	ctx := context.Background()

	if err := s.SetWeightUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference: %v", err)
	}
	for i := 0; i < 3; i++ {
		unit, err := s.GetWeightUnitPreference(ctx)
		if err != nil {
			t.Fatalf("GetWeightUnitPreference iteration %d: %v", i, err)
		}
		if unit != "lb" {
			t.Fatalf("iteration %d: expected 'lb', got %q", i, unit)
		}
	}
}
