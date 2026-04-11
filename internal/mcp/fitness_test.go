package mcp

import (
	"context"
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
		data:  st,
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
	if err := st.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.SetWeightEnabled(ctx, true); err != nil {
		t.Fatalf("SetWeightEnabled: %v", err)
	}

	// Add weight logs
	if _, err := st.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     userID,
		MeasuredAt: time.Date(2026, 3, 10, 8, 0, 0, 0, time.Local),
		Weight:     80.0,
	}); err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}
	if _, err := st.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     userID,
		MeasuredAt: time.Date(2026, 3, 15, 8, 0, 0, 0, time.Local),
		Weight:     79.5,
	}); err != nil {
		t.Fatalf("CreateWeightLog: %v", err)
	}

	// Add food log
	if _, err := st.CreateFoodLog(ctx, &store.FoodLog{
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
	if _, _, err := st.ImportDayStats(ctx, userID, []store.DayStat{
		{Day: "2026-03-15", Steps: 8500, Calories: 350, Distance: 6200},
	}); err != nil {
		t.Fatalf("ImportDayStats: %v", err)
	}

	// Add diary note
	if _, err := st.CreateDiaryNote(ctx, userID, "felt great during workout"); err != nil {
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

	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.SetWeightEnabled(ctx, true); err != nil {
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
		if _, err := st.CreateFoodLog(ctx, &store.FoodLog{
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
	if err := st.SetFoodIntakeEnabled(ctx, false); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	// Enable workout and weight
	if err := st.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.SetWeightEnabled(ctx, true); err != nil {
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

	if err := st.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.SetWeightEnabled(ctx, true); err != nil {
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

	if err := st.SetWorkoutEnabled(ctx, true); err != nil {
		t.Fatalf("SetWorkoutEnabled: %v", err)
	}
	if err := st.SetFoodIntakeEnabled(ctx, true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}
	if err := st.SetWeightEnabled(ctx, true); err != nil {
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
