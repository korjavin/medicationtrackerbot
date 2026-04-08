package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (s *Server) getFeatureMap(ctx context.Context) (map[string]bool, error) {
	foodEnabled, err := s.settings.GetFoodIntakeEnabled(ctx)
	if err != nil {
		return nil, err
	}
	bpEnabled, err := s.settings.GetBloodPressureEnabled(ctx)
	if err != nil {
		return nil, err
	}
	weightEnabled, err := s.settings.GetWeightEnabled(ctx)
	if err != nil {
		return nil, err
	}
	medicationEnabled, err := s.settings.GetMedicationEnabled(ctx)
	if err != nil {
		return nil, err
	}
	workoutEnabled, err := s.settings.GetWorkoutEnabled(ctx)
	if err != nil {
		return nil, err
	}
	healthEnabled, err := s.settings.GetHealthEnabled(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]bool{
		"food":       foodEnabled,
		"bp":         bpEnabled,
		"weight":     weightEnabled,
		"medication": medicationEnabled,
		"workout":    workoutEnabled,
		"health":     healthEnabled,
	}, nil
}

func (s *Server) handleGetFeatureSettings(w http.ResponseWriter, r *http.Request) {
	features, err := s.getFeatureMap(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(features)
}

// handleInit returns all data needed to render the app on first load.
func (s *Server) handleInit(w http.ResponseWriter, r *http.Request) {
	features, err := s.getFeatureMap(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"features": features,
	})
}

type weightGoalBootstrapResponse struct {
	Goal          *float64   `json:"goal,omitempty"`
	GoalDate      *time.Time `json:"goal_date,omitempty"`
	HighestWeight *float64   `json:"highest_weight,omitempty"`
	HighestDate   *time.Time `json:"highest_date,omitempty"`
}

// computeNextIntakeData returns the nearest scheduled intake in the next 12h window.
func (s *Server) computeNextIntakeData(now time.Time) (time.Time, []string, error) {
	meds, err := s.meds.ListMedications(false)
	if err != nil {
		return time.Time{}, nil, err
	}

	var nextTime time.Time
	var nextMeds []store.Medication

	for _, med := range meds {
		cfg, err := med.ValidSchedule()
		if err != nil || cfg.Type == "as_needed" {
			continue
		}

		for daysAhead := 0; daysAhead < 1; daysAhead++ {
			checkDay := now.AddDate(0, 0, daysAhead)

			if cfg.Type == "weekly" {
				found := false
				dayIdx := int(checkDay.Weekday())
				for _, d := range cfg.Days {
					if d == dayIdx {
						found = true
						break
					}
				}
				if !found {
					continue
				}
			}

			for _, timeStr := range cfg.Times {
				if len(timeStr) != 5 {
					continue
				}
				var hour, minute int
				_, _ = fmt.Sscanf(timeStr, "%d:%d", &hour, &minute)

				target := time.Date(checkDay.Year(), checkDay.Month(), checkDay.Day(), hour, minute, 0, 0, now.Location())
				if target.Before(now) {
					continue
				}
				if target.Sub(now) > 12*time.Hour {
					continue
				}
				if med.StartDate != nil && target.Before(*med.StartDate) {
					continue
				}
				if med.EndDate != nil && target.After(*med.EndDate) {
					continue
				}

				intake, _ := s.meds.GetIntakeBySchedule(med.ID, target)
				if intake != nil && (intake.Status == "TAKEN" || intake.Status == "SKIPPED") {
					continue
				}

				if nextTime.IsZero() || target.Before(nextTime) {
					nextTime = target
					nextMeds = []store.Medication{med}
				} else if target.Equal(nextTime) {
					nextMeds = append(nextMeds, med)
				}
			}
		}
	}

	if len(nextMeds) == 0 {
		return time.Time{}, nil, nil
	}

	names := make([]string, len(nextMeds))
	for i, m := range nextMeds {
		names[i] = m.Name
	}

	return nextTime, names, nil
}

// handleBootstrap returns a broad initial snapshot to minimize first-load request fanout.
func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	tgUser, ok := r.Context().Value(UserCtxKey).(*TelegramUser)
	if !ok || tgUser == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	ctx := context.Background()
	now := time.Now()
	userID := tgUser.ID
	bootstrapCursor := s.currentChangeCursor()

	features, err := s.getFeatureMap(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	medications, err := s.meds.ListMedications(true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	historyDefault, err := s.meds.GetIntakeHistory(0, 3)
	if err != nil {
		slog.Error("bootstrap history query failed", "error", err)
		historyDefault = []store.IntakeLog{}
	}

	var nextIntake any
	nextTime, nextNames, err := s.computeNextIntakeData(now)
	if err != nil {
		slog.Error("bootstrap next intake query failed", "error", err)
	} else if !nextTime.IsZero() {
		nextIntake = map[string]any{
			"scheduled_at":     nextTime.Format(time.RFC3339),
			"medication_names": nextNames,
		}
	}

	bpSince := now.AddDate(0, 0, -60)
	bpReadings, err := s.bp.GetBloodPressureReadings(ctx, userID, bpSince)
	if err != nil {
		slog.Error("bootstrap bp readings query failed", "error", err)
		bpReadings = []store.BloodPressure{}
	}
	bpGoal, err := s.bp.GetBPGoal()
	if err != nil {
		slog.Error("bootstrap bp goal query failed", "error", err)
		bpGoal = nil
	}
	bpStats, err := s.bp.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		slog.Error("bootstrap bp stats query failed", "error", err)
		bpStats = nil
	}

	weightSince := now.AddDate(0, 0, -35)
	weightLogs, err := s.weight.GetWeightLogs(ctx, userID, weightSince)
	if err != nil {
		slog.Error("bootstrap weight logs query failed", "error", err)
		weightLogs = []store.WeightLog{}
	}
	weightGoal, err := s.weight.GetWeightGoal()
	if err != nil {
		slog.Error("bootstrap weight goal query failed", "error", err)
		weightGoal = nil
	}
	highestRecord, err := s.weight.GetHighestWeightRecord(ctx, userID)
	if err != nil {
		slog.Error("bootstrap highest weight query failed", "error", err)
		highestRecord = nil
	}
	weightGoalResponse := &weightGoalBootstrapResponse{}
	if weightGoal != nil {
		weightGoalResponse.Goal = weightGoal.Goal
		weightGoalResponse.GoalDate = weightGoal.GoalDate
	}
	if highestRecord != nil {
		weightGoalResponse.HighestWeight = &highestRecord.Weight
		weightGoalResponse.HighestDate = &highestRecord.MeasuredAt
	}

	foodTargets, err := s.food.GetFoodTargets(ctx)
	if err != nil {
		slog.Error("bootstrap food targets query failed", "error", err)
		foodTargets = store.FoodTargets{}
	}
	bpReminderStatus, err := s.bp.GetBPReminderState(userID)
	if err != nil {
		slog.Error("bootstrap bp reminder state query failed", "error", err)
		bpReminderStatus = nil
	}
	weightReminderStatus, err := s.weight.GetWeightReminderState(userID)
	if err != nil {
		slog.Error("bootstrap weight reminder state query failed", "error", err)
		weightReminderStatus = nil
	}

	var tabOrder any
	tabOrderStr, err := s.settings.GetTabOrder(ctx)
	if err != nil {
		slog.Error("bootstrap tab order query failed", "error", err)
	} else if tabOrderStr != "" {
		if err := json.Unmarshal([]byte(tabOrderStr), &tabOrder); err != nil {
			slog.Error("bootstrap invalid tab order json", "error", err)
		}
	}

	currentTimezone, err := s.settings.GetCurrentTimezone()
	if err != nil {
		slog.Error("bootstrap timezone query failed", "error", err)
	}

	response := map[string]any{
		"cursor":          bootstrapCursor,
		"features":        features,
		"medications":     medications,
		"history_default": historyDefault,
		"next_intake":     nextIntake,
		"bp": map[string]any{
			"readings": bpReadings,
			"goal":     bpGoal,
			"stats":    bpStats,
		},
		"weight": map[string]any{
			"logs": weightLogs,
			"goal": weightGoalResponse,
		},
		"settings": map[string]any{
			"food_targets":           foodTargets,
			"bp_reminder_status":     bpReminderStatus,
			"weight_reminder_status": weightReminderStatus,
			"tab_order":              tabOrder,
			"timezone":               currentTimezone,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSetFeatureEnabled(w http.ResponseWriter, r *http.Request) {
	feature := r.PathValue("feature")
	var req struct {
		Enabled bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	var err error
	switch feature {
	case "food":
		err = s.settings.SetFoodIntakeEnabled(ctx, req.Enabled)
	case "bp":
		err = s.settings.SetBloodPressureEnabled(ctx, req.Enabled)
	case "weight":
		err = s.settings.SetWeightEnabled(ctx, req.Enabled)
	case "medication":
		err = s.settings.SetMedicationEnabled(ctx, req.Enabled)
	case "workout":
		err = s.settings.SetWorkoutEnabled(ctx, req.Enabled)
	case "health":
		err = s.settings.SetHealthEnabled(ctx, req.Enabled)
	default:
		http.Error(w, "Unknown feature", http.StatusBadRequest)
		return
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	tz, err := s.settings.GetCurrentTimezone()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	now := time.Now()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"timezone":        tz,
		"server_time":     now.Format(time.RFC3339),
		"server_timezone": formatServerTimezone(now),
	})
}

func formatServerTimezone(now time.Time) string {
	name, offsetSeconds := now.Zone()
	sign := "+"
	if offsetSeconds < 0 {
		sign = "-"
		offsetSeconds = -offsetSeconds
	}
	hours := offsetSeconds / 3600
	minutes := (offsetSeconds % 3600) / 60
	if name == "" {
		return fmt.Sprintf("UTC%s%02d:%02d", sign, hours, minutes)
	}
	return fmt.Sprintf("%s (UTC%s%02d:%02d)", name, sign, hours, minutes)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Timezone string `json:"timezone"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Timezone != "" {
		if _, err := time.LoadLocation(req.Timezone); err != nil {
			http.Error(w, "Invalid timezone: "+req.Timezone, http.StatusBadRequest)
			return
		}
		// Capture the current timezone before the update so we can detect a change.
		oldTZ, err := s.settings.GetCurrentTimezone()
		if err != nil {
			slog.Error("handleUpdateSettings: GetCurrentTimezone before update failed", "error", err)
		}
		if err := s.settings.RecordTimezone(req.Timezone); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Trigger plan generation only when the stored timezone string actually changed.
		if s.tzPlanner != nil && oldTZ != req.Timezone {
			if err := s.tzPlanner.GenerateIfChanged(oldTZ, req.Timezone, time.Now()); err != nil {
				slog.Error("handleUpdateSettings: GenerateIfChanged failed", "error", err)
				// Intentionally not returning an error — plan generation is best-effort.
			}
		}
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSetTabOrder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Order []string `json:"order"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate tab IDs
	validTabs := map[string]bool{
		"bp":       true,
		"weight":   true,
		"workouts": true,
		"food":     true,
		"health":   true,
		"meds":     true,
		"settings": true,
	}

	for _, tab := range req.Order {
		if !validTabs[tab] {
			http.Error(w, "Unknown tab ID: "+tab, http.StatusBadRequest)
			return
		}
	}

	ctx := context.Background()
	orderJSON, err := json.Marshal(req.Order)
	if err != nil {
		http.Error(w, "Failed to marshal order", http.StatusInternalServerError)
		return
	}

	if err := s.settings.SetTabOrder(ctx, string(orderJSON)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}
