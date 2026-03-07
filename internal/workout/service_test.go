package workout

import (
	"errors"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type mockWorkoutStore struct {
	session *store.WorkoutSession
	group   *store.WorkoutGroup

	getSessionErr error
	getGroupErr   error
	startErr      error
	clearSnoozeErr error
	snoozeErr     error
	skipErr       error
	completeErr   error
	advanceErr    error
	createErr     error

	skipCalled     bool
	completeCalled bool
	advanceCalled  bool
}

func (m *mockWorkoutStore) GetWorkoutSession(id int64) (*store.WorkoutSession, error) {
	if m.getSessionErr != nil {
		return nil, m.getSessionErr
	}
	return m.session, nil
}

func (m *mockWorkoutStore) GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error) {
	if m.getGroupErr != nil {
		return nil, m.getGroupErr
	}
	return m.group, nil
}

func (m *mockWorkoutStore) StartSession(id int64) error {
	return m.startErr
}

func (m *mockWorkoutStore) ClearSnooze(id int64) error {
	return m.clearSnoozeErr
}

func (m *mockWorkoutStore) SnoozeSession(id int64, duration time.Duration) error {
	return m.snoozeErr
}

func (m *mockWorkoutStore) SkipSession(sessionID int64) error {
	m.skipCalled = true
	return m.skipErr
}

func (m *mockWorkoutStore) CompleteSession(id int64) error {
	m.completeCalled = true
	return m.completeErr
}

func (m *mockWorkoutStore) AdvanceRotation(groupID int64) error {
	m.advanceCalled = true
	return m.advanceErr
}

func (m *mockWorkoutStore) CreateAdHocWorkoutSession(userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	if m.createErr != nil {
		return nil, m.createErr
	}
	return m.session, nil
}

func TestSkipSession_IgnoresRotationAdvanceError(t *testing.T) {
	m := &mockWorkoutStore{
		session:    &store.WorkoutSession{ID: 42, GroupID: 7},
		group:      &store.WorkoutGroup{ID: 7, IsRotating: true},
		advanceErr: errors.New("advance failed"),
	}
	svc := New(m)

	err := svc.SkipSession(42)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if !m.skipCalled {
		t.Fatal("expected SkipSession to be called")
	}
	if !m.advanceCalled {
		t.Fatal("expected AdvanceRotation to be called")
	}
}

func TestSkipSession_ReturnsSkipError(t *testing.T) {
	m := &mockWorkoutStore{
		session: &store.WorkoutSession{ID: 42, GroupID: 7},
		group:   &store.WorkoutGroup{ID: 7, IsRotating: true},
		skipErr: errors.New("skip failed"),
	}
	svc := New(m)

	err := svc.SkipSession(42)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !m.skipCalled {
		t.Fatal("expected SkipSession to be called")
	}
	if m.advanceCalled {
		t.Fatal("did not expect AdvanceRotation when skip failed")
	}
}

func TestCompleteSession_IgnoresGroupLookupError(t *testing.T) {
	m := &mockWorkoutStore{
		session:     &store.WorkoutSession{ID: 42, GroupID: 7},
		group:       &store.WorkoutGroup{ID: 7, IsRotating: true},
		getGroupErr: errors.New("group read failed"),
	}
	svc := New(m)

	err := svc.CompleteSession(42)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if !m.completeCalled {
		t.Fatal("expected CompleteSession to be called")
	}
	if m.advanceCalled {
		t.Fatal("did not expect AdvanceRotation when group lookup fails")
	}
}

func TestCompleteSession_ReturnsCompleteError(t *testing.T) {
	m := &mockWorkoutStore{
		session:     &store.WorkoutSession{ID: 42, GroupID: 7},
		group:       &store.WorkoutGroup{ID: 7, IsRotating: true},
		completeErr: errors.New("complete failed"),
	}
	svc := New(m)

	err := svc.CompleteSession(42)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !m.completeCalled {
		t.Fatal("expected CompleteSession to be called")
	}
	if m.advanceCalled {
		t.Fatal("did not expect AdvanceRotation when complete failed")
	}
}
