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
		store: st,
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
