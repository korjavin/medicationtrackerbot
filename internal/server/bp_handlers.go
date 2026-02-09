package server

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (s *Server) handleCreateBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		MeasuredAt time.Time `json:"measured_at"`
		Systolic   int       `json:"systolic"`
		Diastolic  int       `json:"diastolic"`
		Pulse      *int      `json:"pulse,omitempty"`
		Site       string    `json:"site,omitempty"`
		Position   string    `json:"position,omitempty"`
		Notes      string    `json:"notes,omitempty"`
		Tag        string    `json:"tag,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	bp := &store.BloodPressure{
		UserID:     userID,
		MeasuredAt: req.MeasuredAt,
		Systolic:   req.Systolic,
		Diastolic:  req.Diastolic,
		Pulse:      req.Pulse,
		Site:       req.Site,
		Position:   req.Position,
		Notes:      req.Notes,
		Tag:        req.Tag,
	}

	id, err := s.store.CreateBloodPressureReading(r.Context(), bp)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	bp.ID = id
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(bp)
}

func (s *Server) handleListBloodPressure(w http.ResponseWriter, r *http.Request) {
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

	readings, err := s.store.GetBloodPressureReadings(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if limit > 0 && len(readings) > limit {
		readings = readings[:limit]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(readings)
}

func (s *Server) handleDeleteBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.store.DeleteBloodPressureReading(r.Context(), id, userID); err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "Reading not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleImportBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Readings []struct {
			MeasuredAt time.Time `json:"measured_at"`
			Systolic   int       `json:"systolic"`
			Diastolic  int       `json:"diastolic"`
			Pulse      *int      `json:"pulse,omitempty"`
			Site       string    `json:"site,omitempty"`
			Position   string    `json:"position,omitempty"`
			Notes      string    `json:"notes,omitempty"`
			Tag        string    `json:"tag,omitempty"`
		} `json:"readings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	readings := make([]store.BloodPressure, len(req.Readings))
	for i, r := range req.Readings {
		readings[i] = store.BloodPressure{
			MeasuredAt: r.MeasuredAt,
			Systolic:   r.Systolic,
			Diastolic:  r.Diastolic,
			Pulse:      r.Pulse,
			Site:       r.Site,
			Position:   r.Position,
			Notes:      r.Notes,
			Tag:        r.Tag,
		}
	}

	if err := s.store.ImportBloodPressureReadings(r.Context(), userID, readings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"imported": len(readings),
		"status":   "success",
	})
}

func (s *Server) handleExportBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Parse query params
	var since time.Time
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if days, err := strconv.Atoi(dStr); err == nil && days > 0 {
			since = time.Now().AddDate(0, 0, -days)
		}
	}

	readings, err := s.store.GetBloodPressureReadings(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=blood_pressure_export.csv")

	wr := csv.NewWriter(w)
	defer wr.Flush()

	// Write CSV header
	header := []string{"Date", "Systolic", "Diastolic", "Pulse", "Site", "Position", "Category", "Notes", "Tag"}
	if err := wr.Write(header); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Write data rows
	for _, bp := range readings {
		pulse := ""
		if bp.Pulse != nil {
			pulse = strconv.Itoa(*bp.Pulse)
		}

		notes := strings.ReplaceAll(bp.Notes, "\n", " ")
		notes = strings.ReplaceAll(notes, "\r", "")

		row := []string{
			bp.MeasuredAt.Format(time.RFC3339),
			strconv.Itoa(bp.Systolic),
			strconv.Itoa(bp.Diastolic),
			pulse,
			bp.Site,
			bp.Position,
			bp.Category,
			notes,
			bp.Tag,
		}
		if err := wr.Write(row); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
}

func (s *Server) handleGetBPGoal(w http.ResponseWriter, r *http.Request) {
	goal, err := s.store.GetBPGoal()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(goal)
}

func (s *Server) handleGetBPStats(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	stats, err := s.store.GetBPDailyWeightedStats(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// BP Reminder handlers

func (s *Server) handleGetBPReminderStatus(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	state, err := s.store.GetBPReminderState(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}

func (s *Server) handleToggleBPReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.store.SetBPReminderEnabled(userID, req.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled": req.Enabled,
		"status":  "success",
	})
}

func (s *Server) handleSnoozeBPReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	if err := s.store.SnoozeBPReminder(userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "BP reminder snoozed for 2 hours",
	})
}

func (s *Server) handleDontBugMeBPReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	if err := s.store.DontBugMeBPReminder(userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "BP reminders disabled for 24 hours",
	})
}
