package workout

import (
	"errors"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fakeRotationStore drives GetRotationState / InitializeRotation. Everything
// else falls through to the embedded no-op base.
type fakeRotationStore struct {
	noopWorkoutStore

	state    *store.WorkoutRotationState
	stateErr error

	initCalls [][2]int64
	initErr   error
}

func (f *fakeRotationStore) GetRotationState(groupID int64) (*store.WorkoutRotationState, error) {
	return f.state, f.stateErr
}
func (f *fakeRotationStore) InitializeRotation(groupID, startingVariantID int64) error {
	f.initCalls = append(f.initCalls, [2]int64{groupID, startingVariantID})
	return f.initErr
}

func TestGetRotationState_Found(t *testing.T) {
	want := &store.WorkoutRotationState{GroupID: 5, CurrentVariantID: 50}
	f := &fakeRotationStore{state: want}
	got, err := New(f, nil).GetRotationState(5)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != want {
		t.Fatalf("want %+v, got %+v", want, got)
	}
}

func TestGetRotationState_NonRotatingGroupReturnsNilNil(t *testing.T) {
	// A non-rotating group has no workout_rotation_state row → store returns
	// nil; the service forwards (nil, nil) so the handler emits 404.
	f := &fakeRotationStore{state: nil}
	got, err := New(f, nil).GetRotationState(5)
	if err != nil {
		t.Fatalf("missing state must not error (handler maps nil→404), got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil state, got %+v", got)
	}
}

func TestGetRotationState_StoreErrorSwallowedToNil(t *testing.T) {
	// A read error is swallowed to (nil, nil), matching the legacy handler's
	// "err != nil || state == nil" → 404 branch.
	f := &fakeRotationStore{stateErr: errors.New("boom")}
	got, err := New(f, nil).GetRotationState(5)
	if err != nil {
		t.Fatalf("store error must be swallowed to nil, got %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil state, got %+v", got)
	}
}

func TestInitializeRotation_ForwardsArgs(t *testing.T) {
	f := &fakeRotationStore{}
	if err := New(f, nil).InitializeRotation(7, 70); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(f.initCalls) != 1 || f.initCalls[0] != [2]int64{7, 70} {
		t.Fatalf("InitializeRotation must forward (groupID, startingVariantID), got %v", f.initCalls)
	}
}

func TestInitializeRotation_Idempotent(t *testing.T) {
	// The store uses INSERT OR REPLACE, so re-initializing the same group is a
	// no-op-equivalent at this layer: repeated calls succeed and record the
	// latest args without error.
	f := &fakeRotationStore{}
	svc := New(f, nil)
	if err := svc.InitializeRotation(7, 70); err != nil {
		t.Fatalf("first init: %v", err)
	}
	if err := svc.InitializeRotation(7, 71); err != nil {
		t.Fatalf("second init: %v", err)
	}
	if len(f.initCalls) != 2 {
		t.Fatalf("want 2 forwarded calls, got %d", len(f.initCalls))
	}
	if f.initCalls[1] != [2]int64{7, 71} {
		t.Errorf("latest init args: want {7,71}, got %v", f.initCalls[1])
	}
}

func TestInitializeRotation_ErrorPropagates(t *testing.T) {
	wantErr := errors.New("init failed")
	f := &fakeRotationStore{initErr: wantErr}
	if err := New(f, nil).InitializeRotation(7, 70); !errors.Is(err, wantErr) {
		t.Fatalf("expected init error to propagate, got %v", err)
	}
}
