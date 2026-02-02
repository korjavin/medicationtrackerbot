package notification

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TelegramMessenger defines the interface for sending Telegram messages
// This avoids circular dependency with the bot package
type TelegramMessenger interface {
	SendMedicationNotification(medications []store.Medication, scheduledTime time.Time, intakeIDs []int64) (int, error)
	SendWorkoutNotification(message string, sessionID int64) (int, error)
	SendLowStockWarning(message string) error
	RemoveMedicationNotification(messageID int) error
	SendSimpleMessage(message string) (int, error)
	DeleteMessage(messageID int) error                                     // For backward compatibility
	SendGroupNotification(meds []store.Medication, target time.Time) error // For backward compatibility
}

// TelegramProvider implements the Provider interface for Telegram
type TelegramProvider struct {
	messenger TelegramMessenger
}

// NewTelegramProvider creates a new Telegram notification provider
func NewTelegramProvider(messenger TelegramMessenger) *TelegramProvider {
	return &TelegramProvider{messenger: messenger}
}

func (p *TelegramProvider) Name() string {
	return "telegram"
}

func (p *TelegramProvider) IsEnabled() bool {
	return p.messenger != nil
}

func (p *TelegramProvider) SupportsActions() bool {
	return true
}

func (p *TelegramProvider) MaxActions() int {
	return 8 // Telegram inline keyboard can have many buttons
}

func (p *TelegramProvider) SupportsNotificationRemoval() bool {
	return true // Telegram can delete messages
}

func (p *TelegramProvider) RemoveNotification(ctx context.Context, notificationID interface{}) error {
	if p.messenger == nil {
		return fmt.Errorf("telegram bot not configured")
	}

	messageID, ok := notificationID.(int)
	if !ok {
		return fmt.Errorf("invalid notification ID type for Telegram: expected int")
	}

	return p.messenger.DeleteMessage(messageID)
}

func (p *TelegramProvider) SendSimpleMessage(ctx context.Context, userID int64, message string, notifType NotificationType) (string, error) {
	if p.messenger == nil {
		return "", fmt.Errorf("telegram bot not configured")
	}

	msgID, err := p.messenger.SendSimpleMessage(message)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d", msgID), nil
}

// ClearReminders removes all reminder messages for a specific intake
func (p *TelegramProvider) ClearReminders(ctx context.Context, userID int64, intakeID int64) error {
	// This will be called by ActionHandler which has access to store
	log.Printf("[TelegramProvider] ClearReminders called for intake %d", intakeID)
	return nil
}

func (p *TelegramProvider) Send(ctx context.Context, userID int64, notif NotificationContext) error {
	if p.messenger == nil {
		return fmt.Errorf("telegram bot not configured")
	}

	switch notif.Type {
	case TypeMedication:
		return p.sendMedicationNotification(notif)
	case TypeWorkout:
		return p.sendWorkoutNotification(notif)
	case TypeLowStock:
		return p.sendLowStockNotification(notif)
	default:
		return fmt.Errorf("unsupported notification type: %s", notif.Type)
	}
}

func (p *TelegramProvider) sendMedicationNotification(notif NotificationContext) error {
	// Extract medication data
	medsInterface, ok := notif.Data["medications"]
	if !ok {
		return fmt.Errorf("medications data not found")
	}

	meds, ok := medsInterface.([]store.Medication)
	if !ok {
		return fmt.Errorf("invalid medications data type")
	}

	targetInterface, ok := notif.Data["scheduled_time"]
	if !ok {
		return fmt.Errorf("scheduled_time not found")
	}

	target, ok := targetInterface.(time.Time)
	if !ok {
		return fmt.Errorf("invalid scheduled_time type")
	}

	// Use existing bot method for medication notifications
	return p.messenger.SendGroupNotification(meds, target)
}

func (p *TelegramProvider) sendWorkoutNotification(notif NotificationContext) error {
	// Extract workout session data
	sessionIDInterface, ok := notif.Data["session_id"]
	if !ok {
		return fmt.Errorf("session_id not found")
	}

	sessionID, ok := sessionIDInterface.(int64)
	if !ok {
		return fmt.Errorf("invalid session_id type")
	}

	message := fmt.Sprintf("%s\n\n%s", notif.Title, notif.Body)

	// Use existing bot method for workout notifications
	_, err := p.messenger.SendWorkoutNotification(message, sessionID)
	return err
}

func (p *TelegramProvider) sendLowStockNotification(notif NotificationContext) error {
	message := fmt.Sprintf("%s\n\n%s", notif.Title, notif.Body)
	return p.messenger.SendLowStockWarning(message)
}
