package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
)

// handleDeleteFutureIntake removes one or more PENDING intakes whose scheduled_at
// is in the future. The scheduler will recreate them on the regular schedule.
// Past intakes (TAKEN/SKIPPED/MISSED, or PENDING with scheduled_at in the past)
// are skipped — their history is preserved.
func (s *Server) handleDeleteFutureIntake(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		IntakeIDs []int64 `json:"intake_ids"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	deletedCount := 0

	for _, intakeID := range req.IntakeIDs {
		intake, err := s.meds.GetIntake(intakeID)
		if err != nil {
			slog.Error("Error getting intake", "intakeID", intakeID, "error", err)
			continue
		}
		if intake == nil || intake.UserID != userID {
			slog.Warn("Intake not found or unauthorized", "intakeID", intakeID)
			continue
		}

		reminders, _, _, err := s.medSvc.DeleteFutureIntake(intakeID)
		if err != nil {
			if errors.Is(err, domain.ErrNotFutureIntake) {
				slog.Warn("Intake is not a future pending dose, skipping", "intakeID", intakeID)
			} else {
				slog.Error("Error deleting future intake", "intakeID", intakeID, "error", err)
			}
			continue
		}

		for _, msgID := range reminders {
			s.deleteNotification(r.Context(), msgID)
		}
		s.closeNotification(r.Context(), fmt.Sprintf("medication-%d", intakeID))
		s.closeNotification(r.Context(), fmt.Sprintf("medication-reminder-%d", intakeID))

		deletedCount++
		slog.Info("Deleted future intake", "intakeID", intakeID)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          "deleted",
		"deleted_count":   deletedCount,
		"requested_count": len(req.IntakeIDs),
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}
