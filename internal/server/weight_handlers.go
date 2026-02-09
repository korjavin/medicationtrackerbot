package server

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (s *Server) handleCreateWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		MeasuredAt time.Time `json:"measured_at"`
		Weight     float64   `json:"weight"`
		BodyFat    *float64  `json:"body_fat,omitempty"`
		MuscleMass *float64  `json:"muscle_mass,omitempty"`
		Notes      string    `json:"notes,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Get last weight log to calculate trend
	lastLog, err := s.store.GetLastWeightLog(r.Context(), userID)
	if err != nil {
		// Log error but continue
	}

	var previousTrend *float64
	if lastLog != nil && lastLog.WeightTrend != nil {
		previousTrend = lastLog.WeightTrend
	}

	weightTrend := store.CalculateWeightTrend(req.Weight, previousTrend)

	wLog := &store.WeightLog{
		UserID:      userID,
		MeasuredAt:  req.MeasuredAt,
		Weight:      req.Weight,
		WeightTrend: &weightTrend,
		BodyFat:     req.BodyFat,
		MuscleMass:  req.MuscleMass,
		Notes:       req.Notes,
	}

	id, err := s.store.CreateWeightLog(r.Context(), wLog)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	wLog.ID = id
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(wLog)
}

func (s *Server) handleListWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Parse query params
	days := 30 // Default
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil {
			days = d
		}
	}

	var since time.Time
	if days > 0 {
		since = time.Now().AddDate(0, 0, -days)
	}

	limit := 100 // Default
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil {
			limit = l
		}
	}

	logs, err := s.store.GetWeightLogs(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if limit > 0 && len(logs) > limit {
		logs = logs[:limit]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(logs)
}

func (s *Server) handleDeleteWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.store.DeleteWeightLog(r.Context(), id, userID); err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "Weight log not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleExportWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Parse query params
	var since time.Time
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if days, err := strconv.Atoi(dStr); err == nil && days > 0 {
			since = time.Now().AddDate(0, 0, -days)
		}
	}

	logs, err := s.store.GetWeightLogs(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=weight_export.csv")

	wr := csv.NewWriter(w)
	defer wr.Flush()

	// Write CSV header in Libra format
	wr.Write([]string{"#Version: 6"})
	wr.Write([]string{"#Units: kg"})
	wr.Write([]string{""})
	wr.Write([]string{"#date;weight;weight trend;body fat;body fat trend;muscle mass;muscle mass trend;log"})

	// Write data rows
	for _, wLog := range logs {
		weight := fmt.Sprintf("%.1f", wLog.Weight)
		weightTrend := ""
		if wLog.WeightTrend != nil {
			weightTrend = fmt.Sprintf("%.1f", *wLog.WeightTrend)
		}

		bodyFat := ""
		if wLog.BodyFat != nil {
			bodyFat = fmt.Sprintf("%.1f", *wLog.BodyFat)
		}

		bodyFatTrend := ""
		if wLog.BodyFatTrend != nil {
			bodyFatTrend = fmt.Sprintf("%.1f", *wLog.BodyFatTrend)
		}

		muscleMass := ""
		if wLog.MuscleMass != nil {
			muscleMass = fmt.Sprintf("%.1f", *wLog.MuscleMass)
		}

		muscleMassTrend := ""
		if wLog.MuscleMassTrend != nil {
			muscleMassTrend = fmt.Sprintf("%.1f", *wLog.MuscleMassTrend)
		}

		notes := strings.ReplaceAll(wLog.Notes, "\n", " ")
		notes = strings.ReplaceAll(notes, "\r", "")

		row := []string{
			wLog.MeasuredAt.Format("2006-01-02T15:04:05.000Z") + ";" + weight + ";" + weightTrend + ";" + bodyFat + ";" + bodyFatTrend + ";" + muscleMass + ";" + muscleMassTrend + ";" + notes,
		}
		if err := wr.Write(row); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
}

func (s *Server) handleGetWeightGoal(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	goal, err := s.store.GetWeightGoal()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get highest weight record for diet plan line
	highestRecord, err := s.store.GetHighestWeightRecord(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Extended response with highest weight metadata
	type WeightGoalResponse struct {
		Goal          *float64   `json:"goal,omitempty"`
		GoalDate      *time.Time `json:"goal_date,omitempty"`
		HighestWeight *float64   `json:"highest_weight,omitempty"`
		HighestDate   *time.Time `json:"highest_date,omitempty"`
	}

	response := WeightGoalResponse{
		Goal:     goal.Goal,
		GoalDate: goal.GoalDate,
	}

	if highestRecord != nil {
		response.HighestWeight = &highestRecord.Weight
		response.HighestDate = &highestRecord.MeasuredAt
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// Weight Reminder handlers

func (s *Server) handleGetWeightReminderStatus(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	state, err := s.store.GetWeightReminderState(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}

func (s *Server) handleToggleWeightReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if err := s.store.SetWeightReminderEnabled(userID, req.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled": req.Enabled,
		"status":  "success",
	})
}

func (s *Server) handleSnoozeWeightReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	if err := s.store.SnoozeWeightReminder(userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "Weight reminder snoozed for 2 hours",
	})
}

func (s *Server) handleDontBugMeWeightReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	if err := s.store.DontBugMeWeightReminder(userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "Weight reminders disabled for 24 hours",
	})
}
