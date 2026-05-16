package bp

import (
	"context"
	"testing"
	"time"
)

func TestGetReminderState_NewUser(t *testing.T) {
	r := setupBPRepo(t)

	state, err := r.GetReminderState(12345)
	if err != nil {
		t.Fatalf("Failed to get BP reminder state: %v", err)
	}

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

func TestSetReminderEnabled(t *testing.T) {
	r := setupBPRepo(t)
	userID := int64(12345)

	if err := r.SetReminderEnabled(userID, false); err != nil {
		t.Fatalf("Failed to disable BP reminders: %v", err)
	}

	state, err := r.GetReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}
	if state.Enabled {
		t.Errorf("Expected enabled to be false, got true")
	}

	if err := r.SetReminderEnabled(userID, true); err != nil {
		t.Fatalf("Failed to enable BP reminders: %v", err)
	}

	state, err = r.GetReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}
	if !state.Enabled {
		t.Errorf("Expected enabled to be true, got false")
	}
}

func TestSnoozeReminder(t *testing.T) {
	r := setupBPRepo(t)
	userID := int64(12345)

	if _, err := r.GetReminderState(userID); err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	beforeSnooze := time.Now()
	if err := r.SnoozeReminder(userID); err != nil {
		t.Fatalf("Failed to snooze BP reminder: %v", err)
	}

	state, err := r.GetReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.SnoozedUntil == nil {
		t.Fatalf("Expected snoozed_until to be set, got nil")
	}

	expectedSnooze := beforeSnooze.Add(2 * time.Hour)
	diff := state.SnoozedUntil.Sub(expectedSnooze)
	if diff < -time.Minute || diff > time.Minute {
		t.Errorf("Expected snoozed_until to be ~2 hours from now, got %v (diff: %v)", state.SnoozedUntil, diff)
	}
}

func TestDontBugMeReminder(t *testing.T) {
	r := setupBPRepo(t)
	userID := int64(12345)

	if _, err := r.GetReminderState(userID); err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	beforeBlock := time.Now()
	if err := r.DontBugMeReminder(userID); err != nil {
		t.Fatalf("Failed to set don't bug me: %v", err)
	}

	state, err := r.GetReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.DontRemindUntil == nil {
		t.Fatalf("Expected dont_remind_until to be set, got nil")
	}

	expectedBlock := beforeBlock.Add(24 * time.Hour)
	diff := state.DontRemindUntil.Sub(expectedBlock)
	if diff < -time.Minute || diff > time.Minute {
		t.Errorf("Expected dont_remind_until to be ~24 hours from now, got %v (diff: %v)", state.DontRemindUntil, diff)
	}
}

func TestGetLastReading(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(12345)

	reading, err := r.GetLastReading(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get last BP reading: %v", err)
	}
	if reading != nil {
		t.Errorf("Expected nil for no readings, got %v", reading)
	}

	now := time.Now()
	_, err = r.CreateReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: now.Add(-2 * time.Hour),
		Systolic:   120,
		Diastolic:  80,
	})
	if err != nil {
		t.Fatalf("Failed to create BP reading: %v", err)
	}

	_, err = r.CreateReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: now.Add(-1 * time.Hour),
		Systolic:   130,
		Diastolic:  85,
	})
	if err != nil {
		t.Fatalf("Failed to create BP reading: %v", err)
	}

	reading, err = r.GetLastReading(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get last BP reading: %v", err)
	}

	if reading == nil {
		t.Fatalf("Expected reading, got nil")
	}

	if reading.Systolic != 130 || reading.Diastolic != 85 {
		t.Errorf("Expected 130/85, got %d/%d", reading.Systolic, reading.Diastolic)
	}
}

func TestGetDominantCategory(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(12345)

	category, err := r.GetDominantCategory(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get dominant category: %v", err)
	}
	if category != "Normal" {
		t.Errorf("Expected 'Normal' for no readings, got '%s'", category)
	}

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

	for i, rd := range readings {
		_, err = r.CreateReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: now.Add(-time.Duration(len(readings)-i) * time.Hour),
			Systolic:   rd.systolic,
			Diastolic:  rd.diastolic,
		})
		if err != nil {
			t.Fatalf("Failed to create BP reading: %v", err)
		}
	}

	category, err = r.GetDominantCategory(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to get dominant category: %v", err)
	}

	// 1 Normal, 2 Elevated, 2 High BP Stage 1 — tie should pick more severe.
	if category != "High BP Stage 1" {
		t.Errorf("Expected 'High BP Stage 1', got '%s'", category)
	}
}

func TestCalculatePreferredReminderHour(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(12345)

	hour, err := r.CalculatePreferredReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}
	if hour != 20 {
		t.Errorf("Expected 20 for no readings, got %d", hour)
	}

	now := time.Now()
	hours := []int{9, 21, 21, 22, 21} // Average: 18.8, integer divides to 18.

	for i, h := range hours {
		measuredAt := time.Date(now.Year(), now.Month(), now.Day()-i, h, 0, 0, 0, now.Location())
		_, err = r.CreateReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: measuredAt,
			Systolic:   120,
			Diastolic:  80,
		})
		if err != nil {
			t.Fatalf("Failed to create BP reading: %v", err)
		}
	}

	hour, err = r.CalculatePreferredReminderHour(ctx, userID)
	if err != nil {
		t.Fatalf("Failed to calculate preferred hour: %v", err)
	}

	if hour != 18 {
		t.Errorf("Expected 18, got %d", hour)
	}

	r2 := setupBPRepo(t)
	userID2 := int64(54321)
	_, err = r2.CreateReading(ctx, &BloodPressure{
		UserID:     userID2,
		MeasuredAt: now,
		Systolic:   120,
		Diastolic:  80,
	})
	if err != nil {
		t.Fatalf("Failed to create BP reading: %v", err)
	}

	hour, err = r2.CalculatePreferredReminderHour(ctx, userID2)
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
	r := setupBPRepo(t)
	userID := int64(12345)

	if _, err := r.GetReminderState(userID); err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	if err := r.UpdatePreferredReminderHour(userID, 15); err != nil {
		t.Fatalf("Failed to update preferred hour: %v", err)
	}

	state, err := r.GetReminderState(userID)
	if err != nil {
		t.Fatalf("Failed to get state: %v", err)
	}

	if state.PreferredReminderHour != 15 {
		t.Errorf("Expected preferred_reminder_hour to be 15, got %d", state.PreferredReminderHour)
	}
}

func TestListUsersForReminders(t *testing.T) {
	r := setupBPRepo(t)

	users := []struct {
		id      int64
		enabled bool
	}{
		{12345, true},
		{54321, false},
		{99999, true},
	}

	for _, u := range users {
		if err := r.SetReminderEnabled(u.id, u.enabled); err != nil {
			t.Fatalf("Failed to set enabled for user %d: %v", u.id, err)
		}
	}

	userIDs, err := r.ListUsersForReminders()
	if err != nil {
		t.Fatalf("Failed to get users: %v", err)
	}

	if len(userIDs) != 2 {
		t.Errorf("Expected 2 enabled users, got %d", len(userIDs))
	}

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

func TestUpdateReminderNotificationSent(t *testing.T) {
	r := setupBPRepo(t)
	userID := int64(12345)

	if _, err := r.GetReminderState(userID); err != nil {
		t.Fatalf("Failed to initialize state: %v", err)
	}

	messageID := 98765
	if err := r.UpdateReminderNotificationSent(userID, &messageID); err != nil {
		t.Fatalf("Failed to update notification sent: %v", err)
	}

	state, err := r.GetReminderState(userID)
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
	diff := time.Since(*state.LastNotificationSentAt)
	if diff < -5*time.Minute || diff > 5*time.Minute {
		t.Errorf("Expected last_notification_sent_at to be recent (within 5 minutes), got %v (diff: %v)", state.LastNotificationSentAt, diff)
	}
}

func TestListReadings_Sorting(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(12345)

	today := time.Now().Truncate(24 * time.Hour)

	// Earlier reading: 21:56
	time1 := today.Add(21*time.Hour + 56*time.Minute)
	// Later reading: 22:14
	time2 := today.Add(22*time.Hour + 14*time.Minute)

	_, err := r.CreateReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: time1,
		Systolic:   120,
		Diastolic:  80,
	})
	if err != nil {
		t.Fatalf("Failed to create first BP reading: %v", err)
	}

	_, err = r.CreateReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: time2,
		Systolic:   130,
		Diastolic:  85,
	})
	if err != nil {
		t.Fatalf("Failed to create second BP reading: %v", err)
	}

	readings, err := r.ListReadings(ctx, userID, time.Time{})
	if err != nil {
		t.Fatalf("Failed to get BP readings: %v", err)
	}

	if len(readings) != 2 {
		t.Fatalf("Expected 2 readings, got %d", len(readings))
	}

	if !readings[0].MeasuredAt.Equal(time2) {
		t.Errorf("Expected first reading to be more recent (%v), got %v", time2, readings[0].MeasuredAt)
	}

	if !readings[1].MeasuredAt.Equal(time1) {
		t.Errorf("Expected second reading to be less recent (%v), got %v", time1, readings[1].MeasuredAt)
	}
}
