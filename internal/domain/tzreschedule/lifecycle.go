package tzreschedule

import (
	"context"
	"time"
)

// LifecycleService is the domain entry point for transitions of an existing
// tz_transition_plan: approve (which both flips the plan to APPROVED *and*
// pre-materializes its remaining steps as PENDING intake_log rows under one
// transaction) and any future plan-state mutations Track D adds.
//
// CLAUDE.md rule #1: every bot callback and HTTP handler that needs to flip a
// plan to APPROVED must call Approve through this interface, not the bare
// store.SetTZTransitionPlanApproved primitive — that primitive misses the
// materialize step and would silently lose scheduling for the plan.
type LifecycleService interface {
	// Approve flips the plan to APPROVED and pre-materializes every
	// unconsumed step into intake_log under one transaction. Returns
	// (true, nil) when this call performed the approval; (false, nil) when
	// the plan was already past pending (benign no-op, e.g. another caller
	// approved first); (false, err) on any database error.
	Approve(ctx context.Context, planID int64, approvedAt time.Time) (bool, error)
}

// LifecycleStore is the minimal store surface LifecycleService needs. It is
// satisfied by *store.Repos and exists so tests can fake the cross-repo
// transaction without standing up a SQLite database.
type LifecycleStore interface {
	ApproveAndMaterialize(ctx context.Context, planID, allowedUserID int64, approvedAt time.Time) (bool, error)
}

type lifecycleService struct {
	store         LifecycleStore
	allowedUserID int64
}

// NewLifecycleService constructs a LifecycleService that attributes
// pre-materialized intake rows to allowedUserID — the operator's Telegram ID
// derived from ALLOWED_USER_ID at the composition root. Call once at startup
// and share the resulting service across every transport that approves plans.
func NewLifecycleService(store LifecycleStore, allowedUserID int64) LifecycleService {
	return &lifecycleService{store: store, allowedUserID: allowedUserID}
}

// Approve is documented on the LifecycleService interface.
func (s *lifecycleService) Approve(ctx context.Context, planID int64, approvedAt time.Time) (bool, error) {
	return s.store.ApproveAndMaterialize(ctx, planID, s.allowedUserID, approvedAt)
}
