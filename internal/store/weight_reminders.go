package store

import (
	"context"
)

// Forwarders to (*weight.Repo) for the weight_reminder_state methods that used
// to live on *Store. Deletable in Task 13.

// GetWeightReminderState forwards to (*weight.Repo).GetWeightReminderState.
func (s *Store) GetWeightReminderState(userID int64) (*WeightReminderState, error) {
	return s.weight.GetWeightReminderState(userID)
}

// SetWeightReminderEnabled forwards to (*weight.Repo).SetWeightReminderEnabled.
func (s *Store) SetWeightReminderEnabled(userID int64, enabled bool) error {
	return s.weight.SetWeightReminderEnabled(userID, enabled)
}

// SnoozeWeightReminder forwards to (*weight.Repo).SnoozeWeightReminder.
func (s *Store) SnoozeWeightReminder(userID int64) error {
	return s.weight.SnoozeWeightReminder(userID)
}

// DontBugMeWeightReminder forwards to (*weight.Repo).DontBugMeWeightReminder.
func (s *Store) DontBugMeWeightReminder(userID int64) error {
	return s.weight.DontBugMeWeightReminder(userID)
}

// UpdateWeightReminderNotificationSent forwards to (*weight.Repo).UpdateWeightReminderNotificationSent.
func (s *Store) UpdateWeightReminderNotificationSent(userID int64, messageID *int) error {
	return s.weight.UpdateWeightReminderNotificationSent(userID, messageID)
}

// ClearWeightReminderNotificationMessage forwards to (*weight.Repo).ClearWeightReminderNotificationMessage.
func (s *Store) ClearWeightReminderNotificationMessage(userID int64) error {
	return s.weight.ClearWeightReminderNotificationMessage(userID)
}

// CalculatePreferredWeightReminderHour forwards to (*weight.Repo).CalculatePreferredWeightReminderHour.
func (s *Store) CalculatePreferredWeightReminderHour(ctx context.Context, userID int64) (int, error) {
	return s.weight.CalculatePreferredWeightReminderHour(ctx, userID)
}

// UpdatePreferredWeightReminderHour forwards to (*weight.Repo).UpdatePreferredWeightReminderHour.
func (s *Store) UpdatePreferredWeightReminderHour(userID int64, hour int) error {
	return s.weight.UpdatePreferredWeightReminderHour(userID, hour)
}

// GetUsersForWeightReminders forwards to (*weight.Repo).GetUsersForWeightReminders.
func (s *Store) GetUsersForWeightReminders() ([]int64, error) {
	return s.weight.GetUsersForWeightReminders()
}

// GetWeightReminderStates forwards to (*weight.Repo).GetWeightReminderStates.
func (s *Store) GetWeightReminderStates(ctx context.Context) (map[int64]*WeightReminderState, error) {
	return s.weight.GetWeightReminderStates(ctx)
}
