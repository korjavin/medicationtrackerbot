package workout

import (
	"errors"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fakeTransitionStore drives the SetSessionStatus / PreSkip / NextVariant tests.
// Only the methods those paths touch carry behavior; everything else falls
// through to the embedded no-op base.
type fakeTransitionStore struct {
	noopWorkoutStore

	session       *store.WorkoutSession
	group         *store.WorkoutGroup
	getSessionErr error

	updateStatusCalled bool
	updateStatusArg    string
	updateStatusErr    error

	skipCalled  bool
	skipErr     error
	completeErr error

	advanceCalled bool
	advanceErr    error

	deleteCalled bool
	deleteErr    error

	preSkipCalled       bool
	preSkipErr          error
	cancelPreSkipCalled bool
	cancelPreSkipErr    error
}

func (f *fakeTransitionStore) GetSession(id int64) (*store.WorkoutSession, error) {
	return f.session, f.getSessionErr
}
func (f *fakeTransitionStore) GetGroup(id int64) (*store.WorkoutGroup, error) {
	return f.group, nil
}
func (f *fakeTransitionStore) UpdateSessionStatus(id int64, status string) error {
	f.updateStatusCalled = true
	f.updateStatusArg = status
	return f.updateStatusErr
}
func (f *fakeTransitionStore) SkipSession(id int64) error {
	f.skipCalled = true
	return f.skipErr
}
func (f *fakeTransitionStore) CompleteSession(id int64) error { return f.completeErr }
func (f *fakeTransitionStore) AdvanceRotation(id int64) error {
	f.advanceCalled = true
	return f.advanceErr
}
func (f *fakeTransitionStore) DeleteSession(id int64) error {
	f.deleteCalled = true
	return f.deleteErr
}
func (f *fakeTransitionStore) PreSkipSession(id int64) error {
	f.preSkipCalled = true
	return f.preSkipErr
}
func (f *fakeTransitionStore) CancelPreSkip(id int64) error {
	f.cancelPreSkipCalled = true
	return f.cancelPreSkipErr
}

func newTransitionSvc(f *fakeTransitionStore) *Service {
	// The transitions tested here never touch the timezone; a no-op TZ suffices.
	return New(f, stubTZ{})
}

type stubTZ struct{}

func (stubTZ) GetCurrent() (string, error) { return "", nil }

func TestSetSessionStatus_InvalidStatus(t *testing.T) {
	f := &fakeTransitionStore{session: &store.WorkoutSession{ID: 1}}
	_, err := newTransitionSvc(f).SetSessionStatus(1, "pending")
	if !errors.Is(err, ErrInvalidSessionStatus) {
		t.Fatalf("want ErrInvalidSessionStatus, got %v", err)
	}
	if f.updateStatusCalled || f.skipCalled {
		t.Fatal("no store mutation should run for an invalid status")
	}
}

func TestSetSessionStatus_NotFound(t *testing.T) {
	// Missing row.
	f := &fakeTransitionStore{session: nil}
	out, err := newTransitionSvc(f).SetSessionStatus(1, "completed")
	if err != nil || out != nil {
		t.Fatalf("missing session should return (nil, nil), got out=%v err=%v", out, err)
	}

	// Read error is also treated as not-found (legacy err||nil → 404).
	f = &fakeTransitionStore{getSessionErr: errors.New("read fail")}
	out, err = newTransitionSvc(f).SetSessionStatus(1, "completed")
	if err != nil || out != nil {
		t.Fatalf("read error should return (nil, nil), got out=%v err=%v", out, err)
	}
}

func TestSetSessionStatus_InProgress(t *testing.T) {
	f := &fakeTransitionStore{session: &store.WorkoutSession{ID: 1, GroupID: 7}}
	out, err := newTransitionSvc(f).SetSessionStatus(1, "in_progress")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.updateStatusCalled || f.updateStatusArg != "in_progress" {
		t.Fatalf("expected plain UpdateSessionStatus(in_progress), called=%v arg=%q", f.updateStatusCalled, f.updateStatusArg)
	}
	if f.skipCalled || f.advanceCalled {
		t.Fatal("in_progress must not skip or advance rotation")
	}
	if out == nil || out.Terminal {
		t.Fatalf("in_progress outcome should be non-terminal, got %+v", out)
	}
	if out.Session != f.session {
		t.Fatal("outcome should carry the loaded session")
	}
}

func TestSetSessionStatus_SkippedAdvancesRotation(t *testing.T) {
	f := &fakeTransitionStore{
		session: &store.WorkoutSession{ID: 1, GroupID: 7},
		group:   &store.WorkoutGroup{ID: 7, IsRotating: true},
	}
	out, err := newTransitionSvc(f).SetSessionStatus(1, "skipped")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.skipCalled {
		t.Fatal("expected SkipSession to be called")
	}
	if !f.advanceCalled {
		t.Fatal("expected AdvanceRotation for a rotating group")
	}
	if f.updateStatusCalled {
		t.Fatal("skipped must not go through plain UpdateSessionStatus")
	}
	if out == nil || !out.Terminal {
		t.Fatalf("skipped outcome should be terminal, got %+v", out)
	}
}

func TestSetSessionStatus_CompletedNonRotating(t *testing.T) {
	f := &fakeTransitionStore{
		session: &store.WorkoutSession{ID: 1, GroupID: 7},
		group:   &store.WorkoutGroup{ID: 7, IsRotating: false},
	}
	out, err := newTransitionSvc(f).SetSessionStatus(1, "completed")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.advanceCalled {
		t.Fatal("non-rotating group must not advance rotation")
	}
	if out == nil || !out.Terminal {
		t.Fatalf("completed outcome should be terminal, got %+v", out)
	}
}

func TestSetSessionStatus_SkipErrorPropagates(t *testing.T) {
	f := &fakeTransitionStore{
		session: &store.WorkoutSession{ID: 1, GroupID: 7},
		skipErr: errors.New("skip boom"),
	}
	out, err := newTransitionSvc(f).SetSessionStatus(1, "skipped")
	if err == nil {
		t.Fatal("expected skip error to propagate")
	}
	if out != nil {
		t.Fatal("no outcome should be returned on store error")
	}
}

func TestPreSkipSession_ForwardsAndPropagates(t *testing.T) {
	f := &fakeTransitionStore{}
	if err := newTransitionSvc(f).PreSkipSession(9); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.preSkipCalled {
		t.Fatal("expected store.PreSkipSession to be called")
	}

	f = &fakeTransitionStore{preSkipErr: errors.New("boom")}
	if err := newTransitionSvc(f).PreSkipSession(9); err == nil {
		t.Fatal("expected pre-skip error to propagate")
	}
}

func TestCancelPreSkipSession_ForwardsAndPropagates(t *testing.T) {
	f := &fakeTransitionStore{}
	if err := newTransitionSvc(f).CancelPreSkipSession(9); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.cancelPreSkipCalled {
		t.Fatal("expected store.CancelPreSkip to be called")
	}

	f = &fakeTransitionStore{cancelPreSkipErr: errors.New("boom")}
	if err := newTransitionSvc(f).CancelPreSkipSession(9); err == nil {
		t.Fatal("expected cancel-pre-skip error to propagate")
	}
}

func TestNextVariant_HappyPath(t *testing.T) {
	f := &fakeTransitionStore{
		session: &store.WorkoutSession{ID: 1, GroupID: 7, Status: "pending"},
		group:   &store.WorkoutGroup{ID: 7, IsRotating: true},
	}
	if err := newTransitionSvc(f).NextVariant(1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !f.advanceCalled {
		t.Fatal("expected AdvanceRotation to be called")
	}
	if !f.deleteCalled {
		t.Fatal("expected DeleteSession to be called")
	}
}

func TestNextVariant_Errors(t *testing.T) {
	tests := []struct {
		name  string
		store *fakeTransitionStore
		want  error
	}{
		{
			name:  "missing session",
			store: &fakeTransitionStore{session: nil},
			want:  ErrSessionNotFound,
		},
		{
			name:  "read error treated as not found",
			store: &fakeTransitionStore{getSessionErr: errors.New("read")},
			want:  ErrSessionNotFound,
		},
		{
			name:  "active session rejected",
			store: &fakeTransitionStore{session: &store.WorkoutSession{ID: 1, Status: "in_progress"}},
			want:  ErrVariantChangeNotAllowed,
		},
		{
			name:  "completed session rejected",
			store: &fakeTransitionStore{session: &store.WorkoutSession{ID: 1, Status: "completed"}},
			want:  ErrVariantChangeNotAllowed,
		},
		{
			name:  "skipped session rejected",
			store: &fakeTransitionStore{session: &store.WorkoutSession{ID: 1, Status: "skipped"}},
			want:  ErrVariantChangeNotAllowed,
		},
		{
			name:  "group missing",
			store: &fakeTransitionStore{session: &store.WorkoutSession{ID: 1, GroupID: 7, Status: "pending"}, group: nil},
			want:  ErrGroupNotFound,
		},
		{
			name: "group not rotating",
			store: &fakeTransitionStore{
				session: &store.WorkoutSession{ID: 1, GroupID: 7, Status: "pending"},
				group:   &store.WorkoutGroup{ID: 7, IsRotating: false},
			},
			want: ErrGroupNotRotating,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := newTransitionSvc(tt.store).NextVariant(1)
			if !errors.Is(err, tt.want) {
				t.Fatalf("want %v, got %v", tt.want, err)
			}
			if tt.store.advanceCalled || tt.store.deleteCalled {
				t.Fatal("no rotation advance / delete should run on a rejected transition")
			}
		})
	}
}

func TestNextVariant_AdvanceAndDeleteErrorsPropagate(t *testing.T) {
	// Advance error stops before delete.
	f := &fakeTransitionStore{
		session:    &store.WorkoutSession{ID: 1, GroupID: 7, Status: "pending"},
		group:      &store.WorkoutGroup{ID: 7, IsRotating: true},
		advanceErr: errors.New("advance boom"),
	}
	if err := newTransitionSvc(f).NextVariant(1); err == nil {
		t.Fatal("expected advance error to propagate")
	}
	if f.deleteCalled {
		t.Fatal("delete must not run after an advance failure")
	}

	// Delete error propagates.
	f = &fakeTransitionStore{
		session:   &store.WorkoutSession{ID: 1, GroupID: 7, Status: "pending"},
		group:     &store.WorkoutGroup{ID: 7, IsRotating: true},
		deleteErr: errors.New("delete boom"),
	}
	if err := newTransitionSvc(f).NextVariant(1); err == nil {
		t.Fatal("expected delete error to propagate")
	}
}
