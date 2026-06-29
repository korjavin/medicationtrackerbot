package gamification

import (
	"context"
	"errors"
	"testing"

	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// TestUpsertTarget_ValidatesMetricAndBand asserts the domain layer rejects
// targets that the scorer could not honor (unknown metric key) or that are
// incoherent (Low>High, negative Falloff) before they reach the store, and that a
// valid one-sided target persists.
func TestUpsertTarget_ValidatesMetricAndBand(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 61
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}})

	if _, err := svc.UpsertTarget(ctx, userID, gamstore.Target{MetricKey: "bogus"}); !errors.Is(err, ErrUnknownTargetMetric) {
		t.Errorf("unknown key err = %v, want ErrUnknownTargetMetric", err)
	}

	low, high := 9.0, 7.0
	if _, err := svc.UpsertTarget(ctx, userID, gamstore.Target{MetricKey: TargetKeySleepHours, LowVal: &low, HighVal: &high}); !errors.Is(err, ErrInvalidTarget) {
		t.Errorf("low>high err = %v, want ErrInvalidTarget", err)
	}

	negFalloff := -1.0
	if _, err := svc.UpsertTarget(ctx, userID, gamstore.Target{MetricKey: TargetKeySleepHours, Falloff: &negFalloff}); !errors.Is(err, ErrInvalidTarget) {
		t.Errorf("negative falloff err = %v, want ErrInvalidTarget", err)
	}

	// One-sided override whose set side crosses the recommended default's unset
	// side: steps low=20000 with the default high=15000 merges to a High<Low band
	// the scorer would silently zero. Must reject, not persist.
	crossLow := 20000.0
	if _, err := svc.UpsertTarget(ctx, userID, gamstore.Target{MetricKey: TargetKeySteps, LowVal: &crossLow}); !errors.Is(err, ErrInvalidTarget) {
		t.Errorf("one-sided low above default high err = %v, want ErrInvalidTarget", err)
	}

	okLow := 6.5
	got, err := svc.UpsertTarget(ctx, userID, gamstore.Target{MetricKey: TargetKeySleepHours, LowVal: &okLow})
	if err != nil {
		t.Fatalf("valid one-sided upsert: %v", err)
	}
	if got == nil || got.MetricKey != TargetKeySleepHours {
		t.Errorf("upsert returned %+v, want a sleep-hours target", got)
	}
}

// TestSetTargets_RejectsBatchWithoutPartialCommit asserts the batch PUT validates
// the whole payload before any write: a valid item ahead of an invalid one must
// not be persisted when the batch is rejected.
func TestSetTargets_RejectsBatchWithoutPartialCommit(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 65
	fs := &fullStores{settings: fakeSettings{enabled: true}}
	svc := newFullService(fs)

	low := 6.5
	batch := []gamstore.Target{
		{MetricKey: TargetKeySleepHours, LowVal: &low}, // valid
		{MetricKey: "bogus"},                           // invalid → whole batch rejected
	}
	if _, err := svc.SetTargets(ctx, userID, batch); !errors.Is(err, ErrUnknownTargetMetric) {
		t.Fatalf("SetTargets err = %v, want ErrUnknownTargetMetric", err)
	}
	if n := len(fs.gam.targets[userID]); n != 0 {
		t.Errorf("rejected batch persisted %d targets, want 0 (partial commit)", n)
	}
}

// TestTargetsCRUD_GateOff_NoOp asserts every target entry point short-circuits to
// a no-op when the feature flag is off, persisting nothing.
func TestTargetsCRUD_GateOff_NoOp(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 62
	fs := &fullStores{settings: fakeSettings{enabled: false}}
	svc := newFullService(fs)

	if ts, err := svc.ListTargets(ctx, userID); err != nil || ts != nil {
		t.Errorf("gate-off ListTargets = %v, %v; want nil, nil", ts, err)
	}
	low := 6.5
	if got, err := svc.UpsertTarget(ctx, userID, gamstore.Target{MetricKey: TargetKeySleepHours, LowVal: &low}); err != nil || got != nil {
		t.Errorf("gate-off UpsertTarget = %v, %v; want nil, nil", got, err)
	}
	if n := len(fs.gam.targets[userID]); n != 0 {
		t.Errorf("gate-off UpsertTarget persisted %d targets, want 0", n)
	}
	if err := svc.DeleteTarget(ctx, userID, TargetKeySleepHours); err != nil {
		t.Errorf("gate-off DeleteTarget err = %v, want nil", err)
	}
}

// TestListTargets_PassThrough asserts an enabled user's stored overrides are
// returned through the service.
func TestListTargets_PassThrough(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 63
	gam := newMemGam()
	low := 6.5
	gam.targets[userID] = []gamstore.Target{{MetricKey: TargetKeySleepHours, LowVal: &low}}
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}, gam: gam})

	ts, err := svc.ListTargets(ctx, userID)
	if err != nil {
		t.Fatalf("ListTargets: %v", err)
	}
	if len(ts) != 1 || ts[0].MetricKey != TargetKeySleepHours {
		t.Errorf("ListTargets = %+v, want one sleep-hours target", ts)
	}
}

// TestDeleteTarget_UnknownMetric asserts the domain layer rejects a delete for a
// metric key the scorer never honored, keeping the error surface consistent with
// UpsertTarget.
func TestDeleteTarget_UnknownMetric(t *testing.T) {
	ctx := context.Background()
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}})
	if err := svc.DeleteTarget(ctx, 64, "bogus"); !errors.Is(err, ErrUnknownTargetMetric) {
		t.Errorf("delete unknown key err = %v, want ErrUnknownTargetMetric", err)
	}
}
