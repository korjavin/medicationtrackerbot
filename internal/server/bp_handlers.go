package server

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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

	id, err := s.bp.CreateBloodPressureReading(r.Context(), bp)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Cross-channel sync: if reminder is handled from web, clear notification.
	if state, err := s.bp.GetBPReminderState(userID); err == nil && state != nil {
		if state.NotificationMessageID != nil {
			s.deleteNotification(r.Context(), *state.NotificationMessageID)
		}
		_ = s.bp.ClearBPReminderNotificationMessage(userID)
	}

	bp.ID = id
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(bp); err != nil {
		slog.Error("encode response", "error", err)
	}
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

	readings, err := s.bp.GetBloodPressureReadings(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if limit > 0 && len(readings) > limit {
		readings = readings[:limit]
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(readings); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleDeleteBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.bp.DeleteBloodPressureReading(r.Context(), id, userID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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

	if err := s.bp.ImportBloodPressureReadings(r.Context(), userID, readings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"imported": len(readings),
		"status":   "success",
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
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

	readings, err := s.bp.GetBloodPressureReadings(r.Context(), userID, since)
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
	goal, err := s.bp.GetBPGoal()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(goal); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleGetBPStats(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	stats, err := s.bp.GetBPDailyWeightedStats(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// BP Reminder handlers

func (s *Server) handleGetBPReminderStatus(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	state, err := s.bp.GetBPReminderState(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(state); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleToggleBPReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Enabled bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.bp.SetBPReminderEnabled(userID, req.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled": req.Enabled,
		"status":  "success",
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSnoozeBPReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	if err := s.bp.SnoozeBPReminder(userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Cross-channel sync: remove notification when snoozed from web/push.
	if state, err := s.bp.GetBPReminderState(userID); err == nil && state != nil {
		if state.NotificationMessageID != nil {
			s.deleteNotification(r.Context(), *state.NotificationMessageID)
		}
		_ = s.bp.ClearBPReminderNotificationMessage(userID)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "BP reminder snoozed for 2 hours",
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleDontBugMeBPReminder(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	if err := s.bp.DontBugMeBPReminder(userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Cross-channel sync: remove notification when disabled from web/push.
	if state, err := s.bp.GetBPReminderState(userID); err == nil && state != nil {
		if state.NotificationMessageID != nil {
			s.deleteNotification(r.Context(), *state.NotificationMessageID)
		}
		_ = s.bp.ClearBPReminderNotificationMessage(userID)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"message": "BP reminders disabled for 24 hours",
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSendTestBPNotification(w http.ResponseWriter, r *http.Request) {
	_ = r.Context().Value(UserCtxKey).(*TelegramUser).ID

	if len(s.notifiers) == 0 {
		http.Error(w, "No notification channels configured", http.StatusBadRequest)
		return
	}

	// Send test BP notification matching the scheduler's format
	n := notifier.Notification{
		Text: "📊 **Time to measure your blood pressure**\n\nPlease take a moment to measure and record your BP.",
		Actions: []notifier.Action{
			{ID: "bp_confirm", Label: "✅ Confirm"},
			{ID: "bp_snooze", Label: "⏰ Snooze (2h)"},
			{ID: "bp_dontbug", Label: "🔇 Don't Bug Me (24h)"},
		},
		Tag: "bp-reminder",
		Metadata: map[string]interface{}{
			"type":     "bp_reminder",
			"enhanced": false,
		},
	}

	s.notify(r.Context(), n)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status": "sent",
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}
