package domain

// ReminderStore is the subset of store operations needed for reminder operations.
type ReminderStore interface {
	// Blood pressure reminder operations
	SnoozeReminder(userID int64) error
	DontBugMeReminder(userID int64) error

	// Weight reminder operations
	SnoozeWeightReminder(userID int64) error
	DontBugMeWeightReminder(userID int64) error
}

// ReminderService provides business logic for reminder operations.
type ReminderService interface {
	// Blood pressure reminder operations
	SnoozeBPReminder(userID int64) error
	BlockBPReminders(userID int64) error

	// Weight reminder operations
	SnoozeWeightReminder(userID int64) error
	BlockWeightReminders(userID int64) error
}

type reminderService struct {
	store ReminderStore
}

// NewReminderService creates a new ReminderService.
func NewReminderService(s ReminderStore) ReminderService {
	return &reminderService{store: s}
}

// SnoozeBPReminder snoozes BP reminders for 2 hours.
func (s *reminderService) SnoozeBPReminder(userID int64) error {
	return s.store.SnoozeReminder(userID)
}

// BlockBPReminders disables BP reminders for 24 hours.
func (s *reminderService) BlockBPReminders(userID int64) error {
	return s.store.DontBugMeReminder(userID)
}

// SnoozeWeightReminder snoozes weight reminders for 2 hours.
func (s *reminderService) SnoozeWeightReminder(userID int64) error {
	return s.store.SnoozeWeightReminder(userID)
}

// BlockWeightReminders disables weight reminders for 24 hours.
func (s *reminderService) BlockWeightReminders(userID int64) error {
	return s.store.DontBugMeWeightReminder(userID)
}
