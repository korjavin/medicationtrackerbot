package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// DateRangeInput is a common input type for date range queries
type DateRangeInput struct {
	StartDate    string `json:"start_date"`
	EndDate      string `json:"end_date"`
	ExcludeNotes bool   `json:"exclude_notes"`
}

func (s *Server) ensureFeatureEnabled(ctx context.Context, feature string) error {
	var enabled bool
	var err error

	switch feature {
	case "bp":
		enabled, err = s.data.GetBloodPressureEnabled(ctx)
	case "weight":
		enabled, err = s.data.GetWeightEnabled(ctx)
	case "medication":
		enabled, err = s.data.GetMedicationEnabled(ctx)
	case "workout":
		enabled, err = s.data.GetWorkoutEnabled(ctx)
	case "food":
		enabled, err = s.data.GetFoodIntakeEnabled(ctx)
	default:
		return nil
	}

	if err != nil {
		return err
	}
	if !enabled {
		return fmt.Errorf("%s feature is disabled in settings", feature)
	}
	return nil
}

func (s *Server) resolveDateRangeArgs(req *mcp.CallToolRequest, startDate, endDate string) (string, string, string, error) {
	if req == nil || req.Params == nil || len(req.Params.Arguments) == 0 {
		return startDate, endDate, "", nil
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(req.Params.Arguments, &raw); err != nil {
		return "", "", "", fmt.Errorf("invalid arguments payload: expected JSON object")
	}

	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	slog.Info("[MCP] Tool called", "name", req.Params.Name, "argumentKeys", strings.Join(keys, ","))

	var notes []string
	if startDate == "" {
		if v, ok, err := getStringArg(raw, "startDate"); err != nil {
			return "", "", "", fmt.Errorf("invalid startDate: expected string")
		} else if ok {
			startDate = v
			notes = append(notes, "Accepted compatibility alias startDate; prefer start_date.")
		}
	}
	if endDate == "" {
		if v, ok, err := getStringArg(raw, "endDate"); err != nil {
			return "", "", "", fmt.Errorf("invalid endDate: expected string")
		} else if ok {
			endDate = v
			notes = append(notes, "Accepted compatibility alias endDate; prefer end_date.")
		}
	}

	return startDate, endDate, strings.Join(notes, " "), nil
}

func getStringArg(args map[string]json.RawMessage, key string) (string, bool, error) {
	raw, ok := args[key]
	if !ok {
		return "", false, nil
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "", true, err
	}
	return strings.TrimSpace(v), true, nil
}

func noDataWarning(entity string, startDate, endDate time.Time, storeCount, returnedCount int) string {
	if returnedCount > 0 {
		return ""
	}
	if storeCount > 0 {
		return fmt.Sprintf(
			"No %s in requested range %s to %s. Found %d record(s) after start_date, but all were outside end_date.",
			entity,
			startDate.Format("2006-01-02"),
			endDate.Format("2006-01-02"),
			storeCount,
		)
	}
	return fmt.Sprintf(
		"No %s found in effective range %s to %s.",
		entity,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
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
	Readings     []BloodPressureResult `json:"readings"`
	Count        int                   `json:"count"`
	Period       string                `json:"period"`
	ContextNotes []ContextNote         `json:"context_notes,omitempty"`
	Warning      string                `json:"warning,omitempty"`
}

// handleGetBloodPressure handles the get_blood_pressure tool
func (s *Server) handleGetBloodPressure(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, BloodPressureResponse, error) {
	if err := s.ensureFeatureEnabled(ctx, "bp"); err != nil {
		return nil, BloodPressureResponse{}, err
	}

	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, BloodPressureResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		slog.Warn("[MCP] Date parsing failed for BP", "error", err)
		return nil, BloodPressureResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)
	slog.Info("[MCP] Fetching BP for date range", "start", startDate, "end", endDate)

	// Get the user ID from config
	userID := s.config.UserID

	readings, err := s.data.GetBloodPressureReadings(ctx, userID, startDate)
	if err != nil {
		slog.Error("[MCP] Failed to fetch BP readings", "error", err)
		return nil, BloodPressureResponse{}, err
	}
	slog.Info("[MCP] Found BP readings", "count", len(readings))

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
	slog.Info("[MCP] BP query result",
		"store_count", len(readings),
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate))
	if len(results) == 0 {
		reason := noDataWarning("blood pressure readings", startDate, endDate, len(readings), len(results))
		warning = appendWarnings(warning, reason)
		slog.Warn("[MCP] BP query returned zero rows",
			"user_id", userID,
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"warning", warning)
	}

	response := BloodPressureResponse{
		Readings: results,
		Count:    len(results),
		Period:   formatPeriod(startDate, endDate),
		Warning:  warning,
	}

	if shouldIncludeNotes(input.ExcludeNotes) {
		response.ContextNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Blood Pressure",
			StartDate: startDate,
			EndDate:   endDate,
		})
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
	Logs         []WeightResult `json:"logs"`
	Count        int            `json:"count"`
	Period       string         `json:"period"`
	ContextNotes []ContextNote  `json:"context_notes,omitempty"`
	Warning      string         `json:"warning,omitempty"`
}

// handleGetWeight handles the get_weight tool
func (s *Server) handleGetWeight(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, WeightResponse, error) {
	if err := s.ensureFeatureEnabled(ctx, "weight"); err != nil {
		return nil, WeightResponse{}, err
	}

	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, WeightResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		slog.Warn("[MCP] Date parsing failed for Weight", "error", err)
		return nil, WeightResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)
	slog.Info("[MCP] Fetching Weight for date range", "start", startDate, "end", endDate)

	userID := s.config.UserID

	logs, err := s.data.GetWeightLogs(ctx, userID, startDate)
	if err != nil {
		slog.Error("[MCP] Failed to fetch Weight logs", "error", err)
		return nil, WeightResponse{}, err
	}
	slog.Info("[MCP] Found weight logs", "count", len(logs))

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
	slog.Info("[MCP] Weight query result",
		"store_count", len(logs),
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate))
	if len(results) == 0 {
		reason := noDataWarning("weight logs", startDate, endDate, len(logs), len(results))
		warning = appendWarnings(warning, reason)
		slog.Warn("[MCP] Weight query returned zero rows",
			"user_id", userID,
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"warning", warning)
	}

	response := WeightResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	if shouldIncludeNotes(input.ExcludeNotes) {
		response.ContextNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Weight",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

// MedicationIntakeInput includes optional medication filter
type MedicationIntakeInput struct {
	StartDate      string `json:"start_date"`
	EndDate        string `json:"end_date"`
	MedicationName string `json:"medication_name"`
	ExcludeNotes   bool   `json:"exclude_notes"`
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
	Intakes      []MedicationIntakeResult `json:"intakes"`
	Count        int                      `json:"count"`
	Period       string                   `json:"period"`
	ContextNotes []ContextNote            `json:"context_notes,omitempty"`
	Warning      string                   `json:"warning,omitempty"`
}

// handleGetMedicationIntake handles the get_medication_intake tool
func (s *Server) handleGetMedicationIntake(ctx context.Context, req *mcp.CallToolRequest, input MedicationIntakeInput) (*mcp.CallToolResult, MedicationIntakeResponse, error) {
	if err := s.ensureFeatureEnabled(ctx, "medication"); err != nil {
		return nil, MedicationIntakeResponse{}, err
	}

	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, MedicationIntakeResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, MedicationIntakeResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	// Get intakes since start date
	intakes, err := s.data.GetIntakesSince(startDate)
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
	slog.Info("[MCP] Medication query result",
		"store_count", len(intakes),
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate),
		"medication_filter", input.MedicationName)
	if len(results) == 0 {
		reason := noDataWarning("medication intake records", startDate, endDate, len(intakes), len(results))
		if strings.TrimSpace(input.MedicationName) != "" {
			reason = reason + fmt.Sprintf(" Applied medication_name filter: %q.", input.MedicationName)
		}
		warning = appendWarnings(warning, reason)
		slog.Warn("[MCP] Medication query returned zero rows",
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"medication_filter", input.MedicationName,
			"warning", warning)
	}

	response := MedicationIntakeResponse{
		Intakes: results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	if shouldIncludeNotes(input.ExcludeNotes) {
		response.ContextNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Medications",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

// WorkoutHistoryInput includes option to include exercises
type WorkoutHistoryInput struct {
	StartDate        string `json:"start_date"`
	EndDate          string `json:"end_date"`
	IncludeExercises bool   `json:"include_exercises"`
	ExcludeNotes     bool   `json:"exclude_notes"`
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
	Type          string              `json:"type"` // "manual" or "miband"
	GroupName     string              `json:"group_name"`
	VariantName   string              `json:"variant_name,omitempty"`
	ScheduledDate string              `json:"scheduled_date"`
	Status        string              `json:"status"`
	StartedAt     *string             `json:"started_at,omitempty"`
	CompletedAt   *string             `json:"completed_at,omitempty"`
	Notes         string              `json:"notes,omitempty"`
	Exercises     []ExerciseLogResult `json:"exercises,omitempty"`
	TotalVolumeKg *float64            `json:"total_volume_kg,omitempty"`

	// MiBand specific fields
	DurationSec  *int     `json:"duration_sec,omitempty"`
	DistanceM    *float64 `json:"distance_m,omitempty"`
	Steps        *int     `json:"steps,omitempty"`
	Calories     *int     `json:"calories,omitempty"`
	HeartRateAvg *int     `json:"heart_rate_avg,omitempty"`
}

// WorkoutHistoryResponse is the response for the get_workout_history tool
type WorkoutHistoryResponse struct {
	Sessions     []WorkoutSessionResult `json:"sessions"`
	Count        int                    `json:"count"`
	Period       string                 `json:"period"`
	ContextNotes []ContextNote          `json:"context_notes,omitempty"`
	Warning      string                 `json:"warning,omitempty"`
}

// handleGetWorkoutHistory handles the get_workout_history tool
func (s *Server) handleGetWorkoutHistory(ctx context.Context, req *mcp.CallToolRequest, input WorkoutHistoryInput) (*mcp.CallToolResult, WorkoutHistoryResponse, error) {
	if err := s.ensureFeatureEnabled(ctx, "workout"); err != nil {
		return nil, WorkoutHistoryResponse{}, err
	}

	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, WorkoutHistoryResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, WorkoutHistoryResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	userID := s.config.UserID

	// Get workout history - the store method returns recent sessions with limit
	// We'll need to filter by date range
	sessions, err := s.data.GetWorkoutHistory(userID, 1000) // Get plenty, then filter
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
		group, _ := s.data.GetWorkoutGroup(session.GroupID)
		variant, _ := s.data.GetWorkoutVariant(session.VariantID)

		groupName := ""
		variantName := ""
		if group != nil {
			groupName = group.Name
		}
		if variant != nil {
			variantName = variant.Name
		}

		result := WorkoutSessionResult{
			Type:          "manual",
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
			logs, err := s.data.GetExerciseLogs(session.ID)
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

	// Fetch Mi Band workouts
	mibandWorkouts, err := s.data.ListMiBandWorkouts(ctx, userID, 1000)
	if err == nil {
		for _, wo := range mibandWorkouts {
			startTime := time.UnixMilli(wo.SourceStartMs).UTC()
			endTime := time.UnixMilli(wo.SourceEndMs).UTC()
			if wo.TzOffset != 0 {
				loc := time.FixedZone("local", wo.TzOffset)
				startTime = startTime.In(loc)
				endTime = endTime.In(loc)
			}

			// Filter by start date range
			if startTime.Before(startDate) || startTime.After(endDate) {
				continue
			}

			startedStr := startTime.Format("2006-01-02 15:04")
			completedStr := endTime.Format("2006-01-02 15:04")

			result := WorkoutSessionResult{
				Type:          "miband",
				GroupName:     wo.ActivityName,
				ScheduledDate: startTime.Format("2006-01-02"),
				Status:        "completed",
				StartedAt:     &startedStr,
				CompletedAt:   &completedStr,
				DurationSec:   &wo.DurationSec,
				DistanceM:     &wo.DistanceM,
			}
			if wo.Steps > 0 {
				s := wo.Steps
				result.Steps = &s
			}
			if wo.Calories > 0 {
				c := wo.Calories
				result.Calories = &c
			}
			if wo.HeartRateAvg > 0 {
				hr := wo.HeartRateAvg
				result.HeartRateAvg = &hr
			}
			results = append(results, result)
		}
	}

	// Sort mixed results by date (descending)
	sort.Slice(results, func(i, j int) bool {
		t1 := results[i].ScheduledDate
		if results[i].StartedAt != nil {
			t1 = *results[i].StartedAt
		}
		t2 := results[j].ScheduledDate
		if results[j].StartedAt != nil {
			t2 = *results[j].StartedAt
		}
		return t1 > t2
	})

	slog.Info("[MCP] Workout query result",
		"store_count", len(sessions),
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate),
		"include_exercises", input.IncludeExercises)
	if len(results) == 0 {
		reason := noDataWarning("workout sessions", startDate, endDate, len(sessions), len(results))
		warning = appendWarnings(warning, reason)
		slog.Warn("[MCP] Workout query returned zero rows",
			"user_id", userID,
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"warning", warning)
	}

	// Check for likely year hallucination if no results found
	if len(results) == 0 {
		// If the query end date is more than 30 days in the past
		if time.Since(endDate) > 30*24*time.Hour {
			warning += fmt.Sprintf(" No data found for %s to %s. Note: Current date is %s. Please verify the year.",
				startDate.Format("2006-01-02"),
				endDate.Format("2006-01-02"),
				time.Now().Format("2006-01-02"))
		}
	}

	response := WorkoutHistoryResponse{
		Sessions: results,
		Count:    len(results),
		Period:   formatPeriod(startDate, endDate),
		Warning:  strings.TrimSpace(warning),
	}

	if shouldIncludeNotes(input.ExcludeNotes) {
		response.ContextNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Workouts",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

// formatPeriod formats the date range as a human-readable string
func formatPeriod(start, end time.Time) string {
	return start.Format("2006-01-02") + " to " + end.Format("2006-01-02")
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
	Logs         []SleepLogResult `json:"logs"`
	Count        int              `json:"count"`
	Period       string           `json:"period"`
	ContextNotes []ContextNote    `json:"context_notes,omitempty"`
	Warning      string           `json:"warning,omitempty"`
}

// handleGetSleepLogs handles the get_sleep_logs tool
func (s *Server) handleGetSleepLogs(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, SleepLogResponse, error) {
	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, SleepLogResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, SleepLogResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	slog.Info("[MCP] Fetching Sleep Logs for date range", "start", startDate, "end", endDate)

	userID := s.config.UserID
	logs, err := s.data.GetSleepLogs(ctx, userID, startDate)
	if err != nil {
		slog.Error("[MCP] Failed to fetch sleep logs", "error", err)
		return nil, SleepLogResponse{}, err
	}
	slog.Info("[MCP] Found sleep logs", "count", len(logs))

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

	slog.Info("[MCP] Sleep logs query result",
		"store_count", len(logs),
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate))
	if len(results) == 0 {
		emptyReason := noDataWarning("sleep logs", startDate, endDate, len(logs), len(results))
		warning = appendWarnings(warning, emptyReason)
		slog.Warn("[MCP] Sleep logs query returned zero rows",
			"user_id", userID,
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"warning", warning)
	}

	response := SleepLogResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	if shouldIncludeNotes(input.ExcludeNotes) {
		response.ContextNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Sleep",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

// FoodIntakeResult represents a food log for the tool response
type FoodIntakeResult struct {
	EatenAt  string `json:"eaten_at"`
	Meal     string `json:"meal"` // Breakfast, Lunch, Dinner, Snack
	Name     string `json:"name,omitempty"`
	Weight   int    `json:"weight_g"`
	Calories int    `json:"calories"`
	Carbs    int    `json:"carbs_g"`
	Protein  int    `json:"protein_g"`
	Fat      int    `json:"fat_g"`
}

// FoodIntakeResponse is the response for the get_food_intake tool
type FoodIntakeResponse struct {
	Logs         []FoodIntakeResult `json:"logs"`
	Count        int                `json:"count"`
	Period       string             `json:"period"`
	Target       *FoodTargetResult  `json:"target,omitempty"`
	ContextNotes []ContextNote      `json:"context_notes,omitempty"`
	Warning      string             `json:"warning,omitempty"`
}

// FoodTargetResult represents configured daily nutrition targets
type FoodTargetResult struct {
	Calories int `json:"calories"`
	Carbs    int `json:"carbs_g"`
	Protein  int `json:"protein_g"`
	Fat      int `json:"fat_g"`
}

// handleGetFoodIntake handles the get_food_intake tool
func (s *Server) handleGetFoodIntake(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, FoodIntakeResponse, error) {
	if err := s.ensureFeatureEnabled(ctx, "food"); err != nil {
		return nil, FoodIntakeResponse{}, err
	}

	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, FoodIntakeResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, FoodIntakeResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	slog.Info("[MCP] Fetching Food Logs for date range", "start", startDate, "end", endDate)

	userID := s.config.UserID

	var results []FoodIntakeResult

	// Fetch all food logs in a single query instead of day-by-day
	totalDays := int(endDate.Sub(startDate).Hours()/24) + 1
	logs, err := s.data.GetFoodLogs(ctx, userID, endDate, totalDays)
	if err != nil {
		return nil, FoodIntakeResponse{}, fmt.Errorf("failed to fetch food logs: %w", err)
	}

	// Helper to determine meal name based on time
	getMealName := func(t time.Time) string {
		hour := t.Hour()
		if hour >= 5 && hour < 11 {
			return "Breakfast"
		} else if hour >= 11 && hour < 16 {
			return "Lunch"
		} else if hour >= 16 && hour < 22 {
			return "Dinner"
		}
		return "Snack"
	}

	for _, l := range logs {
		res := FoodIntakeResult{
			EatenAt:  l.EatenAt.Format("2006-01-02 15:04"),
			Meal:     getMealName(l.EatenAt),
			Name:     l.Name,
			Weight:   l.Weight,
			Calories: l.Calories,
			Carbs:    l.Carbs,
			Protein:  l.Protein,
			Fat:      l.Fat,
		}
		results = append(results, res)
	}
	slog.Info("[MCP] Food intake query result",
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate))
	if len(results) == 0 {
		reason := noDataWarning("food intake logs", startDate, endDate, len(logs), len(results))
		warning = appendWarnings(warning, reason)
		slog.Warn("[MCP] Food intake query returned zero rows",
			"user_id", userID,
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"warning", warning)
	}

	targets, err := s.data.GetFoodTargets(ctx)
	if err != nil {
		return nil, FoodIntakeResponse{}, fmt.Errorf("failed to fetch food intake targets: %w", err)
	}
	var target *FoodTargetResult
	if targets.Calories > 0 || targets.Carbs > 0 || targets.Protein > 0 || targets.Fat > 0 {
		target = &FoodTargetResult{
			Calories: targets.Calories,
			Carbs:    targets.Carbs,
			Protein:  targets.Protein,
			Fat:      targets.Fat,
		}
	}

	response := FoodIntakeResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Target:  target,
		Warning: warning,
	}

	if shouldIncludeNotes(input.ExcludeNotes) {
		response.ContextNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Food",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

// LogFoodIntakeInput is the input type for the log_food_intake tool
type LogFoodIntakeInput struct {
	Name     string `json:"name"`
	EatenAt  string `json:"eaten_at"`
	Calories int    `json:"calories"`
	CarbsG   int    `json:"carbs_g"`
	ProteinG int    `json:"protein_g"`
	FatG     int    `json:"fat_g"`
	WeightG  int    `json:"weight_g"`
}

// LogFoodIntakeResponse is the response for the log_food_intake tool
type LogFoodIntakeResponse struct {
	ID      int64  `json:"id"`
	Message string `json:"message"`
}

// handleLogFoodIntake handles the log_food_intake tool
func (s *Server) handleLogFoodIntake(ctx context.Context, req *mcp.CallToolRequest, input LogFoodIntakeInput) (*mcp.CallToolResult, LogFoodIntakeResponse, error) {
	if s.foodWriter == nil {
		return nil, LogFoodIntakeResponse{}, fmt.Errorf("food write-through not configured (MCP_AUDIT_ENDPOINT and MCP_AUDIT_SECRET required)")
	}

	if err := s.ensureFeatureEnabled(ctx, "food"); err != nil {
		return nil, LogFoodIntakeResponse{}, err
	}

	if input.Name == "" {
		return nil, LogFoodIntakeResponse{}, fmt.Errorf("name is required")
	}
	if input.EatenAt == "" {
		return nil, LogFoodIntakeResponse{}, fmt.Errorf("eaten_at is required (format: YYYY-MM-DD HH:MM or RFC3339)")
	}

	// Parse eaten_at — accept RFC3339 or "YYYY-MM-DD HH:MM"
	var eatenAt time.Time
	var parseErr error
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04", "2006-01-02T15:04", "2006-01-02"} {
		eatenAt, parseErr = time.ParseInLocation(layout, strings.TrimSpace(input.EatenAt), time.Local)
		if parseErr == nil {
			break
		}
	}
	if parseErr != nil {
		return nil, LogFoodIntakeResponse{}, fmt.Errorf("invalid eaten_at %q: use YYYY-MM-DD HH:MM or RFC3339", input.EatenAt)
	}

	// Validate non-negative macros
	if input.Calories < 0 || input.CarbsG < 0 || input.ProteinG < 0 || input.FatG < 0 || input.WeightG < 0 {
		return nil, LogFoodIntakeResponse{}, fmt.Errorf("macro values and weight must be non-negative")
	}

	id, err := s.foodWriter.LogFood(ctx, foodLogPayload{
		Name:     input.Name,
		EatenAt:  eatenAt,
		Calories: input.Calories,
		CarbsG:   input.CarbsG,
		ProteinG: input.ProteinG,
		FatG:     input.FatG,
		WeightG:  input.WeightG,
	})
	if err != nil {
		slog.Error("[MCP] Failed to log food intake via HTTP", "error", err)
		return nil, LogFoodIntakeResponse{}, fmt.Errorf("failed to log food intake: %w", err)
	}

	slog.Info("[MCP] Food intake logged", "id", id, "name", input.Name, "eaten_at", eatenAt.Format("2006-01-02 15:04"))

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Food (write)",
			StartDate: eatenAt,
			EndDate:   eatenAt,
		})
	}

	return nil, LogFoodIntakeResponse{
		ID:      id,
		Message: fmt.Sprintf("Food intake logged: %s at %s (id=%d)", input.Name, eatenAt.Format("2006-01-02 15:04"), id),
	}, nil
}

// StepHistoryResult represents a daily step count for the tool response
type StepHistoryResult struct {
	Date     string `json:"date"`
	Steps    int    `json:"steps"`
	Calories int    `json:"calories"`
	Distance int    `json:"distance"`
}

// StepHistoryResponse is the response for the get_step_history tool
type StepHistoryResponse struct {
	Logs         []StepHistoryResult `json:"logs"`
	Count        int                 `json:"count"`
	Period       string              `json:"period"`
	ContextNotes []ContextNote       `json:"context_notes,omitempty"`
	Warning      string              `json:"warning,omitempty"`
}

// handleGetStepHistory handles the get_step_history tool
func (s *Server) handleGetStepHistory(ctx context.Context, req *mcp.CallToolRequest, input DateRangeInput) (*mcp.CallToolResult, StepHistoryResponse, error) {
	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, StepHistoryResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, StepHistoryResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	slog.Info("[MCP] Fetching Step History for date range", "start", startDate, "end", endDate)

	userID := s.config.UserID
	logs, err := s.data.GetDayStats(ctx, userID, startDate)
	if err != nil {
		slog.Error("[MCP] Failed to fetch step history", "error", err)
		return nil, StepHistoryResponse{}, err
	}
	slog.Info("[MCP] Found step history logs", "count", len(logs))

	var results []StepHistoryResult
	for _, l := range logs {
		t, err := time.Parse("2006-01-02", l.Day)
		if err == nil && t.After(endDate) {
			continue
		}

		res := StepHistoryResult{
			Date:     l.Day,
			Steps:    l.Steps,
			Calories: l.Calories,
			Distance: l.Distance,
		}

		results = append(results, res)
	}

	slog.Info("[MCP] Step history query result",
		"store_count", len(logs),
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate))
	if len(results) == 0 {
		emptyReason := noDataWarning("step history logs", startDate, endDate, len(logs), len(results))
		warning = appendWarnings(warning, emptyReason)
		slog.Warn("[MCP] Step history query returned zero rows",
			"user_id", userID,
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"warning", warning)
	}

	response := StepHistoryResponse{
		Logs:    results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	if shouldIncludeNotes(input.ExcludeNotes) {
		response.ContextNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "Steps",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

// DiaryNoteInput is the input type for the get_diary_notes tool
type DiaryNoteInput struct {
	StartDate string `json:"start_date"`
	EndDate   string `json:"end_date"`
	Limit     int    `json:"limit"`
}

// DiaryNoteResult represents a single diary note in the tool response
type DiaryNoteResult struct {
	ID        int64  `json:"id"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

// DiaryNoteResponse is the response for the get_diary_notes tool
type DiaryNoteResponse struct {
	Notes   []DiaryNoteResult `json:"notes"`
	Count   int               `json:"count"`
	Period  string            `json:"period"`
	Warning string            `json:"warning,omitempty"`
}

// handleGetDiaryNotes handles the get_diary_notes tool
func (s *Server) handleGetDiaryNotes(ctx context.Context, req *mcp.CallToolRequest, input DiaryNoteInput) (*mcp.CallToolResult, DiaryNoteResponse, error) {
	startStr, endStr, argsWarning, err := s.resolveDateRangeArgs(req, input.StartDate, input.EndDate)
	if err != nil {
		return nil, DiaryNoteResponse{}, err
	}
	startDate, endDate, warning, err := s.parseDateRange(startStr, endStr)
	if err != nil {
		return nil, DiaryNoteResponse{}, err
	}
	warning = appendWarnings(argsWarning, warning)

	limit := input.Limit
	if limit <= 0 {
		limit = 50
	}
	const maxDiaryNotesLimit = 1000
	if limit > maxDiaryNotesLimit {
		limit = maxDiaryNotesLimit
	}

	slog.Info("[MCP] Fetching Diary Notes for date range", "start", startDate, "end", endDate, "limit", limit)

	userID := s.config.UserID
	// Pass both startDate and endDate to the store so the SQL WHERE clause
	// applies both filters before LIMIT, preventing the 1000-row ceiling
	// from silently truncating notes within the requested date range.
	notes, err := s.data.ListDiaryNotes(ctx, userID, startDate, endDate, limit, 0)
	if err != nil {
		slog.Error("[MCP] Failed to fetch diary notes", "error", err)
		return nil, DiaryNoteResponse{}, err
	}
	slog.Info("[MCP] Found diary notes", "count", len(notes))

	var results []DiaryNoteResult
	for _, n := range notes {
		results = append(results, DiaryNoteResult{
			ID:        n.ID,
			Content:   n.Content,
			CreatedAt: n.CreatedAt.Format(time.RFC3339),
		})
	}

	slog.Info("[MCP] Diary notes query result",
		"store_count", len(notes),
		"returned_count", len(results),
		"period", formatPeriod(startDate, endDate))
	if len(results) == 0 {
		emptyReason := noDataWarning("diary notes", startDate, endDate, len(notes), len(results))
		warning = appendWarnings(warning, emptyReason)
		slog.Warn("[MCP] Diary notes query returned zero rows",
			"user_id", userID,
			"start", startDate.Format(time.RFC3339),
			"end", endDate.Format(time.RFC3339),
			"warning", warning)
	}

	response := DiaryNoteResponse{
		Notes:   results,
		Count:   len(results),
		Period:  formatPeriod(startDate, endDate),
		Warning: warning,
	}

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "DiaryNotes",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}
