package domain

import (
	"context"
	"errors"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
)

type mockAIClient struct {
	result *ai.MealData
	err    error
}

func (m *mockAIClient) ParseMealFromDescription(ctx context.Context, description string) (*ai.MealData, error) {
	return m.result, m.err
}

func TestParseMealDescription_EmptyDescription(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{})
	_, err := service.ParseMealDescription(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty description")
	}
	if err.Error() != "description cannot be empty" {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestParseMealDescription_APIError(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		err: errors.New("simulated API error"),
	})
	_, err := service.ParseMealDescription(context.Background(), "apple")
	if err == nil {
		t.Fatal("expected error from API")
	}
}

func TestParseMealDescription_NilResult(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		result: nil,
	})
	_, err := service.ParseMealDescription(context.Background(), "apple")
	if err == nil {
		t.Fatal("expected error for nil result")
	}
}

func TestParseMealDescription_Success(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		result: &ai.MealData{
			Name:        "Chicken Breast with Rice",
			WeightGrams: 300,
			Carbs100g:   20,
			Protein100g: 10,
			Fat100g:     2,
		},
	})

	log, err := service.ParseMealDescription(context.Background(), "chicken breast and rice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if log.Name != "Chicken Breast with Rice" {
		t.Errorf("expected Chicken Breast with Rice, got %s", log.Name)
	}
	if log.Weight != 300 {
		t.Errorf("expected weight 300, got %d", log.Weight)
	}
	if log.Carbs != 60 { // (20 * 300) / 100
		t.Errorf("expected carbs 60, got %d", log.Carbs)
	}
	if log.Protein != 30 { // (10 * 300) / 100
		t.Errorf("expected protein 30, got %d", log.Protein)
	}
	if log.Fat != 6 { // (2 * 300) / 100
		t.Errorf("expected fat 6, got %d", log.Fat)
	}
	// Calories = (4 * 60) + (4 * 30) + (9 * 6) = 240 + 120 + 54 = 414
	if log.Calories != 414 {
		t.Errorf("expected calories 414, got %d", log.Calories)
	}
}
