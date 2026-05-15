package weight

import (
	"context"
	"testing"
)

func TestWeightUnitPreference_DefaultIsKg(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	unit, err := r.GetUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetUnitPreference: %v", err)
	}
	if unit != "kg" {
		t.Fatalf("expected default 'kg', got %q", unit)
	}
}

func TestWeightUnitPreference_SetAndGet(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	if err := r.SetUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetUnitPreference(lb): %v", err)
	}
	unit, err := r.GetUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetUnitPreference: %v", err)
	}
	if unit != "lb" {
		t.Fatalf("expected 'lb', got %q", unit)
	}

	if err := r.SetUnitPreference(ctx, "kg"); err != nil {
		t.Fatalf("SetUnitPreference(kg): %v", err)
	}
	unit, err = r.GetUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetUnitPreference after set kg: %v", err)
	}
	if unit != "kg" {
		t.Fatalf("expected 'kg', got %q", unit)
	}
}

func TestWeightUnitPreference_RejectsInvalid(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	cases := []string{"", "lbs", "KG", "pounds", "stone", "g"}
	for _, c := range cases {
		if err := r.SetUnitPreference(ctx, c); err == nil {
			t.Errorf("expected SetUnitPreference(%q) to fail, got nil", c)
		}
	}

	// Confirm preference unchanged after invalid attempts.
	unit, err := r.GetUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetUnitPreference: %v", err)
	}
	if unit != "kg" {
		t.Fatalf("expected default 'kg' to be preserved, got %q", unit)
	}
}

func TestWeightUnitPreference_PersistsAcrossReads(t *testing.T) {
	r := setupWeightRepo(t)
	ctx := context.Background()

	if err := r.SetUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetUnitPreference: %v", err)
	}
	for i := 0; i < 3; i++ {
		unit, err := r.GetUnitPreference(ctx)
		if err != nil {
			t.Fatalf("GetUnitPreference iteration %d: %v", i, err)
		}
		if unit != "lb" {
			t.Fatalf("iteration %d: expected 'lb', got %q", i, unit)
		}
	}
}
