package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
		log.Printf("[bootstrap] history query failed: %v", err)
		historyDefault = []store.IntakeLog{}
	}

	var nextIntake any
	nextTime, nextNames, err := s.computeNextIntakeData(now)
	if err != nil {
		log.Printf("[bootstrap] next intake query failed: %v", err)
	} else if !nextTime.IsZero() {
		nextIntake = map[string]any{
			"scheduled_at":     nextTime.Format(time.RFC3339),
			"medication_names": nextNames,
		}
	}

	bpSince := now.AddDate(0, 0, -60)
	bpReadings, err := s.bp.GetBloodPressureReadings(ctx, userID, bpSince)
	if err != nil {
		log.Printf("[bootstrap] bp readings query failed: %v", err)
		bpReadings = []store.BloodPressure{}
	}
	bpGoal, err := s.bp.GetBPGoal()
	if err != nil {
		log.Printf("[bootstrap] bp goal query failed: %v", err)
		bpGoal = nil
	}
	bpStats, err := s.bp.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		log.Printf("[bootstrap] bp stats query failed: %v", err)
		bpStats = nil
	}

	weightSince := now.AddDate(0, 0, -35)
	weightLogs, err := s.weight.GetWeightLogs(ctx, userID, weightSince)
	if err != nil {
		log.Printf("[bootstrap] weight logs query failed: %v", err)
		weightLogs = []store.WeightLog{}
	}
	weightGoal, err := s.weight.GetWeightGoal()
	if err != nil {
		log.Printf("[bootstrap] weight goal query failed: %v", err)
		weightGoal = nil
	}
	highestRecord, err := s.weight.GetHighestWeightRecord(ctx, userID)
	if err != nil {
		log.Printf("[bootstrap] highest weight query failed: %v", err)
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
		log.Printf("[bootstrap] food targets query failed: %v", err)
		foodTargets = store.FoodTargets{}
	}
	bpReminderStatus, err := s.bp.GetBPReminderState(userID)
	if err != nil {
		log.Printf("[bootstrap] bp reminder state query failed: %v", err)
		bpReminderStatus = nil
	}
	weightReminderStatus, err := s.weight.GetWeightReminderState(userID)
	if err != nil {
		log.Printf("[bootstrap] weight reminder state query failed: %v", err)
		weightReminderStatus = nil
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
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleSetFeatureEnabled(w http.ResponseWriter, r *http.Request) {
	feature := r.PathValue("feature")
	var req struct {
		Enabled bool `json:"enabled"`
	}
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
