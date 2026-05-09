package domain

import (
	"context"
	"fmt"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
)

// FoodAIService defines the interface for parsing meal descriptions, whether
// from natural-language text or a food photograph.
type FoodAIService interface {
	ParseMealDescription(ctx context.Context, description string) ([]FoodLog, error)
	ParseMealPhoto(ctx context.Context, imageBytes []byte, mimeType string) ([]FoodLog, error)
}

// AIClient is an interface describing the methods we need from the AI client,
// making it easier to mock for tests.
type AIClient interface {
	ParseMealFromDescription(ctx context.Context, description string) (*ai.ParsedMeal, error)
	ParseMealFromImage(ctx context.Context, imageBytes []byte, mimeType string) (*ai.ParsedMeal, error)
}

type foodAIService struct {
	client AIClient
}

// NewFoodAIService creates a new FoodAIService using the provided AI client.
func NewFoodAIService(client AIClient) FoodAIService {
	return &foodAIService{
		client: client,
	}
}

func (s *foodAIService) ParseMealDescription(ctx context.Context, description string) ([]FoodLog, error) {
	if description == "" {
		return nil, fmt.Errorf("description cannot be empty")
	}

	parsed, err := s.client.ParseMealFromDescription(ctx, description)
	if err != nil {
		return nil, fmt.Errorf("failed to parse meal description: %w", err)
	}

	return convertParsedMeal(parsed)
}

func (s *foodAIService) ParseMealPhoto(ctx context.Context, imageBytes []byte, mimeType string) ([]FoodLog, error) {
	if len(imageBytes) == 0 {
		return nil, fmt.Errorf("image bytes are empty")
	}

	parsed, err := s.client.ParseMealFromImage(ctx, imageBytes, mimeType)
	if err != nil {
		return nil, fmt.Errorf("failed to parse meal photo: %w", err)
	}

	return convertParsedMeal(parsed)
}

func convertParsedMeal(parsed *ai.ParsedMeal) ([]FoodLog, error) {
	if parsed == nil {
		return nil, fmt.Errorf("received nil meal data from AI service")
	}

	if len(parsed.Items) == 0 {
		return nil, fmt.Errorf("AI returned no meal items")
	}

	logs := make([]FoodLog, 0, len(parsed.Items))
	for i, item := range parsed.Items {
		if item.Name == "" {
			return nil, fmt.Errorf("item %d missing name", i)
		}
		if item.WeightGrams <= 0 {
			return nil, fmt.Errorf("item %d (%q) has non-positive weight_grams", i, item.Name)
		}
		if item.Carbs100g < 0 || item.Protein100g < 0 || item.Fat100g < 0 {
			return nil, fmt.Errorf("item %d (%q) has negative macros", i, item.Name)
		}

		carbs, protein, fat, calories := CalculateMacros(item.Carbs100g, item.Protein100g, item.Fat100g, item.WeightGrams)
		logs = append(logs, FoodLog{
			Name:     item.Name,
			Weight:   int(item.WeightGrams),
			Carbs:    carbs,
			Protein:  protein,
			Fat:      fat,
			Calories: calories,
		})
	}

	return logs, nil
}
