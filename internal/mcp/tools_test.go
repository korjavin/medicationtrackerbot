package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func setupFoodMCPTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()

	st, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test store: %v", err)
	}

	s := &Server{
		config: &Config{
			MaxQueryDays: 90,
			UserID:       123456,
		},
		data: st,
	}

	return s, st
}

func TestHandleGetFoodIntakeIncludesTargetWhenConfigured(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("failed to enable food intake: %v", err)
	}
	if err := st.SetFoodTargets(ctx, store.FoodTargets{
		Calories: 2200,
		Carbs:    250,
		Protein:  150,
		Fat:      70,
	}); err != nil {
		t.Fatalf("failed to set food targets: %v", err)
	}

	_, err := st.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Date(2026, 2, 18, 8, 30, 0, 0, time.Local),
		Name:     "Oatmeal",
		Weight:   200,
		Calories: 320,
		Carbs:    52,
		Protein:  12,
		Fat:      8,
	})
	if err != nil {
		t.Fatalf("failed to create food log: %v", err)
	}

	_, resp, err := s.handleGetFoodIntake(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetFoodIntake returned error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 log, got %d", resp.Count)
	}
	if resp.Target == nil {
		t.Fatal("expected target to be present when configured")
	}
	if resp.Target.Calories != 2200 || resp.Target.Carbs != 250 || resp.Target.Protein != 150 || resp.Target.Fat != 70 {
		t.Fatalf("unexpected target values: %+v", *resp.Target)
	}
}

func TestHandleGetFoodIntakeOmitsTargetWhenNotConfigured(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("failed to enable food intake: %v", err)
	}

	_, err := st.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Date(2026, 2, 19, 13, 0, 0, 0, time.Local),
		Name:     "Chicken",
		Weight:   180,
		Calories: 300,
		Carbs:    0,
		Protein:  55,
		Fat:      8,
	})
	if err != nil {
		t.Fatalf("failed to create food log: %v", err)
	}

	_, resp, err := s.handleGetFoodIntake(ctx, nil, DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetFoodIntake returned error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 log, got %d", resp.Count)
	}
	if resp.Target != nil {
		t.Fatalf("expected target to be omitted when not configured, got %+v", *resp.Target)
	}
}

func TestHandleGetFoodIntakeAcceptsCamelCaseDates(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("failed to enable food intake: %v", err)
	}

	_, err := st.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Date(2026, 2, 19, 9, 0, 0, 0, time.Local),
		Name:     "Yogurt",
		Weight:   150,
		Calories: 140,
		Carbs:    12,
		Protein:  10,
		Fat:      5,
	})
	if err != nil {
		t.Fatalf("failed to create food log: %v", err)
	}

	req := &sdkmcp.CallToolRequest{
		Params: &sdkmcp.CallToolParamsRaw{
			Name:      "get_food_intake",
			Arguments: []byte(`{"startDate":"2026-02-18","endDate":"2026-02-19"}`),
		},
	}

	_, resp, err := s.handleGetFoodIntake(ctx, req, DateRangeInput{})
	if err != nil {
		t.Fatalf("handleGetFoodIntake returned error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 log, got %d", resp.Count)
	}
	if resp.Warning == "" {
		t.Fatal("expected compatibility warning for camelCase date fields")
	}
}

// --- handleGetBloodPressure tests ---

func TestHandleGetBloodPressure_WithData(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetBloodPressureEnabled(ctx, true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	pulse := 72
	_, err := st.CreateBloodPressureReading(ctx, &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Date(2026, 2, 18, 9, 0, 0, 0, time.UTC),
		Systolic:   120,
		Diastolic:  80,
		Pulse:      &pulse,
		Category:   "normal",
	})
	if err != nil {
		t.Fatalf("CreateBloodPressureReading: %v", err)
	}

	_, resp, err := s.handleGetBloodPressure(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetBloodPressure error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 reading, got %d", resp.Count)
	}
	r := resp.Readings[0]
	if r.Systolic != 120 {
		t.Errorf("expected systolic 120, got %d", r.Systolic)
	}
	if r.Diastolic != 80 {
		t.Errorf("expected diastolic 80, got %d", r.Diastolic)
	}
	if r.Pulse != 72 {
		t.Errorf("expected pulse 72, got %d", r.Pulse)
	}
}

func TestHandleGetBloodPressure_FeatureDisabled(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetBloodPressureEnabled(ctx, false); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	_, _, err := s.handleGetBloodPressure(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err == nil {
		t.Fatal("expected error when BP feature is disabled")
	}
}

func TestHandleGetBloodPressure_EmptyRange(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetBloodPressureEnabled(ctx, true); err != nil {
		t.Fatalf("SetBloodPressureEnabled: %v", err)
	}

	_, resp, err := s.handleGetBloodPressure(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetBloodPressure error: %v", err)
	}

	if resp.Count != 0 {
		t.Errorf("expected 0 readings for empty range, got %d", resp.Count)
	}
	if resp.Warning == "" {
		t.Error("expected a warning when no readings found")
	}
}

// --- handleGetWeight tests ---

func TestHandleGetWeight_WithData(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	_, err := st.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     123456,
		MeasuredAt: time.Date(2026, 2, 18, 8, 0, 0, 0, time.UTC),
		Weight:     75.5,
	})
	if err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}

	_, resp, err := s.handleGetWeight(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetWeight error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 weight log, got %d", resp.Count)
	}
	if resp.Logs[0].Weight != 75.5 {
		t.Errorf("expected weight 75.5, got %f", resp.Logs[0].Weight)
	}
}

func TestHandleGetWeight_FeatureDisabled(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetWeightEnabled(ctx, false); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	_, _, err := s.handleGetWeight(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err == nil {
		t.Fatal("expected error when weight feature is disabled")
	}
}

// --- handleGetMedicationIntake tests ---

func TestHandleGetMedicationIntake_WithData(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	medID, err := st.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	scheduledAt := time.Date(2026, 2, 18, 8, 0, 0, 0, time.UTC)
	intakeID, err := st.CreateIntake(medID, 123456, scheduledAt)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}
	if err := st.ConfirmIntake(intakeID, scheduledAt); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}

	_, resp, err := s.handleGetMedicationIntake(ctx, nil, MedicationIntakeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetMedicationIntake error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 intake, got %d", resp.Count)
	}
	if resp.Intakes[0].MedicationName != "Aspirin" {
		t.Errorf("expected medication name 'Aspirin', got %q", resp.Intakes[0].MedicationName)
	}
	if resp.Intakes[0].Status != "TAKEN" {
		t.Errorf("expected status 'TAKEN', got %q", resp.Intakes[0].Status)
	}
}

func TestHandleGetMedicationIntake_FilterByName(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	// Create two medications
	med1ID, _ := st.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "")
	med2ID, _ := st.CreateMedication("Ibuprofen", "200mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "")

	scheduledAt := time.Date(2026, 2, 18, 8, 0, 0, 0, time.UTC)
	id1, _ := st.CreateIntake(med1ID, 123456, scheduledAt)
	id2, _ := st.CreateIntake(med2ID, 123456, scheduledAt)
	st.ConfirmIntake(id1, scheduledAt)
	st.ConfirmIntake(id2, scheduledAt)

	_, resp, err := s.handleGetMedicationIntake(ctx, nil, MedicationIntakeInput{
		StartDate:      "2026-02-17",
		EndDate:        "2026-02-19",
		MedicationName: "aspirin",
	})
	if err != nil {
		t.Fatalf("handleGetMedicationIntake error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 intake after name filter, got %d", resp.Count)
	}
	if resp.Intakes[0].MedicationName != "Aspirin" {
		t.Errorf("expected 'Aspirin', got %q", resp.Intakes[0].MedicationName)
	}
}

func TestHandleGetMedicationIntake_FeatureDisabled(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetMedicationEnabled(ctx, false); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	_, _, err := s.handleGetMedicationIntake(ctx, nil, MedicationIntakeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err == nil {
		t.Fatal("expected error when medication feature is disabled")
	}
}
