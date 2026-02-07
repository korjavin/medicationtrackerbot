package notification

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// ActionHandler processes notification actions from any provider
type ActionHandler struct {
	store *store.Store
}

// NewActionHandler creates a new action handler
func NewActionHandler(store *store.Store) *ActionHandler {
	return &ActionHandler{store: store}
}

// HandleAction routes actions to appropriate business logic
func (h *ActionHandler) HandleAction(ctx context.Context, userID int64, action NotificationAction) error {
	log.Printf("[ActionHandler] Processing action: type=%s, id=%s, user=%d", action.Type, action.ID, userID)

	switch action.Type {
	case ActionConfirm:
		return h.handleConfirm(ctx, userID, action.Data)
	case ActionSnooze:
		return h.handleSnooze(ctx, userID, action.Data)
	case ActionSkip:
		return h.handleSkip(ctx, userID, action.Data)
	case ActionStart:
		return h.handleStart(ctx, userID, action.Data)
	case ActionEdit:
		return h.handleEdit(ctx, userID, action.Data)
	default:
		return fmt.Errorf("unknown action type: %s", action.Type)
	}
}

// handleConfirm processes medication confirmation
func (h *ActionHandler) handleConfirm(ctx context.Context, userID int64, data map[string]interface{}) error {
	// Handle intake_ids (preferred method)
	if rawIDs, ok := data["intake_ids"]; ok {
		var intakeIDs []int64

		// Handle both []int64 and []interface{}
		switch ids := rawIDs.(type) {
		case []int64:
			intakeIDs = ids
		case []interface{}:
			for _, id := range ids {
				switch v := id.(type) {
				case int64:
					intakeIDs = append(intakeIDs, v)
				case float64:
					intakeIDs = append(intakeIDs, int64(v))
				case int:
					intakeIDs = append(intakeIDs, int64(v))
				}
			}
		}

		if len(intakeIDs) > 0 {
			now := time.Now()
			for _, intakeID := range intakeIDs {
				// Confirm intake
				if err := h.store.ConfirmIntake(intakeID, now); err != nil {
					log.Printf("Failed to confirm intake %d: %v", intakeID, err)
					continue
				}

				// Get intake to decrement inventory
				intake, err := h.store.GetIntake(intakeID)
				if err != nil {
					log.Printf("Failed to get intake %d for inventory: %v", intakeID, err)
					continue
				}

				if err := h.store.DecrementInventory(intake.MedicationID, 1); err != nil {
					log.Printf("Failed to decrement inventory for med %d: %v", intake.MedicationID, err)
				}
			}
			return nil
		}
	}

	// Fallback: Handle single medication_id
	if medID, ok := data["medication_id"]; ok {
		var medicationID int64
		switch v := medID.(type) {
		case int64:
			medicationID = v
		case float64:
			medicationID = int64(v)
		case int:
			medicationID = int64(v)
		}

		// Find pending intake for this medication
		pending, err := h.store.GetPendingIntakes()
		if err != nil {
			return fmt.Errorf("failed to get pending intakes: %w", err)
		}

		for _, p := range pending {
			if p.MedicationID == medicationID && p.UserID == userID {
				now := time.Now()
				if err := h.store.ConfirmIntake(p.ID, now); err != nil {
					return fmt.Errorf("failed to confirm intake: %w", err)
				}
				if err := h.store.DecrementInventory(medicationID, 1); err != nil {
					log.Printf("Failed to decrement inventory: %v", err)
				}
				return nil
			}
		}
	}

	// Fallback: Handle scheduled_at (legacy format)
	if scheduledAt, ok := data["scheduled_at"]; ok {
		var timestamp int64
		switch v := scheduledAt.(type) {
		case int64:
			timestamp = v
		case float64:
			timestamp = int64(v)
		}

		target := time.Unix(timestamp, 0)
		// This would need GetPendingIntakesBySchedule if we want to support it
		log.Printf("Scheduled_at confirmation not fully implemented: %v", target)
		return fmt.Errorf("scheduled_at confirmation method deprecated, use intake_ids")
	}

	return fmt.Errorf("invalid confirm action data: no intake_ids or medication_id")
}

// handleSnooze processes snooze requests
func (h *ActionHandler) handleSnooze(ctx context.Context, userID int64, data map[string]interface{}) error {
	// For workout snooze
	if sessionID, ok := data["session_id"]; ok {
		var id int64
		switch v := sessionID.(type) {
		case int64:
			id = v
		case float64:
			id = int64(v)
		case int:
			id = int64(v)
		}

		// Get duration (default 1 hour for workouts)
		duration := 1 * time.Hour
		if d, ok := data["duration"]; ok {
			if mins, ok := d.(float64); ok {
				duration = time.Duration(mins) * time.Minute
			} else if mins, ok := d.(int); ok {
				duration = time.Duration(mins) * time.Minute
			} else if mins, ok := d.(int64); ok {
				duration = time.Duration(mins) * time.Minute
			}
		}

		// Removed unused variable
		return h.store.SnoozeSession(id, duration)
	}

	// For medication snooze (future implementation)
	return fmt.Errorf("medication snooze not yet implemented")
}

// handleSkip processes skip requests
func (h *ActionHandler) handleSkip(ctx context.Context, userID int64, data map[string]interface{}) error {
	// For workout skip
	if sessionID, ok := data["session_id"]; ok {
		var id int64
		switch v := sessionID.(type) {
		case int64:
			id = v
		case float64:
			id = int64(v)
		case int:
			id = int64(v)
		}

		return h.store.SkipSession(id)
	}

	return fmt.Errorf("invalid skip action data: no session_id")
}

// handleStart processes workout start requests
func (h *ActionHandler) handleStart(ctx context.Context, userID int64, data map[string]interface{}) error {
	if sessionID, ok := data["session_id"]; ok {
		var id int64
		switch v := sessionID.(type) {
		case int64:
			id = v
		case float64:
			id = int64(v)
		case int:
			id = int64(v)
		}

		// Removed unused variable
		return h.store.StartSession(id)
	}

	return fmt.Errorf("invalid start action data: no session_id")
}

// handleEdit is a placeholder - typically requires UI
func (h *ActionHandler) handleEdit(ctx context.Context, userID int64, data map[string]interface{}) error {
	// Edit actions typically require opening the UI with specific params
	// This is handled by the provider (e.g., opening app with ?action=edit&id=123)
	return fmt.Errorf("edit action requires UI, should be handled by provider")
}

// DecodeCallbackData parses Telegram callback_data back to NotificationAction
func DecodeCallbackData(callbackData string) (*NotificationAction, error) {
	// This uses the existing parsing logic from TelegramProvider
	// For now, we'll parse the common patterns

	// Pattern: "confirm:123" (medication ID)
	if len(callbackData) > 8 && callbackData[:8] == "confirm:" {
		medID := parseInt64(callbackData[8:])
		return &NotificationAction{
			ID:   "confirm_med",
			Type: ActionConfirm,
			Data: map[string]interface{}{
				"medication_id": medID,
			},
		}, nil
	}

	// Pattern: "workout_start_123"
	if len(callbackData) > 14 && callbackData[:14] == "workout_start_" {
		sessionID := parseInt64(callbackData[14:])
		return &NotificationAction{
			ID:   "start_workout",
			Type: ActionStart,
			Data: map[string]interface{}{
				"session_id": sessionID,
			},
		}, nil
	}

	// Pattern: "workout_snooze_123"
	if len(callbackData) > 15 && callbackData[:15] == "workout_snooze_" {
		sessionID := parseInt64(callbackData[15:])
		return &NotificationAction{
			ID:   "snooze_workout",
			Type: ActionSnooze,
			Data: map[string]interface{}{
				"session_id": sessionID,
				"duration":   60, // 1 hour in minutes
			},
		}, nil
	}

	// Pattern: "workout_skip_123"
	if len(callbackData) > 13 && callbackData[:13] == "workout_skip_" {
		sessionID := parseInt64(callbackData[13:])
		return &NotificationAction{
			ID:   "skip_workout",
			Type: ActionSkip,
			Data: map[string]interface{}{
				"session_id": sessionID,
			},
		}, nil
	}

	return nil, fmt.Errorf("unknown callback data format: %s", callbackData)
}

// parseInt64 safely parses string to int64
func parseInt64(s string) int64 {
	var n int64
	fmt.Sscanf(s, "%d", &n)
	return n
}
