package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
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
		// Verify ownership before delegating to domain service
		intake, err := s.meds.GetIntake(intakeID)
		if err != nil {
			slog.Error("Error getting intake", "intakeID", intakeID, "error", err)
			continue
		}
		if intake == nil || intake.UserID != userID {
			slog.Warn("Intake not found or unauthorized", "intakeID", intakeID)
			continue
		}

		// Delegate to domain service for business logic
		if _, _, err := s.medSvc.CancelIntake(intakeID); err != nil {
			if errors.Is(err, domain.ErrNotTaken) {
				slog.Warn("Intake is not TAKEN, skipping", "intakeID", intakeID)
			} else {
				slog.Error("Error cancelling intake", "intakeID", intakeID, "error", err)
			}
			continue
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
