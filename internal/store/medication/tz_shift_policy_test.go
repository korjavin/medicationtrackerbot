package medication

import (
	"testing"
)

// These four tests cover the tz_shift_policy column round-trip on the
// medications table via Create / Update / Get /
// List. They originated in store_tz_transition_test.go and stayed
// with the medication repo when the rest of that file moved to
// internal/store/tz/ in Task 11.

func TestMedicationTZShiftPolicyDefaultsToFlexible(t *testing.T) {
	s := setupMedicationRepo(t)

	id, err := s.Create("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	med, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if med.TZShiftPolicy != "flexible" {
		t.Errorf("expected TZShiftPolicy=flexible, got %q", med.TZShiftPolicy)
	}
}

func TestMedicationTZShiftPolicyRoundTrip(t *testing.T) {
	s := setupMedicationRepo(t)

	id, err := s.Create("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "strict")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	med, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if med.TZShiftPolicy != "strict" {
		t.Errorf("expected TZShiftPolicy=strict after create, got %q", med.TZShiftPolicy)
	}

	// Update to medium
	if err := s.Update(id, "TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, false, nil, nil, "", "", nil, "medium"); err != nil {
		t.Fatalf("Update: %v", err)
	}

	med, err = s.Get(id)
	if err != nil {
		t.Fatalf("Get after update: %v", err)
	}
	if med.TZShiftPolicy != "medium" {
		t.Errorf("expected TZShiftPolicy=medium after update, got %q", med.TZShiftPolicy)
	}
}

func TestListMedicationsIncludesTZShiftPolicy(t *testing.T) {
	s := setupMedicationRepo(t)

	if _, err := s.Create("MedA", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "flexible"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := s.Create("MedB", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "strict"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	meds, err := s.List(false)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(meds) != 2 {
		t.Fatalf("expected 2 meds, got %d", len(meds))
	}

	policies := map[string]string{}
	for _, m := range meds {
		policies[m.Name] = m.TZShiftPolicy
	}
	if policies["MedA"] != "flexible" {
		t.Errorf("MedA: expected flexible, got %q", policies["MedA"])
	}
	if policies["MedB"] != "strict" {
		t.Errorf("MedB: expected strict, got %q", policies["MedB"])
	}
}
