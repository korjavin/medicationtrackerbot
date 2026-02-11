package store

import (
	"context"
	"testing"
	"time"
)

// setupBPReminderTestDB creates an in-memory test database with all required tables
func setupBPReminderTestDB(t *testing.T) *Store {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	return db
}

func TestGetBPReminderState_NewUser(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	// Test: Get state for new user (should auto-initialize)
	state, err := store.GetBPReminderState(12345)
	if err != nil {
		t.Fatalf("Failed to get BP reminder state: %v", err)
	}

	// Verify defaults
	if state.UserID != 12345 {
		t.Errorf("Expected user_id 12345, got %d", state.UserID)
	}
	if !state.Enabled {
		t.Errorf("Expected enabled to be true for new user, got false")
	}
	if state.PreferredReminderHour != 20 {
		t.Errorf("Expected preferred_reminder_hour to be 20, got %d", state.PreferredReminderHour)
	}
	if state.SnoozedUntil != nil {
		t.Errorf("Expected snoozed_until to be nil, got %v", state.SnoozedUntil)
	}
	if state.DontRemindUntil != nil {
		t.Errorf("Expected dont_remind_until to be nil, got %v", state.DontRemindUntil)
	}
}

func TestSetBPReminderEnabled(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Test: Disable reminders
	err := store.SetBPReminderEnabled(userID, false)
	if err != nil {
		t.Fatalf("Failed to disable BP reminders: %v", err)
	}

	state, err := store.GetBPReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}
	if state.Enabled {
		t.Errorf("Expected enabled to be false, got true")
	}

	// Test: Enable reminders
	err = store.SetBPReminderEnabled(userID, true)
	if err != nil {
		t.Fatalf("Failed to enable BP reminders: %v", err)
	}

	state, err = store.GetBPReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}
	if !state.Enabled {
		t.Errorf("Expected enabled to be true, got false")
	}
}

func TestSnoozeBPReminder(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetBPReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Snooze
	beforeSnooze := time.Now()
	err = store.SnoozeBPReminder(userID)
	if err != nil {
		t.Fatalf("Failed to snooze BP reminder: %v", err)
	}

	state, err := store.GetBPReminderState(userID)
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

func TestDontBugMeBPReminder(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetBPReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Don't bug me
	beforeBlock := time.Now()
	err = store.DontBugMeBPReminder(userID)
	if err != nil {
		t.Fatalf("Failed to set don't bug me: %v", err)
	}

	state, err := store.GetBPReminderState(userID)
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

func TestGetLastBPReading(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	ctx := context.Background()
	userID := int64(12345)

	// Test: No readings
	reading, err := store.GetLastBPReading(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get last BP reading: %v", err)
	}
	if reading != nil {
		t.Errorf("Expected nil for no readings, got %v", reading)
	}

	// Create readings
	now := time.Now()
	_, err = store.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: now.Add(-2 * time.Hour),
		Systolic:   120,
		Diastolic:  80,
	})
	if err != nil {
		t.Fatalf("Failed to create BP reading: %v", err)
	}

	_, err = store.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: now.Add(-1 * time.Hour),
		Systolic:   130,
		Diastolic:  85,
	})
	if err != nil {
		t.Fatalf("Failed to create BP reading: %v", err)
	}

	// Test: Get last reading
	reading, err = store.GetLastBPReading(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get last BP reading: %v", err)
	}

	if reading == nil {
		t.Fatalf("Expected reading, got nil")
	}

	// Should be the most recent (130/85)
	if reading.Systolic != 130 || reading.Diastolic != 85 {
		t.Errorf("Expected 130/85, got %d/%d", reading.Systolic, reading.Diastolic)
	}
}

func TestGetDominantBPCategory(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	ctx := context.Background()
	userID := int64(12345)

	// Test: No readings (should return Normal)
	category, err := store.GetDominantBPCategory(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get dominant category: %v", err)
	}
	if category != "Normal" {
		t.Errorf("Expected 'Normal' for no readings, got '%s'", category)
	}

	// Create readings with different categories
	now := time.Now()
	readings := []struct {
		systolic  int
		diastolic int
		category  string
	}{
		{120, 80, "Normal"},
		{125, 82, "Elevated"},
		{135, 88, "High BP Stage 1"},
		{130, 85, "High BP Stage 1"},
		{128, 83, "Elevated"},
	}

	for i, r := range readings {
		_, err = store.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: now.Add(-time.Duration(len(readings)-i) * time.Hour),
			Systolic:   r.systolic,
			Diastolic:  r.diastolic,
		})
		if err != nil {
			t.Fatalf("Failed to create BP reading: %v", err)
		}
	}

	// Test: Get dominant category
	// We have: 1 Normal, 2 Elevated, 2 High BP Stage 1
	// In case of tie, should pick the more severe one
	category, err = store.GetDominantBPCategory(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get dominant category: %v", err)
	}

	// Should be "High BP Stage 1" (most severe among tied counts)
	if category != "High BP Stage 1" {
		t.Errorf("Expected 'High BP Stage 1', got '%s'", category)
	}
}

func TestCalculatePreferredReminderHour(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	ctx := context.Background()
	userID := int64(12345)

	// Test: No readings (should return default 20)
	hour, err := store.CalculatePreferredReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}
	if hour != 20 {
		t.Errorf("Expected 20 for no readings, got %d", hour)
	}

	// Create readings at different hours
	now := time.Now()
	hours := []int{9, 21, 21, 22, 21} // Average: 18.8, should round to 19

	for i, h := range hours {
		measuredAt := time.Date(now.Year(), now.Month(), now.Day()-i, h, 0, 0, 0, now.Location())
		_, err = store.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: measuredAt,
			Systolic:   120,
			Diastolic:  80,
		})
		if err != nil {
			t.Fatalf("Failed to create BP reading: %v", err)
		}
	}

	// Test: Calculate preferred hour
	hour, err = store.CalculatePreferredReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}

	// Average of [9, 21, 21, 22, 21] = 94/5 = 18.8 -> 18
	if hour != 18 {
		t.Errorf("Expected 18, got %d", hour)
	}

	// Test: Too few readings (< 3)
	store2 := setupBPReminderTestDB(t)
	defer store2.Close()

	userID2 := int64(54321)
	_, err = store2.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID2,
		MeasuredAt: now,
		Systolic:   120,
		Diastolic:  80,
	})
	if err != nil {
		t.Fatalf("Failed to create BP reading: %v", err)
	}

	hour, err = store2.CalculatePreferredReminderHour(ctx, userID2)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}
	if hour != 20 {
		t.Errorf("Expected 20 for too few readings, got %d", hour)
	}
}

func TestCategorySeverity(t *testing.T) {
	tests := []struct {
		category string
		expected int
	}{
		{"Normal", 1},
		{"Elevated", 2},
		{"High BP Stage 1", 3},
		{"High BP Stage 2", 4},
		{"Hypertensive Crisis", 5},
		{"Unknown", 0},
		{"", 0},
	}

	for _, tt := range tests {
		t.Run(tt.category, func(t *testing.T) {
			severity := CategorySeverity(tt.category)
			if severity != tt.expected {
				t.Errorf("CategorySeverity(%q) = %d, expected %d", tt.category, severity, tt.expected)
			}
		})
	}
}

func TestUpdatePreferredReminderHour(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetBPReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Update preferred hour
	err = store.UpdatePreferredReminderHour(userID, 15)
	if err != nil {
		t.Fatalf("Failed to update preferred hour: %v", err)
	}

	state, err := store.GetBPReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.PreferredReminderHour != 15 {
		t.Errorf("Expected preferred_reminder_hour to be 15, got %d", state.PreferredReminderHour)
	}
}

func TestGetUsersForBPReminders(t *testing.T) {
	store := setupBPReminderTestDB(t)
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
		err := store.SetBPReminderEnabled(u.id, u.enabled)
		if err != nil {
			t.Fatalf("Failed to set enabled for user %d: %v", u.id, err)
		}
	}

	// Test: Get users with reminders enabled
	userIDs, err := store.GetUsersForBPReminders()
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

func TestUpdateBPReminderNotificationSent(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	userID := int64(12345)

	// Initialize state
	_, err := store.GetBPReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	// Test: Update notification sent
	messageID := 98765
	err = store.UpdateBPReminderNotificationSent(userID, &messageID)
	if err != nil {
		t.Fatalf("Failed to update notification sent: %v", err)
	}

	state, err := store.GetBPReminderState(userID)
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

func TestGetBloodPressureReadings_Sorting(t *testing.T) {
	store := setupBPReminderTestDB(t)
	defer store.Close()

	ctx := context.Background()
	userID := int64(12345)

	// Create readings on the same day with different times
	today := time.Now().Truncate(24 * time.Hour)

	// Earlier reading: 21:56
	time1 := today.Add(21*time.Hour + 56*time.Minute)
	// Later reading: 22:14
	time2 := today.Add(22*time.Hour + 14*time.Minute)

	// Insert in "wrong" order (earlier first) to ensure sorting works
	_, err := store.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: time1,
		Systolic:   120,
		Diastolic:  80,
	})
	if err != nil {
		t.Fatalf("Failed to create first BP reading: %v", err)
	}

	_, err = store.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: time2,
		Systolic:   130,
		Diastolic:  85,
	})
	if err != nil {
		t.Fatalf("Failed to create second BP reading: %v", err)
	}

	// Fetch readings
	readings, err := store.GetBloodPressureReadings(ctx, userID, time.Time{})
	if err != nil {
		t.Fatalf("Failed to get BP readings: %v", err)
	}

	if len(readings) != 2 {
		t.Fatalf("Expected 2 readings, got %d", len(readings))
	}

	// First reading (index 0) should be the NEWEST (time2: 22:14)
	if !readings[0].MeasuredAt.Equal(time2) {
		t.Errorf("Expected first reading to be more recent (%v), got %v", time2, readings[0].MeasuredAt)
	}

	// Second reading (index 1) should be the OLDEST (time1: 21:56)
	if !readings[1].MeasuredAt.Equal(time1) {
		t.Errorf("Expected second reading to be less recent (%v), got %v", time1, readings[1].MeasuredAt)
	}
}
