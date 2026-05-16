package tzreschedule

import (
	"context"
	"errors"
	"testing"
	"time"
)

// fakeLifecycleStore captures arguments to ApproveAndMaterialize so the
// LifecycleService Approve plumbing can be verified without a real DB.
type fakeLifecycleStore struct {
	gotPlanID     int64
	gotUserID     int64
	gotApprovedAt time.Time
	approved      bool
	err           error
}

func (f *fakeLifecycleStore) ApproveAndMaterialize(_ context.Context, planID, allowedUserID int64, approvedAt time.Time) (bool, error) {
	f.gotPlanID = planID
	f.gotUserID = allowedUserID
	f.gotApprovedAt = approvedAt
	return f.approved, f.err
}

func TestLifecycleService_Approve_PassesAllowedUserID(t *testing.T) {
	f := &fakeLifecycleStore{approved: true}
	svc := NewLifecycleService(f, 42)

	at := time.Date(2026, 5, 16, 5, 0, 0, 0, time.UTC)
	ok, err := svc.Approve(context.Background(), 17, at)
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
	if !ok {
		t.Errorf("ok=false; want true")
	}
	if f.gotPlanID != 17 {
		t.Errorf("planID=%d want 17", f.gotPlanID)
	}
	if f.gotUserID != 42 {
		t.Errorf("userID=%d want 42 (allowed user from constructor)", f.gotUserID)
	}
	if !f.gotApprovedAt.Equal(at) {
		t.Errorf("approvedAt=%v want %v", f.gotApprovedAt, at)
	}
}

func TestLifecycleService_Approve_ForwardsError(t *testing.T) {
	want := errors.New("db boom")
	f := &fakeLifecycleStore{err: want}
	svc := NewLifecycleService(f, 42)

	ok, err := svc.Approve(context.Background(), 17, time.Now())
	if !errors.Is(err, want) {
		t.Errorf("err=%v want %v", err, want)
	}
	if ok {
		t.Errorf("ok=true on error; want false")
	}
}

func TestLifecycleService_Approve_BenignNoOp(t *testing.T) {
	// approved=false simulates the plan already being past
	// PENDING_APPROVAL/NOTIFIED — a benign duplicate approve.
	f := &fakeLifecycleStore{approved: false}
	svc := NewLifecycleService(f, 42)

	ok, err := svc.Approve(context.Background(), 17, time.Now())
	if err != nil {
		t.Errorf("Approve: %v", err)
	}
	if ok {
		t.Errorf("ok=true on already-past-pending plan; want false")
	}
}
