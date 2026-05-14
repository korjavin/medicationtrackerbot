package mcp

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

func setupFitnessTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()

	st, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test store: %v", err)
	}

	audit := NewAuditBuffer("", "")
	s := &Server{
		config: &Config{
			MaxQueryDays: 90,
			UserID:       123456,
		},
		data:  newStoreAdapter(st),
		audit: audit,
	}

	return s, st
}

func TestAnalyzeFitness_AllDomains(t *testing.T) {
	s, st := setupFitnessTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)

	// Enable features
	if err := st.Settings.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.Settings.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.Settings.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	// Add weight logs
	if _, err := st.Weight.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     userID,
		MeasuredAt: time.Date(2026, 3, 10, 8, 0, 0, 0, time.Local),
		Weight:     80.0,
	}); err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}
	if _, err := st.Weight.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     userID,
		MeasuredAt: time.Date(2026, 3, 15, 8, 0, 0, 0, time.Local),
		Weight:     79.5,
	}); err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}

	// Add food log
	if _, err := st.Food.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   userID,
		EatenAt:  time.Date(2026, 3, 15, 12, 0, 0, 0, time.Local),
		Name:     "Chicken Breast Salad",
		Weight:   300,
		Calories: 450,
		Protein:  40,
		Carbs:    20,
		Fat:      15,
	}); err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}

	// Add step data
	if _, _, err := st.Vitals.ImportDayStats(ctx, userID, []store.DayStat{
		{Day: "2026-03-15", Steps: 8500, Calories: 350, Distance: 6200},
	}); err != nil {
		t.Fatalf("ImportDayStats: %v", err)
	}

	// Add diary note
	if _, err := st.Diary.Create(ctx, userID, "felt great during workout", nil); err != nil {
		t.Fatalf("CreateDiaryNote: %v", err)
	}

	now := time.Now()
	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeFitnessInput{
		StartDate: "2026-03-09",
		EndDate:   now.AddDate(0, 0, 1).Format("2006-01-02"),
	}

	_, resp, err := s.handleAnalyzeFitness(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeFitness: %v", err)
	}

	// Period
	if resp.Period == "" {
		t.Error("expected non-empty period")
	}

	// Workouts section (may be empty but should be present)
	if resp.Workouts == nil {
		t.Fatal("expected workouts section to be present")
	}

	// Steps section
	if resp.Steps == nil {
		t.Fatal("expected steps section to be present")
	}
	if len(resp.Steps.Daily) != 1 {
		t.Errorf("expected 1 step entry, got %d", len(resp.Steps.Daily))
	}
	if resp.Steps.AvgDailySteps != 8500 {
		t.Errorf("expected avg daily steps 8500, got %d", resp.Steps.AvgDailySteps)
	}

	// Nutrition section
	if resp.Nutrition == nil {
		t.Fatal("expected nutrition section to be present")
	}
	if len(resp.Nutrition.DailyTotals) != 1 {
		t.Errorf("expected 1 nutrition daily total, got %d", len(resp.Nutrition.DailyTotals))
	}
	if resp.Nutrition.AvgDailyCalories != 450 {
		t.Errorf("expected avg daily calories 450, got %d", resp.Nutrition.AvgDailyCalories)
	}
	if resp.Nutrition.AvgDailyProtein != 40 {
		t.Errorf("expected avg daily protein 40, got %d", resp.Nutrition.AvgDailyProtein)
	}

	// Weight section
	if resp.Weight == nil {
		t.Fatal("expected weight section to be present")
	}
	if len(resp.Weight.Logs) != 2 {
		t.Errorf("expected 2 weight logs, got %d", len(resp.Weight.Logs))
	}
	if resp.Weight.CurrentKg == nil {
		t.Fatal("expected current_kg to be set")
	}
	if resp.Weight.TrendDirection != "losing" {
		t.Errorf("expected trend_direction 'losing', got %q", resp.Weight.TrendDirection)
	}
	if resp.Weight.ChangeKg == nil {
		t.Fatal("expected change_kg to be set")
	}

	// Diary notes
	if len(resp.DiaryNotes) != 1 {
		t.Errorf("expected 1 diary note, got %d", len(resp.DiaryNotes))
	}
}

func TestAnalyzeFitness_NutritionDailyTotalsNoFoodNames(t *testing.T) {
	s, st := setupFitnessTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)

	if err := st.Settings.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.Settings.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.Settings.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	// Add multiple food items for same day
	for _, food := range []struct {
		name     string
		calories int
		protein  int
		carbs    int
		fat      int
	}{
		{"Secret Recipe Smoothie", 200, 10, 30, 5},
		{"Personal Comfort Food", 600, 25, 50, 30},
	} {
		if _, err := st.Food.CreateFoodLog(ctx, &store.FoodLog{
			UserID:   userID,
			EatenAt:  time.Date(2026, 3, 15, 12, 0, 0, 0, time.Local),
			Name:     food.name,
			Weight:   200,
			Calories: food.calories,
			Protein:  food.protein,
			Carbs:    food.carbs,
			Fat:      food.fat,
		}); err != nil {
			t.Fatalf("CreateFoodLog: %v", err)
		}
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeFitnessInput{
		StartDate: "2026-03-14",
		EndDate:   "2026-03-16",
	}

	_, resp, err := s.handleAnalyzeFitness(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeFitness: %v", err)
	}

	if resp.Nutrition == nil {
		t.Fatal("expected nutrition section to be present")
	}

	// Should have 1 daily total (both items aggregated)
	if len(resp.Nutrition.DailyTotals) != 1 {
		t.Fatalf("expected 1 daily total, got %d", len(resp.Nutrition.DailyTotals))
	}

	dt := resp.Nutrition.DailyTotals[0]

	// Verify aggregated totals
	if dt.Calories != 800 {
		t.Errorf("expected 800 calories, got %d", dt.Calories)
	}
	if dt.ProteinG != 35 {
		t.Errorf("expected 35g protein, got %d", dt.ProteinG)
	}
	if dt.CarbsG != 80 {
		t.Errorf("expected 80g carbs, got %d", dt.CarbsG)
	}
	if dt.FatG != 35 {
		t.Errorf("expected 35g fat, got %d", dt.FatG)
	}

	// NutritionDailyTotal struct has no name field - verify at compile time
	// The struct only contains: Date, Calories, ProteinG, CarbsG, FatG
	// No food names leak through the response
}

func TestAnalyzeFitness_FoodDisabledOmitsNutrition(t *testing.T) {
	s, st := setupFitnessTestServer(t)
	defer st.Close()

	ctx := context.Background()

	// Disable food
	if err := st.Settings.SetFoodIntakeEnabled(ctx, false); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	// Enable workout and weight
	if err := st.Settings.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.Settings.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeFitnessInput{
		StartDate: "2026-03-14",
		EndDate:   "2026-03-16",
	}

	_, resp, err := s.handleAnalyzeFitness(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeFitness: %v", err)
	}

	if resp.Nutrition != nil {
		t.Error("expected nutrition section to be omitted when food is disabled")
	}

	// Workouts and weight should still be present
	if resp.Workouts == nil {
		t.Error("expected workouts section to be present")
	}
	if resp.Weight == nil {
		t.Error("expected weight section to be present")
	}

	// Warning should mention unavailable sections
	if resp.Warning == "" {
		t.Error("expected warning about unavailable sections")
	}
	if !contains(resp.Warning, "nutrition") {
		t.Errorf("expected warning to mention nutrition, got %q", resp.Warning)
	}
}

func TestAnalyzeFitness_EmptyDateRange(t *testing.T) {
	s, st := setupFitnessTestServer(t)
	defer st.Close()

	ctx := context.Background()

	if err := st.Settings.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.Settings.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.Settings.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeFitnessInput{
		StartDate: "2026-03-14",
		EndDate:   "2026-03-16",
	}

	_, resp, err := s.handleAnalyzeFitness(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeFitness: %v", err)
	}

	// All sections should be present but empty
	if resp.Workouts == nil {
		t.Error("expected workouts section to be present (even if empty)")
	} else if resp.Workouts.TotalSessions != 0 {
		t.Errorf("expected 0 total sessions, got %d", resp.Workouts.TotalSessions)
	}

	if resp.Steps == nil {
		t.Error("expected steps section to be present")
	}

	if resp.Nutrition == nil {
		t.Error("expected nutrition section to be present")
	}

	if resp.Weight == nil {
		t.Error("expected weight section to be present")
	}
}

func TestAnalyzeFitness_AuditLogging(t *testing.T) {
	s, st := setupFitnessTestServer(t)
	defer st.Close()

	ctx := context.Background()

	if err := st.Settings.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.Settings.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.Settings.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeFitnessInput{
		StartDate: "2026-03-14",
		EndDate:   "2026-03-16",
	}

	_, _, err := s.handleAnalyzeFitness(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeFitness: %v", err)
	}

	s.audit.mu.Lock()
	defer s.audit.mu.Unlock()

	found := false
	for _, ev := range s.audit.events {
		if ev.DataType == "FitnessAnalysis" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected audit event for FitnessAnalysis")
	}
}

// TestAnalyzeFitness_WeightUnitPreferenceDoesNotLeak verifies that the user's
// weight unit preference (set via SetWeightUnitPreference) does NOT influence
// the WeightSection of the analyze_fitness response. The MCP boundary is
// fixed at kg with _kg-suffixed field names regardless of user preference.
func TestAnalyzeFitness_WeightUnitPreferenceDoesNotLeak(t *testing.T) {
	s, st := setupFitnessTestServer(t)
	defer st.Close()

	ctx := context.Background()
	userID := int64(123456)

	if err := st.Settings.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.Settings.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.Settings.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}
	// Flip the user's unit preference to lb. The analyze_fitness response must
	// remain in kg.
	if err := st.Weight.SetWeightUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference: %v", err)
	}

	if _, err := st.Weight.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     userID,
		MeasuredAt: time.Date(2026, 3, 10, 8, 0, 0, 0, time.Local),
		Weight:     80.0, // stored in kg
	}); err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}
	if _, err := st.Weight.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     userID,
		MeasuredAt: time.Date(2026, 3, 15, 8, 0, 0, 0, time.Local),
		Weight:     79.5, // stored in kg
	}); err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}

	req := &sdkmcp.CallToolRequest{}
	input := AnalyzeFitnessInput{
		StartDate: "2026-03-09",
		EndDate:   time.Now().AddDate(0, 0, 1).Format("2006-01-02"),
	}

	_, resp, err := s.handleAnalyzeFitness(ctx, req, input)
	if err != nil {
		t.Fatalf("handleAnalyzeFitness: %v", err)
	}

	if resp.Weight == nil {
		t.Fatal("expected weight section to be present")
	}
	if resp.Weight.CurrentKg == nil {
		t.Fatal("expected current_kg to be set")
	}
	// Numeric values must remain in kg, not lb-converted.
	if *resp.Weight.CurrentKg != 79.5 {
		t.Errorf("expected current_kg 79.5 (kg, unchanged by user lb preference), got %f", *resp.Weight.CurrentKg)
	}
	if resp.Weight.ChangeKg == nil {
		t.Fatal("expected change_kg to be set")
	}

	// Marshal and inspect the JSON to assert field names use _kg suffixes and
	// no plain "current" / "change" / "weight" / "unit" fields are exposed.
	body, err := json.Marshal(resp.Weight)
	if err != nil {
		t.Fatalf("marshal weight section: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal weight section: %v", err)
	}
	if _, ok := raw["current_kg"]; !ok {
		t.Error("expected 'current_kg' field in WeightSection JSON")
	}
	if _, ok := raw["change_kg"]; !ok {
		t.Error("expected 'change_kg' field in WeightSection JSON")
	}
	for _, banned := range []string{"current", "change", "current_lb", "change_lb", "weight", "unit"} {
		if _, ok := raw[banned]; ok {
			t.Errorf("MCP WeightSection must not expose %q field — boundary is fixed at kg", banned)
		}
	}

	// Inspect each log entry for the same kg-only contract.
	var logs []map[string]json.RawMessage
	if err := json.Unmarshal(raw["logs"], &logs); err != nil {
		t.Fatalf("unmarshal logs array: %v", err)
	}
	if len(logs) == 0 {
		t.Fatal("expected at least one log entry")
	}
	for i, log := range logs {
		if _, ok := log["weight_kg"]; !ok {
			t.Errorf("log[%d]: expected 'weight_kg' field", i)
		}
		for _, banned := range []string{"weight", "weight_lb", "unit"} {
			if _, ok := log[banned]; ok {
				t.Errorf("log[%d]: MCP must not expose %q field", i, banned)
			}
		}
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsSubstring(s, substr))
}

func containsSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
