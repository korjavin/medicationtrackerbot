package workout

import (
	"errors"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fakeExerciseLogStore drives the UpdateExerciseLog / AddExerciseToSession
// tests. Only the methods those paths touch carry behavior; everything else
// falls through to the embedded no-op base.
type fakeExerciseLogStore struct {
	noopWorkoutStore

	// UpdateExerciseLog capture + injected error.
	updateCalled  bool
	updatedID     int64
	updatedSets   *int
	updatedReps   *int
	updatedWeight *float64
	updatedNotes  string
	updateErr     error

	// GetExerciseLogByID injected return.
	logEntry *store.WorkoutExerciseLog
	logErr   error

	// PropagateExerciseToSchedule capture + injected error.
	propagateCalled bool
	propSessionID   int64
	propExerciseID  int64
	propName        string
	propSets        *int
	propReps        *int
	propWeight      *float64
	propErr         error

	// UpdateExerciseLogStatus capture + injected error.
	statusCalled bool
	statusID     int64
	statusVal    string
	statusErr    error

	// LogExerciseWithSource capture + injected return.
	logCalled    bool
	logSessionID int64
	logExID      int64
	logName      string
	logSets      *int
	logReps      *int
	logWeight    *float64
	logStatus    string
	logNotes     string
	logSource    string
	logRetID     int64
	logRetErr    error
}

func (f *fakeExerciseLogStore) UpdateExerciseLog(id int64, sets, reps *int, weight *float64, notes string) error {
	f.updateCalled = true
	f.updatedID = id
	f.updatedSets = sets
	f.updatedReps = reps
	f.updatedWeight = weight
	f.updatedNotes = notes
	return f.updateErr
}

func (f *fakeExerciseLogStore) GetExerciseLogByID(id int64) (*store.WorkoutExerciseLog, error) {
	return f.logEntry, f.logErr
}

func (f *fakeExerciseLogStore) PropagateExerciseToSchedule(sessionID, exerciseID int64, name string, sets, reps *int, weight *float64) error {
	f.propagateCalled = true
	f.propSessionID = sessionID
	f.propExerciseID = exerciseID
	f.propName = name
	f.propSets = sets
	f.propReps = reps
	f.propWeight = weight
	return f.propErr
}

func (f *fakeExerciseLogStore) UpdateExerciseLogStatus(id int64, status string) error {
	f.statusCalled = true
	f.statusID = id
	f.statusVal = status
	return f.statusErr
}

func (f *fakeExerciseLogStore) LogExerciseWithSource(sessionID, exerciseID int64, name string, sets, reps *int, weight *float64, status, notes, source string) (int64, error) {
	f.logCalled = true
	f.logSessionID = sessionID
	f.logExID = exerciseID
	f.logName = name
	f.logSets = sets
	f.logReps = reps
	f.logWeight = weight
	f.logStatus = status
	f.logNotes = notes
	f.logSource = source
	return f.logRetID, f.logRetErr
}

func svcWithLog(f *fakeExerciseLogStore) *Service { return New(f, nil) }

// --- UpdateExerciseLog ---

func TestUpdateExerciseLog_ValidationRejections(t *testing.T) {
	tests := []struct {
		name    string
		sets    *int
		reps    *int
		weight  *float64
		status  string
		wantErr error
	}{
		{name: "negative sets", sets: ptrInt(-1), wantErr: ErrNegativeSets},
		{name: "negative reps", reps: ptrInt(-2), wantErr: ErrNegativeReps},
		{name: "negative weight", weight: ptrFloat(-0.5), wantErr: ErrNegativeWeight},
		{name: "invalid status", status: "bogus", wantErr: ErrInvalidExerciseLogStatus},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeExerciseLogStore{}
			err := svcWithLog(f).UpdateExerciseLog(1, tt.sets, tt.reps, tt.weight, "", tt.status)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("want %v, got %v", tt.wantErr, err)
			}
			if f.updateCalled {
				t.Fatalf("store.UpdateExerciseLog must not be called on validation failure")
			}
		})
	}
}

func TestUpdateExerciseLog_AcceptsBlankCompletedSkippedStatuses(t *testing.T) {
	for _, status := range []string{"", "completed", "skipped"} {
		f := &fakeExerciseLogStore{}
		if err := svcWithLog(f).UpdateExerciseLog(1, nil, nil, nil, "", status); err != nil {
			t.Fatalf("status %q: unexpected error %v", status, err)
		}
		if !f.updateCalled {
			t.Fatalf("status %q: expected store.UpdateExerciseLog to be called", status)
		}
	}
}

func TestUpdateExerciseLog_StoreUpdateErrorPropagates(t *testing.T) {
	sentinel := errors.New("db down")
	f := &fakeExerciseLogStore{updateErr: sentinel}
	err := svcWithLog(f).UpdateExerciseLog(7, ptrInt(3), ptrInt(5), nil, "", "")
	if !errors.Is(err, sentinel) {
		t.Fatalf("want %v, got %v", sentinel, err)
	}
	if f.propagateCalled {
		t.Fatalf("propagation must not run after the update write fails")
	}
}

func TestUpdateExerciseLog_PropagatesNonZeroValues(t *testing.T) {
	w := 55.0
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{
			ID: 9, SessionID: 42, ExerciseID: 100, ExerciseName: "OHP", Source: "schedule", Status: "completed",
		},
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(4), ptrInt(6), &w, "n", "completed"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.propagateCalled {
		t.Fatalf("expected propagation for a schedule-sourced log")
	}
	if f.propSessionID != 42 || f.propExerciseID != 100 || f.propName != "OHP" {
		t.Fatalf("propagation target mismatch: %d/%d/%q", f.propSessionID, f.propExerciseID, f.propName)
	}
	if f.propSets == nil || *f.propSets != 4 || f.propReps == nil || *f.propReps != 6 {
		t.Fatalf("expected sets=4 reps=6 propagated, got %v/%v", f.propSets, f.propReps)
	}
	if f.propWeight == nil || *f.propWeight != 55.0 {
		t.Fatalf("expected weight 55 propagated, got %v", f.propWeight)
	}
}

func TestUpdateExerciseLog_ZeroSetsRepsPropagateAsNil(t *testing.T) {
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{ID: 9, SessionID: 42, ExerciseID: 100, ExerciseName: "OHP", Source: "schedule", Status: "completed"},
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(0), ptrInt(0), nil, "", "completed"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.propagateCalled {
		t.Fatalf("expected propagation")
	}
	if f.propSets != nil || f.propReps != nil {
		t.Fatalf("zero sets/reps must propagate as nil, got %v/%v", f.propSets, f.propReps)
	}
}

func TestUpdateExerciseLog_LibrarySourceSkipsPropagation(t *testing.T) {
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{ID: 9, SessionID: 42, ExerciseID: 100, Source: "library", Status: "completed"},
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(4), ptrInt(6), nil, "", "completed"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.propagateCalled {
		t.Fatalf("library-sourced logs must not propagate to the schedule")
	}
}

func TestUpdateExerciseLog_MissingLogSkipsPropagationAndPromotion(t *testing.T) {
	// GetExerciseLogByID returns (nil, nil): propagation and status promotion
	// are both skipped, but the method still succeeds.
	f := &fakeExerciseLogStore{logEntry: nil}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(4), nil, nil, "", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.propagateCalled {
		t.Fatalf("propagation must be skipped when the log can't be re-read")
	}
	if f.statusCalled {
		t.Fatalf("status promotion must be skipped when the log can't be re-read")
	}
}

func TestUpdateExerciseLog_AutoPromotesPlaceholderToCompleted(t *testing.T) {
	// status="" + pre-state status="" + sets>=1 → promote to completed.
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{ID: 9, SessionID: 42, ExerciseID: 100, Source: "schedule", Status: ""},
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(1), nil, nil, "", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.statusCalled || f.statusID != 9 || f.statusVal != "completed" {
		t.Fatalf("expected promotion to completed for id 9, got called=%v id=%d val=%q", f.statusCalled, f.statusID, f.statusVal)
	}
}

func TestUpdateExerciseLog_NoPromotionWhenSetsZero(t *testing.T) {
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{ID: 9, Source: "schedule", Status: ""},
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(0), nil, nil, "", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.statusCalled {
		t.Fatalf("a placeholder with sets=0 must not be promoted")
	}
}

func TestUpdateExerciseLog_ExplicitStatusWinsOverPlaceholder(t *testing.T) {
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{ID: 9, Source: "schedule", Status: ""},
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(3), nil, nil, "", "skipped"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.statusCalled || f.statusVal != "skipped" {
		t.Fatalf("explicit status should win, got called=%v val=%q", f.statusCalled, f.statusVal)
	}
}

func TestUpdateExerciseLog_NoStatusUpdateWhenUnchanged(t *testing.T) {
	// newStatus equals the existing status → no status write.
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{ID: 9, Source: "schedule", Status: "completed"},
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(3), nil, nil, "", "completed"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.statusCalled {
		t.Fatalf("status write must be skipped when the status is unchanged")
	}
}

func TestUpdateExerciseLog_StatusPromotionErrorPropagates(t *testing.T) {
	sentinel := errors.New("status write failed")
	f := &fakeExerciseLogStore{
		logEntry:  &store.WorkoutExerciseLog{ID: 9, Source: "schedule", Status: ""},
		statusErr: sentinel,
	}
	err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(1), nil, nil, "", "")
	if !errors.Is(err, sentinel) {
		t.Fatalf("want %v, got %v", sentinel, err)
	}
}

func TestUpdateExerciseLog_PropagationErrorIsBestEffort(t *testing.T) {
	// A propagation failure must not fail the overall update.
	f := &fakeExerciseLogStore{
		logEntry: &store.WorkoutExerciseLog{ID: 9, SessionID: 1, ExerciseID: 2, Source: "schedule", Status: "completed"},
		propErr:  errors.New("propagate boom"),
	}
	if err := svcWithLog(f).UpdateExerciseLog(9, ptrInt(3), nil, nil, "", "completed"); err != nil {
		t.Fatalf("propagation error must be swallowed, got %v", err)
	}
}

// --- AddExerciseToSession ---

func TestAddExerciseToSession_ScheduleSourcePropagates(t *testing.T) {
	w := 60.0
	f := &fakeExerciseLogStore{logRetID: 555}
	id, err := svcWithLog(f).AddExerciseToSession(42, 100, "Bench", 4, 8, &w, "completed", "note", "schedule")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != 555 {
		t.Fatalf("expected returned id 555, got %d", id)
	}
	if !f.logCalled {
		t.Fatalf("expected LogExerciseWithSource to be called")
	}
	if f.logSessionID != 42 || f.logExID != 100 || f.logName != "Bench" || f.logSource != "schedule" {
		t.Fatalf("log args mismatch: %d/%d/%q/%q", f.logSessionID, f.logExID, f.logName, f.logSource)
	}
	if f.logSets == nil || *f.logSets != 4 || f.logReps == nil || *f.logReps != 8 {
		t.Fatalf("expected logged sets=4 reps=8, got %v/%v", f.logSets, f.logReps)
	}
	if !f.propagateCalled {
		t.Fatalf("expected propagation for a schedule source")
	}
	if f.propSets == nil || *f.propSets != 4 || f.propReps == nil || *f.propReps != 8 {
		t.Fatalf("expected propagated sets=4 reps=8, got %v/%v", f.propSets, f.propReps)
	}
	if f.propWeight == nil || *f.propWeight != 60.0 {
		t.Fatalf("expected propagated weight 60, got %v", f.propWeight)
	}
}

func TestAddExerciseToSession_LibrarySourceSkipsPropagation(t *testing.T) {
	f := &fakeExerciseLogStore{logRetID: 1}
	if _, err := svcWithLog(f).AddExerciseToSession(42, 100, "Curls", 3, 12, nil, "completed", "", "library"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.logCalled || f.logSource != "library" {
		t.Fatalf("expected library-sourced log write")
	}
	if f.propagateCalled {
		t.Fatalf("library source must not propagate to the schedule")
	}
}

func TestAddExerciseToSession_ZeroSetsRepsPropagateAsNil(t *testing.T) {
	f := &fakeExerciseLogStore{logRetID: 1}
	if _, err := svcWithLog(f).AddExerciseToSession(42, 100, "Plank", 0, 0, nil, "completed", "", "schedule"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.propagateCalled {
		t.Fatalf("expected propagation")
	}
	if f.propSets != nil || f.propReps != nil {
		t.Fatalf("zero sets/reps must propagate as nil, got %v/%v", f.propSets, f.propReps)
	}
}

func TestAddExerciseToSession_LogErrorPropagates(t *testing.T) {
	sentinel := errors.New("insert failed")
	f := &fakeExerciseLogStore{logRetErr: sentinel}
	id, err := svcWithLog(f).AddExerciseToSession(42, 100, "Bench", 4, 8, nil, "completed", "", "schedule")
	if !errors.Is(err, sentinel) {
		t.Fatalf("want %v, got %v", sentinel, err)
	}
	if id != 0 {
		t.Fatalf("expected id 0 on error, got %d", id)
	}
	if f.propagateCalled {
		t.Fatalf("propagation must not run after the log write fails")
	}
}

func TestAddExerciseToSession_PropagationErrorIsBestEffort(t *testing.T) {
	f := &fakeExerciseLogStore{logRetID: 7, propErr: errors.New("propagate boom")}
	id, err := svcWithLog(f).AddExerciseToSession(42, 100, "Bench", 4, 8, nil, "completed", "", "schedule")
	if err != nil {
		t.Fatalf("propagation error must be swallowed, got %v", err)
	}
	if id != 7 {
		t.Fatalf("expected id 7 despite propagation failure, got %d", id)
	}
}
