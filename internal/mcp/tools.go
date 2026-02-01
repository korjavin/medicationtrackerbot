package mcp

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// DateRangeInput is a common input type for date range queries
type DateRangeInput struct {
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
}

// BloodPressureResult represents a blood pressure reading for the tool response
type BloodPressureResult struct {
	MeasuredAt string `json:"measured_at"`
	Systolic   int    `json:"systolic"`
	Diastolic  int    `json:"diastolic"`
	Pulse      int    `json:"pulse,omitempty"`
	Category   string `json:"category"`
	Notes      string `json:"notes,omitempty"`
}

// BloodPressureResponse is the response for the get_blood_pressure tool
type BloodPressureResponse struct {
	Readings []BloodPressureResult `json:"readings"`
	Count    int                   `json:"count"`
	Period   string                `json:"period"`
	Warning  string                `json:"warning,omitempty"`
}

// handleGetBloodPressure handles the get_blood_pressure tool
func (s *Server) handleGetBloodPressure(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, BloodPressureResponse, error) {
	startDate, endDate, warning, err := s.parseDateRange(input.StartDate, input.EndDate)
	if err != nil {
		log.Printf("[MCP] Date parsing failed for BP: %v", err)
		return nil, BloodPressureResponse{}, err
	}
	log.Printf("[MCP] Fetching BP for date range: %s to %s", startDate, endDate)

	// Get the user ID from config
	userID := s.config.UserID

	readings, err := s.store.GetBloodPressureReadings(ctx, userID, startDate)
	if err != nil {
		log.Printf("[MCP] Failed to fetch BP readings: %v", err)
		return nil, BloodPressureResponse{}, err
	}
	log.Printf("[MCP] Found %d BP readings", len(readings))

	// Filter readings by end date and convert to response format
	var results []BloodPressureResult
	for _, r := range readings {
		if r.MeasuredAt.After(endDate) {
			continue
		}

		pulse := 0
		if r.Pulse != nil {
			pulse = *r.Pulse
		}

		results = append(results, BloodPressureResult{
			MeasuredAt: r.MeasuredAt.Format("2006-01-02 15:04"),
			Systolic:   r.Systolic,
			Diastolic:  r.Diastolic,
			Pulse:      pulse,
			Category:   r.Category,
			Notes:      r.Notes,
		})
	}

	response := BloodPressureResponse{
		Readings: results,
		Count:    len(results),
		Period:   formatPeriod(startDate, endDate),
		Warning:  warning,
	}

	return nil, response, nil
}

// WeightResult represents a weight log for the tool response
type WeightResult struct {
	MeasuredAt string   `json:"measured_at"`
	Weight     float64  `json:"weight_kg"`
	Trend      *float64 `json:"trend_kg,omitempty"`
	BodyFat    *float64 `json:"body_fat_percent,omitempty"`
	Notes      string   `json:"notes,omitempty"`
}

// WeightResponse is the response for the get_weight tool
type WeightResponse struct {
	Logs    []WeightResult `json:"logs"`
	Count   int            `json:"count"`
	Period  string         `json:"period"`
	Warning string         `json:"warning,omitempty"`
}

// handleGetWeight handles the get_weight tool
func (s *Server) handleGetWeight(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, WeightResponse, error) {
	startDate, endDate, warning, err := s.parseDateRange(input.StartDate, input.EndDate)
	if err != nil {
		log.Printf("[MCP] Date parsing failed for Weight: %v", err)
		return nil, WeightResponse{}, err
	}
	log.Printf("[MCP] Fetching Weight for date range: %s to %s", startDate, endDate)

	userID := s.config.UserID

	logs, err := s.store.GetWeightLogs(ctx, userID, startDate)
	if err != nil {
		log.Printf("[MCP] Failed to fetch Weight logs: %v", err)
		return nil, WeightResponse{}, err
	}
	log.Printf("[MCP] Found %d weight logs", len(logs))

	// Filter and convert
	var results []WeightResult
	for _, l := range logs {
		if l.MeasuredAt.After(endDate) {
			continue
		}
		results = append(results, WeightResult{
			MeasuredAt: l.MeasuredAt.Format("2006-01-02"),
			Weight:     l.Weight,
			Trend:      l.WeightTrend,
			BodyFat:    l.BodyFat,
			Notes:      l.Notes,
		})
	}

	response := WeightResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	return nil, response, nil
}

// MedicationIntakeInput includes optional medication filter
type MedicationIntakeInput struct {
	StartDate      string `json:"start_date"`
	EndDate        string `json:"end_date"`
	MedicationName string `json:"medication_name"`
}

// MedicationIntakeResult represents a medication intake for the tool response
type MedicationIntakeResult struct {
	MedicationName string  `json:"medication_name"`
	Dosage         string  `json:"dosage"`
	ScheduledAt    string  `json:"scheduled_at"`
	TakenAt        *string `json:"taken_at,omitempty"`
	Status         string  `json:"status"`
}

// MedicationIntakeResponse is the response for the get_medication_intake tool
type MedicationIntakeResponse struct {
	Intakes []MedicationIntakeResult `json:"intakes"`
	Count   int                      `json:"count"`
	Period  string                   `json:"period"`
	Warning string                   `json:"warning,omitempty"`
}

// handleGetMedicationIntake handles the get_medication_intake tool
func (s *Server) handleGetMedicationIntake(ctx context.Context, req *mcp.CallToolRequest, input MedicationIntakeInput) (*mcp.CallToolResult, MedicationIntakeResponse, error) {
	startDate, endDate, warning, err := s.parseDateRange(input.StartDate, input.EndDate)
	if err != nil {
		return nil, MedicationIntakeResponse{}, err
	}

	// Get intakes since start date
	intakes, err := s.store.GetIntakesSince(startDate)
	if err != nil {
		return nil, MedicationIntakeResponse{}, err
	}

	// Filter and convert
	var results []MedicationIntakeResult
	for _, intake := range intakes {
		// Filter by end date
		if intake.ScheduledAt.After(endDate) {
			continue
		}

		// Filter by medication name if specified
		if input.MedicationName != "" {
			if !strings.Contains(strings.ToLower(intake.MedicationName), strings.ToLower(input.MedicationName)) {
				continue
			}
		}

		var takenAt *string
		if intake.TakenAt != nil {
			t := intake.TakenAt.Format("2006-01-02 15:04")
			takenAt = &t
		}

		results = append(results, MedicationIntakeResult{
			MedicationName: intake.MedicationName,
			Dosage:         intake.MedicationDosage,
			ScheduledAt:    intake.ScheduledAt.Format("2006-01-02 15:04"),
			TakenAt:        takenAt,
			Status:         intake.Status,
		})
	}

	response := MedicationIntakeResponse{
		Intakes: results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	return nil, response, nil
}

// WorkoutHistoryInput includes option to include exercises
type WorkoutHistoryInput struct {
	StartDate        string `json:"start_date"`
	EndDate          string `json:"end_date"`
	IncludeExercises bool   `json:"include_exercises"`
}

// ExerciseLogResult represents an exercise log for the tool response
type ExerciseLogResult struct {
	ExerciseName  string   `json:"exercise_name"`
	SetsCompleted *int     `json:"sets_completed,omitempty"`
	RepsCompleted *int     `json:"reps_completed,omitempty"`
	WeightKg      *float64 `json:"weight_kg,omitempty"`
	Status        string   `json:"status"`
	Notes         string   `json:"notes,omitempty"`
}

// WorkoutSessionResult represents a workout session for the tool response
type WorkoutSessionResult struct {
	GroupName     string              `json:"group_name"`
	VariantName   string              `json:"variant_name"`
	ScheduledDate string              `json:"scheduled_date"`
	Status        string              `json:"status"`
	StartedAt     *string             `json:"started_at,omitempty"`
	CompletedAt   *string             `json:"completed_at,omitempty"`
	Notes         string              `json:"notes,omitempty"`
	Exercises     []ExerciseLogResult `json:"exercises,omitempty"`
	TotalVolumeKg *float64            `json:"total_volume_kg,omitempty"`
}

// WorkoutHistoryResponse is the response for the get_workout_history tool
type WorkoutHistoryResponse struct {
	Sessions []WorkoutSessionResult `json:"sessions"`
	Count    int                    `json:"count"`
	Period   string                 `json:"period"`
	Warning  string                 `json:"warning,omitempty"`
}

// handleGetWorkoutHistory handles the get_workout_history tool
func (s *Server) handleGetWorkoutHistory(ctx context.Context, req *mcp.CallToolRequest, input WorkoutHistoryInput) (*mcp.CallToolResult, WorkoutHistoryResponse, error) {
	startDate, endDate, warning, err := s.parseDateRange(input.StartDate, input.EndDate)
	if err != nil {
		return nil, WorkoutHistoryResponse{}, err
	}

	userID := s.config.UserID

	// Get workout history - the store method returns recent sessions with limit
	// We'll need to filter by date range
	sessions, err := s.store.GetWorkoutHistory(userID, 1000) // Get plenty, then filter
	if err != nil {
		return nil, WorkoutHistoryResponse{}, err
	}

	var results []WorkoutSessionResult
	for _, session := range sessions {
		// Filter by date range
		if session.ScheduledDate.Before(startDate) || session.ScheduledDate.After(endDate) {
			continue
		}

		// Get group and variant names
		group, _ := s.store.GetWorkoutGroup(session.GroupID)
		variant, _ := s.store.GetWorkoutVariant(session.VariantID)

		groupName := ""
		variantName := ""
		if group != nil {
			groupName = group.Name
		}
		if variant != nil {
			variantName = variant.Name
		}

		result := WorkoutSessionResult{
			GroupName:     groupName,
			VariantName:   variantName,
			ScheduledDate: session.ScheduledDate.Format("2006-01-02"),
			Status:        session.Status,
			Notes:         session.Notes,
		}

		if session.StartedAt != nil {
			t := session.StartedAt.Format("2006-01-02 15:04")
			result.StartedAt = &t
		}
		if session.CompletedAt != nil {
			t := session.CompletedAt.Format("2006-01-02 15:04")
			result.CompletedAt = &t
		}

		// Include exercises if requested
		if input.IncludeExercises {
			logs, err := s.store.GetExerciseLogs(session.ID)
			if err == nil {
				var totalVolume float64
				for _, log := range logs {
					exerciseResult := ExerciseLogResult{
						ExerciseName:  log.ExerciseName,
						SetsCompleted: log.SetsCompleted,
						RepsCompleted: log.RepsCompleted,
						WeightKg:      log.WeightKg,
						Status:        log.Status,
						Notes:         log.Notes,
					}
					result.Exercises = append(result.Exercises, exerciseResult)

					// Calculate volume (sets * reps * weight)
					if log.SetsCompleted != nil && log.RepsCompleted != nil && log.WeightKg != nil {
						totalVolume += float64(*log.SetsCompleted) * float64(*log.RepsCompleted) * (*log.WeightKg)
					}
				}
				if totalVolume > 0 {
					result.TotalVolumeKg = &totalVolume
				}
			}
		}

		results = append(results, result)
	}

	response := WorkoutHistoryResponse{
		Sessions: results,
		Count:    len(results),
		Period:   formatPeriod(startDate, endDate),
		Warning:  warning,
	}

	return nil, response, nil
}

// formatPeriod formats the date range as a human-readable string
func formatPeriod(start, end time.Time) string {
	return start.Format("2006-01-02") + " to " + end.Format("2006-01-02")
}

// marshalToolResult converts a response struct to a CallToolResult
func marshalToolResult(data interface{}) (*mcp.CallToolResult, error) {
	jsonBytes, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{
				Text: string(jsonBytes),
			},
		},
	}, nil
}

// SleepLogResult represents a sleep log for the tool response
type SleepLogResult struct {
	StartTime    string `json:"start_time"`
	EndTime      string `json:"end_time"`
	TotalMinutes *int   `json:"total_minutes,omitempty"`
	DeepMinutes  *int   `json:"deep_minutes,omitempty"`
	LightMinutes *int   `json:"light_minutes,omitempty"`
	REMMinutes   *int   `json:"rem_minutes,omitempty"`
	AwakeMinutes *int   `json:"awake_minutes,omitempty"`
	HeartRateAvg *int   `json:"heart_rate_avg,omitempty"`
	SpO2Avg      *int   `json:"spo2_avg,omitempty"`
	Notes        string `json:"notes,omitempty"`
}

// SleepLogResponse is the response for the get_sleep_logs tool
type SleepLogResponse struct {
	Logs    []SleepLogResult `json:"logs"`
	Count   int              `json:"count"`
	Period  string           `json:"period"`
	Warning string           `json:"warning,omitempty"`
}

// handleGetSleepLogs handles the get_sleep_logs tool
func (s *Server) handleGetSleepLogs(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, SleepLogResponse, error) {
	startDate, endDate, warning, err := s.parseDateRange(input.StartDate, input.EndDate)
	if err != nil {
		return nil, SleepLogResponse{}, err
	}

	log.Printf("[MCP] Fetching Sleep Logs for date range: %s to %s", startDate, endDate)

	userID := s.config.UserID
	logs, err := s.store.GetSleepLogs(ctx, userID, startDate)
	if err != nil {
		log.Printf("[MCP] Failed to fetch sleep logs: %v", err)
		return nil, SleepLogResponse{}, err
	}
	log.Printf("[MCP] Found %d sleep logs", len(logs))

	var results []SleepLogResult
	for _, l := range logs {
		if l.StartTime.After(endDate) {
			continue
		}

		res := SleepLogResult{
			StartTime:    l.StartTime.Format("2006-01-02 15:04"),
			EndTime:      l.EndTime.Format("2006-01-02 15:04"),
			TotalMinutes: l.TotalMinutes,
			DeepMinutes:  l.DeepMinutes,
			LightMinutes: l.LightMinutes,
			REMMinutes:   l.REMMinutes,
			AwakeMinutes: l.AwakeMinutes,
			HeartRateAvg: l.HeartRateAvg,
			SpO2Avg:      l.SpO2Avg,
			Notes:        l.Notes,
		}

		results = append(results, res)
	}

	response := SleepLogResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	return nil, response, nil
}
