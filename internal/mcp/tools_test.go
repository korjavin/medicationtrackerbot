package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestHandleGetDiaryNotesReturnsNotes(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()

	// Create two notes within range and one outside
	if _, err := st.CreateDiaryNote(ctx, 123456, "feeling great today"); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}
	if _, err := st.CreateDiaryNote(ctx, 123456, "a bit tired"); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	now := time.Now()
	_, resp, err := s.handleGetDiaryNotes(ctx, nil, DiaryNoteInput{
		StartDate: now.AddDate(0, 0, -7).Format("2006-01-02"),
		EndDate:   now.AddDate(0, 0, 1).Format("2006-01-02"),
	})
	if err != nil {
		t.Fatalf("handleGetDiaryNotes returned error: %v", err)
	}

	if resp.Count != 2 {
		t.Fatalf("expected 2 notes, got %d", resp.Count)
	}
	// Notes are newest first; check content
	found := map[string]bool{}
	for _, n := range resp.Notes {
		found[n.Content] = true
		if n.ID == 0 {
			t.Error("expected non-zero ID")
		}
		if n.CreatedAt == "" {
			t.Error("expected non-empty CreatedAt")
		}
	}
	if !found["feeling great today"] || !found["a bit tired"] {
		t.Fatalf("unexpected note contents: %+v", resp.Notes)
	}
}

func TestHandleGetDiaryNotesEmptyRange(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()

	_, resp, err := s.handleGetDiaryNotes(ctx, nil, DiaryNoteInput{
		StartDate: "2026-01-01",
		EndDate:   "2026-01-31",
	})
	if err != nil {
		t.Fatalf("handleGetDiaryNotes returned error: %v", err)
	}
	if resp.Count != 0 {
		t.Fatalf("expected 0 notes, got %d", resp.Count)
	}
	if resp.Warning == "" {
		t.Fatal("expected warning for empty result set")
	}
}

func TestHandleGetDiaryNotesDefaultLimit(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()

	if _, err := st.CreateDiaryNote(ctx, 123456, "note one"); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	_, resp, err := s.handleGetDiaryNotes(ctx, nil, DiaryNoteInput{})
	if err != nil {
		t.Fatalf("handleGetDiaryNotes returned error: %v", err)
	}
	if resp.Count != 1 {
		t.Fatalf("expected 1 note, got %d", resp.Count)
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

	medID, err := st.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
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
	med1ID, _ := st.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	med2ID, _ := st.CreateMedication("Ibuprofen", "200mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")

	scheduledAt := time.Date(2026, 2, 18, 8, 0, 0, 0, time.UTC)
	id1, _ := st.CreateIntake(med1ID, 123456, scheduledAt)
	id2, _ := st.CreateIntake(med2ID, 123456, scheduledAt)
	_ = st.ConfirmIntake(id1, scheduledAt) // #nosec G104
	_ = st.ConfirmIntake(id2, scheduledAt) // #nosec G104

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

// --- handleGetWorkoutHistory tests ---

func TestHandleGetWorkoutHistory_WithData(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}

	group, err := st.CreateWorkoutGroup("Push Day", "chest/shoulders/triceps", false, 123456, "[1]", "08:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	order := 0
	variant, err := st.CreateWorkoutVariant(group.ID, "Heavy", &order, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}

	scheduledDate := time.Date(2026, 2, 18, 0, 0, 0, 0, time.UTC)
	session, err := st.CreateWorkoutSession(group.ID, variant.ID, 123456, scheduledDate, "08:00")
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	if err := st.CompleteSession(session.ID); err != nil {
		t.Fatalf("CompleteSession: %v", err)
	}

	_, resp, err := s.handleGetWorkoutHistory(ctx, nil, WorkoutHistoryInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetWorkoutHistory error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 session, got %d", resp.Count)
	}
	if resp.Sessions[0].GroupName != "Push Day" {
		t.Errorf("expected GroupName 'Push Day', got %q", resp.Sessions[0].GroupName)
	}
	if resp.Sessions[0].VariantName != "Heavy" {
		t.Errorf("expected VariantName 'Heavy', got %q", resp.Sessions[0].VariantName)
	}
	if resp.Sessions[0].Status != "completed" {
		t.Errorf("expected status 'completed', got %q", resp.Sessions[0].Status)
	}
}

func TestHandleGetWorkoutHistory_FeatureDisabled(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetWorkoutEnabled(ctx, false); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}

	_, _, err := s.handleGetWorkoutHistory(ctx, nil, WorkoutHistoryInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err == nil {
		t.Fatal("expected error when workout feature is disabled")
	}
}

func TestHandleGetWorkoutHistory_EmptyRange(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}

	_, resp, err := s.handleGetWorkoutHistory(ctx, nil, WorkoutHistoryInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetWorkoutHistory error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected 0 sessions for empty range, got %d", resp.Count)
	}
	if resp.Warning == "" {
		t.Error("expected a warning when no sessions found")
	}
}

// --- handleGetSleepLogs tests ---

func TestHandleGetSleepLogs_WithData(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	total := 480
	deep := 90
	log := store.SleepLog{
		UserID:       123456,
		StartTime:    time.Date(2026, 2, 18, 22, 30, 0, 0, time.UTC),
		EndTime:      time.Date(2026, 2, 19, 6, 30, 0, 0, time.UTC),
		Day:          "2026-02-18",
		TotalMinutes: &total,
		DeepMinutes:  &deep,
	}
	if _, _, err := st.ImportSleepLogs(ctx, 123456, []store.SleepLog{log}); err != nil {
		t.Fatalf("ImportSleepLogs: %v", err)
	}

	_, resp, err := s.handleGetSleepLogs(ctx, nil, DateRangeInput{
		StartDate: "2026-02-18",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetSleepLogs error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 sleep log, got %d", resp.Count)
	}
	if resp.Logs[0].TotalMinutes == nil || *resp.Logs[0].TotalMinutes != 480 {
		t.Errorf("expected TotalMinutes=480, got %v", resp.Logs[0].TotalMinutes)
	}
	if resp.Logs[0].DeepMinutes == nil || *resp.Logs[0].DeepMinutes != 90 {
		t.Errorf("expected DeepMinutes=90, got %v", resp.Logs[0].DeepMinutes)
	}
}

func TestHandleGetSleepLogs_EmptyRange(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()

	_, resp, err := s.handleGetSleepLogs(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetSleepLogs error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected 0 logs, got %d", resp.Count)
	}
	if resp.Warning == "" {
		t.Error("expected a warning when no sleep logs found")
	}
}

// --- handleGetStepHistory tests ---

func TestHandleGetStepHistory_WithData(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	stat := store.DayStat{
		UserID:   123456,
		Day:      "2026-02-18",
		Steps:    8500,
		Calories: 320,
		Distance: 6200,
	}
	if _, _, err := st.ImportDayStats(ctx, 123456, []store.DayStat{stat}); err != nil {
		t.Fatalf("ImportDayStats: %v", err)
	}

	_, resp, err := s.handleGetStepHistory(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetStepHistory error: %v", err)
	}

	if resp.Count != 1 {
		t.Fatalf("expected 1 stat, got %d", resp.Count)
	}
	if resp.Logs[0].Steps != 8500 {
		t.Errorf("expected Steps=8500, got %d", resp.Logs[0].Steps)
	}
	if resp.Logs[0].Calories != 320 {
		t.Errorf("expected Calories=320, got %d", resp.Logs[0].Calories)
	}
	if resp.Logs[0].Distance != 6200 {
		t.Errorf("expected Distance=6200, got %d", resp.Logs[0].Distance)
	}
}

func TestHandleGetStepHistory_EmptyRange(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()

	_, resp, err := s.handleGetStepHistory(ctx, nil, DateRangeInput{
		StartDate: "2026-02-17",
		EndDate:   "2026-02-19",
	})
	if err != nil {
		t.Fatalf("handleGetStepHistory error: %v", err)
	}
	if resp.Count != 0 {
		t.Errorf("expected 0 stats, got %d", resp.Count)
	}
	if resp.Warning == "" {
		t.Error("expected a warning when no step data found")
	}
}

// --- handleLogFoodIntake tests ---

// fakeFoodLogServer creates a test HTTP server that responds to food log requests.
// It stores the last decoded payload and returns the given ID.
func fakeFoodLogServer(t *testing.T, returnID int64) (*httptest.Server, *foodLogPayload) {
	t.Helper()
	var captured foodLogPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p foodLogPayload
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			http.Error(w, "bad payload", http.StatusBadRequest)
			return
		}
		captured = p
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]int64{"id": returnID})
	}))
	return srv, &captured
}

func TestHandleLogFoodIntake_Success(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	fakeSrv, captured := fakeFoodLogServer(t, 42)
	defer fakeSrv.Close()
	s.foodWriter = NewFoodWriter(fakeSrv.URL, "test-secret")

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	_, resp, err := s.handleLogFoodIntake(ctx, nil, LogFoodIntakeInput{
		Name:     "Pasta Carbonara",
		EatenAt:  "2026-02-18 13:00",
		Calories: 650,
		CarbsG:   80,
		ProteinG: 25,
		FatG:     22,
		WeightG:  300,
	})
	if err != nil {
		t.Fatalf("handleLogFoodIntake error: %v", err)
	}
	if resp.ID != 42 {
		t.Errorf("expected ID=42, got %d", resp.ID)
	}
	if resp.Message == "" {
		t.Error("expected non-empty message")
	}

	// Verify payload was forwarded correctly
	if captured.Name != "Pasta Carbonara" {
		t.Errorf("expected forwarded name 'Pasta Carbonara', got %q", captured.Name)
	}
	if captured.Calories != 650 {
		t.Errorf("expected forwarded calories 650, got %d", captured.Calories)
	}
}

func TestHandleLogFoodIntake_RFC3339(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	fakeSrv, _ := fakeFoodLogServer(t, 7)
	defer fakeSrv.Close()
	s.foodWriter = NewFoodWriter(fakeSrv.URL, "test-secret")

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	_, resp, err := s.handleLogFoodIntake(ctx, nil, LogFoodIntakeInput{
		Name:     "Salad",
		EatenAt:  "2026-02-19T12:30:00Z",
		Calories: 200,
		CarbsG:   15,
		ProteinG: 8,
		FatG:     10,
		WeightG:  150,
	})
	if err != nil {
		t.Fatalf("handleLogFoodIntake RFC3339 error: %v", err)
	}
	if resp.ID != 7 {
		t.Errorf("expected ID=7, got %d", resp.ID)
	}
}

func TestHandleLogFoodIntake_WriterNotConfigured(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	// foodWriter is nil (not configured)
	_, _, err := s.handleLogFoodIntake(ctx, nil, LogFoodIntakeInput{
		Name:    "Burger",
		EatenAt: "2026-02-18 19:00",
	})
	if err == nil {
		t.Fatal("expected error when foodWriter is nil")
	}
}

func TestHandleLogFoodIntake_FeatureDisabled(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	fakeSrv, _ := fakeFoodLogServer(t, 1)
	defer fakeSrv.Close()
	s.foodWriter = NewFoodWriter(fakeSrv.URL, "test-secret")

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, false); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	_, _, err := s.handleLogFoodIntake(ctx, nil, LogFoodIntakeInput{
		Name:    "Burger",
		EatenAt: "2026-02-18 19:00",
	})
	if err == nil {
		t.Fatal("expected error when food feature is disabled")
	}
}

func TestHandleLogFoodIntake_MissingName(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	fakeSrv, _ := fakeFoodLogServer(t, 1)
	defer fakeSrv.Close()
	s.foodWriter = NewFoodWriter(fakeSrv.URL, "test-secret")

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	_, _, err := s.handleLogFoodIntake(ctx, nil, LogFoodIntakeInput{
		EatenAt:  "2026-02-18 13:00",
		Calories: 500,
	})
	if err == nil {
		t.Fatal("expected error when name is missing")
	}
}

func TestHandleLogFoodIntake_InvalidDate(t *testing.T) {
	s, st := setupFoodMCPTestServer(t)
	defer st.Close()

	fakeSrv, _ := fakeFoodLogServer(t, 1)
	defer fakeSrv.Close()
	s.foodWriter = NewFoodWriter(fakeSrv.URL, "test-secret")

	ctx := context.Background()
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	_, _, err := s.handleLogFoodIntake(ctx, nil, LogFoodIntakeInput{
		Name:    "Pizza",
		EatenAt: "not-a-date",
	})
	if err == nil {
		t.Fatal("expected error for invalid date")
	}
}

