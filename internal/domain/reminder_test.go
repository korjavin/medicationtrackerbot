package domain_test

import (
	"context"
	"errors"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
)

// mockReminderStore is a controllable stub for ReminderStore.
type mockReminderStore struct {
	snoozeBPErr         error
	dontBugBPErr        error
	snoozeWeightErr     error
	dontBugWeightErr    error
	snoozeBPCalled      bool
	dontBugBPCalled     bool
	snoozeWeightCalled  bool
	dontBugWeightCalled bool
	snoozeBPUserID      int64
	dontBugBPUserID     int64
	snoozeWeightUserID  int64
	dontBugWeightUserID int64
}

func (m *mockReminderStore) SnoozeBPReminder(userID int64) error {
	m.snoozeBPCalled = true
	m.snoozeBPUserID = userID
	return m.snoozeBPErr
}

func (m *mockReminderStore) DontBugMeBPReminder(userID int64) error {
	m.dontBugBPCalled = true
	m.dontBugBPUserID = userID
	return m.dontBugBPErr
}

func (m *mockReminderStore) SnoozeWeightReminder(userID int64) error {
	m.snoozeWeightCalled = true
	m.snoozeWeightUserID = userID
	return m.snoozeWeightErr
}

func (m *mockReminderStore) DontBugMeWeightReminder(userID int64) error {
	m.dontBugWeightCalled = true
	m.dontBugWeightUserID = userID
	return m.dontBugWeightErr
}

func TestReminderService_SnoozeBPReminder(t *testing.T) {
	storeErr := errors.New("store failure")
	tests := []struct {
		name        string
		storeErr    error
		wantErr     bool
		wantCalled  bool
	}{
		{name: "success", storeErr: nil, wantErr: false, wantCalled: true},
		{name: "store error propagated", storeErr: storeErr, wantErr: true, wantCalled: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mock := &mockReminderStore{snoozeBPErr: tc.storeErr}
			svc := domain.NewReminderService(mock)
			err := svc.SnoozeBPReminder(context.Background(), 42)
			if (err != nil) != tc.wantErr {
				t.Errorf("SnoozeBPReminder() error = %v, wantErr %v", err, tc.wantErr)
			}
			if mock.snoozeBPCalled != tc.wantCalled {
				t.Errorf("SnoozeBPReminder() store called = %v, want %v", mock.snoozeBPCalled, tc.wantCalled)
			}
			if mock.snoozeBPCalled && mock.snoozeBPUserID != 42 {
				t.Errorf("SnoozeBPReminder() userID = %d, want 42", mock.snoozeBPUserID)
			}
			if tc.wantErr && err != nil && !errors.Is(err, storeErr) {
				t.Errorf("expected wrapped store error, got %v", err)
			}
		})
	}
}

func TestReminderService_BlockBPReminders(t *testing.T) {
	storeErr := errors.New("store failure")
	tests := []struct {
		name    string
		storeErr error
		wantErr bool
	}{
		{name: "success", storeErr: nil, wantErr: false},
		{name: "store error propagated", storeErr: storeErr, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mock := &mockReminderStore{dontBugBPErr: tc.storeErr}
			svc := domain.NewReminderService(mock)
			err := svc.BlockBPReminders(context.Background(), 42)
			if (err != nil) != tc.wantErr {
				t.Errorf("BlockBPReminders() error = %v, wantErr %v", err, tc.wantErr)
			}
			if !mock.dontBugBPCalled {
				t.Error("BlockBPReminders() did not call store")
			}
			if mock.dontBugBPUserID != 42 {
				t.Errorf("BlockBPReminders() userID = %d, want 42", mock.dontBugBPUserID)
			}
		})
	}
}

func TestReminderService_SnoozeWeightReminder(t *testing.T) {
	storeErr := errors.New("store failure")
	tests := []struct {
		name    string
		storeErr error
		wantErr bool
	}{
		{name: "success", storeErr: nil, wantErr: false},
		{name: "store error propagated", storeErr: storeErr, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mock := &mockReminderStore{snoozeWeightErr: tc.storeErr}
			svc := domain.NewReminderService(mock)
			err := svc.SnoozeWeightReminder(context.Background(), 99)
			if (err != nil) != tc.wantErr {
				t.Errorf("SnoozeWeightReminder() error = %v, wantErr %v", err, tc.wantErr)
			}
			if !mock.snoozeWeightCalled {
				t.Error("SnoozeWeightReminder() did not call store")
			}
			if mock.snoozeWeightUserID != 99 {
				t.Errorf("SnoozeWeightReminder() userID = %d, want 99", mock.snoozeWeightUserID)
			}
		})
	}
}

func TestReminderService_BlockWeightReminders(t *testing.T) {
	storeErr := errors.New("store failure")
	tests := []struct {
		name    string
		storeErr error
		wantErr bool
	}{
		{name: "success", storeErr: nil, wantErr: false},
		{name: "store error propagated", storeErr: storeErr, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mock := &mockReminderStore{dontBugWeightErr: tc.storeErr}
			svc := domain.NewReminderService(mock)
			err := svc.BlockWeightReminders(context.Background(), 99)
			if (err != nil) != tc.wantErr {
				t.Errorf("BlockWeightReminders() error = %v, wantErr %v", err, tc.wantErr)
			}
			if !mock.dontBugWeightCalled {
				t.Error("BlockWeightReminders() did not call store")
			}
			if mock.dontBugWeightUserID != 99 {
				t.Errorf("BlockWeightReminders() userID = %d, want 99", mock.dontBugWeightUserID)
			}
		})
	}
}
