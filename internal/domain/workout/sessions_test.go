package workout

import (
	"errors"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// noopWorkoutStore implements every WorkoutStore method with a zero-value return
// so test fakes can embed it and override only the handful they exercise.
type noopWorkoutStore struct{}

func (noopWorkoutStore) GetSession(id int64) (*store.WorkoutSession, error) { return nil, nil }
func (noopWorkoutStore) GetGroup(groupID int64) (*store.WorkoutGroup, error) {
	return nil, nil
}
func (noopWorkoutStore) StartSession(id int64) error                   { return nil }
func (noopWorkoutStore) ClearSnooze(id int64) error                    { return nil }
func (noopWorkoutStore) SnoozeSession(id int64, d time.Duration) error { return nil }
func (noopWorkoutStore) SkipSession(id int64) error                    { return nil }
func (noopWorkoutStore) CompleteSession(id int64) error                { return nil }
func (noopWorkoutStore) UpdateSessionStatus(id int64, status string) error { return nil }
func (noopWorkoutStore) PreSkipSession(id int64) error                 { return nil }
func (noopWorkoutStore) CancelPreSkip(id int64) error                  { return nil }
func (noopWorkoutStore) AdvanceRotation(groupID int64) error           { return nil }
func (noopWorkoutStore) CreateAdHocSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return nil, nil
}
func (noopWorkoutStore) CreatePlannedAdHocSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return nil, nil
}
func (noopWorkoutStore) LogExerciseWithSource(sessionID, exerciseID int64, name string, sets, reps *int, weight *float64, status, notes, source string) (int64, error) {
	return 0, nil
}
func (noopWorkoutStore) DeleteSession(id int64) error { return nil }
func (noopWorkoutStore) ListHistory(userID int64, limit int) ([]store.WorkoutSession, error) {
	return nil, nil
}
func (noopWorkoutStore) ListActiveSessions(userID int64, date time.Time) ([]store.WorkoutSession, error) {
	return nil, nil
}
func (noopWorkoutStore) ListSnoozedSessions(userID int64) ([]store.WorkoutSession, error) {
	return nil, nil
}
func (noopWorkoutStore) ListGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error) {
	return nil, nil
}
func (noopWorkoutStore) ListVariantsByGroup(groupID int64) ([]store.WorkoutVariant, error) {
	return nil, nil
}
func (noopWorkoutStore) GetVariant(id int64) (*store.WorkoutVariant, error) { return nil, nil }
func (noopWorkoutStore) ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error) {
	return nil, nil
}
func (noopWorkoutStore) ListExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	return nil, nil
}
func (noopWorkoutStore) GetRotationState(groupID int64) (*store.WorkoutRotationState, error) {
	return nil, nil
}
func (noopWorkoutStore) GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*store.WorkoutSession, error) {
	return nil, nil
}
func (noopWorkoutStore) CreateSession(groupID, variantID, userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	return nil, nil
}
func (noopWorkoutStore) ListExerciseStats(userID int64) ([]store.ExerciseStat, error) {
	return nil, nil
}
func (noopWorkoutStore) InitializeRotation(groupID, startingVariantID int64) error { return nil }
func (noopWorkoutStore) UpdateExerciseLog(id int64, sets, reps *int, weight *float64, notes string) error {
	return nil
}
func (noopWorkoutStore) UpdateExerciseLogStatus(id int64, status string) error { return nil }
func (noopWorkoutStore) GetExerciseLogByID(id int64) (*store.WorkoutExerciseLog, error) {
	return nil, nil
}
func (noopWorkoutStore) PropagateExerciseToSchedule(sessionID, exerciseID int64, name string, sets, reps *int, weight *float64) error {
	return nil
}

// fakeSessionStore drives the ListSessions / GetSessionDetails read models.
type fakeSessionStore struct {
	noopWorkoutStore

	history    []store.WorkoutSession
	historyErr error
	limitArg   int

	groups      map[int64]*store.WorkoutGroup
	variants    map[int64]*store.WorkoutVariant
	exByVariant map[int64][]store.WorkoutExercise
	logsBySess  map[int64][]store.WorkoutExerciseLog

	sessionsByID  map[int64]*store.WorkoutSession
	getSessionErr error
	logsErr       error
}

func (f *fakeSessionStore) ListHistory(userID int64, limit int) ([]store.WorkoutSession, error) {
	f.limitArg = limit
	return f.history, f.historyErr
}
func (f *fakeSessionStore) GetGroup(groupID int64) (*store.WorkoutGroup, error) {
	return f.groups[groupID], nil
}
func (f *fakeSessionStore) GetVariant(id int64) (*store.WorkoutVariant, error) {
	return f.variants[id], nil
}
func (f *fakeSessionStore) ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error) {
	return f.exByVariant[variantID], nil
}
func (f *fakeSessionStore) ListExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	if f.logsErr != nil {
		return nil, f.logsErr
	}
	return f.logsBySess[sessionID], nil
}
func (f *fakeSessionStore) GetSession(id int64) (*store.WorkoutSession, error) {
	if f.getSessionErr != nil {
		return nil, f.getSessionErr
	}
	return f.sessionsByID[id], nil
}

func ptrInt(v int) *int                    { return &v }
func ptrFloat(v float64) *float64          { return &v }
func svcWith(f *fakeSessionStore) *Service { return New(f, nil) }

func TestListSessions_Empty(t *testing.T) {
	f := &fakeSessionStore{}
	views, err := svcWith(f).ListSessions(123, 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if views == nil {
		t.Fatalf("expected non-nil empty slice (marshals to []), got nil")
	}
	if len(views) != 0 {
		t.Fatalf("expected 0 views, got %d", len(views))
	}
	if f.limitArg != 30 {
		t.Errorf("limit must be passed through to ListHistory: want 30, got %d", f.limitArg)
	}
}

func TestListSessions_HistoryErrorPropagates(t *testing.T) {
	wantErr := errors.New("history read failed")
	f := &fakeSessionStore{historyErr: wantErr}
	views, err := svcWith(f).ListSessions(123, 30)
	if views != nil {
		t.Fatalf("expected nil views on error, got %+v", views)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected history error to propagate, got %v", err)
	}
}

func TestListSessions_RegularEnrichment(t *testing.T) {
	f := &fakeSessionStore{
		history: []store.WorkoutSession{
			{ID: 1, GroupID: 5, VariantID: 50, Status: "completed"},
		},
		groups:      map[int64]*store.WorkoutGroup{5: {ID: 5, Name: "Legs"}},
		variants:    map[int64]*store.WorkoutVariant{50: {ID: 50, Name: "Heavy"}},
		exByVariant: map[int64][]store.WorkoutExercise{50: {{ID: 500}, {ID: 501}, {ID: 502}}},
		logsBySess: map[int64][]store.WorkoutExerciseLog{
			1: {
				{Status: "completed", SetsCompleted: ptrInt(3), RepsCompleted: ptrInt(10), WeightKg: ptrFloat(100)}, // 3000
				{Status: "completed", SetsCompleted: ptrInt(3), RepsCompleted: ptrInt(10), WeightKg: ptrFloat(50)},  // 1500
				{Status: "skipped"},
			},
		},
	}
	views, err := svcWith(f).ListSessions(123, 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(views) != 1 {
		t.Fatalf("expected 1 view, got %d", len(views))
	}
	v := views[0]
	if v.GroupName != "Legs" || v.VariantName != "Heavy" {
		t.Errorf("names: got %q/%q, want Legs/Heavy", v.GroupName, v.VariantName)
	}
	if v.Exercises != 3 {
		t.Errorf("exercises_count: want 3 (from variant), got %d", v.Exercises)
	}
	if v.Completed != 2 {
		t.Errorf("exercises_completed: want 2, got %d", v.Completed)
	}
	if v.TotalVolume != 4500 {
		t.Errorf("total_volume: want 4500, got %v", v.TotalVolume)
	}
	if v.Session.ID != 1 {
		t.Errorf("session must be echoed back, got id %d", v.Session.ID)
	}
}

func TestListSessions_MissingGroupVariantFallsBackToUnknown(t *testing.T) {
	f := &fakeSessionStore{
		history: []store.WorkoutSession{{ID: 1, GroupID: 5, VariantID: 50}},
		// groups/variants maps empty → GetGroup/GetVariant return nil.
	}
	views, err := svcWith(f).ListSessions(123, 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if views[0].GroupName != "Unknown" || views[0].VariantName != "Unknown" {
		t.Errorf("missing group/variant must fall back to Unknown, got %q/%q", views[0].GroupName, views[0].VariantName)
	}
}

func TestListSessions_AdHocVariantIsBiggestVolume(t *testing.T) {
	f := &fakeSessionStore{
		history: []store.WorkoutSession{{ID: 7, GroupID: -1, VariantID: -1}},
		logsBySess: map[int64][]store.WorkoutExerciseLog{
			7: {
				{ExerciseName: "Bench", Status: "completed", SetsCompleted: ptrInt(3), RepsCompleted: ptrInt(10), WeightKg: ptrFloat(50)},   // 1500
				{ExerciseName: "Squats", Status: "completed", SetsCompleted: ptrInt(3), RepsCompleted: ptrInt(10), WeightKg: ptrFloat(100)}, // 3000
			},
		},
	}
	views, err := svcWith(f).ListSessions(123, 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	v := views[0]
	if v.GroupName != "Ad-hoc" {
		t.Errorf("ad-hoc group name: want Ad-hoc, got %q", v.GroupName)
	}
	if v.VariantName != "Squats" {
		t.Errorf("ad-hoc variant: want biggest-volume Squats, got %q", v.VariantName)
	}
	if v.Exercises != 2 {
		t.Errorf("ad-hoc exercise count comes from logs: want 2, got %d", v.Exercises)
	}
	if v.Completed != 2 {
		t.Errorf("exercises_completed: want 2, got %d", v.Completed)
	}
}

func TestListSessions_AdHocBodyweightUsesSetsRepsProxy(t *testing.T) {
	// No weights logged: best-name selection must use sets*reps as the proxy
	// volume, but total_volume (which requires a weight) stays 0.
	f := &fakeSessionStore{
		history: []store.WorkoutSession{{ID: 7, GroupID: -1, VariantID: -1}},
		logsBySess: map[int64][]store.WorkoutExerciseLog{
			7: {
				{ExerciseName: "Pushups", Status: "completed", SetsCompleted: ptrInt(3), RepsCompleted: ptrInt(20)}, // proxy 60
				{ExerciseName: "Pullups", Status: "completed", SetsCompleted: ptrInt(3), RepsCompleted: ptrInt(8)},  // proxy 24
			},
		},
	}
	views, err := svcWith(f).ListSessions(123, 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if views[0].VariantName != "Pushups" {
		t.Errorf("ad-hoc bodyweight best-name: want Pushups (sets*reps proxy), got %q", views[0].VariantName)
	}
	if views[0].TotalVolume != 0 {
		t.Errorf("total_volume must be 0 without weights, got %v", views[0].TotalVolume)
	}
}

func TestListSessions_EmptyAdHocHasBlankVariant(t *testing.T) {
	f := &fakeSessionStore{
		history: []store.WorkoutSession{{ID: 7, GroupID: -1, VariantID: -1}},
		// no logs
	}
	views, err := svcWith(f).ListSessions(123, 30)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	v := views[0]
	if v.GroupName != "Ad-hoc" {
		t.Errorf("group name: want Ad-hoc, got %q", v.GroupName)
	}
	if v.VariantName != "" {
		t.Errorf("empty ad-hoc variant: want \"\", got %q", v.VariantName)
	}
	if v.Exercises != 0 || v.Completed != 0 {
		t.Errorf("empty ad-hoc counts: want 0/0, got %d/%d", v.Exercises, v.Completed)
	}
}

func TestGetSessionDetails_Found(t *testing.T) {
	f := &fakeSessionStore{
		sessionsByID: map[int64]*store.WorkoutSession{42: {ID: 42, Status: "in_progress"}},
		logsBySess:   map[int64][]store.WorkoutExerciseLog{42: {{ID: 1}, {ID: 2}}},
	}
	details, err := svcWith(f).GetSessionDetails(42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if details == nil || details.Session == nil {
		t.Fatalf("expected details with session, got %+v", details)
	}
	if details.Session.ID != 42 {
		t.Errorf("session id: want 42, got %d", details.Session.ID)
	}
	if len(details.Logs) != 2 {
		t.Errorf("logs: want 2, got %d", len(details.Logs))
	}
}

func TestGetSessionDetails_NotFoundReturnsNilNil(t *testing.T) {
	// Missing session → (nil, nil) so the handler emits 404.
	details, err := svcWith(&fakeSessionStore{}).GetSessionDetails(99)
	if err != nil {
		t.Fatalf("missing session must not error (handler maps nil→404), got %v", err)
	}
	if details != nil {
		t.Fatalf("expected nil details for missing session, got %+v", details)
	}
}

func TestGetSessionDetails_GetSessionErrorTreatedAsNotFound(t *testing.T) {
	// A GetSession error is swallowed to (nil, nil), matching the legacy handler's
	// "err != nil || session == nil" → 404 branch.
	f := &fakeSessionStore{getSessionErr: errors.New("boom")}
	details, err := svcWith(f).GetSessionDetails(99)
	if err != nil {
		t.Fatalf("GetSession error must be swallowed to nil (404), got %v", err)
	}
	if details != nil {
		t.Fatalf("expected nil details, got %+v", details)
	}
}

func TestGetSessionDetails_LogsErrorPropagates(t *testing.T) {
	wantErr := errors.New("logs read failed")
	f := &fakeSessionStore{
		sessionsByID: map[int64]*store.WorkoutSession{42: {ID: 42}},
		logsErr:      wantErr,
	}
	details, err := svcWith(f).GetSessionDetails(42)
	if details != nil {
		t.Fatalf("expected nil details on logs error, got %+v", details)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected logs error to propagate (handler 500), got %v", err)
	}
}
