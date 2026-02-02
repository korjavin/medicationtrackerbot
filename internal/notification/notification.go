package notification

import (
	"context"
)

// NotificationType defines the category of notification
type NotificationType string

const (
	TypeMedication NotificationType = "medication"
	TypeWorkout    NotificationType = "workout"
	TypeLowStock   NotificationType = "low_stock"
	TypeReminder   NotificationType = "reminder"
)

// ActionType defines the type of interactive action
type ActionType string

const (
	ActionConfirm ActionType = "confirm"
	ActionSnooze  ActionType = "snooze"
	ActionSkip    ActionType = "skip"
	ActionStart   ActionType = "start"
	ActionEdit    ActionType = "edit"
)

// NotificationAction describes an interactive action that can be taken on a notification
type NotificationAction struct {
	ID         string                 // Unique identifier: "confirm_all", "snooze_10m", "start_workout"
	Label      string                 // Human-readable label for display
	Type       ActionType             // Type of action
	Data       map[string]interface{} // Action-specific data (IDs, timestamps, etc.)
	RequiresUI bool                   // Whether action needs UI (e.g., edit form)
}

// NotificationContext bundles notification content with actions
type NotificationContext struct {
	Type         NotificationType
	Title        string
	Body         string
	Icon         string                 // Path to icon
	Tag          string                 // Notification tag for grouping/replacing
	Data         map[string]interface{} // Additional metadata
	Actions      []NotificationAction
	RequiresAuth bool
}

// Provider defines the interface for notification providers
type Provider interface {
	// Name returns the provider identifier ("telegram", "web_push", etc.)
	Name() string

	// Send sends a notification with actions to a user
	Send(ctx context.Context, userID int64, notif NotificationContext) error

	// IsEnabled checks if this provider is configured and available
	IsEnabled() bool

	// SupportsActions returns whether this provider can handle interactive actions
	SupportsActions() bool

	// MaxActions returns the maximum number of actions this provider supports
	MaxActions() int

	// RemoveNotification removes a specific notification from the user's device/chat
	// Returns nil if removal is not supported or notification doesn't exist
	RemoveNotification(ctx context.Context, notificationID interface{}) error

	// ClearReminders removes all reminder messages for a specific intake
	// This is called after a medication is confirmed to clean up pending reminders
	ClearReminders(ctx context.Context, userID int64, intakeID int64) error

	// SendSimpleMessage sends a plain text notification without actions
	// Returns message ID that can be stored for later removal
	SendSimpleMessage(ctx context.Context, userID int64, message string, notifType NotificationType) (messageID string, err error)

	// SupportsNotificationRemoval indicates if this provider can remove notifications
	SupportsNotificationRemoval() bool
}
