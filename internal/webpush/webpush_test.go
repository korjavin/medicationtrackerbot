package webpush

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestSendMedicationNotification(t *testing.T) {
	s, _ := store.New(":memory:")
	svc := New(s, "pub", "priv", "mailto:test@test.com", "admin@test.com", "example.com")

	ctx := context.Background()
	userID := int64(123)
	meds := []store.Medication{
		{ID: 1, Name: "Med 1", Dosage: "10mg"},
	}
	scheduledTime := time.Now()
	intakeIDs := []int64{1}

	// Should return nil even if no subscriptions (just doesn't send)
	err := svc.SendMedicationNotification(ctx, userID, meds, scheduledTime, intakeIDs)
	if err != nil {
		t.Errorf("Expected nil error, got %v", err)
	}

	// Test with no VAPID keys
	svcNoKeys := New(s, "", "", "", "", "")
	err = svcNoKeys.SendMedicationNotification(ctx, userID, meds, scheduledTime, intakeIDs)
	if err != nil {
		t.Errorf("Expected nil error when keys missing, got %v", err)
	}
}

func TestSendLowStockNotification(t *testing.T) {
	s, _ := store.New(":memory:")
	svc := New(s, "pub", "priv", "subject", "admin@test.com", "example.com")

	ctx := context.Background()
	userID := int64(123)
	meds := []store.Medication{{Name: "Test Med"}}

	err := svc.SendLowStockNotification(ctx, userID, meds)
	if err != nil {
		t.Errorf("Expected nil error, got %v", err)
	}
}

func TestSendWorkoutNotification(t *testing.T) {
	s, _ := store.New(":memory:")
	svc := New(s, "pub", "priv", "subject", "admin@test.com", "example.com")

	ctx := context.Background()
	userID := int64(123)
	session := &store.WorkoutSession{ID: 1}
	group := &store.WorkoutGroup{Name: "Group"}
	variant := &store.WorkoutVariant{Name: "Variant"}

	err := svc.SendWorkoutNotification(ctx, userID, session, group, variant)
	if err != nil {
		t.Errorf("Expected nil error, got %v", err)
	}
}

func TestSendBPReminderNotification(t *testing.T) {
	s, _ := store.New(":memory:")
	svc := New(s, "pub", "priv", "subject", "admin@test.com", "example.com")

	err := svc.SendBPReminderNotification(context.Background(), 123, true)
	if err != nil {
		t.Errorf("Expected nil error, got %v", err)
	}
}

func TestSendWeightReminderNotification(t *testing.T) {
	s, _ := store.New(":memory:")
	svc := New(s, "pub", "priv", "subject", "admin@test.com", "example.com")

	err := svc.SendWeightReminderNotification(context.Background(), 123)
	if err != nil {
		t.Errorf("Expected nil error, got %v", err)
	}
}

func TestSendEarlyIntakeConfirmation(t *testing.T) {
	s, _ := store.New(":memory:")
	svc := New(s, "pub", "priv", "subject", "admin@test.com", "example.com")

	err := svc.SendEarlyIntakeConfirmation(context.Background(), 123, []store.Medication{{Name: "Med"}}, time.Now(), time.Now(), []int64{1})
	if err != nil {
		t.Errorf("Expected nil error, got %v", err)
	}
}
