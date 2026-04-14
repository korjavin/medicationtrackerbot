package domain

import (
	"testing"
)

func TestCalculateStreak(t *testing.T) {
	tests := []struct {
		name     string
		sessions []SessionStatus
		want     int
	}{
		{"empty", nil, 0},
		{"all completed", []SessionStatus{{"completed"}, {"completed"}, {"completed"}}, 3},
		{"break on skipped", []SessionStatus{{"completed"}, {"completed"}, {"skipped"}, {"completed"}}, 2},
		{"break on pending", []SessionStatus{{"completed"}, {"pending"}}, 1},
		{"starts with skipped", []SessionStatus{{"skipped"}, {"completed"}}, 0},
		{"single completed", []SessionStatus{{"completed"}}, 1},
		{"in_progress does not break streak", []SessionStatus{{"completed"}, {"in_progress"}, {"completed"}}, 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CalculateStreak(tt.sessions)
			if got != tt.want {
				t.Errorf("CalculateStreak() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestCheckCompletion(t *testing.T) {
	t.Run("all completed", func(t *testing.T) {
		planned := []int64{1, 2, 3}
		logs := []ExerciseLogStatus{
			{ExerciseID: 1, Status: "completed"},
			{ExerciseID: 2, Status: "completed"},
			{ExerciseID: 3, Status: "skipped"},
		}
		result := CheckCompletion(planned, logs)
		if !result.AllDone {
			t.Error("expected AllDone = true")
		}
		if result.CompletedCount != 2 {
			t.Errorf("expected 2 completed, got %d", result.CompletedCount)
		}
		if result.TotalCount != 3 {
			t.Errorf("expected 3 total, got %d", result.TotalCount)
		}
	})

	t.Run("not all handled", func(t *testing.T) {
		planned := []int64{1, 2, 3}
		logs := []ExerciseLogStatus{
			{ExerciseID: 1, Status: "completed"},
			{ExerciseID: 2, Status: "completed"},
		}
		result := CheckCompletion(planned, logs)
		if result.AllDone {
			t.Error("expected AllDone = false")
		}
	})

	t.Run("extra logged exercises", func(t *testing.T) {
		planned := []int64{1}
		logs := []ExerciseLogStatus{
			{ExerciseID: 1, Status: "completed"},
			{ExerciseID: 2, Status: "completed"}, // extra exercise not in planned
		}
		result := CheckCompletion(planned, logs)
		if !result.AllDone {
			t.Error("expected AllDone = true")
		}
		if result.TotalCount != 2 {
			t.Errorf("expected 2 total (union), got %d", result.TotalCount)
		}
	})

	t.Run("empty", func(t *testing.T) {
		result := CheckCompletion(nil, nil)
		if !result.AllDone {
			t.Error("expected AllDone = true for empty inputs")
		}
	})

	t.Run("library log does not satisfy planned exercise with same ID", func(t *testing.T) {
		planned := []int64{10, 20}
		logs := []ExerciseLogStatus{
			{ExerciseID: 10, Status: "completed", Source: "library"}, // same ID but from library
			{ExerciseID: 20, Status: "completed", Source: "schedule"},
		}
		result := CheckCompletion(planned, logs)
		if result.AllDone {
			t.Error("expected AllDone = false: library log should not satisfy planned exercise 10")
		}
		// 1 completed from schedule (20) + 1 completed from library (10) = 2
		if result.CompletedCount != 2 {
			t.Errorf("expected 2 completed, got %d", result.CompletedCount)
		}
		// 2 planned (schedule) + 1 library = 3 unique (exercise_id, source) entries
		if result.TotalCount != 3 {
			t.Errorf("expected 3 total, got %d", result.TotalCount)
		}
	})

	t.Run("schedule log satisfies planned exercise", func(t *testing.T) {
		planned := []int64{10}
		logs := []ExerciseLogStatus{
			{ExerciseID: 10, Status: "completed", Source: "schedule"},
		}
		result := CheckCompletion(planned, logs)
		if !result.AllDone {
			t.Error("expected AllDone = true: schedule log should satisfy planned exercise")
		}
	})

	t.Run("both schedule and library logs with same ID", func(t *testing.T) {
		planned := []int64{10}
		logs := []ExerciseLogStatus{
			{ExerciseID: 10, Status: "completed", Source: "schedule"},
			{ExerciseID: 10, Status: "completed", Source: "library"},
		}
		result := CheckCompletion(planned, logs)
		if !result.AllDone {
			t.Error("expected AllDone = true")
		}
		// Both are completed but separate (different sources)
		if result.CompletedCount != 2 {
			t.Errorf("expected 2 completed, got %d", result.CompletedCount)
		}
		if result.TotalCount != 2 {
			t.Errorf("expected 2 total, got %d", result.TotalCount)
		}
	})
}
