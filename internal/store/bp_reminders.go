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

// ClearBPReminderNotificationMessage clears the stored Telegram message ID for the current BP reminder.
func (s *Store) ClearBPReminderNotificationMessage(userID int64) error {
	_, err := s.db.Exec(`
		UPDATE bp_reminder_state
		SET notification_message_id = NULL,
		    updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		userID)
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

// BatchGetBPReminderStates retrieves BP reminder states for multiple users efficiently.
// Returns a map keyed by user_id. For users not in the database, a default state is created and saved.
func (s *Store) BatchGetBPReminderStates(userIDs []int64) (map[int64]*BPReminderState, error) {
	result := make(map[int64]*BPReminderState, len(userIDs))
	if len(userIDs) == 0 {
		return result, nil
	}

	batchSize := 500
	for i := 0; i < len(userIDs); i += batchSize {
		end := i + batchSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		batch := userIDs[i:end]

		placeholders := make([]byte, 0, len(batch)*2)
		args := make([]interface{}, len(batch))
		for j, id := range batch {
			if j > 0 {
				placeholders = append(placeholders, ',', '?')
			} else {
				placeholders = append(placeholders, '?')
			}
			args[j] = id
		}

		query := `
			SELECT user_id, enabled, snoozed_until, dont_remind_until,
				   last_notification_sent_at, notification_message_id,
				   preferred_reminder_hour, created_at, updated_at
			FROM bp_reminder_state WHERE user_id IN (` + string(placeholders) + `)`

		rows, err := s.db.Query(query, args...)
		if err != nil {
			return nil, err
		}

		for rows.Next() {
			var state BPReminderState
			var snoozedUntil, dontRemindUntil, lastNotificationSentAt sql.NullTime
			var notificationMessageID sql.NullInt64

			if err := rows.Scan(
				&state.UserID, &state.Enabled, &snoozedUntil, &dontRemindUntil,
				&lastNotificationSentAt, &notificationMessageID,
				&state.PreferredReminderHour, &state.CreatedAt, &state.UpdatedAt,
			); err != nil {
				rows.Close()
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

			result[state.UserID] = &state
		}
		rows.Close()
	}

	// Handle missing states (create default)
	for _, id := range userIDs {
		if _, exists := result[id]; !exists {
			state := &BPReminderState{
				UserID:                id,
				Enabled:               true,
				PreferredReminderHour: 20, // Default 8 PM
				CreatedAt:             time.Now(),
				UpdatedAt:             time.Now(),
			}
			if err := s.initBPReminderState(id); err != nil {
				return nil, err
			}
			result[id] = state
		}
	}

	return result, nil
}

// BatchGetLastBPReadings retrieves the most recent BP reading for multiple users.
func (s *Store) BatchGetLastBPReadings(ctx context.Context, userIDs []int64) (map[int64]*BloodPressure, error) {
	result := make(map[int64]*BloodPressure, len(userIDs))
	if len(userIDs) == 0 {
		return result, nil
	}

	batchSize := 500
	for i := 0; i < len(userIDs); i += batchSize {
		end := i + batchSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		batch := userIDs[i:end]

		placeholders := make([]byte, 0, len(batch)*2)
		args := make([]interface{}, len(batch))
		for j, id := range batch {
			if j > 0 {
				placeholders = append(placeholders, ',', '?')
			} else {
				placeholders = append(placeholders, '?')
			}
			args[j] = id
		}

		// Use window function to efficiently get the latest reading per user without N+1
		query := `
			WITH RankedReadings AS (
				SELECT id, user_id, measured_at, systolic, diastolic, pulse,
					   site, position, category, ignore_calc, notes, tag,
					   ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY measured_at DESC) as rn
				FROM blood_pressure_readings
				WHERE user_id IN (` + string(placeholders) + `)
			)
			SELECT id, user_id, measured_at, systolic, diastolic, pulse,
				   site, position, category, ignore_calc, notes, tag
			FROM RankedReadings
			WHERE rn = 1`

		rows, err := s.db.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}

		for rows.Next() {
			var bp BloodPressure
			var pulse sql.NullInt64
			var site, position, category, notes, tag sql.NullString

			if err := rows.Scan(
				&bp.ID, &bp.UserID, &bp.MeasuredAt, &bp.Systolic, &bp.Diastolic,
				&pulse, &site, &position, &category, &bp.IgnoreCalc, &notes, &tag,
			); err != nil {
				rows.Close()
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

			result[bp.UserID] = &bp
		}
		rows.Close()
	}

	return result, nil
}

// BatchGetDominantBPCategories calculates the dominant BP category over the last 14 days for multiple users.
func (s *Store) BatchGetDominantBPCategories(ctx context.Context, userIDs []int64) (map[int64]string, error) {
	result := make(map[int64]string, len(userIDs))
	if len(userIDs) == 0 {
		return result, nil
	}

	// Initialize with default
	for _, id := range userIDs {
		result[id] = "Normal"
	}

	since := time.Now().AddDate(0, 0, -14)

	batchSize := 500
	for i := 0; i < len(userIDs); i += batchSize {
		end := i + batchSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		batch := userIDs[i:end]

		placeholders := make([]byte, 0, len(batch)*2)
		args := make([]interface{}, 0, len(batch)+1)
		for j, id := range batch {
			if j > 0 {
				placeholders = append(placeholders, ',', '?')
			} else {
				placeholders = append(placeholders, '?')
			}
			args = append(args, id)
		}
		args = append(args, since)

		query := `
			SELECT user_id, category
			FROM blood_pressure_readings
			WHERE user_id IN (` + string(placeholders) + `)
			  AND measured_at >= ?
			  AND ignore_calc = 0`

		rows, err := s.db.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}

		userCategories := make(map[int64]map[string]int)

		for rows.Next() {
			var userID int64
			var category string
			if err := rows.Scan(&userID, &category); err != nil {
				rows.Close()
				return nil, err
			}

			if _, ok := userCategories[userID]; !ok {
				userCategories[userID] = make(map[string]int)
			}
			userCategories[userID][category]++
		}
		rows.Close()

		categoryOrder := []string{"Hypertensive Crisis", "High BP Stage 2", "High BP Stage 1", "Elevated", "Normal"}

		for userID, counts := range userCategories {
			maxCount := 0
			dominantCategory := "Normal"

			for _, cat := range categoryOrder {
				// We iterate starting with the most severe ("Hypertensive Crisis") down to "Normal"
				// If a category count matches maxCount, we ONLY update it if it's the very first time
				// we are setting the maxCount, OR if count > maxCount, meaning ties default to the
				// earlier (more severe) category we already captured.
				if count, ok := counts[cat]; ok && count > maxCount {
					maxCount = count
					dominantCategory = cat
				} else if ok && count == maxCount && maxCount == 0 {
					// edge case: if we process the first valid category and its count is 0
					dominantCategory = cat
				} else if ok && count == maxCount {
					// tie! but since we go from most severe to least, we want to KEEP the more severe one
					// (which we saw earlier). Thus, do nothing here.
				}
			}
			result[userID] = dominantCategory
		}
	}

	return result, nil
}

// BatchCalculatePreferredReminderHours calculates the preferred reminder hour for multiple users.
func (s *Store) BatchCalculatePreferredReminderHours(ctx context.Context, userIDs []int64) (map[int64]int, error) {
	result := make(map[int64]int, len(userIDs))
	if len(userIDs) == 0 {
		return result, nil
	}

	// Initialize with default
	for _, id := range userIDs {
		result[id] = 20
	}

	since := time.Now().AddDate(0, 0, -14)

	batchSize := 500
	for i := 0; i < len(userIDs); i += batchSize {
		end := i + batchSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		batch := userIDs[i:end]

		placeholders := make([]byte, 0, len(batch)*2)
		args := make([]interface{}, 0, len(batch)+1)
		for j, id := range batch {
			if j > 0 {
				placeholders = append(placeholders, ',', '?')
			} else {
				placeholders = append(placeholders, '?')
			}
			args = append(args, id)
		}
		args = append(args, since)

		query := `
			SELECT user_id, measured_at
			FROM blood_pressure_readings
			WHERE user_id IN (` + string(placeholders) + `)
			  AND measured_at >= ?`

		rows, err := s.db.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}

		userHours := make(map[int64][]int)

		for rows.Next() {
			var userID int64
			var measuredAt time.Time
			if err := rows.Scan(&userID, &measuredAt); err != nil {
				rows.Close()
				return nil, err
			}

			userHours[userID] = append(userHours[userID], measuredAt.Hour())
		}
		rows.Close()

		for userID, hours := range userHours {
			if len(hours) < 3 {
				continue
			}

			totalHour := 0
			for _, h := range hours {
				totalHour += h
			}
			avgHour := totalHour / len(hours)

			if avgHour < 8 {
				avgHour = 8
			} else if avgHour > 23 {
				avgHour = 23
			}

			result[userID] = avgHour
		}
	}

	return result, nil
}
