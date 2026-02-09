package store

import (
	"context"
	"database/sql"
	"time"
)

// BPReminderState represents the state of BP reminders for a user
type BPReminderState struct {
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

// GetBPReminderState retrieves the BP reminder state for a user
// If no state exists, returns a default state with enabled=true
func (s *Store) GetBPReminderState(userID int64) (*BPReminderState, error) {
	var state BPReminderState
	var snoozedUntil, dontRemindUntil, lastNotificationSentAt sql.NullTime
	var notificationMessageID sql.NullInt64

	err := s.db.QueryRow(`
		SELECT user_id, enabled, snoozed_until, dont_remind_until,
		       last_notification_sent_at, notification_message_id,
		       preferred_reminder_hour, created_at, updated_at
		FROM bp_reminder_state WHERE user_id = ?`, userID).Scan(
		&state.UserID, &state.Enabled, &snoozedUntil, &dontRemindUntil,
		&lastNotificationSentAt, &notificationMessageID,
		&state.PreferredReminderHour, &state.CreatedAt, &state.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		// Create default state for new user
		state = BPReminderState{
			UserID:                userID,
			Enabled:               true,
			PreferredReminderHour: 20, // Default 8 PM
			CreatedAt:             time.Now(),
			UpdatedAt:             time.Now(),
		}
		// Initialize in database
		if err := s.initBPReminderState(userID); err != nil {
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

// initBPReminderState initializes the BP reminder state for a new user
func (s *Store) initBPReminderState(userID int64) error {
	_, err := s.db.Exec(`
		INSERT OR IGNORE INTO bp_reminder_state
		(user_id, enabled, preferred_reminder_hour)
		VALUES (?, 1, 20)`, userID)
	return err
}

// SetBPReminderEnabled enables or disables BP reminders for a user
func (s *Store) SetBPReminderEnabled(userID int64, enabled bool) error {
	_, err := s.db.Exec(`
		INSERT INTO bp_reminder_state (user_id, enabled, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id) DO UPDATE SET
			enabled = excluded.enabled,
			updated_at = CURRENT_TIMESTAMP`,
		userID, enabled)
	return err
}

// SnoozeBPReminder snoozes BP reminders for 2 hours
func (s *Store) SnoozeBPReminder(userID int64) error {
	snoozedUntil := time.Now().Add(2 * time.Hour)
	_, err := s.db.Exec(`
		UPDATE bp_reminder_state
		SET snoozed_until = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		snoozedUntil, userID)
	return err
}

// DontBugMeBPReminder disables BP reminders for 24 hours
func (s *Store) DontBugMeBPReminder(userID int64) error {
	dontRemindUntil := time.Now().Add(24 * time.Hour)
	_, err := s.db.Exec(`
		UPDATE bp_reminder_state
		SET dont_remind_until = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		dontRemindUntil, userID)
	return err
}

// UpdateBPReminderNotificationSent records when a notification was sent
func (s *Store) UpdateBPReminderNotificationSent(userID int64, messageID *int) error {
	_, err := s.db.Exec(`
		UPDATE bp_reminder_state
		SET last_notification_sent_at = CURRENT_TIMESTAMP,
		    notification_message_id = ?,
		    updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		messageID, userID)
	return err
}

// GetLastBPReading retrieves the most recent BP reading for a user
func (s *Store) GetLastBPReading(ctx context.Context, userID int64) (*BloodPressure, error) {
	var bp BloodPressure
	var pulse sql.NullInt64
	var site, position, category, notes, tag sql.NullString

	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, measured_at, systolic, diastolic, pulse,
		       site, position, category, ignore_calc, notes, tag
		FROM blood_pressure_readings
		WHERE user_id = ?
		ORDER BY measured_at DESC
		LIMIT 1`, userID).Scan(
		&bp.ID, &bp.UserID, &bp.MeasuredAt, &bp.Systolic, &bp.Diastolic,
		&pulse, &site, &position, &category, &bp.IgnoreCalc, &notes, &tag,
	)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if pulse.Valid {
		p := int(pulse.Int64)
		bp.Pulse = &p
	}
	if site.Valid {
		bp.Site = site.String
	}
	if position.Valid {
		bp.Position = position.String
	}
	if category.Valid {
		bp.Category = category.String
	}
	if notes.Valid {
		bp.Notes = notes.String
	}
	if tag.Valid {
		bp.Tag = tag.String
	}

	return &bp, nil
}

// GetDominantBPCategory calculates the dominant BP category over the last 14 days
func (s *Store) GetDominantBPCategory(ctx context.Context, userID int64) (string, error) {
	// Get readings from last 14 days
	since := time.Now().AddDate(0, 0, -14)
	readings, err := s.GetBloodPressureReadings(ctx, userID, since)
	if err != nil {
		return "", err
	}

	if len(readings) == 0 {
		return "Normal", nil // Default if no history
	}

	// Count categories
	categoryCounts := make(map[string]int)
	for _, reading := range readings {
		if !reading.IgnoreCalc {
			categoryCounts[reading.Category]++
		}
	}

	// Find dominant category (most frequent)
	maxCount := 0
	dominantCategory := "Normal"

	// Order of severity (higher is worse)
	categoryOrder := []string{"Hypertensive Crisis", "High BP Stage 2", "High BP Stage 1", "Elevated", "Normal"}

	// If there's a tie, pick the more severe one
	for _, cat := range categoryOrder {
		if count, ok := categoryCounts[cat]; ok && count >= maxCount {
			maxCount = count
			dominantCategory = cat
		}
	}

	return dominantCategory, nil
}

// CalculatePreferredReminderHour calculates the preferred reminder hour based on recent BP readings
func (s *Store) CalculatePreferredReminderHour(ctx context.Context, userID int64) (int, error) {
	// Get readings from last 14 days
	since := time.Now().AddDate(0, 0, -14)
	readings, err := s.GetBloodPressureReadings(ctx, userID, since)
	if err != nil {
		return 20, err // Return default on error
	}

	if len(readings) < 3 {
		return 20, nil // Default if not enough history
	}

	// Calculate average hour
	totalHour := 0
	for _, reading := range readings {
		totalHour += reading.MeasuredAt.Hour()
	}
	avgHour := totalHour / len(readings)

	// Constrain to reasonable range (8 AM - 11 PM)
	if avgHour < 8 {
		avgHour = 8
	} else if avgHour > 23 {
		avgHour = 23
	}

	return avgHour, nil
}

// UpdatePreferredReminderHour updates the preferred reminder hour for a user
func (s *Store) UpdatePreferredReminderHour(userID int64, hour int) error {
	_, err := s.db.Exec(`
		UPDATE bp_reminder_state
		SET preferred_reminder_hour = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		hour, userID)
	return err
}

// GetUsersForBPReminders returns users who have BP reminders enabled
func (s *Store) GetUsersForBPReminders() ([]int64, error) {
	rows, err := s.db.Query(`
		SELECT user_id
		FROM bp_reminder_state
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

// CategorySeverity returns a numeric value for category comparison (higher = worse)
func CategorySeverity(category string) int {
	switch category {
	case "Hypertensive Crisis":
		return 5
	case "High BP Stage 2":
		return 4
	case "High BP Stage 1":
		return 3
	case "Elevated":
		return 2
	case "Normal":
		return 1
	default:
		return 0
	}
}
