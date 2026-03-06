package domain

import (
	"context"
	"fmt"
)

// ReminderStore is the narrow store interface required by ReminderService.
type ReminderStore interface {
	SnoozeBPReminder(userID int64) error
	DontBugMeBPReminder(userID int64) error
	SnoozeWeightReminder(userID int64) error
	DontBugMeWeightReminder(userID int64) error
}

// ReminderService handles BP and weight reminder management.
// It delegates persistence to the store and keeps the bot layer free from store calls.
type ReminderService interface {
	SnoozeBPReminder(ctx context.Context, userID int64) error
	BlockBPReminders(ctx context.Context, userID int64) error
	SnoozeWeightReminder(ctx context.Context, userID int64) error
	BlockWeightReminders(ctx context.Context, userID int64) error
}

type reminderService struct {
	store ReminderStore
}

// NewReminderService creates a new ReminderService backed by the given store.
func NewReminderService(s ReminderStore) ReminderService {
	return &reminderService{store: s}
}

func (s *reminderService) SnoozeBPReminder(_ context.Context, userID int64) error {
	if err := s.store.SnoozeBPReminder(userID); err != nil {
		return fmt.Errorf("snooze BP reminder for user %d: %w", userID, err)
	}
	return nil
}

func (s *reminderService) BlockBPReminders(_ context.Context, userID int64) error {
	if err := s.store.DontBugMeBPReminder(userID); err != nil {
		return fmt.Errorf("block BP reminders for user %d: %w", userID, err)
	}
	return nil
}

func (s *reminderService) SnoozeWeightReminder(_ context.Context, userID int64) error {
	if err := s.store.SnoozeWeightReminder(userID); err != nil {
		return fmt.Errorf("snooze weight reminder for user %d: %w", userID, err)
	}
	return nil
}

func (s *reminderService) BlockWeightReminders(_ context.Context, userID int64) error {
	if err := s.store.DontBugMeWeightReminder(userID); err != nil {
		return fmt.Errorf("block weight reminders for user %d: %w", userID, err)
	}
	return nil
}
