package domain

import (
	"errors"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// mockExerciseStore implements ExerciseStore for tests.
type mockExerciseStore struct {
	exercises   map[int64]*store.WorkoutExercise
	logs        map[int64]*store.WorkoutExerciseLog // keyed by logID
	sessionLogs map[int64][]int64                   // sessionID → []logID
	nextLogID   int64

	// call tracking
	logExerciseCalls       []logExerciseCall
	updateExerciseLogCalls []updateExerciseLogCall
	updateStatusCalls      []updateStatusCall
}

type logExerciseCall struct {
	sessionID  int64
	exerciseID int64
	status     string
}

type updateExerciseLogCall struct {
	logID int64
}

type updateStatusCall struct {
	logID  int64
	status string
}

func newMockExerciseStore() *mockExerciseStore {
	return &mockExerciseStore{
		exercises:   make(map[int64]*store.WorkoutExercise),
		logs:        make(map[int64]*store.WorkoutExerciseLog),
		sessionLogs: make(map[int64][]int64),
		nextLogID:   1,
	}
}

func (m *mockExerciseStore) addExercise(id int64, name string, sets, repsMin int, weightKg *float64) {
	m.exercises[id] = &store.WorkoutExercise{
		ID:             id,
		VariantID:      1,
		ExerciseName:   name,
		TargetSets:     sets,
		TargetRepsMin:  repsMin,
		TargetWeightKg: weightKg,
	}
}

func (m *mockExerciseStore) addLog(sessionID, exerciseID int64, status string) int64 {
	id := m.nextLogID
	m.nextLogID++
	m.logs[id] = &store.WorkoutExerciseLog{
		ID:         id,
		SessionID:  sessionID,
		ExerciseID: exerciseID,
		Status:     status,
	}
	m.sessionLogs[sessionID] = append(m.sessionLogs[sessionID], id)
	return id
}

func (m *mockExerciseStore) GetWorkoutExercise(id int64) (*store.WorkoutExercise, error) {
	return m.exercises[id], nil
}

func (m *mockExerciseStore) GetExerciseLogBySessionAndExercise(sessionID, exerciseID int64) (*store.WorkoutExerciseLog, error) {
	for _, logID := range m.sessionLogs[sessionID] {
		l := m.logs[logID]
		if l != nil && l.ExerciseID == exerciseID {
			return l, nil
		}
	}
	return nil, nil
}

func (m *mockExerciseStore) LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error) {
	m.logExerciseCalls = append(m.logExerciseCalls, logExerciseCall{sessionID, exerciseID, status})
	id := m.nextLogID
	m.nextLogID++
	m.logs[id] = &store.WorkoutExerciseLog{
		ID:         id,
		SessionID:  sessionID,
		ExerciseID: exerciseID,
		Status:     status,
	}
	m.sessionLogs[sessionID] = append(m.sessionLogs[sessionID], id)
	return id, nil
}

func (m *mockExerciseStore) UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error {
	m.updateExerciseLogCalls = append(m.updateExerciseLogCalls, updateExerciseLogCall{id})
	return nil
}

func (m *mockExerciseStore) UpdateExerciseLogStatus(id int64, status string) error {
	m.updateStatusCalls = append(m.updateStatusCalls, updateStatusCall{id, status})
	if l, ok := m.logs[id]; ok {
		l.Status = status
	}
	return nil
}

func (m *mockExerciseStore) ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error) {
	var result []store.WorkoutExercise
	for _, ex := range m.exercises {
		if ex.VariantID == variantID {
			result = append(result, *ex)
		}
	}
	return result, nil
}

func (m *mockExerciseStore) GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	var result []store.WorkoutExerciseLog
	for _, logID := range m.sessionLogs[sessionID] {
		if l, ok := m.logs[logID]; ok {
			result = append(result, *l)
		}
	}
	return result, nil
}

// errExerciseStore wraps a mock store to inject errors.
type errExerciseStore struct {
	*mockExerciseStore
	errGetExercise          bool
	errGetLog               bool
	errListExercises        bool
	errGetLogs              bool
	errLogExercise          bool
	errUpdateExerciseLog    bool
	errUpdateExerciseStatus bool
}

func (e *errExerciseStore) GetWorkoutExercise(id int64) (*store.WorkoutExercise, error) {
	if e.errGetExercise {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetWorkoutExercise(id)
}

func (e *errExerciseStore) GetExerciseLogBySessionAndExercise(sessionID, exerciseID int64) (*store.WorkoutExerciseLog, error) {
	if e.errGetLog {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetExerciseLogBySessionAndExercise(sessionID, exerciseID)
}

func (e *errExerciseStore) ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error) {
	if e.errListExercises {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.ListExercisesByVariant(variantID)
}

func (e *errExerciseStore) GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	if e.errGetLogs {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetExerciseLogs(sessionID)
}

func (e *errExerciseStore) LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error) {
	if e.errLogExercise {
		return 0, errors.New("store error")
	}
	return e.mockExerciseStore.LogExercise(sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes)
}

func (e *errExerciseStore) UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error {
	if e.errUpdateExerciseLog {
		return errors.New("store error")
	}
	return e.mockExerciseStore.UpdateExerciseLog(id, setsCompleted, repsCompleted, weightKg, notes)
}

func (e *errExerciseStore) UpdateExerciseLogStatus(id int64, status string) error {
	if e.errUpdateExerciseStatus {
		return errors.New("store error")
	}
	return e.mockExerciseStore.UpdateExerciseLogStatus(id, status)
}

// --- LogExercise tests ---

func TestLogExercise_NewLog(t *testing.T) {
	ms := newMockExerciseStore()
	weight := 80.0
	ms.addExercise(10, "Squat", 4, 8, &weight)
	svc := NewExerciseService(ms)

	if err := svc.LogExercise(1, 10, "completed"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(ms.logExerciseCalls) != 1 {
		t.Fatalf("expected 1 LogExercise call, got %d", len(ms.logExerciseCalls))
	}
	if ms.logExerciseCalls[0].status != "completed" {
		t.Errorf("expected status completed, got %s", ms.logExerciseCalls[0].status)
	}
}

func TestLogExercise_NewLogSkipped(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Squat", 4, 8, nil)
	svc := NewExerciseService(ms)

	if err := svc.LogExercise(1, 10, "skipped"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(ms.logExerciseCalls) != 1 {
		t.Fatalf("expected 1 LogExercise call, got %d", len(ms.logExerciseCalls))
	}
	if ms.logExerciseCalls[0].status != "skipped" {
		t.Errorf("expected status skipped, got %s", ms.logExerciseCalls[0].status)
	}
}

func TestLogExercise_SkippedToCompleted(t *testing.T) {
	ms := newMockExerciseStore()
	weight := 60.0
	ms.addExercise(10, "Bench", 3, 10, &weight)
	logID := ms.addLog(1, 10, "skipped")
	svc := NewExerciseService(ms)

	if err := svc.LogExercise(1, 10, "completed"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(ms.logExerciseCalls) != 0 {
		t.Error("should not create new log when one already exists")
	}
	if len(ms.updateExerciseLogCalls) != 1 || ms.updateExerciseLogCalls[0].logID != logID {
		t.Errorf("expected UpdateExerciseLog call for logID %d", logID)
	}
	if len(ms.updateStatusCalls) != 1 || ms.updateStatusCalls[0].status != "completed" {
		t.Error("expected UpdateExerciseLogStatus call with completed")
	}
}

func TestLogExercise_ExistingCompletedNoOp(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Deadlift", 1, 5, nil)
	ms.addLog(1, 10, "completed")
	svc := NewExerciseService(ms)

	// Try to log as completed again
	if err := svc.LogExercise(1, 10, "completed"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Also try to skip a completed exercise
	if err := svc.LogExercise(1, 10, "skipped"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(ms.logExerciseCalls) != 0 {
		t.Error("should not create new log")
	}
	if len(ms.updateExerciseLogCalls) != 0 {
		t.Error("should not update log values")
	}
	if len(ms.updateStatusCalls) != 0 {
		t.Error("should not update log status")
	}
}

func TestLogExercise_ExistingSkippedNoOp(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Row", 3, 12, nil)
	ms.addLog(1, 10, "skipped")
	svc := NewExerciseService(ms)

	if err := svc.LogExercise(1, 10, "skipped"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(ms.logExerciseCalls) != 0 {
		t.Error("should not create new log")
	}
	if len(ms.updateStatusCalls) != 0 {
		t.Error("should not update status")
	}
}

func TestLogExercise_ExerciseNotFound(t *testing.T) {
	ms := newMockExerciseStore()
	svc := NewExerciseService(ms)

	err := svc.LogExercise(1, 999, "completed")
	if err == nil {
		t.Fatal("expected error for missing exercise")
	}
}

func TestLogExercise_StoreError(t *testing.T) {
	ms := newMockExerciseStore()
	es := &errExerciseStore{mockExerciseStore: ms, errGetExercise: true}
	ms.addExercise(10, "Curl", 3, 12, nil)
	svc := NewExerciseService(es)

	err := svc.LogExercise(1, 10, "completed")
	if err == nil {
		t.Fatal("expected error from store")
	}
}

func TestLogExercise_GetLogError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Curl", 3, 12, nil)
	es := &errExerciseStore{mockExerciseStore: ms, errGetLog: true}
	svc := NewExerciseService(es)

	err := svc.LogExercise(1, 10, "completed")
	if err == nil {
		t.Fatal("expected error when GetExerciseLogBySessionAndExercise fails")
	}
}

func TestLogExercise_LogExerciseStoreError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Curl", 3, 12, nil)
	es := &errExerciseStore{mockExerciseStore: ms, errLogExercise: true}
	svc := NewExerciseService(es)

	err := svc.LogExercise(1, 10, "completed")
	if err == nil {
		t.Fatal("expected error when LogExercise store call fails")
	}
}

func TestLogExercise_UpdateExerciseLogError(t *testing.T) {
	ms := newMockExerciseStore()
	weight := 80.0
	ms.addExercise(10, "Curl", 3, 12, &weight)
	ms.addLog(1, 10, "skipped")
	es := &errExerciseStore{mockExerciseStore: ms, errUpdateExerciseLog: true}
	svc := NewExerciseService(es)

	err := svc.LogExercise(1, 10, "completed")
	if err == nil {
		t.Fatal("expected error when UpdateExerciseLog store call fails")
	}
}

func TestLogExercise_UpdateExerciseLogStatusError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Curl", 3, 12, nil)
	ms.addLog(1, 10, "skipped")
	es := &errExerciseStore{mockExerciseStore: ms, errUpdateExerciseStatus: true}
	svc := NewExerciseService(es)

	err := svc.LogExercise(1, 10, "completed")
	if err == nil {
		t.Fatal("expected error when UpdateExerciseLogStatus store call fails")
	}
}

// --- CheckSessionCompletion tests ---

func TestCheckSessionCompletion_AllDone(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(1, "A", 3, 10, nil)
	ms.addExercise(2, "B", 3, 10, nil)
	ms.addLog(100, 1, "completed")
	ms.addLog(100, 2, "skipped")
	svc := NewExerciseService(ms)

	done, completed, total, err := svc.CheckSessionCompletion(100, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !done {
		t.Error("expected all done")
	}
	if completed != 1 {
		t.Errorf("expected completedCount=1, got %d", completed)
	}
	if total != 2 {
		t.Errorf("expected totalCount=2, got %d", total)
	}
}

func TestCheckSessionCompletion_Partial(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(1, "A", 3, 10, nil)
	ms.addExercise(2, "B", 3, 10, nil)
	ms.addExercise(3, "C", 3, 10, nil)
	ms.addLog(100, 1, "completed")
	// exercises 2 and 3 not logged yet
	svc := NewExerciseService(ms)

	done, _, _, err := svc.CheckSessionCompletion(100, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if done {
		t.Error("expected not done (partial)")
	}
}

func TestCheckSessionCompletion_NoneDone(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(1, "A", 3, 10, nil)
	ms.addExercise(2, "B", 3, 10, nil)
	svc := NewExerciseService(ms)

	done, completed, _, err := svc.CheckSessionCompletion(100, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if done {
		t.Error("expected not done")
	}
	if completed != 0 {
		t.Errorf("expected 0 completed, got %d", completed)
	}
}

func TestCheckSessionCompletion_ListExercisesError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(1, "A", 3, 10, nil)
	es := &errExerciseStore{mockExerciseStore: ms, errListExercises: true}
	svc := NewExerciseService(es)

	_, _, _, err := svc.CheckSessionCompletion(100, 1)
	if err == nil {
		t.Fatal("expected error when ListExercisesByVariant fails")
	}
}

func TestCheckSessionCompletion_GetLogsError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(1, "A", 3, 10, nil)
	es := &errExerciseStore{mockExerciseStore: ms, errGetLogs: true}
	svc := NewExerciseService(es)

	_, _, _, err := svc.CheckSessionCompletion(100, 1)
	if err == nil {
		t.Fatal("expected error when GetExerciseLogs fails")
	}
}
