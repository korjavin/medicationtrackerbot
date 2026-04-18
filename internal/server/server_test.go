package server

import (
	"testing"
)

type mockWorkoutInteractor struct{}

func (m *mockWorkoutInteractor) UpdateWorkoutMessage(msgID int, text string) error {
	return nil
}
func (m *mockWorkoutInteractor) StartWorkoutFlowFromWeb(sessionID int64) error {
	return nil
}
func (m *mockWorkoutInteractor) CleanupWorkoutSessionMessages(sessionID int64) error {
	return nil
}
func (m *mockWorkoutInteractor) ClearPendingExercises(sessionID int64) {}

func TestSetWorkoutInteractor(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	if srv.workout != nil {
		t.Errorf("Expected workout to be nil initially")
	}

	mock := &mockWorkoutInteractor{}
	srv.SetWorkoutInteractor(mock)

	if srv.workout != WorkoutInteractor(mock) {
		t.Errorf("Expected workout to be set to the mock")
	}
}
