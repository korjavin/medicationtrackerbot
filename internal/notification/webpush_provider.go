package notification

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/webpush"
)

// WebPushProvider implements the Provider interface for Web Push notifications
type WebPushProvider struct {
	service *webpush.Service
}

// NewWebPushProvider creates a new Web Push notification provider
func NewWebPushProvider(service *webpush.Service) *WebPushProvider {
	return &WebPushProvider{service: service}
}

func (p *WebPushProvider) Name() string {
	return "web_push"
}

func (p *WebPushProvider) IsEnabled() bool {
	return p.service != nil
}

func (p *WebPushProvider) SupportsActions() bool {
	return true
}

func (p *WebPushProvider) MaxActions() int {
	return 2 // Web Push standard supports 2 action buttons
}

func (p *WebPushProvider) SupportsNotificationRemoval() bool {
	return false // Web Push can't programmatically remove notifications from user's device
}

func (p *WebPushProvider) RemoveNotification(ctx context.Context, notificationID interface{}) error {
	// Not supported for Web Push - user must dismiss manually
	return nil
}

func (p *WebPushProvider) SendSimpleMessage(ctx context.Context, userID int64, message string) error {
	if p.service == nil {
		return fmt.Errorf("web push service not configured")
	}

	// Send a simple notification without actions
	// Implementation would go here - for now, not implemented
	log.Printf("[WebPushProvider] SendSimpleMessage not fully implemented: %s", message)
	return nil
}

func (p *WebPushProvider) Send(ctx context.Context, userID int64, notif NotificationContext) error {
	if p.service == nil {
		return fmt.Errorf("web push service not configured")
	}

	switch notif.Type {
	case TypeMedication:
		return p.sendMedicationNotification(ctx, userID, notif)
	case TypeWorkout:
		return p.sendWorkoutNotification(ctx, userID, notif)
	case TypeLowStock:
		return p.sendLowStockNotification(ctx, userID, notif)
	default:
		return fmt.Errorf("unsupported notification type: %s", notif.Type)
	}
}

func (p *WebPushProvider) sendMedicationNotification(ctx context.Context, userID int64, notif NotificationContext) error {
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

	intakeIDsInterface, _ := notif.Data["intake_ids"]
	intakeIDs, _ := intakeIDsInterface.([]int64)

	// Use existing webpush service method
	return p.service.SendMedicationNotification(ctx, userID, meds, target, intakeIDs)
}

func (p *WebPushProvider) sendWorkoutNotification(ctx context.Context, userID int64, notif NotificationContext) error {
	// Extract workout data
	sessionInterface, ok := notif.Data["session"]
	if !ok {
		return fmt.Errorf("session data not found")
	}
	session, ok := sessionInterface.(*store.WorkoutSession)
	if !ok {
		return fmt.Errorf("invalid session data type")
	}

	groupInterface, ok := notif.Data["group"]
	if !ok {
		return fmt.Errorf("group data not found")
	}
	group, ok := groupInterface.(*store.WorkoutGroup)
	if !ok {
		return fmt.Errorf("invalid group data type")
	}

	variantInterface, ok := notif.Data["variant"]
	if !ok {
		return fmt.Errorf("variant data not found")
	}
	variant, ok := variantInterface.(*store.WorkoutVariant)
	if !ok {
		return fmt.Errorf("invalid variant data type")
	}

	// Use existing webpush service method
	return p.service.SendWorkoutNotification(ctx, userID, session, group, variant)
}

func (p *WebPushProvider) sendLowStockNotification(ctx context.Context, userID int64, notif NotificationContext) error {
	// Extract medication data
	medsInterface, ok := notif.Data["medications"]
	if !ok {
		return fmt.Errorf("medications data not found")
	}

	meds, ok := medsInterface.([]store.Medication)
	if !ok {
		return fmt.Errorf("invalid medications data type")
	}

	// Use existing webpush service method
	return p.service.SendLowStockNotification(ctx, userID, meds)
}
