package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (s *Server) handleListMedications(w http.ResponseWriter, r *http.Request) {
	showArchived := r.URL.Query().Get("archived") == "true"
	meds, err := s.store.ListMedications(showArchived)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(meds)
}

func (s *Server) handleCreateMedication(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string     `json:"name"`
		Dosage    string     `json:"dosage"`
		Schedule  string     `json:"schedule"`
		StartDate *time.Time `json:"start_date"`
		EndDate   *time.Time `json:"end_date"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// 1. Search RxNorm
	rxcui, normalizedName, _ := s.rxnorm.SearchRxNorm(req.Name)

	// 2. Create in DB
	id, err := s.store.CreateMedication(req.Name, req.Dosage, req.Schedule, req.StartDate, req.EndDate, rxcui, normalizedName)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// 3. Check Interactions
	var warning string
	if rxcui != "" {
		meds, err := s.store.ListMedications(false) // Only active
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
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":      id,
		"status":  "created",
		"warning": warning,
	})
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
		StartDate      *time.Time `json:"start_date"`
		EndDate        *time.Time `json:"end_date"`
		InventoryCount *int       `json:"inventory_count"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Search RxNorm (Always update on edit to handle renames or missing data)
	rxcui, normalizedName, _ := s.rxnorm.SearchRxNorm(req.Name)

	// If archiving, clean up pending notifications/intakes
	if req.Archived {
		pending, err := s.store.GetPendingIntakesForMedication(id)
		if err == nil {
			for _, p := range pending {
				// 1. Delete Telegram messages
				msgIDs, err := s.store.GetIntakeReminders(p.ID)
				if err == nil {
					for _, msgID := range msgIDs {
						s.bot.DeleteMessage(msgID)
					}
				}
				// 2. Delete the pending intake
				s.store.DeleteIntake(p.ID)
			}
		} else {
			log.Printf("Error getting pending intakes for cleanup: %v", err)
		}
	}

	if err := s.store.UpdateMedication(id, req.Name, req.Dosage, req.Schedule, req.Archived, req.StartDate, req.EndDate, rxcui, normalizedName, req.InventoryCount); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Check interactions if unarchiving OR just updating (e.g. name change might trigger interaction)
	// Strategy: If active (not archived), check interactions.
	var warning string
	if !req.Archived {
		// We have the new RxCUI now
		if rxcui != "" {
			meds, err := s.store.ListMedications(false) // Active only
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
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "updated",
		"warning": warning,
	})
}

func (s *Server) handleDeleteMedication(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.store.DeleteMedication(id); err != nil {
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

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	for _, up := range req.Updates {
		// Verify ownership
		intake, err := s.store.GetIntake(up.ID)
		if err != nil {
			log.Printf("Error getting intake %d: %v", up.ID, err)
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

		// Reverting to PENDING logic
		if up.Status == "PENDING" {
			// If it was TAKEN, we are reverting.
			// Inventory increment?
			if intake.Status == "TAKEN" {
				// Reverting a taken status, so add back to inventory
				if err := s.store.DecrementInventory(intake.MedicationID, -1); err != nil {
					log.Printf("Error incrementing inventory on revert: %v", err)
				}
			}
		} else if up.Status == "TAKEN" {
			// If it was PENDING, we are confirming.
			if intake.Status == "PENDING" {
				if err := s.store.DecrementInventory(intake.MedicationID, 1); err != nil {
					log.Printf("Error decrementing inventory: %v", err)
				}
				// Clear reminders?
				reminders, _ := s.store.GetIntakeReminders(intake.ID)
				for _, msgID := range reminders {
					if s.bot != nil {
						s.bot.DeleteMessage(msgID)
					}
				}
			}
		}

		if err := s.store.UpdateIntake(up.ID, takenAt, up.Status); err != nil {
			log.Printf("Error updating intake %d: %v", up.ID, err)
		}
	}

	w.WriteHeader(http.StatusOK)
}

// handleTriggerNextIntake allows users to take their next scheduled medication early
func (s *Server) handleTriggerNextIntake(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Get all active medications
	meds, err := s.store.ListMedications(false)
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

		// Check next 2 days for the earliest occurrence
		for daysAhead := 0; daysAhead < 2; daysAhead++ {
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
				fmt.Sscanf(timeStr, "%d:%d", &hour, &minute)

				target := time.Date(checkDay.Year(), checkDay.Month(), checkDay.Day(), hour, minute, 0, 0, now.Location())

				// Skip if in the past
				if target.Before(now) {
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
		med, _ := s.store.GetMedication(medID)
		if med != nil {
			medNames = append(medNames, med.Name)
			confirmedMeds = append(confirmedMeds, *med)
		}

		// Check if intake log exists
		intake, _ := s.store.GetIntakeBySchedule(medID, nextTime)

		// If intake exists and is pending, mark as taken
		if intake != nil && intake.Status == "PENDING" {
			// Delete Telegram reminder messages
			reminders, _ := s.store.GetIntakeReminders(intake.ID)
			for _, msgID := range reminders {
				if s.bot != nil {
					s.bot.DeleteMessage(msgID)
				}
			}

			// Confirm the intake with current time
			if err := s.store.ConfirmIntake(intake.ID, now); err != nil {
				log.Printf("Error confirming intake %d: %v", intake.ID, err)
				continue
			}

			// Decrement inventory
			if err := s.store.DecrementInventory(medID, 1); err != nil {
				log.Printf("Error decrementing inventory: %v", err)
			}

			confirmedIntakeIDs = append(confirmedIntakeIDs, intake.ID)
			confirmedCount++
		} else if intake == nil {
			// Create a new intake log and mark it as taken immediately
			intakeID, err := s.store.CreateIntake(medID, userID, nextTime)
			if err != nil {
				log.Printf("Error creating intake for med %d: %v", medID, err)
				continue
			}

			// Immediately confirm it
			if err := s.store.ConfirmIntake(intakeID, now); err != nil {
				log.Printf("Error confirming new intake %d: %v", intakeID, err)
				continue
			}

			// Decrement inventory
			if err := s.store.DecrementInventory(medID, 1); err != nil {
				log.Printf("Error decrementing inventory: %v", err)
			}

			confirmedIntakeIDs = append(confirmedIntakeIDs, intakeID)
			confirmedCount++
		}
		// If intake exists but is already taken, skip it
	}

	// Send confirmation notification (only web push for now, we'll add Telegram bot method next)
	if s.webPush != nil && len(confirmedMeds) > 0 && len(confirmedIntakeIDs) > 0 {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.webPush.SendEarlyIntakeConfirmation(ctx, userID, confirmedMeds, nextTime, now, confirmedIntakeIDs); err != nil {
				log.Printf("Failed to send early intake confirmation: %v", err)
			}
		}()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "confirmed",
		"scheduled_at":     nextTime.Format(time.RFC3339),
		"taken_at":         now.Format(time.RFC3339),
		"medication_count": confirmedCount,
		"medication_names": medNames,
	})
}
