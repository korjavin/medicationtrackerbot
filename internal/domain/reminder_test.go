package domain

import (
	"errors"
	"testing"
)

// Ensure mockReminderStore satisfies the ReminderStore interface at compile time.
var _ ReminderStore = (*mockReminderStore)(nil)

// mockReminderStore implements ReminderStore for testing.
type mockReminderStore struct {
	snoozeBPFn        func(userID int64) error
	dontBugMeBPFn     func(userID int64) error
	snoozeWeightFn    func(userID int64) error
	dontBugMeWeightFn func(userID int64) error
}

func (m *mockReminderStore) SnoozeBPReminder(userID int64) error {
	if m.snoozeBPFn != nil {
		return m.snoozeBPFn(userID)
	}
	return nil
}

func (m *mockReminderStore) DontBugMeBPReminder(userID int64) error {
	if m.dontBugMeBPFn != nil {
		return m.dontBugMeBPFn(userID)
	}
	return nil
}

func (m *mockReminderStore) SnoozeWeightReminder(userID int64) error {
	if m.snoozeWeightFn != nil {
		return m.snoozeWeightFn(userID)
	}
	return nil
}

func (m *mockReminderStore) DontBugMeWeightReminder(userID int64) error {
	if m.dontBugMeWeightFn != nil {
		return m.dontBugMeWeightFn(userID)
	}
	return nil
}

func TestSnoozeBPReminder(t *testing.T) {
	tests := []struct {
		name    string
		userID  int64
		store   *mockReminderStore
		wantErr bool
	}{
		{
			name:   "snooze BP reminder successfully",
			userID: 12345,
			store: &mockReminderStore{
				snoozeBPFn: func(userID int64) error {
					if userID != 12345 {
						t.Errorf("expected userID 12345, got %d", userID)
					}
					return nil
				},
			},
			wantErr: false,
		},
		{
			name:   "store error is propagated",
			userID: 12345,
			store: &mockReminderStore{
				snoozeBPFn: func(userID int64) error {
					return errors.New("database error")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewReminderService(tt.store)
			err := svc.SnoozeBPReminder(tt.userID)
			if (err != nil) != tt.wantErr {
				t.Errorf("SnoozeBPReminder() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestBlockBPReminders(t *testing.T) {
	tests := []struct {
		name    string
		userID  int64
		store   *mockReminderStore
		wantErr bool
	}{
		{
			name:   "block BP reminders successfully",
			userID: 12345,
			store: &mockReminderStore{
				dontBugMeBPFn: func(userID int64) error {
					if userID != 12345 {
						t.Errorf("expected userID 12345, got %d", userID)
					}
					return nil
				},
			},
			wantErr: false,
		},
		{
			name:   "store error is propagated",
			userID: 12345,
			store: &mockReminderStore{
				dontBugMeBPFn: func(userID int64) error {
					return errors.New("database error")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewReminderService(tt.store)
			err := svc.BlockBPReminders(tt.userID)
			if (err != nil) != tt.wantErr {
				t.Errorf("BlockBPReminders() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSnoozeWeightReminder(t *testing.T) {
	tests := []struct {
		name    string
		userID  int64
		store   *mockReminderStore
		wantErr bool
	}{
		{
			name:   "snooze weight reminder successfully",
			userID: 12345,
			store: &mockReminderStore{
				snoozeWeightFn: func(userID int64) error {
					if userID != 12345 {
						t.Errorf("expected userID 12345, got %d", userID)
					}
					return nil
				},
			},
			wantErr: false,
		},
		{
			name:   "store error is propagated",
			userID: 12345,
			store: &mockReminderStore{
				snoozeWeightFn: func(userID int64) error {
					return errors.New("database error")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewReminderService(tt.store)
			err := svc.SnoozeWeightReminder(tt.userID)
			if (err != nil) != tt.wantErr {
				t.Errorf("SnoozeWeightReminder() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestBlockWeightReminders(t *testing.T) {
	tests := []struct {
		name    string
		userID  int64
		store   *mockReminderStore
		wantErr bool
	}{
		{
			name:   "block weight reminders successfully",
			userID: 12345,
			store: &mockReminderStore{
				dontBugMeWeightFn: func(userID int64) error {
					if userID != 12345 {
						t.Errorf("expected userID 12345, got %d", userID)
					}
					return nil
				},
			},
			wantErr: false,
		},
		{
			name:   "store error is propagated",
			userID: 12345,
			store: &mockReminderStore{
				dontBugMeWeightFn: func(userID int64) error {
					return errors.New("database error")
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewReminderService(tt.store)
			err := svc.BlockWeightReminders(tt.userID)
			if (err != nil) != tt.wantErr {
				t.Errorf("BlockWeightReminders() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
