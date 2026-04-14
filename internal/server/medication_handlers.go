package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (s *Server) handleSnoozeMedication(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		IntakeID        int64 `json:"intake_id"`
		DurationMinutes int   `json:"duration_minutes"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.DurationMinutes <= 0 {
		req.DurationMinutes = 10
	}

	intake, err := s.meds.GetIntake(req.IntakeID)
	if err != nil {
		http.Error(w, "Intake not found", http.StatusNotFound)
		return
	}
	if intake == nil || intake.UserID != userID {
		http.Error(w, "Unauthorized or intake not found", http.StatusForbidden)
		return
	}

	snoozeUntil := time.Now().Add(time.Duration(req.DurationMinutes) * time.Minute)
	if err := s.meds.SnoozeIntake(req.IntakeID, snoozeUntil); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSkipMedication(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		IntakeID int64 `json:"intake_id"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	intake, err := s.meds.GetIntake(req.IntakeID)
	if err != nil {
		http.Error(w, "Intake not found", http.StatusNotFound)
		return
	}
	if intake == nil || intake.UserID != userID {
		http.Error(w, "Unauthorized or intake not found", http.StatusForbidden)
		return
	}

	// Use the domain service so skip rules stay consistent with the bot flow.
	reminders, _, _, err := s.medSvc.SkipIntake(req.IntakeID)
	if err != nil {
		if errors.Is(err, domain.ErrNotPending) {
			http.Error(w, "intake is not pending", http.StatusConflict)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	for _, msgID := range reminders {
		s.deleteNotification(r.Context(), msgID)
	}
	s.closeNotification(r.Context(), fmt.Sprintf("medication-%d", req.IntakeID))
	s.closeNotification(r.Context(), fmt.Sprintf("medication-reminder-%d", req.IntakeID))

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleListMedications(w http.ResponseWriter, r *http.Request) {
	showArchived := r.URL.Query().Get("archived") == "true"
	meds, err := s.meds.ListMedications(showArchived)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := json.NewEncoder(w).Encode(meds); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateMedication(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name          string     `json:"name"`
		Dosage        string     `json:"dosage"`
		Schedule      string     `json:"schedule"`
		Supplement    *bool      `json:"supplement"`
		StartDate     *time.Time `json:"start_date"`
		EndDate       *time.Time `json:"end_date"`
		TZShiftPolicy string     `json:"tz_shift_policy"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate tz_shift_policy before hitting the DB.
	if req.TZShiftPolicy != "" && req.TZShiftPolicy != "flexible" && req.TZShiftPolicy != "medium" && req.TZShiftPolicy != "strict" {
		http.Error(w, "Invalid tz_shift_policy: must be one of flexible, medium, strict", http.StatusBadRequest)
		return
	}

	// Check for duplicate medication (same name + dosage, including archived)
	allMeds, err := s.meds.ListMedications(true)
	if err != nil {
		slog.Error("list medications for duplicate check", "error", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	for _, m := range allMeds {
		if strings.EqualFold(m.Name, req.Name) && m.Dosage == req.Dosage {
			http.Error(w, "Medication with this name and dosage already exists", http.StatusConflict)
			return
		}
	}

	// 1. Search RxNorm
	rxcui, normalizedName, _ := s.rxnorm.SearchRxNorm(req.Name)

	// 2. Create in DB
	id, err := s.meds.CreateMedication(req.Name, req.Dosage, req.Schedule, req.StartDate, req.EndDate, rxcui, normalizedName, req.TZShiftPolicy)
	if err != nil {
		if isDuplicateMedicationError(err) {
			http.Error(w, "Medication with this name and dosage already exists", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if req.Supplement != nil {
		if err := s.meds.SetMedicationSupplement(id, *req.Supplement); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	// 3. Check Interactions
	var warning string
	if rxcui != "" {
		meds, err := s.meds.ListMedications(false) // Only active
		if err == nil {
			var rxcuis []string
			for _, m := range meds {
				if m.RxCUI != "" {
					rxcuis = append(rxcuis, m.RxCUI)
				}
			}
			// Only check if we have > 1 meds totally (since we just added one, list includes it)
			if len(rxcuis) > 1 {
				warnings, _ := s.rxnorm.CheckInteractions(rxcuis)
				if len(warnings) > 0 {
					warning = warnings[0] // Just take the first one or join them
					// Maybe join top 3
					if len(warnings) > 1 {
						warning += " (+ " + strconv.Itoa(len(warnings)-1) + " more)"
					}
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"id":      id,
		"status":  "created",
		"warning": warning,
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateMedication(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name           string     `json:"name"`
		Dosage         string     `json:"dosage"`
		Schedule       string     `json:"schedule"`
		Archived       bool       `json:"archived"`
		Supplement     *bool      `json:"supplement"`
		StartDate      *time.Time `json:"start_date"`
		EndDate        *time.Time `json:"end_date"`
		InventoryCount *int       `json:"inventory_count"`
		TZShiftPolicy  string     `json:"tz_shift_policy"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate tz_shift_policy before hitting the DB.
	if req.TZShiftPolicy != "" && req.TZShiftPolicy != "flexible" && req.TZShiftPolicy != "medium" && req.TZShiftPolicy != "strict" {
		http.Error(w, "Invalid tz_shift_policy: must be one of flexible, medium, strict", http.StatusBadRequest)
		return
	}

	// Check for duplicate medication (same name + dosage, excluding self)
	allMeds, err := s.meds.ListMedications(true)
	if err != nil {
		slog.Error("list medications for duplicate check", "error", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	for _, m := range allMeds {
		if m.ID != id && strings.EqualFold(m.Name, req.Name) && m.Dosage == req.Dosage {
			http.Error(w, "Medication with this name and dosage already exists", http.StatusConflict)
			return
		}
	}

	// Search RxNorm (Always update on edit to handle renames or missing data)
	rxcui, normalizedName, _ := s.rxnorm.SearchRxNorm(req.Name)

	// If archiving, clean up pending notifications/intakes
	if req.Archived {
		pending, err := s.meds.GetPendingIntakesForMedication(id)
		if err == nil {
			for _, p := range pending {
				// 1. Delete notification messages
				msgIDs, err := s.meds.GetIntakeReminders(p.ID)
				if err == nil {
					for _, msgID := range msgIDs {
						s.deleteNotification(r.Context(), msgID)
					}
				}
				// 2. Delete the pending intake
				if err := s.meds.DeleteIntake(p.ID); err != nil {
					slog.Error("delete intake failed", "intakeID", p.ID, "error", err)
				}
			}
		} else {
			slog.Error("Error getting pending intakes for cleanup", "medID", id, "error", err)
		}
	}

	if err := s.meds.UpdateMedication(id, req.Name, req.Dosage, req.Schedule, req.Archived, req.StartDate, req.EndDate, rxcui, normalizedName, req.InventoryCount, req.TZShiftPolicy); err != nil {
		if isDuplicateMedicationError(err) {
			http.Error(w, "Medication with this name and dosage already exists", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if req.Supplement != nil {
		if err := s.meds.SetMedicationSupplement(id, *req.Supplement); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	// Check interactions if unarchiving OR just updating (e.g. name change might trigger interaction)
	// Strategy: If active (not archived), check interactions.
	var warning string
	if !req.Archived {
		// We have the new RxCUI now
		if rxcui != "" {
			meds, err := s.meds.ListMedications(false) // Active only
			if err == nil {
				var rxcuis []string
				for _, m := range meds {
					// We need to exclude the current med from the list fetched from DB
					// because the DB list technically has the OLD data for this ID if read before commit,
					// BUT we just committed the update above. So DB list SHOULD have the new data.
					// Let's rely on ListMedications returning the updated state.
					if m.RxCUI != "" {
						rxcuis = append(rxcuis, m.RxCUI)
					}
				}
				if len(rxcuis) > 1 {
					warnings, _ := s.rxnorm.CheckInteractions(rxcuis)
					if len(warnings) > 0 {
						warning = warnings[0]
						if len(warnings) > 1 {
							warning += " (+ " + strconv.Itoa(len(warnings)-1) + " more)"
						}
					}
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "updated",
		"warning": warning,
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleDeleteMedication(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	med, err := s.meds.GetMedication(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if med == nil {
		http.Error(w, "Medication not found", http.StatusNotFound)
		return
	}
	if !med.Archived {
		http.Error(w, "Cannot delete active medication. Archive it first.", http.StatusConflict)
		return
	}

	canDelete, err := s.meds.CanDeleteMedication(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if !canDelete {
		http.Error(w, "Cannot delete medication with intake history", http.StatusConflict)
		return
	}

	if err := s.meds.DeleteMedication(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleUpdateIntake(w http.ResponseWriter, r *http.Request) {
	userId := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Updates []struct {
			ID      int64  `json:"id"`
			Status  string `json:"status"`
			TakenAt string `json:"taken_at"` // RFC3339
		} `json:"updates"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	for _, up := range req.Updates {
		// Verify ownership
		intake, err := s.meds.GetIntake(up.ID)
		if err != nil {
			slog.Error("Error getting intake", "intakeID", up.ID, "error", err)
			continue
		}
		if intake == nil || intake.UserID != userId {
			continue
		}

		var takenAt time.Time
		if up.TakenAt != "" {
			t, err := time.Parse(time.RFC3339, up.TakenAt)
			if err == nil {
				takenAt = t
			}
		} else if up.Status == "TAKEN" {
			// If not provided but status is TAKEN, default to now? Or keep old?
			// Let's assume frontend sends it. logic in store uses it if Status==TAKEN
			takenAt = time.Now()
		}

		// First update the intake status, then adjust inventory
		if err := s.meds.UpdateIntake(up.ID, takenAt, up.Status); err != nil {
			slog.Error("Error updating intake", "intakeID", up.ID, "error", err)
			continue
		}

		// Adjust inventory after successful update
		switch up.Status {
		case "PENDING":
			// If it was TAKEN, we are reverting.
			// Inventory increment?
			if intake.Status == "TAKEN" {
				// Reverting a taken status, so add back to inventory
				if err := s.meds.DecrementInventory(intake.MedicationID, -1); err != nil {
					slog.Error("Error incrementing inventory on revert", "medicationID", intake.MedicationID, "error", err)
				}
			}
		case "TAKEN":
			// If it was PENDING, we are confirming.
			if intake.Status == "PENDING" {
				if err := s.meds.DecrementInventory(intake.MedicationID, 1); err != nil {
					slog.Error("Error decrementing inventory", "medicationID", intake.MedicationID, "error", err)
				}
				// Clear reminders
				reminders, _ := s.meds.GetIntakeReminders(intake.ID)
				for _, msgID := range reminders {
					s.deleteNotification(r.Context(), msgID)
				}
				// Close webpush notification
				s.closeNotification(r.Context(), fmt.Sprintf("medication-%d", intake.ID))
			}
		}
	}

	w.WriteHeader(http.StatusOK)
}

// handleTriggerNextIntake allows users to take their next scheduled medication early
func (s *Server) handleTriggerNextIntake(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Get all active medications
	meds, err := s.meds.ListMedications(false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now()
	var nextTime time.Time
	var nextMeds []int64

	// Find the next scheduled intake
	for _, med := range meds {
		cfg, err := med.ValidSchedule()
		if err != nil || cfg.Type == "as_needed" {
			continue
		}

		// Check next 12 hours for the earliest occurrence (0.5 days)
		for daysAhead := 0; daysAhead < 1; daysAhead++ {
			checkDay := now.AddDate(0, 0, daysAhead)

			// If "weekly", check day
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

			// Iterate over times
			for _, timeStr := range cfg.Times {
				if len(timeStr) != 5 {
					continue
				}
				var hour, minute int
				_, _ = fmt.Sscanf(timeStr, "%d:%d", &hour, &minute)

				target := time.Date(checkDay.Year(), checkDay.Month(), checkDay.Day(), hour, minute, 0, 0, now.Location())

				// Skip if in the past
				if target.Before(now) {
					continue
				}

				// Skip if more than 12 hours in the future
				if target.Sub(now) > 12*time.Hour {
					continue
				}

				// Check Start/End Dates
				if med.StartDate != nil && target.Before(*med.StartDate) {
					continue
				}
				if med.EndDate != nil && target.After(*med.EndDate) {
					continue
				}

				// Is this the earliest we've found?
				if nextTime.IsZero() || target.Before(nextTime) {
					nextTime = target
					nextMeds = []int64{med.ID}
				} else if target.Equal(nextTime) {
					nextMeds = append(nextMeds, med.ID)
				}
			}
		}
	}

	if len(nextMeds) == 0 {
		http.Error(w, "No upcoming scheduled intakes found", http.StatusNotFound)
		return
	}

	// Find or create intake logs for the next scheduled time and mark them as taken NOW
	confirmedCount := 0
	var medNames []string
	var confirmedIntakeIDs []int64
	var confirmedMeds []store.Medication

	for _, medID := range nextMeds {
		// Get medication info for response
		med, _ := s.meds.GetMedication(medID)
		if med != nil {
			medNames = append(medNames, med.Name)
			confirmedMeds = append(confirmedMeds, *med)
		}

		// Check if intake log exists
		intake, _ := s.meds.GetIntakeBySchedule(medID, nextTime)

		// If intake exists and is pending, mark as taken
		if intake != nil && intake.Status == "PENDING" {
			// Delete notification messages
			reminders, _ := s.meds.GetIntakeReminders(intake.ID)
			for _, msgID := range reminders {
				s.deleteNotification(r.Context(), msgID)
			}

			// Confirm the intake with current time. If it returns sql.ErrNoRows,
			// the intake was already confirmed by another concurrent request.
			if err := s.meds.ConfirmIntake(intake.ID, now); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					slog.Info("Intake already confirmed by another request (race condition)", "intakeID", intake.ID)
				} else {
					slog.Error("Error confirming intake", "intakeID", intake.ID, "error", err)
				}
				continue
			}

			// Close the notification
			s.closeNotification(r.Context(), fmt.Sprintf("medication-%d", intake.ID))

			// Decrement inventory only if confirmation succeeded
			if err := s.meds.DecrementInventory(intake.MedicationID, 1); err != nil {
				slog.Error("Error decrementing inventory", "error", err)
			}

			confirmedIntakeIDs = append(confirmedIntakeIDs, intake.ID)
			confirmedCount++
		} else if intake == nil {
			// Create a new intake log and mark it as taken immediately
			intakeID, err := s.meds.CreateIntake(medID, userID, nextTime)
			if err != nil {
				slog.Error("Error creating intake for med", "medID", medID, "error", err)
				continue
			}

			// Immediately confirm it. If it returns sql.ErrNoRows,
			// the intake was already confirmed by another concurrent request.
			if err := s.meds.ConfirmIntake(intakeID, now); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					slog.Info("Intake already confirmed by another request (race condition)", "intakeID", intakeID)
				} else {
					slog.Error("Error confirming new intake", "intakeID", intakeID, "error", err)
				}
				continue
			}

			// Close the notification
			s.closeNotification(r.Context(), fmt.Sprintf("medication-%d", intakeID))

			// Decrement inventory only if confirmation succeeded
			if err := s.meds.DecrementInventory(medID, 1); err != nil {
				slog.Error("Error decrementing inventory", "error", err)
			}

			confirmedIntakeIDs = append(confirmedIntakeIDs, intakeID)
			confirmedCount++
		}
		// If intake exists but is already taken, skip it
	}

	// Send early intake confirmation notification via all channels
	if len(s.notifiers) > 0 && len(confirmedMeds) > 0 && len(confirmedIntakeIDs) > 0 {
		earlyMedNames := make([]string, len(confirmedMeds))
		earlyMedIDs := make([]int64, len(confirmedMeds))
		for i, m := range confirmedMeds {
			name := m.Name
			if m.Dosage != "" {
				name += " " + m.Dosage
			}
			earlyMedNames[i] = name
			earlyMedIDs[i] = m.ID
		}

		intakeIDStrs := make([]string, len(confirmedIntakeIDs))
		for i, id := range confirmedIntakeIDs {
			intakeIDStrs[i] = strconv.FormatInt(id, 10)
		}
		cancelActionID := "cancel_intake:" + strings.Join(intakeIDStrs, ",")

		n := notifier.Notification{
			Text: fmt.Sprintf("**Medication taken early**\n%s (scheduled for %s)", strings.Join(earlyMedNames, ", "), nextTime.Format("15:04")),
			Actions: []notifier.Action{
				{ID: cancelActionID, Label: "Cancel (Undo)"},
			},
			Tag: fmt.Sprintf("medication-early-%s", nextTime.Format(time.RFC3339)),
			Metadata: map[string]interface{}{
				"type":             "medication_early_confirmed",
				"scheduled_at":     nextTime.Format(time.RFC3339),
				"taken_at":         now.Format(time.RFC3339),
				"medication_ids":   earlyMedIDs,
				"medication_names": earlyMedNames,
				"intake_ids":       confirmedIntakeIDs,
			},
		}

		s.notifyWithAutoDelete(r.Context(), n, 15*time.Minute)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "confirmed",
		"scheduled_at":     nextTime.Format(time.RFC3339),
		"taken_at":         now.Format(time.RFC3339),
		"medication_count": confirmedCount,
		"medication_names": medNames,
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// handleGetNextIntake returns the next scheduled intake for the UI
func (s *Server) handleGetNextIntake(w http.ResponseWriter, r *http.Request) {
	// Get all active medications
	meds, err := s.meds.ListMedications(false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now()
	var nextTime time.Time
	var nextMeds []store.Medication

	// Find the next scheduled intake
	for _, med := range meds {
		cfg, err := med.ValidSchedule()
		if err != nil || cfg.Type == "as_needed" {
			continue
		}

		// Check next 12 hours (same as trigger logic)
		for daysAhead := 0; daysAhead < 1; daysAhead++ {
			checkDay := now.AddDate(0, 0, daysAhead)

			// If "weekly", check day
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

			// Iterate over times
			for _, timeStr := range cfg.Times {
				if len(timeStr) != 5 {
					continue
				}
				var hour, minute int
				_, _ = fmt.Sscanf(timeStr, "%d:%d", &hour, &minute)

				target := time.Date(checkDay.Year(), checkDay.Month(), checkDay.Day(), hour, minute, 0, 0, now.Location())

				// Skip if in the past
				if target.Before(now) {
					continue
				}

				// Skip if more than 12 hours in the future
				if target.Sub(now) > 12*time.Hour {
					continue
				}

				// Check Start/End Dates
				if med.StartDate != nil && target.Before(*med.StartDate) {
					continue
				}
				if med.EndDate != nil && target.After(*med.EndDate) {
					continue
				}

				// Check if already taken
				intake, _ := s.meds.GetIntakeBySchedule(med.ID, target)
				if intake != nil && (intake.Status == "TAKEN" || intake.Status == "SKIPPED") {
					continue
				}

				// Is this the earliest we've found?
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
		// Return 204 No Content if nothing found
		w.WriteHeader(http.StatusNoContent)
		return
	}

	medNames := make([]string, len(nextMeds))
	for i, m := range nextMeds {
		medNames[i] = m.Name
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"scheduled_at":     nextTime.Format(time.RFC3339),
		"medication_names": medNames,
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// isDuplicateMedicationError checks whether err is a SQLite UNIQUE constraint
// violation on the medications name+dosage index.
func isDuplicateMedicationError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "idx_medications_name_dosage")
}

func (s *Server) handleLogPastIntake(w http.ResponseWriter, r *http.Request) {
	userId := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		MedicationID int64  `json:"medication_id"`
		TakenAt      string `json:"taken_at"` // RFC3339
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	takenAt, err := time.Parse(time.RFC3339, req.TakenAt)
	if err != nil {
		http.Error(w, "Invalid time format", http.StatusBadRequest)
		return
	}

	// Verify medication belongs to user (all meds are shared for now, but good practice)
	med, err := s.meds.GetMedication(req.MedicationID)
	if err != nil || med == nil {
		http.Error(w, "Medication not found", http.StatusNotFound)
		return
	}

	// Create manual intake
	id, err := s.meds.CreateManualIntake(req.MedicationID, userId, takenAt)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Decrement inventory
	if err := s.meds.DecrementInventory(req.MedicationID, 1); err != nil {
		slog.Error("Error decrementing inventory", "error", err)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"id":     id,
		"status": "created",
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}
