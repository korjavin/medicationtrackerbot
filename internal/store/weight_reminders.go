package store

import (
	"context"
	"database/sql"
	"time"
)

// WeightReminderState represents the state of weight reminders for a user
type WeightReminderState struct {
	UserID                 int64      `json:"user_id"`
	Enabled                bool       `json:"enabled"`
	SnoozedUntil           *time.Time `json:"snoozed_until,omitempty"`
	DontRemindUntil        *time.Time `json:"dont_remind_until,omitempty"`
	LastNotificationSentAt *time.Time `json:"last_notification_sent_at,omitempty"`
	NotificationMessageID  *int       `json:"notification_message_id,omitempty"`
	PreferredReminderHour  int        `json:"preferred_reminder_hour"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

// GetWeightReminderState retrieves the weight reminder state for a user
// If no state exists, returns a default state with enabled=true
func (s *Store) GetWeightReminderState(userID int64) (*WeightReminderState, error) {
	var state WeightReminderState
	var snoozedUntil, dontRemindUntil, lastNotificationSentAt sql.NullTime
	var notificationMessageID sql.NullInt64

	err := s.db.QueryRow(`
		SELECT user_id, enabled, snoozed_until, dont_remind_until,
		       last_notification_sent_at, notification_message_id,
		       preferred_reminder_hour, created_at, updated_at
		FROM weight_reminder_state WHERE user_id = ?`, userID).Scan(
		&state.UserID, &state.Enabled, &snoozedUntil, &dontRemindUntil,
		&lastNotificationSentAt, &notificationMessageID,
		&state.PreferredReminderHour, &state.CreatedAt, &state.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		// Create default state for new user
		state = WeightReminderState{
			UserID:                userID,
			Enabled:               true,
			PreferredReminderHour: 9, // Default 9 AM (morning weigh-ins recommended)
			CreatedAt:             time.Now(),
			UpdatedAt:             time.Now(),
		}
		// Initialize in database
		if err := s.initWeightReminderState(userID); err != nil {
			return nil, err
		}
		return &state, nil
	}
	if err != nil {
		return nil, err
	}

	if snoozedUntil.Valid {
		state.SnoozedUntil = &snoozedUntil.Time
	}
	if dontRemindUntil.Valid {
		state.DontRemindUntil = &dontRemindUntil.Time
	}
	if lastNotificationSentAt.Valid {
		state.LastNotificationSentAt = &lastNotificationSentAt.Time
	}
	if notificationMessageID.Valid {
		msgID := int(notificationMessageID.Int64)
		state.NotificationMessageID = &msgID
	}

	return &state, nil
}

// initWeightReminderState initializes the weight reminder state for a new user
func (s *Store) initWeightReminderState(userID int64) error {
	_, err := s.db.Exec(`
		INSERT OR IGNORE INTO weight_reminder_state
		(user_id, enabled, preferred_reminder_hour)
		VALUES (?, 1, 9)`, userID)
	return err
}

// SetWeightReminderEnabled enables or disables weight reminders for a user
func (s *Store) SetWeightReminderEnabled(userID int64, enabled bool) error {
	_, err := s.db.Exec(`
		INSERT INTO weight_reminder_state (user_id, enabled, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id) DO UPDATE SET
			enabled = excluded.enabled,
			updated_at = CURRENT_TIMESTAMP`,
		userID, enabled)
	return err
}

// SnoozeWeightReminder snoozes weight reminders for 2 hours
func (s *Store) SnoozeWeightReminder(userID int64) error {
	snoozedUntil := time.Now().Add(2 * time.Hour)
	_, err := s.db.Exec(`
		UPDATE weight_reminder_state
		SET snoozed_until = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		snoozedUntil, userID)
	return err
}

// DontBugMeWeightReminder disables weight reminders for 24 hours
func (s *Store) DontBugMeWeightReminder(userID int64) error {
	dontRemindUntil := time.Now().Add(24 * time.Hour)
	_, err := s.db.Exec(`
		UPDATE weight_reminder_state
		SET dont_remind_until = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		dontRemindUntil, userID)
	return err
}

// UpdateWeightReminderNotificationSent records when a notification was sent
func (s *Store) UpdateWeightReminderNotificationSent(userID int64, messageID *int) error {
	_, err := s.db.Exec(`
		UPDATE weight_reminder_state
		SET last_notification_sent_at = CURRENT_TIMESTAMP,
		    notification_message_id = ?,
		    updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		messageID, userID)
	return err
}

// CalculatePreferredWeightReminderHour calculates the preferred reminder hour based on recent weight logs
// Analyzes last 14 days of weight logs, averages the hour of measurement
// Constraints: 6 AM - 12 PM range (morning weigh-ins recommended)
// Default: 9 AM if < 3 measurements
// Rationale: Weight measurements are most accurate in morning (fasting state)
func (s *Store) CalculatePreferredWeightReminderHour(ctx context.Context, userID int64) (int, error) {
	// Get weight logs from last 14 days
	since := time.Now().AddDate(0, 0, -14)

	rows, err := s.db.QueryContext(ctx, `
		SELECT measured_at
		FROM weight_logs
		WHERE user_id = ? AND measured_at >= ?
		ORDER BY measured_at DESC`, userID, since)
	if err != nil {
		return 9, err // Return default on error
	}
	defer rows.Close()

	var measurements []time.Time
	for rows.Next() {
		var measuredAt time.Time
		if err := rows.Scan(&measuredAt); err != nil {
			return 9, err
		}
		measurements = append(measurements, measuredAt)
	}

	if len(measurements) < 3 {
		return 9, nil // Default if not enough history
	}

	// Calculate average hour
	totalHour := 0
	for _, measurement := range measurements {
		totalHour += measurement.Hour()
	}
	avgHour := totalHour / len(measurements)

	// Constrain to morning range (6 AM - 12 PM)
	if avgHour < 6 {
		avgHour = 6
	} else if avgHour > 12 {
		avgHour = 12
	}

	return avgHour, nil
}

// UpdatePreferredWeightReminderHour updates the preferred reminder hour for a user
func (s *Store) UpdatePreferredWeightReminderHour(userID int64, hour int) error {
	_, err := s.db.Exec(`
		UPDATE weight_reminder_state
		SET preferred_reminder_hour = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		hour, userID)
	return err
}

// GetUsersForWeightReminders returns users who have weight reminders enabled
func (s *Store) GetUsersForWeightReminders() ([]int64, error) {
	rows, err := s.db.Query(`
		SELECT user_id
		FROM weight_reminder_state
		WHERE enabled = 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var userIDs []int64
	for rows.Next() {
		var userID int64
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		userIDs = append(userIDs, userID)
	}
	return userIDs, nil
}
