package store

import (
	"context"
	"testing"
)

func setupWeightUnitPrefTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestStore_WeightUnitPreference_DefaultIsKg(t *testing.T) {
	s := setupWeightUnitPrefTestStore(t)
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
	s := setupWeightUnitPrefTestStore(t)
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
	s := setupWeightUnitPrefTestStore(t)
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
	s := setupWeightUnitPrefTestStore(t)
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
