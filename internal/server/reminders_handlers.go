package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// upcomingReminder is the JSON shape returned by /api/reminders/upcoming.
// The Capacitor JS bridge hands each entry to @capacitor/local-notifications
// so iOS/Android can fire the reminder natively even when the webview is
// suspended. The shape is intentionally small — the bridge only needs the
// scheduled time, an opaque identifier for de-duplication, and a label.
type upcomingReminder struct {
	IntakeID       int64     `json:"intake_id"`
	MedicationID   int64     `json:"medication_id"`
	MedicationName string    `json:"medication_name"`
	ScheduledAt    time.Time `json:"scheduled_at"`
}

// handleGetUpcomingReminders returns medication reminders scheduled within the
// next N hours (default 24, max 168). The mobile-build Capacitor app polls
// this endpoint and hands each entry to the native local-notifications plugin.
// In server mode the endpoint is still useful for diagnostics and for any
// alternative client that wants to schedule its own notifications.
func (s *Server) handleGetUpcomingReminders(w http.ResponseWriter, r *http.Request) {
	hours := 24
	if h := r.URL.Query().Get("hours"); h != "" {
		if n, err := strconv.Atoi(h); err == nil && n > 0 && n <= 168 {
			hours = n
		}
	}

	intakes, err := s.meds.ListPendingIntakes()
	if err != nil {
		slog.Error("upcoming reminders: list pending intakes", "error", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now()
	cutoff := now.Add(time.Duration(hours) * time.Hour)

	out := make([]upcomingReminder, 0, len(intakes))
	for _, in := range intakes {
		// Anchor on snoozed_until when set so a snoozed reminder shows up at
		// its rescheduled wake time rather than its original scheduled time.
		when := in.ScheduledAt
		if in.SnoozedUntil != nil && in.SnoozedUntil.After(now) {
			when = *in.SnoozedUntil
		}
		if when.Before(now) || when.After(cutoff) {
			continue
		}
		name := ""
		if med, err := s.meds.Get(in.MedicationID); err == nil && med != nil {
			name = med.Name
		}
		out = append(out, upcomingReminder{
			IntakeID:       in.ID,
			MedicationID:   in.MedicationID,
			MedicationName: name,
			ScheduledAt:    when,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].ScheduledAt.Before(out[j].ScheduledAt)
	})

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(out); err != nil {
		slog.Error("upcoming reminders: encode", "error", err)
	}
}
