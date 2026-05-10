package domain

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
)

type mockAIClient struct {
	result *ai.ParsedMeal
	err    error

	descriptionCalls int
	imageCalls       int
}

func (m *mockAIClient) ParseMealFromDescription(ctx context.Context, description string) (*ai.ParsedMeal, error) {
	m.descriptionCalls++
	return m.result, m.err
}

func (m *mockAIClient) ParseMealFromImage(ctx context.Context, imageBytes []byte, mimeType string) (*ai.ParsedMeal, error) {
	m.imageCalls++
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

func TestParseMealDescription_EmptyItems(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		result: &ai.ParsedMeal{Items: []ai.MealItem{}},
	})
	_, err := service.ParseMealDescription(context.Background(), "apple")
	if err == nil {
		t.Fatal("expected error when parsed meal has zero items")
	}
}

func TestParseMealDescription_Success_SingleItem(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		result: &ai.ParsedMeal{
			Items: []ai.MealItem{
				{
					Name:        "Chicken Breast",
					WeightGrams: 300,
					Carbs100g:   20,
					Protein100g: 10,
					Fat100g:     2,
				},
			},
		},
	})

	logs, err := service.ParseMealDescription(context.Background(), "300g chicken breast")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}

	log := logs[0]
	if log.Name != "Chicken Breast" {
		t.Errorf("expected Chicken Breast, got %s", log.Name)
	}
	if log.Weight != 300 {
		t.Errorf("expected weight 300, got %d", log.Weight)
	}
	if log.Carbs != 60 {
		t.Errorf("expected carbs 60, got %d", log.Carbs)
	}
	if log.Protein != 30 {
		t.Errorf("expected protein 30, got %d", log.Protein)
	}
	if log.Fat != 6 {
		t.Errorf("expected fat 6, got %d", log.Fat)
	}
	// Calories = (4 * 60) + (4 * 30) + (9 * 6) = 240 + 120 + 54 = 414
	if log.Calories != 414 {
		t.Errorf("expected calories 414, got %d", log.Calories)
	}
}

func TestParseMealDescription_Success_MultipleItems(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		result: &ai.ParsedMeal{
			Items: []ai.MealItem{
				{
					Name:        "Chicken Breast",
					WeightGrams: 200,
					Carbs100g:   0,
					Protein100g: 31,
					Fat100g:     3,
				},
				{
					Name:        "White Rice",
					WeightGrams: 150,
					Carbs100g:   28,
					Protein100g: 2,
					Fat100g:     0,
				},
			},
		},
	})

	logs, err := service.ParseMealDescription(context.Background(), "chicken breast and rice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("expected 2 logs, got %d", len(logs))
	}

	// Preserve input order
	if logs[0].Name != "Chicken Breast" {
		t.Errorf("expected first item Chicken Breast, got %s", logs[0].Name)
	}
	if logs[1].Name != "White Rice" {
		t.Errorf("expected second item White Rice, got %s", logs[1].Name)
	}

	// Chicken: 200g — carbs 0, protein (31*200)/100=62, fat (3*200)/100=6, cals 4*0+4*62+9*6=302
	if logs[0].Weight != 200 || logs[0].Carbs != 0 || logs[0].Protein != 62 || logs[0].Fat != 6 || logs[0].Calories != 302 {
		t.Errorf("chicken macros wrong: %+v", logs[0])
	}

	// Rice: 150g — carbs (28*150)/100=42, protein (2*150)/100=3, fat 0, cals 4*42+4*3+9*0=168+12=180
	if logs[1].Weight != 150 || logs[1].Carbs != 42 || logs[1].Protein != 3 || logs[1].Fat != 0 || logs[1].Calories != 180 {
		t.Errorf("rice macros wrong: %+v", logs[1])
	}
}

func TestParseMealDescription_MissingName(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		result: &ai.ParsedMeal{
			Items: []ai.MealItem{
				{Name: "", WeightGrams: 100, Carbs100g: 10, Protein100g: 5, Fat100g: 2},
			},
		},
	})

	_, err := service.ParseMealDescription(context.Background(), "mystery food")
	if err == nil {
		t.Fatal("expected error for item with empty name")
	}
}

func TestParseMealDescription_NegativeMacros(t *testing.T) {
	cases := []struct {
		name string
		item ai.MealItem
	}{
		{"negative carbs", ai.MealItem{Name: "Thing", WeightGrams: 100, Carbs100g: -1, Protein100g: 0, Fat100g: 0}},
		{"negative protein", ai.MealItem{Name: "Thing", WeightGrams: 100, Carbs100g: 0, Protein100g: -1, Fat100g: 0}},
		{"negative fat", ai.MealItem{Name: "Thing", WeightGrams: 100, Carbs100g: 0, Protein100g: 0, Fat100g: -1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := NewFoodAIService(&mockAIClient{
				result: &ai.ParsedMeal{Items: []ai.MealItem{tc.item}},
			})
			_, err := service.ParseMealDescription(context.Background(), "bad macros")
			if err == nil {
				t.Fatalf("expected error for item with negative macros")
			}
		})
	}
}

func TestNewFoodAIServiceWithVision_RoutesToCorrectClient(t *testing.T) {
	textClient := &mockAIClient{
		result: &ai.ParsedMeal{Items: []ai.MealItem{
			{Name: "Apple", WeightGrams: 100, Carbs100g: 14, Protein100g: 0, Fat100g: 0},
		}},
	}
	visionClient := &mockAIClient{
		result: &ai.ParsedMeal{Items: []ai.MealItem{
			{Name: "Banana", WeightGrams: 120, Carbs100g: 23, Protein100g: 1, Fat100g: 0},
		}},
	}
	service := NewFoodAIServiceWithVision(textClient, visionClient)

	if _, err := service.ParseMealDescription(context.Background(), "an apple"); err != nil {
		t.Fatalf("description: %v", err)
	}
	if _, err := service.ParseMealPhoto(context.Background(), []byte{0x1, 0x2}, "image/jpeg"); err != nil {
		t.Fatalf("photo: %v", err)
	}

	if textClient.descriptionCalls != 1 || textClient.imageCalls != 0 {
		t.Errorf("text client should only see description: desc=%d img=%d", textClient.descriptionCalls, textClient.imageCalls)
	}
	if visionClient.imageCalls != 1 || visionClient.descriptionCalls != 0 {
		t.Errorf("vision client should only see image: desc=%d img=%d", visionClient.descriptionCalls, visionClient.imageCalls)
	}
}

func TestNewFoodAIServiceWithVision_NilVisionFallsBackToText(t *testing.T) {
	textClient := &mockAIClient{
		result: &ai.ParsedMeal{Items: []ai.MealItem{
			{Name: "Apple", WeightGrams: 100, Carbs100g: 14, Protein100g: 0, Fat100g: 0},
		}},
	}
	service := NewFoodAIServiceWithVision(textClient, nil)
	if _, err := service.ParseMealPhoto(context.Background(), []byte{0x1}, "image/jpeg"); err != nil {
		t.Fatalf("photo: %v", err)
	}
	if textClient.imageCalls != 1 {
		t.Errorf("expected fallback to text client, got imageCalls=%d", textClient.imageCalls)
	}
}

func TestParseMealPhoto_ProviderNoVisionErrorIsFriendly(t *testing.T) {
	service := NewFoodAIService(&mockAIClient{
		err: errors.New("API error: Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text` at line 1 column 3663405"),
	})
	_, err := service.ParseMealPhoto(context.Background(), []byte{0x1}, "image/jpeg")
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "does not support photo analysis") || !strings.Contains(msg, "OPENAI_VISION_") {
		t.Errorf("expected friendly error, got: %v", msg)
	}
}

func TestParseMealDescription_NonPositiveWeight(t *testing.T) {
	cases := []struct {
		name   string
		weight float64
	}{
		{"zero", 0},
		{"negative", -10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := NewFoodAIService(&mockAIClient{
				result: &ai.ParsedMeal{
					Items: []ai.MealItem{
						{Name: "Air", WeightGrams: tc.weight, Carbs100g: 0, Protein100g: 0, Fat100g: 0},
					},
				},
			})

			_, err := service.ParseMealDescription(context.Background(), "a whiff of nothing")
			if err == nil {
				t.Fatalf("expected error for item with non-positive weight %v", tc.weight)
			}
		})
	}
}
