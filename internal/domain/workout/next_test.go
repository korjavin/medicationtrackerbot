package workout

import (
	"errors"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fakeNextStore is a controllable WorkoutStore + TZStore for GetNext tests. Only
// the read methods the scheduling engine touches carry behavior; everything else
// returns zero values.
type fakeNextStore struct {
	activeSessions []store.WorkoutSession
	activeErr      error
	activeDateArg  time.Time
	activeCalled   bool

	snoozedSessions []store.WorkoutSession
	snoozedErr      error

	groups    []store.WorkoutGroup
	groupsErr error

	groupsByID         map[int64]*store.WorkoutGroup
	variants           map[int64]*store.WorkoutVariant
	variantsByGroup    map[int64][]store.WorkoutVariant
	exercisesByVariant map[int64][]store.WorkoutExercise
	logsBySession      map[int64][]store.WorkoutExerciseLog
	rotationByGroup    map[int64]*store.WorkoutRotationState
	existingByGroup    map[int64]*store.WorkoutSession

	createSession *store.WorkoutSession
	createErr     error
	createCalled  bool

	tz string
}

func (f *fakeNextStore) ListActiveSessions(userID int64, date time.Time) ([]store.WorkoutSession, error) {
	f.activeCalled = true
	f.activeDateArg = date
	return f.activeSessions, f.activeErr
}

func (f *fakeNextStore) ListSnoozedSessions(userID int64) ([]store.WorkoutSession, error) {
	return f.snoozedSessions, f.snoozedErr
}

func (f *fakeNextStore) ListGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error) {
	return f.groups, f.groupsErr
}

func (f *fakeNextStore) GetGroup(groupID int64) (*store.WorkoutGroup, error) {
	return f.groupsByID[groupID], nil
}

func (f *fakeNextStore) GetVariant(id int64) (*store.WorkoutVariant, error) {
	return f.variants[id], nil
}

func (f *fakeNextStore) ListVariantsByGroup(groupID int64) ([]store.WorkoutVariant, error) {
	return f.variantsByGroup[groupID], nil
}

func (f *fakeNextStore) ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error) {
	return f.exercisesByVariant[variantID], nil
}

func (f *fakeNextStore) ListExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	return f.logsBySession[sessionID], nil
}

func (f *fakeNextStore) GetRotationState(groupID int64) (*store.WorkoutRotationState, error) {
	return f.rotationByGroup[groupID], nil
}

func (f *fakeNextStore) GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*store.WorkoutSession, error) {
	return f.existingByGroup[groupID], nil
}

func (f *fakeNextStore) CreateSession(groupID, variantID, userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	f.createCalled = true
	if f.createErr != nil {
		return nil, f.createErr
	}
	return f.createSession, nil
}

func (f *fakeNextStore) GetCurrent() (string, error) { return f.tz, nil }

// Unused-by-GetNext WorkoutStore methods.
func (f *fakeNextStore) ListHistory(userID int64, limit int) ([]store.WorkoutSession, error) {
	return nil, nil
}
func (f *fakeNextStore) GetSession(id int64) (*store.WorkoutSession, error) { return nil, nil }
func (f *fakeNextStore) StartSession(id int64) error                        { return nil }
func (f *fakeNextStore) ClearSnooze(id int64) error                         { return nil }
func (f *fakeNextStore) SnoozeSession(id int64, d time.Duration) error      { return nil }
func (f *fakeNextStore) SkipSession(id int64) error                         { return nil }
func (f *fakeNextStore) CompleteSession(id int64) error                     { return nil }
func (f *fakeNextStore) UpdateSessionStatus(id int64, status string) error  { return nil }
func (f *fakeNextStore) PreSkipSession(id int64) error                      { return nil }
func (f *fakeNextStore) CancelPreSkip(id int64) error                       { return nil }
func (f *fakeNextStore) AdvanceRotation(groupID int64) error                { return nil }
func (f *fakeNextStore) CreateAdHocSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return nil, nil
}
func (f *fakeNextStore) CreatePlannedAdHocSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return nil, nil
}
func (f *fakeNextStore) LogExerciseWithSource(sessionID, exerciseID int64, name string, sets, reps *int, weight *float64, status, notes, source string) (int64, error) {
	return 0, nil
}
func (f *fakeNextStore) DeleteSession(id int64) error { return nil }
func (f *fakeNextStore) ListExerciseStats(userID int64) ([]store.ExerciseStat, error) {
	return nil, nil
}
func (f *fakeNextStore) InitializeRotation(groupID, startingVariantID int64) error { return nil }
func (f *fakeNextStore) UpdateExerciseLog(id int64, sets, reps *int, weight *float64, notes string) error {
	return nil
}
func (f *fakeNextStore) UpdateExerciseLogStatus(id int64, status string) error { return nil }
func (f *fakeNextStore) GetExerciseLogByID(id int64) (*store.WorkoutExerciseLog, error) {
	return nil, nil
}
func (f *fakeNextStore) PropagateExerciseToSchedule(sessionID, exerciseID int64, name string, sets, reps *int, weight *float64) error {
	return nil
}

// nextClock is the fixed "now" used across the table-driven cases: noon UTC on a
// Saturday, so a 23:59 same-day workout is always in the future.
var nextClock = time.Date(2030, 6, 1, 12, 0, 0, 0, time.UTC)

func newNextService(f *fakeNextStore) *Service {
	svc := New(f, f)
	svc.Now = func() time.Time { return nextClock }
	return svc
}

func sessionField(t *testing.T, nw *NextWorkout, key string) (interface{}, bool) {
	t.Helper()
	if nw == nil || nw.Session == nil {
		t.Fatalf("expected a session, got nil NextWorkout/Session")
	}
	v, ok := nw.Session[key]
	return v, ok
}

func TestGetNext_Branches(t *testing.T) {
	today := time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	snoozeReady := time.Date(2030, 6, 1, 11, 0, 0, 0, time.UTC) // before nextClock

	tests := []struct {
		name   string
		setup  func() *fakeNextStore
		assert func(t *testing.T, nw *NextWorkout, err error, f *fakeNextStore)
	}{
		{
			name: "active today wins over snoozed and pending",
			setup: func() *fakeNextStore {
				return &fakeNextStore{
					activeSessions: []store.WorkoutSession{
						{ID: 1, GroupID: 5, VariantID: 50, Status: "notified", ScheduledDate: today, ScheduledTime: "09:00"},
					},
					// A ready snoozed session and a scheduled group exist but must be ignored.
					snoozedSessions: []store.WorkoutSession{
						{ID: 2, GroupID: 6, VariantID: 60, Status: "notified", ScheduledDate: today, SnoozedUntil: &snoozeReady},
					},
					groups: []store.WorkoutGroup{
						{ID: 7, Name: "Pull", DaysOfWeek: "[0,1,2,3,4,5,6]", ScheduledTime: "23:59"},
					},
					groupsByID: map[int64]*store.WorkoutGroup{5: {ID: 5, Name: "Push", IsRotating: true}},
					variants:   map[int64]*store.WorkoutVariant{50: {ID: 50, Name: "Day A"}},
					exercisesByVariant: map[int64][]store.WorkoutExercise{
						50: {{ID: 500}, {ID: 501}},
					},
				}
			},
			assert: func(t *testing.T, nw *NextWorkout, err error, f *fakeNextStore) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if nw.GroupID != 5 || nw.VariantID != 50 {
					t.Fatalf("expected active session group/variant 5/50, got %d/%d", nw.GroupID, nw.VariantID)
				}
				if nw.GroupName != "Push" || nw.VariantName != "Day A" {
					t.Errorf("names: got %q/%q", nw.GroupName, nw.VariantName)
				}
				if nw.ExercisesCount != 2 {
					t.Errorf("exercises_count: want 2, got %d", nw.ExercisesCount)
				}
				if !nw.IsRotating {
					t.Errorf("expected is_rotating true")
				}
				if id, _ := sessionField(t, nw, "id"); id != int64(1) {
					t.Errorf("session id: want 1, got %v", id)
				}
				if v, _ := sessionField(t, nw, "is_snoozed"); v != false {
					t.Errorf("is_snoozed: want false (no snooze on active), got %v", v)
				}
				if v, ok := sessionField(t, nw, "snoozed_until"); !ok || v != (*time.Time)(nil) {
					t.Errorf("active branch must include snoozed_until (null here), got %v ok=%v", v, ok)
				}
				if v, _ := sessionField(t, nw, "is_today"); v != true {
					t.Errorf("is_today: want true, got %v", v)
				}
				if f.createCalled {
					t.Errorf("active branch must not lazily create a session")
				}
			},
		},
		{
			name: "snoozed branch when no active",
			setup: func() *fakeNextStore {
				return &fakeNextStore{
					snoozedSessions: []store.WorkoutSession{
						{ID: 9, GroupID: 6, VariantID: 60, Status: "notified", ScheduledDate: today, SnoozedUntil: &snoozeReady},
					},
					groupsByID:         map[int64]*store.WorkoutGroup{6: {ID: 6, Name: "Legs"}},
					variants:           map[int64]*store.WorkoutVariant{60: {ID: 60, Name: "Day B"}},
					exercisesByVariant: map[int64][]store.WorkoutExercise{60: {{ID: 600}}},
				}
			},
			assert: func(t *testing.T, nw *NextWorkout, err error, f *fakeNextStore) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if nw.GroupID != 6 || nw.GroupName != "Legs" || nw.VariantName != "Day B" {
					t.Fatalf("unexpected resolution: %+v", nw)
				}
				if v, _ := sessionField(t, nw, "is_snoozed"); v != true {
					t.Errorf("is_snoozed: want true, got %v", v)
				}
				if v, ok := sessionField(t, nw, "snoozed_until"); !ok || v != &snoozeReady {
					t.Errorf("snoozed_until: want %v, got %v ok=%v", snoozeReady, v, ok)
				}
				if nw.ExercisesCount != 1 {
					t.Errorf("exercises_count: want 1, got %d", nw.ExercisesCount)
				}
			},
		},
		{
			name: "pending branch lazily creates session",
			setup: func() *fakeNextStore {
				return &fakeNextStore{
					groups: []store.WorkoutGroup{
						{ID: 7, Name: "Full Body", DaysOfWeek: "[0,1,2,3,4,5,6]", ScheduledTime: "23:59"},
					},
					variantsByGroup:    map[int64][]store.WorkoutVariant{7: {{ID: 70, Name: "Default"}}},
					variants:           map[int64]*store.WorkoutVariant{70: {ID: 70, Name: "Default"}},
					exercisesByVariant: map[int64][]store.WorkoutExercise{70: {{ID: 700}, {ID: 701}, {ID: 702}}},
					createSession:      &store.WorkoutSession{ID: 99, Status: "pending"},
				}
			},
			assert: func(t *testing.T, nw *NextWorkout, err error, f *fakeNextStore) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if !f.createCalled {
					t.Fatalf("pending branch must lazily create the session")
				}
				if nw.GroupID != 7 || nw.VariantID != 70 || nw.GroupName != "Full Body" {
					t.Fatalf("unexpected resolution: %+v", nw)
				}
				if id, _ := sessionField(t, nw, "id"); id != int64(99) {
					t.Errorf("session id: want created 99, got %v", id)
				}
				if v, _ := sessionField(t, nw, "status"); v != "pending" {
					t.Errorf("status: want pending, got %v", v)
				}
				if v, _ := sessionField(t, nw, "is_snoozed"); v != false {
					t.Errorf("is_snoozed: want false, got %v", v)
				}
				// Pending branch must NOT carry a snoozed_until key at all.
				if _, ok := sessionField(t, nw, "snoozed_until"); ok {
					t.Errorf("pending branch must omit snoozed_until entirely")
				}
				if nw.ExercisesCount != 3 {
					t.Errorf("exercises_count: want 3, got %d", nw.ExercisesCount)
				}
			},
		},
		{
			name: "no workout returns nil",
			setup: func() *fakeNextStore {
				return &fakeNextStore{}
			},
			assert: func(t *testing.T, nw *NextWorkout, err error, f *fakeNextStore) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if nw != nil {
					t.Fatalf("expected nil NextWorkout, got %+v", nw)
				}
			},
		},
		{
			name: "ad-hoc active session counts placeholder logs",
			setup: func() *fakeNextStore {
				return &fakeNextStore{
					activeSessions: []store.WorkoutSession{
						{ID: 11, GroupID: -1, VariantID: -1, Status: "notified", ScheduledDate: today, ScheduledTime: "23:59"},
					},
					// ListExercisesByVariant(-1) is empty; count must come from logs.
					logsBySession: map[int64][]store.WorkoutExerciseLog{
						11: {{ID: 1}, {ID: 2}, {ID: 3}},
					},
				}
			},
			assert: func(t *testing.T, nw *NextWorkout, err error, f *fakeNextStore) {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if nw.GroupID != -1 {
					t.Fatalf("expected ad-hoc group_id -1, got %d", nw.GroupID)
				}
				if nw.GroupName != "Unknown" || nw.VariantName != "Unknown" {
					t.Errorf("ad-hoc names: want Unknown/Unknown, got %q/%q", nw.GroupName, nw.VariantName)
				}
				if nw.ExercisesCount != 3 {
					t.Errorf("exercises_count: want 3 from placeholder logs, got %d", nw.ExercisesCount)
				}
				if nw.IsRotating {
					t.Errorf("ad-hoc must not be rotating")
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := tc.setup()
			svc := newNextService(f)
			nw, err := svc.GetNext(123)
			tc.assert(t, nw, err, f)
		})
	}
}

// TestGetNext_TimezoneDayBoundary verifies the day boundary (and is_today) are
// computed in the user's timezone, not UTC. With now=23:00 UTC and Asia/Tokyo
// (+09:00), local "today" rolls to the next calendar day.
func TestGetNext_TimezoneDayBoundary(t *testing.T) {
	tokyoDate := time.Date(2030, 6, 2, 0, 0, 0, 0, time.UTC) // local-today in Tokyo
	f := &fakeNextStore{
		tz: "Asia/Tokyo",
		activeSessions: []store.WorkoutSession{
			{ID: 1, GroupID: 5, VariantID: 50, Status: "notified", ScheduledDate: tokyoDate, ScheduledTime: "09:00"},
		},
		groupsByID:         map[int64]*store.WorkoutGroup{5: {ID: 5, Name: "Push"}},
		variants:           map[int64]*store.WorkoutVariant{50: {ID: 50, Name: "Day A"}},
		exercisesByVariant: map[int64][]store.WorkoutExercise{50: {{ID: 500}}},
	}
	svc := New(f, f)
	// 2030-06-01 23:00 UTC == 2030-06-02 08:00 Tokyo → local today is 2030-06-02.
	svc.Now = func() time.Time { return time.Date(2030, 6, 1, 23, 0, 0, 0, time.UTC) }

	nw, err := svc.GetNext(123)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The day boundary passed to the store must be local-tz midnight (2030-06-02),
	// not the UTC date (2030-06-01).
	if got := f.activeDateArg.Format("2006-01-02"); got != "2030-06-02" {
		t.Errorf("ListActiveSessions date arg: want 2030-06-02 (Tokyo), got %s", got)
	}
	if v, _ := sessionField(t, nw, "is_today"); v != true {
		t.Errorf("is_today: want true in user TZ, got %v", v)
	}
}

func TestGetNext_ListGroupsErrorPropagates(t *testing.T) {
	wantErr := errors.New("groups read failed")
	f := &fakeNextStore{groupsErr: wantErr}
	svc := newNextService(f)

	nw, err := svc.GetNext(123)
	if nw != nil {
		t.Fatalf("expected nil NextWorkout on error, got %+v", nw)
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected ListGroups error to propagate, got %v", err)
	}
}

func TestGetNext_CreateSessionErrorWrapped(t *testing.T) {
	wantErr := errors.New("insert failed")
	f := &fakeNextStore{
		groups: []store.WorkoutGroup{
			{ID: 7, Name: "Full Body", DaysOfWeek: "[0,1,2,3,4,5,6]", ScheduledTime: "23:59"},
		},
		variantsByGroup:    map[int64][]store.WorkoutVariant{7: {{ID: 70, Name: "Default"}}},
		variants:           map[int64]*store.WorkoutVariant{70: {ID: 70, Name: "Default"}},
		exercisesByVariant: map[int64][]store.WorkoutExercise{70: {{ID: 700}}},
		createErr:          wantErr,
	}
	svc := newNextService(f)

	nw, err := svc.GetNext(123)
	if nw != nil {
		t.Fatalf("expected nil NextWorkout on create error, got %+v", nw)
	}
	var cse *CreateSessionError
	if !errors.As(err, &cse) {
		t.Fatalf("expected *CreateSessionError, got %T: %v", err, err)
	}
	if !errors.Is(err, wantErr) {
		t.Errorf("CreateSessionError must wrap the underlying error")
	}
}

// TestGetNext_SwallowsActiveSessionsError verifies that a ListActiveSessions error
// is non-fatal: the engine falls through to the snoozed branch.
func TestGetNext_SwallowsActiveSessionsError(t *testing.T) {
	snoozeReady := time.Date(2030, 6, 1, 11, 0, 0, 0, time.UTC)
	f := &fakeNextStore{
		activeErr: errors.New("active read failed"),
		snoozedSessions: []store.WorkoutSession{
			{ID: 9, GroupID: 6, VariantID: 60, Status: "notified", SnoozedUntil: &snoozeReady},
		},
		groupsByID:         map[int64]*store.WorkoutGroup{6: {ID: 6, Name: "Legs"}},
		variants:           map[int64]*store.WorkoutVariant{60: {ID: 60, Name: "Day B"}},
		exercisesByVariant: map[int64][]store.WorkoutExercise{60: {{ID: 600}}},
	}
	svc := newNextService(f)

	nw, err := svc.GetNext(123)
	if err != nil {
		t.Fatalf("expected active error to be swallowed, got %v", err)
	}
	if nw == nil || nw.GroupID != 6 {
		t.Fatalf("expected fall-through to snoozed branch (group 6), got %+v", nw)
	}
}
