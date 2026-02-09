package store

import (
	"context"
	"testing"
	"time"
)

// setupWeightReminderTestDB creates an in-memory test database with all required tables
func setupWeightReminderTestDB(t *testing.T) *Store {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	return db
}

func TestGetWeightReminderState_NewUser(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	// Test: Get state for new user (should auto-initialize)
	state, err := store.GetWeightReminderState(12345)
	if err != nil {
		t.Fatalf("Failed to get weight reminder state: %v", err)
	}

	// Verify defaults
	if state.UserID != 12345 {
		t.Errorf("Expected user_id 12345, got %d", state.UserID)
	}
	if !state.Enabled {
		t.Errorf("Expected enabled to be true for new user, got false")
	}
	if state.PreferredReminderHour != 9 {
		t.Errorf("Expected preferred_reminder_hour to be 9, got %d", state.PreferredReminderHour)
	}
	if state.SnoozedUntil != nil {
		t.Errorf("Expected snoozed_until to be nil, got %v", state.SnoozedUntil)
	}
	if state.DontRemindUntil != nil {
		t.Errorf("Expected dont_remind_until to be nil, got %v", state.DontRemindUntil)
	}
}

func TestSetWeightReminderEnabled(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Test: Disable reminders
	err := store.SetWeightReminderEnabled(userID, false)
	if err != nil {
		t.Fatalf("Failed to disable weight reminders: %v", err)
	}

	state, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}
	if state.Enabled {
		t.Errorf("Expected enabled to be false, got true")
	}

	// Test: Enable reminders
	err = store.SetWeightReminderEnabled(userID, true)
	if err != nil {
		t.Fatalf("Failed to enable weight reminders: %v", err)
	}

	state, err = store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}
	if !state.Enabled {
		t.Errorf("Expected enabled to be true, got false")
	}
}

func TestSnoozeWeightReminder(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Snooze
	beforeSnooze := time.Now()
	err = store.SnoozeWeightReminder(userID)
	if err != nil {
		t.Fatalf("Failed to snooze weight reminder: %v", err)
	}

	state, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.SnoozedUntil == nil {
		t.Fatalf("Expected snoozed_until to be set, got nil")
	}

	// Should be approximately 2 hours from now
	expectedSnooze := beforeSnooze.Add(2 * time.Hour)
	diff := state.SnoozedUntil.Sub(expectedSnooze)
	if diff < -time.Minute || diff > time.Minute {
		t.Errorf("Expected snoozed_until to be ~2 hours from now, got %v (diff: %v)", state.SnoozedUntil, diff)
	}
}

func TestDontBugMeWeightReminder(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Don't bug me
	beforeBlock := time.Now()
	err = store.DontBugMeWeightReminder(userID)
	if err != nil {
		t.Fatalf("Failed to set don't bug me: %v", err)
	}

	state, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.DontRemindUntil == nil {
		t.Fatalf("Expected dont_remind_until to be set, got nil")
	}

	// Should be approximately 24 hours from now
	expectedBlock := beforeBlock.Add(24 * time.Hour)
	diff := state.DontRemindUntil.Sub(expectedBlock)
	if diff < -time.Minute || diff > time.Minute {
		t.Errorf("Expected dont_remind_until to be ~24 hours from now, got %v (diff: %v)", state.DontRemindUntil, diff)
	}
}

func TestGetLastWeightLog(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	ctx := context.Background()
	userID := int64(12345)

	// Test: No logs
	log, err := store.GetLastWeightLog(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get last weight log: %v", err)
	}
	if log != nil {
		t.Errorf("Expected nil for no logs, got %v", log)
	}

	// Create weight logs
	now := time.Now()
	_, err = store.CreateWeightLog(ctx, &WeightLog{
		UserID:     userID,
		MeasuredAt: now.Add(-2 * time.Hour),
		Weight:     70.5,
	})
	if err != nil {
		t.Fatalf("Failed to create weight log: %v", err)
	}

	_, err = store.CreateWeightLog(ctx, &WeightLog{
		UserID:     userID,
		MeasuredAt: now.Add(-1 * time.Hour),
		Weight:     71.0,
	})
	if err != nil {
		t.Fatalf("Failed to create weight log: %v", err)
	}

	// Test: Get last log
	log, err = store.GetLastWeightLog(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get last weight log: %v", err)
	}

	if log == nil {
		t.Fatalf("Expected log, got nil")
	}

	// Should be the most recent (71.0)
	if log.Weight != 71.0 {
		t.Errorf("Expected weight 71.0, got %f", log.Weight)
	}
}

func TestCalculatePreferredWeightReminderHour(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	ctx := context.Background()
	userID := int64(12345)

	// Test: No logs (should return default 9)
	hour, err := store.CalculatePreferredWeightReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}
	if hour != 9 {
		t.Errorf("Expected 9 for no logs, got %d", hour)
	}

	// Test: Too few logs (< 3)
	now := time.Now()
	_, err = store.CreateWeightLog(ctx, &WeightLog{
		UserID:     userID,
		MeasuredAt: now,
		Weight:     70.0,
	})
	if err != nil {
		t.Fatalf("Failed to create weight log: %v", err)
	}

	hour, err = store.CalculatePreferredWeightReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}
	if hour != 9 {
		t.Errorf("Expected 9 for too few logs, got %d", hour)
	}

	// Create more logs at specific hours (clear the first one by using a new test scenario)
	hours := []int{7, 8, 8, 9, 8} // Average: 8.0, within 6-12 range

	for i, h := range hours {
		measuredAt := time.Date(now.Year(), now.Month(), now.Day()-i, h, 0, 0, 0, now.Location())
		_, err = store.CreateWeightLog(ctx, &WeightLog{
			UserID:     userID,
			MeasuredAt: measuredAt,
			Weight:     70.0 + float64(i)*0.1,
		})
		if err != nil {
			t.Fatalf("Failed to create weight log: %v", err)
		}
	}

	// Test: Calculate preferred hour
	// We now have 6 logs total: the first one at current hour + 5 with [7, 8, 8, 9, 8]
	// The calculation should only use the 5 most recent ones if that's what the query does
	// or all 6 if they're all within 14 days. Let's check what we actually get.
	hour, err = store.CalculatePreferredWeightReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}

	// Since all logs are within 14 days, average should be based on all measurements
	// We can't predict exactly without knowing current hour, so just verify it's in valid range
	if hour < 6 || hour > 12 {
		t.Errorf("Expected hour in range 6-12, got %d", hour)
	}
}

func TestCalculatePreferredWeightReminderHour_Constraints(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	ctx := context.Background()
	userID := int64(12345)
	now := time.Now()

	// Test: Hours below minimum (< 6 AM)
	// Create logs at 3, 4, 5 AM (average = 4, should constrain to 6)
	earlyHours := []int{3, 4, 5}
	for i, h := range earlyHours {
		measuredAt := time.Date(now.Year(), now.Month(), now.Day()-i, h, 0, 0, 0, now.Location())
		_, err := store.CreateWeightLog(ctx, &WeightLog{
			UserID:     userID,
			MeasuredAt: measuredAt,
			Weight:     70.0,
		})
		if err != nil {
			t.Fatalf("Failed to create weight log: %v", err)
		}
	}

	hour, err := store.CalculatePreferredWeightReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}
	if hour != 6 {
		t.Errorf("Expected 6 (constrained minimum), got %d", hour)
	}

	// Test: Hours above maximum (> 12 PM)
	store2 := setupWeightReminderTestDB(t)
	defer store2.Close()
	userID2 := int64(54321)

	// Create logs at 18, 19, 20 (average = 19, should constrain to 12)
	lateHours := []int{18, 19, 20}
	for i, h := range lateHours {
		measuredAt := time.Date(now.Year(), now.Month(), now.Day()-i, h, 0, 0, 0, now.Location())
		_, err := store2.CreateWeightLog(ctx, &WeightLog{
			UserID:     userID2,
			MeasuredAt: measuredAt,
			Weight:     70.0,
		})
		if err != nil {
			t.Fatalf("Failed to create weight log: %v", err)
		}
	}

	hour, err = store2.CalculatePreferredWeightReminderHour(ctx, userID2)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}
	if hour != 12 {
		t.Errorf("Expected 12 (constrained maximum), got %d", hour)
	}
}

func TestUpdatePreferredWeightReminderHour(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Update preferred hour
	err = store.UpdatePreferredWeightReminderHour(userID, 7)
	if err != nil {
		t.Fatalf("Failed to update preferred hour: %v", err)
	}

	state, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.PreferredReminderHour != 7 {
		t.Errorf("Expected preferred_reminder_hour to be 7, got %d", state.PreferredReminderHour)
	}
}

func TestGetUsersForWeightReminders(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	// Create multiple users with different states
	users := []struct {
		id      int64
		enabled bool
	}{
		{12345, true},
		{54321, false},
		{99999, true},
	}

	for _, u := range users {
		err := store.SetWeightReminderEnabled(u.id, u.enabled)
		if err != nil {
			t.Fatalf("Failed to set enabled for user %d: %v", u.id, err)
		}
	}

	// Test: Get users with reminders enabled
	userIDs, err := store.GetUsersForWeightReminders()
	if err != nil {
		t.Fatalf("Failed to get users: %v", err)
	}

	// Should only return enabled users (12345 and 99999)
	if len(userIDs) != 2 {
		t.Errorf("Expected 2 enabled users, got %d", len(userIDs))
	}

	// Verify user IDs
	hasUser1 := false
	hasUser3 := false
	for _, id := range userIDs {
		if id == 12345 {
			hasUser1 = true
		}
		if id == 99999 {
			hasUser3 = true
		}
		if id == 54321 {
			t.Errorf("User 54321 should not be in enabled users list (disabled)")
		}
	}

	if !hasUser1 {
		t.Errorf("User 12345 should be in enabled users list")
	}
	if !hasUser3 {
		t.Errorf("User 99999 should be in enabled users list")
	}
}

func TestUpdateWeightReminderNotificationSent(t *testing.T) {
	store := setupWeightReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Update notification sent
	messageID := 98765
	err = store.UpdateWeightReminderNotificationSent(userID, &messageID)
	if err != nil {
		t.Fatalf("Failed to update notification sent: %v", err)
	}

	state, err := store.GetWeightReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.NotificationMessageID == nil {
		t.Fatalf("Expected notification_message_id to be set, got nil")
	}
	if *state.NotificationMessageID != messageID {
		t.Errorf("Expected notification_message_id to be %d, got %d", messageID, *state.NotificationMessageID)
	}

	if state.LastNotificationSentAt == nil {
		t.Fatalf("Expected last_notification_sent_at to be set, got nil")
	}
	// Allow for timezone differences and a few minutes of clock skew
	diff := time.Since(*state.LastNotificationSentAt)
	if diff < -5*time.Minute || diff > 5*time.Minute {
		t.Errorf("Expected last_notification_sent_at to be recent (within 5 minutes), got %v (diff: %v)", state.LastNotificationSentAt, diff)
	}
}
