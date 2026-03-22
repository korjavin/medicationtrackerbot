package domain

import (
	"context"
	"fmt"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
)

// FoodAIService defines the interface for parsing natural language meal descriptions.
type FoodAIService interface {
	ParseMealDescription(ctx context.Context, description string) (*FoodLog, error)
}

// AIClient is an interface describing the methods we need from the AI client,
// making it easier to mock for tests.
type AIClient interface {
	ParseMealFromDescription(ctx context.Context, description string) (*ai.MealData, error)
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

func (s *foodAIService) ParseMealDescription(ctx context.Context, description string) (*FoodLog, error) {
	if description == "" {
		return nil, fmt.Errorf("description cannot be empty")
	}

	mealData, err := s.client.ParseMealFromDescription(ctx, description)
	if err != nil {
		return nil, fmt.Errorf("failed to parse meal description: %w", err)
	}

	if mealData == nil {
		return nil, fmt.Errorf("received nil meal data from AI service")
	}

	carbs, protein, fat, calories := CalculateMacros(mealData.Carbs100g, mealData.Protein100g, mealData.Fat100g, mealData.WeightGrams)

	return &FoodLog{
		Name:     mealData.Name,
		Weight:   int(mealData.WeightGrams),
		Carbs:    carbs,
		Protein:  protein,
		Fat:      fat,
		Calories: calories,
	}, nil
}
