package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// handleCancelIntake allows reverting a TAKEN intake back to PENDING
func (s *Server) handleCancelIntake(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		IntakeIDs []int64 `json:"intake_ids"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	cancelledCount := 0

	for _, intakeID := range req.IntakeIDs {
		// Verify ownership
		intake, err := s.meds.GetIntake(intakeID)
		if err != nil {
			slog.Error("Error getting intake", "intakeID", intakeID, "error", err)
			continue
		}
		if intake == nil || intake.UserID != userID {
			slog.Warn("Intake not found or unauthorized", "intakeID", intakeID)
			continue
		}

		// Only allow cancelling if currently TAKEN
		if intake.Status != "TAKEN" {
			slog.Warn("Intake is not TAKEN, skipping", "intakeID", intakeID, "status", intake.Status)
			continue
		}

		// Revert to PENDING status
		emptyTime := time.Time{} // Zero time for taken_at
		if err := s.meds.UpdateIntake(intakeID, emptyTime, "PENDING"); err != nil {
			slog.Error("Error reverting intake to PENDING", "intakeID", intakeID, "error", err)
			continue
		}

		// Increment inventory back (undoing the decrement)
		if err := s.meds.DecrementInventory(intake.MedicationID, -1); err != nil {
			slog.Error("Error incrementing inventory on cancel", "error", err)
		}

		cancelledCount++
		slog.Info("Cancelled intake, reverted to PENDING", "intakeID", intakeID)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          "cancelled",
		"cancelled_count": cancelledCount,
		"requested_count": len(req.IntakeIDs),
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}
