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

	getSessionErr  error
	getGroupErr    error
	startErr       error
	clearSnoozeErr error
	snoozeErr      error
	skipErr        error
	completeErr    error
	advanceErr     error
	createErr      error

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

func (m *mockWorkoutStore) CreatePlannedAdHocSession(userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	if m.createErr != nil {
		return nil, m.createErr
	}
	return m.session, nil
}

func (m *mockWorkoutStore) LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error) {
	return 0, nil
}

func (m *mockWorkoutStore) GetCurrentTimezone() (string, error) {
	return "", nil
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

// fixedClock returns a deterministic "now" used by SchedulePlannedAdHocSession
// tests so the future-time check is reproducible.
func fixedClock(t time.Time) func() time.Time {
	return func() time.Time { return t }
}

func TestSchedulePlannedAdHocSession_HappyPath(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() //nolint:errcheck

	if err := db.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	svc := New(db)
	svc.Now = fixedClock(time.Date(2030, 6, 1, 12, 0, 0, 0, time.UTC))

	scheduled := time.Date(2030, 6, 2, 0, 0, 0, 0, time.UTC)
	repsMax := 10
	weight := 60.0
	exercises := []PlannedExercise{
		{ExerciseID: 5, ExerciseName: "Bench Press", TargetSets: 3, TargetRepsMin: 6, TargetRepsMax: &repsMax, TargetWeightKg: &weight},
		{ExerciseID: 0, ExerciseName: "Free-form push-ups", TargetSets: 4, TargetRepsMin: 12},
	}

	sess, err := svc.SchedulePlannedAdHocSession(123, scheduled, "07:30", exercises)
	if err != nil {
		t.Fatalf("SchedulePlannedAdHocSession: %v", err)
	}
	if sess == nil {
		t.Fatal("expected session, got nil")
	}
	if sess.GroupID != -1 || sess.VariantID != -1 {
		t.Errorf("expected sentinel ids -1/-1, got %d/%d", sess.GroupID, sess.VariantID)
	}
	if sess.Status != "pending" {
		t.Errorf("expected status pending, got %q", sess.Status)
	}
	if sess.StartedAt != nil {
		t.Errorf("expected started_at to be NULL, got %v", *sess.StartedAt)
	}
	if sess.ScheduledTime != "07:30" {
		t.Errorf("expected scheduled_time 07:30, got %q", sess.ScheduledTime)
	}

	logs, err := db.GetExerciseLogs(sess.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("expected 2 placeholder logs, got %d", len(logs))
	}

	// Logs are ordered by id ASC so they match the input order.
	if logs[0].ExerciseID != 5 || logs[0].ExerciseName != "Bench Press" {
		t.Errorf("log[0] mismatch: id=%d name=%q", logs[0].ExerciseID, logs[0].ExerciseName)
	}
	if logs[0].Source != "library" {
		t.Errorf("log[0] source: want library, got %q", logs[0].Source)
	}
	if logs[0].Status != "" {
		t.Errorf("log[0] status: want empty (pending), got %q", logs[0].Status)
	}
	if logs[0].SetsCompleted != nil || logs[0].RepsCompleted != nil || logs[0].WeightKg != nil {
		t.Errorf("log[0] expected NULL completion fields, got sets=%v reps=%v weight=%v",
			logs[0].SetsCompleted, logs[0].RepsCompleted, logs[0].WeightKg)
	}

	if logs[1].ExerciseID != 0 || logs[1].ExerciseName != "Free-form push-ups" {
		t.Errorf("log[1] mismatch: id=%d name=%q", logs[1].ExerciseID, logs[1].ExerciseName)
	}
	if logs[1].Source != "schedule" {
		t.Errorf("log[1] source: want schedule (free-form), got %q", logs[1].Source)
	}
}

func TestSchedulePlannedAdHocSession_RejectsPastTime(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() //nolint:errcheck

	svc := New(db)
	svc.Now = fixedClock(time.Date(2030, 6, 1, 12, 0, 0, 0, time.UTC))

	// Same calendar date as "now" but earlier time-of-day → in the past.
	scheduled := time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	if _, err := svc.SchedulePlannedAdHocSession(123, scheduled, "06:00", nil); err == nil {
		t.Fatal("expected error for past scheduled time, got nil")
	}

	// Earlier calendar date → in the past.
	scheduled = time.Date(2030, 5, 31, 0, 0, 0, 0, time.UTC)
	if _, err := svc.SchedulePlannedAdHocSession(123, scheduled, "23:59", nil); err == nil {
		t.Fatal("expected error for past calendar date, got nil")
	}

	// Exact match (planned == now) is rejected — strictly future required.
	scheduled = time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	if _, err := svc.SchedulePlannedAdHocSession(123, scheduled, "12:00", nil); err == nil {
		t.Fatal("expected error when planned == now, got nil")
	}
}

func TestSchedulePlannedAdHocSession_RespectsUserTimezone(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() //nolint:errcheck

	// User is in Tokyo (+09:00). 07:00 Tokyo == 22:00 UTC the previous day.
	if err := db.RecordTimezone("Asia/Tokyo"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	svc := New(db)
	// "Now" is 2030-06-01 23:00 UTC == 2030-06-02 08:00 Tokyo.
	svc.Now = fixedClock(time.Date(2030, 6, 1, 23, 0, 0, 0, time.UTC))

	// Scheduled 2030-06-02 at 07:00 Tokyo == 2030-06-01 22:00 UTC, which is in
	// the past — must be rejected even though wall-clock UTC of (date+time)
	// would be 2030-06-02 07:00, which would naively look future.
	scheduled := time.Date(2030, 6, 2, 0, 0, 0, 0, time.UTC)
	if _, err := svc.SchedulePlannedAdHocSession(123, scheduled, "07:00", nil); err == nil {
		t.Fatal("expected past-time rejection in user TZ, got nil")
	}

	// 09:00 Tokyo on 2030-06-02 == 00:00 UTC on 2030-06-02, an hour after now → accepted.
	sess, err := svc.SchedulePlannedAdHocSession(123, scheduled, "09:00", nil)
	if err != nil {
		t.Fatalf("expected accept for future-in-user-TZ, got %v", err)
	}
	if sess.Status != "pending" {
		t.Errorf("expected pending status, got %q", sess.Status)
	}
}

func TestSchedulePlannedAdHocSession_RejectsBadTimeFormat(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() //nolint:errcheck

	svc := New(db)
	svc.Now = fixedClock(time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC))

	scheduled := time.Date(2030, 6, 2, 0, 0, 0, 0, time.UTC)
	for _, bad := range []string{"", "7:30", "07:30:00", "noon", "25:00"} {
		if _, err := svc.SchedulePlannedAdHocSession(123, scheduled, bad, nil); err == nil {
			t.Errorf("expected error for time %q, got nil", bad)
		}
	}
}

func TestSchedulePlannedAdHocSession_NoExercises(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() //nolint:errcheck

	svc := New(db)
	svc.Now = fixedClock(time.Date(2030, 6, 1, 12, 0, 0, 0, time.UTC))

	scheduled := time.Date(2030, 6, 2, 0, 0, 0, 0, time.UTC)
	sess, err := svc.SchedulePlannedAdHocSession(123, scheduled, "07:30", nil)
	if err != nil {
		t.Fatalf("expected success with no exercises, got %v", err)
	}
	logs, err := db.GetExerciseLogs(sess.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 0 {
		t.Errorf("expected 0 logs, got %d", len(logs))
	}
}
