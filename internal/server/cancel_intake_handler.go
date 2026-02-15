package server

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

// handleCancelIntake allows reverting a TAKEN intake back to PENDING
func (s *Server) handleCancelIntake(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		IntakeIDs []int64 `json:"intake_ids"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	cancelledCount := 0

	for _, intakeID := range req.IntakeIDs {
		// Verify ownership
		intake, err := s.store.GetIntake(intakeID)
		if err != nil {
			log.Printf("Error getting intake %d: %v", intakeID, err)
			continue
		}
		if intake == nil || intake.UserID != userID {
			log.Printf("Intake %d not found or unauthorized", intakeID)
			continue
		}

		// Only allow cancelling if currently TAKEN
		if intake.Status != "TAKEN" {
			log.Printf("Intake %d is not TAKEN, skipping (status: %s)", intakeID, intake.Status)
			continue
		}

		// Revert to PENDING status
		emptyTime := time.Time{} // Zero time for taken_at
		if err := s.store.UpdateIntake(intakeID, emptyTime, "PENDING"); err != nil {
			log.Printf("Error reverting intake %d to PENDING: %v", intakeID, err)
			continue
		}

		// Increment inventory back (undoing the decrement)
		if err := s.store.DecrementInventory(intake.MedicationID, -1); err != nil {
			log.Printf("Error incrementing inventory on cancel: %v", err)
		}

		cancelledCount++
		log.Printf("Cancelled intake %d, reverted to PENDING", intakeID)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          "cancelled",
		"cancelled_count": cancelledCount,
		"requested_count": len(req.IntakeIDs),
	})
}
