package domain

import (
	"context"
	"fmt"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
)

// ActivityExercise is a single exercise parsed from natural language.
type ActivityExercise struct {
	Name            string
	Sets            *int
	Reps            *int
	WeightKg        *float64
	DurationMinutes *int
	Notes           string
}

// ActivityLog represents a parsed workout session from natural language.
type ActivityLog struct {
	Name      string
	Exercises []ActivityExercise
}

// ActivityAIService defines the interface for parsing natural language workout descriptions.
type ActivityAIService interface {
	ParseActivityDescription(ctx context.Context, description string) (*ActivityLog, error)
}

// ActivityAIClient is the AI client subset needed by ActivityAIService.
type ActivityAIClient interface {
	ParseActivityFromDescription(ctx context.Context, description string) (*ai.ActivityData, error)
}

type activityAIService struct {
	client ActivityAIClient
}

// NewActivityAIService creates a new ActivityAIService using the provided AI client.
func NewActivityAIService(client ActivityAIClient) ActivityAIService {
	return &activityAIService{client: client}
}

func (s *activityAIService) ParseActivityDescription(ctx context.Context, description string) (*ActivityLog, error) {
	if description == "" {
		return nil, fmt.Errorf("description cannot be empty")
	}

	data, err := s.client.ParseActivityFromDescription(ctx, description)
	if err != nil {
		return nil, fmt.Errorf("failed to parse activity description: %w", err)
	}

	if data == nil {
		return nil, fmt.Errorf("received nil activity data from AI service")
	}

	exercises := make([]ActivityExercise, 0, len(data.Exercises))
	for _, e := range data.Exercises {
		ex := ActivityExercise{
			Name:  e.Name,
			Notes: e.Notes,
		}
		if e.Sets != nil {
			v := *e.Sets
			ex.Sets = &v
		}
		if e.Reps != nil {
			v := *e.Reps
			ex.Reps = &v
		}
		if e.WeightKg != nil {
			v := *e.WeightKg
			ex.WeightKg = &v
		}
		if e.DurationMinutes != nil {
			v := *e.DurationMinutes
			ex.DurationMinutes = &v
		}
		exercises = append(exercises, ex)
	}

	return &ActivityLog{
		Name:      data.Name,
		Exercises: exercises,
	}, nil
}
