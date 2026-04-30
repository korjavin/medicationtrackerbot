package domain

import (
	"errors"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// mockExerciseStore implements ExerciseStore for tests.
type mockExerciseStore struct {
	exercises    map[int64]*store.WorkoutExercise
	libraryItems map[int64]*store.ExerciseLibraryItem
	logs         map[int64]*store.WorkoutExerciseLog // keyed by logID
	sessionLogs  map[int64][]int64                   // sessionID → []logID
	sessions     map[int64]*store.WorkoutSession
	nextLogID    int64

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
		exercises:    make(map[int64]*store.WorkoutExercise),
		libraryItems: make(map[int64]*store.ExerciseLibraryItem),
		logs:         make(map[int64]*store.WorkoutExerciseLog),
		sessionLogs:  make(map[int64][]int64),
		sessions:     make(map[int64]*store.WorkoutSession),
		nextLogID:    1,
	}
}

func (m *mockExerciseStore) addSession(id int64, variantID int64, status string) {
	m.sessions[id] = &store.WorkoutSession{ID: id, VariantID: variantID, Status: status}
}

func (m *mockExerciseStore) GetWorkoutSession(id int64) (*store.WorkoutSession, error) {
	s, ok := m.sessions[id]
	if !ok {
		// Default: return an in_progress session with VariantID=1 (matching addExercise default).
		return &store.WorkoutSession{ID: id, VariantID: 1, Status: "in_progress"}, nil
	}
	return s, nil
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

func (m *mockExerciseStore) addLibraryItem(id int64, userID int64, name string, sets, repsMin int, weightKg *float64) {
	m.libraryItems[id] = &store.ExerciseLibraryItem{
		ID:              id,
		UserID:          userID,
		Name:            name,
		DefaultSets:     sets,
		DefaultRepsMin:  repsMin,
		DefaultWeightKg: weightKg,
	}
}

func (m *mockExerciseStore) addLog(sessionID, exerciseID int64, status string) int64 {
	return m.addLogWithSource(sessionID, exerciseID, status, "schedule")
}

func (m *mockExerciseStore) addLogWithSource(sessionID, exerciseID int64, status, source string) int64 {
	id := m.nextLogID
	m.nextLogID++
	m.logs[id] = &store.WorkoutExerciseLog{
		ID:         id,
		SessionID:  sessionID,
		ExerciseID: exerciseID,
		Status:     status,
		Source:     source,
	}
	m.sessionLogs[sessionID] = append(m.sessionLogs[sessionID], id)
	return id
}

func (m *mockExerciseStore) GetWorkoutExercise(id int64) (*store.WorkoutExercise, error) {
	return m.exercises[id], nil
}

func (m *mockExerciseStore) GetExerciseLibraryItem(id int64) (*store.ExerciseLibraryItem, error) {
	return m.libraryItems[id], nil
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

func (m *mockExerciseStore) GetExerciseLogBySessionExerciseSource(sessionID, exerciseID int64, source string) (*store.WorkoutExerciseLog, error) {
	for _, logID := range m.sessionLogs[sessionID] {
		l := m.logs[logID]
		if l != nil && l.ExerciseID == exerciseID && l.Source == source {
			return l, nil
		}
	}
	return nil, nil
}

func (m *mockExerciseStore) LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error) {
	return m.LogExerciseWithSource(sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, "schedule")
}

func (m *mockExerciseStore) LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error) {
	m.logExerciseCalls = append(m.logExerciseCalls, logExerciseCall{sessionID, exerciseID, status})
	id := m.nextLogID
	m.nextLogID++
	m.logs[id] = &store.WorkoutExerciseLog{
		ID:         id,
		SessionID:  sessionID,
		ExerciseID: exerciseID,
		Status:     status,
		Source:     source,
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
	errGetSession           bool
	errGetExercise          bool
	errGetLibraryItem       bool
	errGetLog               bool
	errListExercises        bool
	errGetLogs              bool
	errLogExercise          bool
	errUpdateExerciseLog    bool
	errUpdateExerciseStatus bool
}

func (e *errExerciseStore) GetWorkoutSession(id int64) (*store.WorkoutSession, error) {
	if e.errGetSession {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetWorkoutSession(id)
}

func (e *errExerciseStore) GetWorkoutExercise(id int64) (*store.WorkoutExercise, error) {
	if e.errGetExercise {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetWorkoutExercise(id)
}

func (e *errExerciseStore) GetExerciseLibraryItem(id int64) (*store.ExerciseLibraryItem, error) {
	if e.errGetLibraryItem {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetExerciseLibraryItem(id)
}

func (e *errExerciseStore) GetExerciseLogBySessionAndExercise(sessionID, exerciseID int64) (*store.WorkoutExerciseLog, error) {
	if e.errGetLog {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetExerciseLogBySessionAndExercise(sessionID, exerciseID)
}

func (e *errExerciseStore) GetExerciseLogBySessionExerciseSource(sessionID, exerciseID int64, source string) (*store.WorkoutExerciseLog, error) {
	if e.errGetLog {
		return nil, errors.New("store error")
	}
	return e.mockExerciseStore.GetExerciseLogBySessionExerciseSource(sessionID, exerciseID, source)
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

func (e *errExerciseStore) LogExerciseWithSource(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes, source string) (int64, error) {
	if e.errLogExercise {
		return 0, errors.New("store error")
	}
	return e.mockExerciseStore.LogExerciseWithSource(sessionID, exerciseID, exerciseName, setsCompleted, repsCompleted, weightKg, status, notes, source)
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

	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for new log")
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

	changed, err := svc.LogExercise(1, 10, "skipped", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for new log")
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

	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for skipped→completed upgrade")
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
	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if changed {
		t.Error("expected changed=false for duplicate completed→completed")
	}
	// Also try to skip a completed exercise
	changed, err = svc.LogExercise(1, 10, "skipped", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if changed {
		t.Error("expected changed=false for completed→skipped no-op")
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

	changed, err := svc.LogExercise(1, 10, "skipped", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if changed {
		t.Error("expected changed=false for duplicate skipped→skipped")
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

	_, err := svc.LogExercise(1, 999, "completed", false)
	if err == nil {
		t.Fatal("expected error for missing exercise")
	}
}

func TestLogExercise_StoreError(t *testing.T) {
	ms := newMockExerciseStore()
	es := &errExerciseStore{mockExerciseStore: ms, errGetExercise: true}
	ms.addExercise(10, "Curl", 3, 12, nil)
	svc := NewExerciseService(es)

	_, err := svc.LogExercise(1, 10, "completed", false)
	if err == nil {
		t.Fatal("expected error from store")
	}
}

func TestLogExercise_GetLogError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Curl", 3, 12, nil)
	es := &errExerciseStore{mockExerciseStore: ms, errGetLog: true}
	svc := NewExerciseService(es)

	_, err := svc.LogExercise(1, 10, "completed", false)
	if err == nil {
		t.Fatal("expected error when GetExerciseLogBySessionAndExercise fails")
	}
}

func TestLogExercise_LogExerciseStoreError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Curl", 3, 12, nil)
	es := &errExerciseStore{mockExerciseStore: ms, errLogExercise: true}
	svc := NewExerciseService(es)

	_, err := svc.LogExercise(1, 10, "completed", false)
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

	_, err := svc.LogExercise(1, 10, "completed", false)
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

	_, err := svc.LogExercise(1, 10, "completed", false)
	if err == nil {
		t.Fatal("expected error when UpdateExerciseLogStatus store call fails")
	}
}

// --- Session status guard tests ---

func TestLogExercise_SessionCompleted_NoOp(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Squat", 4, 8, nil)
	ms.addSession(1, 1, "completed")
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if changed {
		t.Error("expected changed=false when session is completed")
	}
	if len(ms.logExerciseCalls) != 0 {
		t.Error("should not create a log for a completed session")
	}
}

func TestLogExercise_SessionSkipped_NoOp(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Squat", 4, 8, nil)
	ms.addSession(1, 1, "skipped")
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if changed {
		t.Error("expected changed=false when session is skipped")
	}
}

func TestLogExercise_SessionNotFound_NoOp(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Squat", 4, 8, nil)
	// Explicitly set nil session to simulate not found
	ms.sessions[1] = nil
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if changed {
		t.Error("expected changed=false when session not found")
	}
}

func TestLogExercise_GetSessionError(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addExercise(10, "Curl", 3, 12, nil)
	es := &errExerciseStore{mockExerciseStore: ms, errGetSession: true}
	svc := NewExerciseService(es)

	_, err := svc.LogExercise(1, 10, "completed", false)
	if err == nil {
		t.Fatal("expected error when GetWorkoutSession fails")
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

// --- Library-based exercise (ad-hoc) logging tests ---
// These cover the bug where exercises added from the library during a session
// use exercise_library.id as exerciseID, which doesn't exist in workout_exercises.

func TestLogExercise_LibraryItem_NewLog(t *testing.T) {
	ms := newMockExerciseStore()
	weight := 50.0
	// Library item with ID=20 — NOT present in workout_exercises
	ms.addLibraryItem(20, 1, "Cable Row", 3, 12, &weight)
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(1, 20, "completed", true)
	if err != nil {
		t.Fatalf("unexpected error logging library exercise: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for new library exercise log")
	}

	if len(ms.logExerciseCalls) != 1 {
		t.Fatalf("expected 1 LogExercise store call, got %d", len(ms.logExerciseCalls))
	}
	call := ms.logExerciseCalls[0]
	if call.exerciseID != 20 {
		t.Errorf("expected exerciseID=20, got %d", call.exerciseID)
	}
	if call.status != "completed" {
		t.Errorf("expected status=completed, got %s", call.status)
	}
}

func TestLogExercise_LibraryItem_Skipped(t *testing.T) {
	ms := newMockExerciseStore()
	ms.addLibraryItem(21, 1, "Face Pull", 3, 15, nil)
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(2, 21, "skipped", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for new library exercise log")
	}

	if len(ms.logExerciseCalls) != 1 || ms.logExerciseCalls[0].status != "skipped" {
		t.Error("expected 1 skipped LogExercise call")
	}
}

func TestLogExercise_LibraryItem_SkippedToCompleted(t *testing.T) {
	ms := newMockExerciseStore()
	weight := 30.0
	ms.addLibraryItem(22, 1, "Lateral Raise", 3, 15, &weight)
	logID := ms.addLogWithSource(1, 22, "skipped", "library")
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(1, 22, "completed", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for skipped→completed upgrade")
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

func TestLogExercise_LibraryItem_GetLibraryItemError(t *testing.T) {
	ms := newMockExerciseStore()
	// exercise 99 is in neither workout_exercises nor library
	es := &errExerciseStore{mockExerciseStore: ms, errGetLibraryItem: true}
	svc := NewExerciseService(es)

	_, err := svc.LogExercise(1, 99, "completed", true)
	if err == nil {
		t.Fatal("expected error when GetExerciseLibraryItem fails")
	}
}

func TestLogExercise_NeitherExerciseNorLibrary(t *testing.T) {
	ms := newMockExerciseStore()
	// exercise 999 is in neither table
	svc := NewExerciseService(ms)

	_, err := svc.LogExercise(1, 999, "completed", false)
	if err == nil {
		t.Fatal("expected error when exercise is not found anywhere")
	}
}

// --- ID collision guard tests ---
// These cover the bug where exercise_library.id collides with workout_exercises.id
// from a different variant. Without the variant guard, the wrong exercise would be used.

func TestLogExercise_IDCollision_FallsThruToLibrary(t *testing.T) {
	ms := newMockExerciseStore()
	weight := 50.0
	// workout_exercises has id=10 in variant 2 ("Squat")
	ms.exercises[10] = &store.WorkoutExercise{
		ID: 10, VariantID: 2, ExerciseName: "Squat",
		TargetSets: 5, TargetRepsMin: 5, TargetWeightKg: &weight,
	}
	// exercise_library also has id=10 ("Cable Row") — different exercise entirely
	ms.addLibraryItem(10, 1, "Cable Row", 3, 12, &weight)
	// Session belongs to variant 3 (not variant 2)
	ms.addSession(1, 3, "in_progress")
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !changed {
		t.Error("expected changed=true")
	}

	// Verify the library item name was used, not the workout_exercise name
	if len(ms.logExerciseCalls) != 1 {
		t.Fatalf("expected 1 LogExercise store call, got %d", len(ms.logExerciseCalls))
	}

	// Verify source was set to "library"
	logID := int64(ms.logExerciseCalls[0].exerciseID)
	// Find the created log
	for _, l := range ms.logs {
		if l.ExerciseID == logID {
			if l.Source != "library" {
				t.Errorf("expected source=library, got %s", l.Source)
			}
			break
		}
	}
}

func TestLogExercise_SameVariant_UsesWorkoutExercise(t *testing.T) {
	ms := newMockExerciseStore()
	weight := 100.0
	// workout_exercises has id=10 in variant 1
	ms.addExercise(10, "Squat", 5, 5, &weight)
	// exercise_library also has id=10 (different exercise)
	ms.addLibraryItem(10, 1, "Cable Row", 3, 12, nil)
	// Session belongs to variant 1 — matches the workout_exercise
	ms.addSession(1, 1, "in_progress")
	svc := NewExerciseService(ms)

	changed, err := svc.LogExercise(1, 10, "completed", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !changed {
		t.Error("expected changed=true")
	}

	if len(ms.logExerciseCalls) != 1 {
		t.Fatalf("expected 1 LogExercise store call, got %d", len(ms.logExerciseCalls))
	}

	// Verify source was NOT set to "library" (it should stay as default "schedule")
	for _, l := range ms.logs {
		if l.ExerciseID == 10 && l.SessionID == 1 {
			if l.Source == "library" {
				t.Error("expected source to NOT be 'library' when workout_exercise matches variant")
			}
			break
		}
	}
}
