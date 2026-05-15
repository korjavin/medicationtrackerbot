package bp

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// BPReminderState represents the state of BP reminders for a user.
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

// GetReminderState retrieves the BP reminder state for a user. If no state
// exists, returns a default state with enabled=true and PreferredReminderHour=20
// after lazily initializing the row.
func (r *Repo) GetReminderState(userID int64) (*BPReminderState, error) {
	var state BPReminderState
	var snoozedUntil, dontRemindUntil, lastNotificationSentAt sql.NullTime
	var notificationMessageID sql.NullInt64

	err := r.db.QueryRow(`
		SELECT user_id, enabled, snoozed_until, dont_remind_until,
		       last_notification_sent_at, notification_message_id,
		       preferred_reminder_hour, created_at, updated_at
		FROM bp_reminder_state WHERE user_id = ?`, userID).Scan(
		&state.UserID, &state.Enabled, &snoozedUntil, &dontRemindUntil,
		&lastNotificationSentAt, &notificationMessageID,
		&state.PreferredReminderHour, &state.CreatedAt, &state.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		state = BPReminderState{
			UserID:                userID,
			Enabled:               true,
			PreferredReminderHour: 20, // Default 8 PM
			CreatedAt:             time.Now(),
			UpdatedAt:             time.Now(),
		}
		if err := r.initReminderState(userID); err != nil {
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

// initReminderState lazily inserts a default state row for a new user.
func (r *Repo) initReminderState(userID int64) error {
	_, err := r.db.Exec(`
		INSERT OR IGNORE INTO bp_reminder_state
		(user_id, enabled, preferred_reminder_hour)
		VALUES (?, 1, 20)`, userID)
	return err
}

// SetReminderEnabled enables or disables BP reminders for a user.
func (r *Repo) SetReminderEnabled(userID int64, enabled bool) error {
	_, err := r.db.Exec(`
		INSERT INTO bp_reminder_state (user_id, enabled, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id) DO UPDATE SET
			enabled = excluded.enabled,
			updated_at = CURRENT_TIMESTAMP`,
		userID, enabled)
	return err
}

// SnoozeReminder snoozes BP reminders for 2 hours.
func (r *Repo) SnoozeReminder(userID int64) error {
	snoozedUntil := time.Now().Add(2 * time.Hour)
	_, err := r.db.Exec(`
		UPDATE bp_reminder_state
		SET snoozed_until = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		snoozedUntil, userID)
	return err
}

// DontBugMeReminder disables BP reminders for 24 hours.
func (r *Repo) DontBugMeReminder(userID int64) error {
	dontRemindUntil := time.Now().Add(24 * time.Hour)
	_, err := r.db.Exec(`
		UPDATE bp_reminder_state
		SET dont_remind_until = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		dontRemindUntil, userID)
	return err
}

// UpdateReminderNotificationSent records when a notification was sent.
func (r *Repo) UpdateReminderNotificationSent(userID int64, messageID *int) error {
	_, err := r.db.Exec(`
		UPDATE bp_reminder_state
		SET last_notification_sent_at = CURRENT_TIMESTAMP,
		    notification_message_id = ?,
		    updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		messageID, userID)
	return err
}

// ClearReminderNotificationMessage clears the stored Telegram message ID for
// the current BP reminder.
func (r *Repo) ClearReminderNotificationMessage(userID int64) error {
	_, err := r.db.Exec(`
		UPDATE bp_reminder_state
		SET notification_message_id = NULL,
		    updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		userID)
	return err
}

// GetLastReading retrieves the most recent BP reading for a user. Returns
// (nil, nil) when the user has no readings.
func (r *Repo) GetLastReading(ctx context.Context, userID int64) (*BloodPressure, error) {
	var bp BloodPressure
	var pulse sql.NullInt64
	var site, position, category, notes, tag sql.NullString

	err := r.db.QueryRowContext(ctx, `
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

// GetDominantCategory calculates the dominant BP category over the last 14
// days. Ties favour the more severe category.
func (r *Repo) GetDominantCategory(ctx context.Context, userID int64) (string, error) {
	since := time.Now().AddDate(0, 0, -14)
	readings, err := r.ListReadings(ctx, userID, since)
	if err != nil {
		return "", err
	}

	if len(readings) == 0 {
		return "Normal", nil
	}

	categoryCounts := make(map[string]int)
	for _, reading := range readings {
		if !reading.IgnoreCalc {
			categoryCounts[reading.Category]++
		}
	}

	maxCount := 0
	dominantCategory := "Normal"

	// Order of severity (higher index is less severe). When counts tie,
	// the earlier entry in this slice wins, so the more severe category is
	// picked.
	categoryOrder := []string{"Hypertensive Crisis", "High BP Stage 2", "High BP Stage 1", "Elevated", "Normal"}

	for _, cat := range categoryOrder {
		if count, ok := categoryCounts[cat]; ok && count >= maxCount {
			maxCount = count
			dominantCategory = cat
		}
	}

	return dominantCategory, nil
}

// CalculatePreferredReminderHour returns the average measurement hour over the
// last 14 days, clamped to [8, 23]. Returns the default of 20 when there are
// fewer than 3 readings available.
func (r *Repo) CalculatePreferredReminderHour(ctx context.Context, userID int64) (int, error) {
	since := time.Now().AddDate(0, 0, -14)
	readings, err := r.ListReadings(ctx, userID, since)
	if err != nil {
		return 20, err
	}

	if len(readings) < 3 {
		return 20, nil
	}

	totalHour := 0
	for _, reading := range readings {
		totalHour += reading.MeasuredAt.Hour()
	}
	avgHour := totalHour / len(readings)

	if avgHour < 8 {
		avgHour = 8
	} else if avgHour > 23 {
		avgHour = 23
	}

	return avgHour, nil
}

// UpdatePreferredReminderHour updates the preferred reminder hour for a user.
func (r *Repo) UpdatePreferredReminderHour(userID int64, hour int) error {
	_, err := r.db.Exec(`
		UPDATE bp_reminder_state
		SET preferred_reminder_hour = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ?`,
		hour, userID)
	return err
}

// ListUsersForReminders returns users who have BP reminders enabled.
func (r *Repo) ListUsersForReminders() ([]int64, error) {
	rows, err := r.db.Query(`
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

// BatchGetReminderStates retrieves BP reminder states for multiple users
// efficiently. Users without an explicit state in the DB get a default state
// with Enabled=true and PreferredReminderHour=20.
func (r *Repo) BatchGetReminderStates(ctx context.Context, userIDs []int64) (map[int64]*BPReminderState, error) {
	result := make(map[int64]*BPReminderState, len(userIDs))
	if len(userIDs) == 0 {
		return result, nil
	}

	for _, id := range userIDs {
		result[id] = &BPReminderState{
			UserID:                id,
			Enabled:               true,
			PreferredReminderHour: 20,
			CreatedAt:             time.Now(),
			UpdatedAt:             time.Now(),
		}
	}

	chunkSize := 500
	for i := 0; i < len(userIDs); i += chunkSize {
		end := i + chunkSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		chunk := userIDs[i:end]

		placeholders := make([]string, len(chunk))
		args := make([]interface{}, len(chunk))
		for j, id := range chunk {
			placeholders[j] = "?"
			args[j] = id
		}

		query := "SELECT user_id, enabled, snoozed_until, dont_remind_until, last_notification_sent_at, notification_message_id, preferred_reminder_hour, created_at, updated_at FROM bp_reminder_state WHERE user_id IN (" + strings.Join(placeholders, ",") + ")"

		if err := r.scanReminderStateChunk(ctx, query, args, result); err != nil {
			return nil, err
		}
	}

	return result, nil
}

// scanReminderStateChunk runs one IN-list query and merges results. Split out
// of BatchGetReminderStates so that `defer rows.Close()` reliably fires on
// every exit path — the previous inlined version leaked rows on the normal
// success path (the loop hand-closed rows only after error, never after
// successful exit). See plan §Task 7.
func (r *Repo) scanReminderStateChunk(ctx context.Context, query string, args []interface{}, result map[int64]*BPReminderState) error {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("BatchGetReminderStates query failed: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var state BPReminderState
		var snoozedUntil, dontRemindUntil, lastNotificationSentAt sql.NullTime
		var notificationMessageID sql.NullInt64

		if err := rows.Scan(
			&state.UserID, &state.Enabled, &snoozedUntil, &dontRemindUntil,
			&lastNotificationSentAt, &notificationMessageID,
			&state.PreferredReminderHour, &state.CreatedAt, &state.UpdatedAt,
		); err != nil {
			return err
		}

		if snoozedUntil.Valid {
			t := snoozedUntil.Time
			state.SnoozedUntil = &t
		}
		if dontRemindUntil.Valid {
			t := dontRemindUntil.Time
			state.DontRemindUntil = &t
		}
		if lastNotificationSentAt.Valid {
			t := lastNotificationSentAt.Time
			state.LastNotificationSentAt = &t
		}
		if notificationMessageID.Valid {
			msgID := int(notificationMessageID.Int64)
			state.NotificationMessageID = &msgID
		}

		result[state.UserID] = &state
	}

	return rows.Err()
}

// BatchGetLastReadings retrieves the most recent BP reading for multiple
// users efficiently.
func (r *Repo) BatchGetLastReadings(ctx context.Context, userIDs []int64) (map[int64]*BloodPressure, error) {
	result := make(map[int64]*BloodPressure)
	if len(userIDs) == 0 {
		return result, nil
	}

	chunkSize := 500
	for i := 0; i < len(userIDs); i += chunkSize {
		end := i + chunkSize
		if end > len(userIDs) {
			end = len(userIDs)
		}
		chunk := userIDs[i:end]

		placeholders := make([]string, len(chunk))
		args := make([]interface{}, len(chunk))
		for j, id := range chunk {
			placeholders[j] = "?"
			args[j] = id
		}

		query := `
			SELECT id, user_id, measured_at, systolic, diastolic, pulse, site, position, category, ignore_calc, notes, tag
			FROM (
				SELECT *, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY measured_at DESC) as rn
				FROM blood_pressure_readings
				WHERE user_id IN (` + strings.Join(placeholders, ",") + `)
			) WHERE rn = 1`

		if err := r.scanLastReadingsChunk(ctx, query, args, result); err != nil {
			return nil, err
		}
	}

	return result, nil
}

// scanLastReadingsChunk runs one IN-list query and merges results. Split out
// of BatchGetLastReadings so that `defer rows.Close()` reliably fires on
// every exit path — the previous inlined version leaked rows on the normal
// success path (the loop hand-closed rows only after error, never after
// successful exit). See plan §Task 7.
func (r *Repo) scanLastReadingsChunk(ctx context.Context, query string, args []interface{}, result map[int64]*BloodPressure) error {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("BatchGetLastReadings query failed: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var bp BloodPressure
		var pulse sql.NullInt64
		var site, position, category, notes, tag sql.NullString

		if err := rows.Scan(
			&bp.ID, &bp.UserID, &bp.MeasuredAt, &bp.Systolic, &bp.Diastolic,
			&pulse, &site, &position, &category, &bp.IgnoreCalc, &notes, &tag,
		); err != nil {
			return err
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

	return rows.Err()
}
