package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"
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
