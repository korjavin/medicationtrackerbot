package mcp

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// AnalyzeFitnessInput is the input type for the analyze_fitness tool
type AnalyzeFitnessInput struct {
	StartDate    string `json:"start_date"`
	EndDate      string `json:"end_date"`
	Days         int    `json:"days"`
	ExcludeNotes bool   `json:"exclude_notes"`
}

// -- Response sub-structures --

type WorkoutsSection struct {
	Sessions       []WorkoutSessionResult `json:"sessions"`
	TotalSessions  int                    `json:"total_sessions"`
	CompletionRate float64                `json:"completion_rate"`
}

type StepsSection struct {
	Daily         []StepHistoryResult `json:"daily"`
	AvgDailySteps int                 `json:"avg_daily_steps"`
}

type NutritionDailyTotal struct {
	Date     string `json:"date"`
	Calories int    `json:"calories"`
	ProteinG int    `json:"protein_g"`
	CarbsG   int    `json:"carbs_g"`
	FatG     int    `json:"fat_g"`
}

type NutritionSection struct {
	DailyTotals     []NutritionDailyTotal `json:"daily_totals"`
	AvgDailyCalories int                  `json:"avg_daily_calories"`
	AvgDailyProtein  int                  `json:"avg_daily_protein"`
}

type WeightSection struct {
	Logs           []WeightResult `json:"logs"`
	CurrentKg      *float64       `json:"current_kg,omitempty"`
	TrendDirection string         `json:"trend_direction,omitempty"`
	ChangeKg       *float64       `json:"change_kg,omitempty"`
}

// AnalyzeFitnessResponse is the response for the analyze_fitness tool
type AnalyzeFitnessResponse struct {
	Period     string            `json:"period"`
	Workouts   *WorkoutsSection  `json:"workouts,omitempty"`
	Steps      *StepsSection     `json:"steps,omitempty"`
	Nutrition  *NutritionSection `json:"nutrition,omitempty"`
	Weight     *WeightSection    `json:"weight,omitempty"`
	DiaryNotes []ContextNote     `json:"diary_notes,omitempty"`
	Warning    string            `json:"warning,omitempty"`
}

// handleAnalyzeFitness handles the analyze_fitness composite tool
func (s *Server) handleAnalyzeFitness(ctx context.Context, req *sdkmcp.CallToolRequest, input AnalyzeFitnessInput) (*sdkmcp.CallToolResult, AnalyzeFitnessResponse, error) {
	startDate, endDate, warning, err := s.resolveCompositeRange(req, input.StartDate, input.EndDate, input.Days)
	if err != nil {
		return nil, AnalyzeFitnessResponse{}, err
	}

	userID := s.config.UserID
	period := formatPeriod(startDate, endDate)
	var unavailable []string

	response := AnalyzeFitnessResponse{
		Period: period,
	}

	// Workouts
	if wkEnabled, err := s.data.GetWorkoutEnabled(ctx); err != nil {
		slog.Warn("[MCP] FitnessAnalysis: failed to check workout feature", "error", err)
		unavailable = append(unavailable, "workouts (error checking feature)")
	} else if wkEnabled {
		response.Workouts = s.fetchWorkoutsSection(ctx, userID, startDate, endDate)
	} else {
		unavailable = append(unavailable, "workouts (feature disabled)")
	}

	// Steps (no feature gate)
	response.Steps = s.fetchStepsSection(ctx, userID, startDate, endDate)

	// Nutrition
	if foodEnabled, err := s.data.GetFoodIntakeEnabled(ctx); err != nil {
		slog.Warn("[MCP] FitnessAnalysis: failed to check food intake feature", "error", err)
		unavailable = append(unavailable, "nutrition (error checking feature)")
	} else if foodEnabled {
		response.Nutrition = s.fetchNutritionSection(ctx, userID, startDate, endDate)
	} else {
		unavailable = append(unavailable, "nutrition (feature disabled)")
	}

	// Weight
	if weightEnabled, err := s.data.GetWeightEnabled(ctx); err != nil {
		slog.Warn("[MCP] FitnessAnalysis: failed to check weight feature", "error", err)
		unavailable = append(unavailable, "weight (error checking feature)")
	} else if weightEnabled {
		response.Weight = s.fetchWeightSection(ctx, userID, startDate, endDate)
	} else {
		unavailable = append(unavailable, "weight (feature disabled)")
	}

	// Diary Notes
	if shouldIncludeNotes(input.ExcludeNotes) {
		response.DiaryNotes = s.fetchContextNotes(ctx, startDate, endDate)
	}

	if len(unavailable) > 0 {
		unavailWarning := "Unavailable sections: " + strings.Join(unavailable, ", ") + "."
		warning = appendWarnings(warning, unavailWarning)
	}
	response.Warning = warning

	if s.audit != nil {
		s.audit.Record(AuditEvent{
			DataType:  "FitnessAnalysis",
			StartDate: startDate,
			EndDate:   endDate,
		})
	}

	return nil, response, nil
}

func (s *Server) fetchWorkoutsSection(ctx context.Context, userID int64, startDate, endDate time.Time) *WorkoutsSection {
	sessions, err := s.data.GetWorkoutHistory(userID, 1000)
	if err != nil {
		slog.Warn("[MCP] FitnessAnalysis: failed to fetch workouts", "error", err)
		return nil
	}

	var results []WorkoutSessionResult
	var totalSessions, completedSessions int

	for _, session := range sessions {
		if session.ScheduledDate.Before(startDate) || session.ScheduledDate.After(endDate) {
			continue
		}
		totalSessions++
		if session.Status == "completed" {
			completedSessions++
		}

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

		results = append(results, result)
	}

	// Include MiBand workouts
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

			if startTime.Before(startDate) || startTime.After(endDate) {
				continue
			}

			totalSessions++
			completedSessions++

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

	// Sort by date descending
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

	completionRate := 0.0
	if totalSessions > 0 {
		completionRate = float64(completedSessions) / float64(totalSessions) * 100
	}

	return &WorkoutsSection{
		Sessions:       results,
		TotalSessions:  totalSessions,
		CompletionRate: completionRate,
	}
}

func (s *Server) fetchStepsSection(ctx context.Context, userID int64, startDate, endDate time.Time) *StepsSection {
	stats, err := s.data.GetDayStats(ctx, userID, startDate)
	if err != nil {
		slog.Warn("[MCP] FitnessAnalysis: failed to fetch steps", "error", err)
		return nil
	}

	var results []StepHistoryResult
	totalSteps := 0
	for _, st := range stats {
		t, err := time.Parse("2006-01-02", st.Day)
		if err != nil {
			slog.Warn("[MCP] FitnessAnalysis: skipping step entry with invalid date", "day", st.Day, "error", err)
			continue
		}
		if t.After(endDate) {
			continue
		}
		results = append(results, StepHistoryResult{
			Date:     st.Day,
			Steps:    st.Steps,
			Calories: st.Calories,
			Distance: st.Distance,
		})
		totalSteps += st.Steps
	}

	avgSteps := 0
	if len(results) > 0 {
		avgSteps = totalSteps / len(results)
	}

	return &StepsSection{
		Daily:         results,
		AvgDailySteps: avgSteps,
	}
}

func (s *Server) fetchNutritionSection(ctx context.Context, userID int64, startDate, endDate time.Time) *NutritionSection {
	// Aggregate food logs by day, returning only totals (no food names for privacy)
	// Fetch all logs in one query instead of day-by-day
	// Count calendar days using date arithmetic (not duration) to avoid DST off-by-one errors
	startDay := time.Date(startDate.Year(), startDate.Month(), startDate.Day(), 0, 0, 0, 0, startDate.Location())
	endDay := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, endDate.Location())
	totalDays := 0
	for d := startDay; !d.After(endDay); d = d.AddDate(0, 0, 1) {
		totalDays++
	}
	allLogs, err := s.data.GetFoodLogs(ctx, userID, endDate, totalDays)
	if err != nil {
		slog.Warn("[MCP] FitnessAnalysis: failed to fetch food logs", "error", err)
		return nil
	}

	// Group logs by day
	dayMap := make(map[string]*NutritionDailyTotal)
	for _, l := range allLogs {
		day := l.EatenAt.Format("2006-01-02")
		dt, ok := dayMap[day]
		if !ok {
			dt = &NutritionDailyTotal{Date: day}
			dayMap[day] = dt
		}
		dt.Calories += l.Calories
		dt.ProteinG += l.Protein
		dt.CarbsG += l.Carbs
		dt.FatG += l.Fat
	}

	// Collect and sort daily totals
	var dailyTotals []NutritionDailyTotal
	totalCalories := 0
	totalProtein := 0
	for _, dt := range dayMap {
		dailyTotals = append(dailyTotals, *dt)
		totalCalories += dt.Calories
		totalProtein += dt.ProteinG
	}
	sort.Slice(dailyTotals, func(i, j int) bool {
		return dailyTotals[i].Date < dailyTotals[j].Date
	})
	daysWithData := len(dailyTotals)

	avgCalories := 0
	avgProtein := 0
	if daysWithData > 0 {
		avgCalories = totalCalories / daysWithData
		avgProtein = totalProtein / daysWithData
	}

	return &NutritionSection{
		DailyTotals:      dailyTotals,
		AvgDailyCalories: avgCalories,
		AvgDailyProtein:  avgProtein,
	}
}

func (s *Server) fetchWeightSection(ctx context.Context, userID int64, startDate, endDate time.Time) *WeightSection {
	logs, err := s.data.GetWeightLogs(ctx, userID, startDate)
	if err != nil {
		slog.Warn("[MCP] FitnessAnalysis: failed to fetch weight", "error", err)
		return nil
	}

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

	section := &WeightSection{
		Logs: results,
	}

	if len(results) > 0 {
		// Most recent weight (results are ordered by measured_at DESC from store)
		current := results[0].Weight
		section.CurrentKg = &current

		// Calculate change and trend direction
		if len(results) >= 2 {
			oldest := results[len(results)-1].Weight
			change := current - oldest
			section.ChangeKg = &change
			if change > 0.1 {
				section.TrendDirection = "gaining"
			} else if change < -0.1 {
				section.TrendDirection = "losing"
			} else {
				section.TrendDirection = "stable"
			}
		} else {
			section.TrendDirection = "insufficient_data"
		}
	}

	return section
}

// registerFitnessTool registers the analyze_fitness composite tool
func registerFitnessTool(mcpServer *sdkmcp.Server, s *Server) {
	sdkmcp.AddTool(mcpServer,
		&sdkmcp.Tool{
			Name:        "analyze_fitness",
			Description: "Comprehensive fitness and nutrition analysis. Returns workout sessions (gym and outdoor), daily step counts, daily calorie/protein/carb/fat totals (food names omitted for privacy), weight trend, and personal diary notes — all in one call. Maximum 90 days per query. Use this for questions about training, nutrition balance, weight progress, or activity levels.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to 30 days before end_date if both start_date and days are omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					},
					"days": {
						"type": "integer",
						"description": "Number of days to look back from end_date. Alternative to start_date — e.g. days=30 means last 30 days. Ignored if start_date is provided."
					},
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Default false."
					}
				}
			}`),
		},
		s.handleAnalyzeFitness,
	)
}
