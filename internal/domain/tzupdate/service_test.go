package tzupdate

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type mockSettings struct {
	mu                 sync.Mutex
	current            string
	recordCalls        []string
	recordErrs         map[string]error
	getTZErr           error
	beforeGetCurrentTZ func()
}

func newMockSettings(initial string) *mockSettings {
	return &mockSettings{current: initial, recordErrs: map[string]error{}}
}

func (m *mockSettings) GetCurrentTimezone() (string, error) {
	if m.beforeGetCurrentTZ != nil {
		m.beforeGetCurrentTZ()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.getTZErr != nil {
		return "", m.getTZErr
	}
	return m.current, nil
}

func (m *mockSettings) RecordTimezone(tz string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recordCalls = append(m.recordCalls, tz)
	if err, ok := m.recordErrs[tz]; ok {
		return err
	}
	m.current = tz
	return nil
}

func (m *mockSettings) recordedCalls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.recordCalls))
	copy(out, m.recordCalls)
	return out
}

type mockPlanBaseline struct {
	plan *store.TZTransitionPlan
	err  error
}

func (m *mockPlanBaseline) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return m.plan, m.err
}

type generateCall struct {
	OldTZ string
	NewTZ string
	Now   time.Time
}

type mockPlanner struct {
	mu             sync.Mutex
	generateCalls  []generateCall
	cancelCalls    []string
	generateReturn bool
	generateErr    error
	cancelErr      error
}

func (m *mockPlanner) GenerateIfChanged(oldTZ, newTZ string, now time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.generateCalls = append(m.generateCalls, generateCall{OldTZ: oldTZ, NewTZ: newTZ, Now: now})
	return m.generateReturn, m.generateErr
}

func (m *mockPlanner) CancelActivePlan(reason string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cancelCalls = append(m.cancelCalls, reason)
	return m.cancelErr
}

func (m *mockPlanner) calls() []generateCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]generateCall, len(m.generateCalls))
	copy(out, m.generateCalls)
	return out
}

func (m *mockPlanner) cancels() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.cancelCalls))
	copy(out, m.cancelCalls)
	return out
}

func fixedNow(t time.Time) func() time.Time { return func() time.Time { return t } }

func TestService_HappyPath_PlanCreated(t *testing.T) {
	settings := newMockSettings("America/New_York")
	planner := &mockPlanner{generateReturn: true}
	baseline := &mockPlanBaseline{}
	now := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)

	svc := NewService(settings, baseline, planner, fixedNow(now), nil)

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err != nil {
		t.Fatalf("UpdateTimezone: %v", err)
	}
	if !result.Changed {
		t.Fatalf("expected Changed=true")
	}
	if !result.PlanCreated {
		t.Fatalf("expected PlanCreated=true")
	}
	calls := planner.calls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 planner call, got %d", len(calls))
	}
	if calls[0].OldTZ != "America/New_York" || calls[0].NewTZ != "Europe/Berlin" {
		t.Errorf("planner.GenerateIfChanged called with %+v", calls[0])
	}
	if !calls[0].Now.Equal(now) {
		t.Errorf("planner.GenerateIfChanged Now = %v, want %v", calls[0].Now, now)
	}
	rec := settings.recordedCalls()
	if len(rec) != 1 || rec[0] != "Europe/Berlin" {
		t.Errorf("RecordTimezone calls = %v, want [Europe/Berlin]", rec)
	}
}

func TestService_NoOp_SameTZ(t *testing.T) {
	settings := newMockSettings("Europe/Berlin")
	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, nil)

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err != nil {
		t.Fatalf("UpdateTimezone: %v", err)
	}
	if result.Changed {
		t.Fatalf("expected Changed=false on no-op")
	}
	if result.PlanCreated {
		t.Fatalf("expected PlanCreated=false on no-op")
	}
	if calls := planner.calls(); len(calls) != 0 {
		t.Errorf("planner should not be called for no-op, got %v", calls)
	}
	if rec := settings.recordedCalls(); len(rec) != 0 {
		t.Errorf("RecordTimezone should not be called for no-op, got %v", rec)
	}
}

func TestService_PlannerSkipped_RecordStillCalled(t *testing.T) {
	// When the planner determines no plan is needed (e.g. oldTZ unresolvable, identical
	// offset, idempotent skip), it returns (false, nil). We must still persist the
	// new timezone so the user-visible change actually takes effect.
	settings := newMockSettings("America/New_York")
	planner := &mockPlanner{generateReturn: false}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, nil)

	result, err := svc.UpdateTimezone(context.Background(), "America/Detroit")
	if err != nil {
		t.Fatalf("UpdateTimezone: %v", err)
	}
	if !result.Changed {
		t.Fatalf("expected Changed=true when TZ was recorded")
	}
	if result.PlanCreated {
		t.Fatalf("expected PlanCreated=false when planner returned (false,nil)")
	}
	if calls := planner.calls(); len(calls) != 1 {
		t.Fatalf("expected 1 planner call, got %v", calls)
	}
	rec := settings.recordedCalls()
	if len(rec) != 1 || rec[0] != "America/Detroit" {
		t.Errorf("expected RecordTimezone(America/Detroit), got %v", rec)
	}
}

func TestService_PlannerError_DoesNotRecord(t *testing.T) {
	settings := newMockSettings("America/New_York")
	plannerErr := errors.New("boom")
	planner := &mockPlanner{generateErr: plannerErr}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, nil)

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err == nil {
		t.Fatalf("expected error")
	}
	if !errors.Is(err, plannerErr) {
		t.Errorf("error chain should wrap plannerErr, got %v", err)
	}
	if result.Changed {
		t.Errorf("expected Changed=false on planner error")
	}
	if result.PlanCreated {
		t.Errorf("expected PlanCreated=false on planner error")
	}
	if rec := settings.recordedCalls(); len(rec) != 0 {
		t.Errorf("RecordTimezone must NOT be called on planner error, got %v", rec)
	}
}

func TestService_RecordError_AfterPlanCreated_RevertsBaseline(t *testing.T) {
	// Scenario: there's already an active plan whose OldTZ = "Europe/Lisbon" (the
	// baseline the scheduler is honouring). The user attempts a TZ change to a new
	// value. Planner creates a new plan, but RecordTimezone fails. We must cancel
	// the new plan AND revert the stored timezone to the superseded baseline so
	// the scheduler doesn't permanently run on an unapproved intermediate value.
	settings := newMockSettings("Europe/Madrid")
	recordErr := errors.New("disk full")
	settings.recordErrs["Asia/Tokyo"] = recordErr // fail the forward write only

	baseline := &mockPlanBaseline{
		plan: &store.TZTransitionPlan{
			ID:     42,
			OldTZ:  "Europe/Lisbon",
			NewTZ:  "Europe/Madrid",
			Status: "PENDING_APPROVAL",
		},
	}
	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, baseline, planner, time.Now, nil)

	result, err := svc.UpdateTimezone(context.Background(), "Asia/Tokyo")
	if err == nil {
		t.Fatalf("expected RecordTimezone error")
	}
	if !errors.Is(err, recordErr) {
		t.Errorf("error chain should wrap recordErr, got %v", err)
	}
	if result.Changed {
		t.Errorf("Changed must be false on overall failure")
	}
	if result.PlanCreated {
		t.Errorf("PlanCreated must be false on overall failure")
	}

	cancels := planner.cancels()
	if len(cancels) != 1 {
		t.Fatalf("expected 1 CancelActivePlan call, got %v", cancels)
	}
	if cancels[0] != "record-timezone-failed" {
		t.Errorf("cancel reason = %q, want record-timezone-failed", cancels[0])
	}

	rec := settings.recordedCalls()
	if len(rec) != 2 {
		t.Fatalf("expected 2 RecordTimezone calls (forward + revert), got %v", rec)
	}
	if rec[0] != "Asia/Tokyo" {
		t.Errorf("first record call = %q, want Asia/Tokyo", rec[0])
	}
	if rec[1] != "Europe/Lisbon" {
		t.Errorf("revert call = %q, want Europe/Lisbon (the superseded plan baseline)", rec[1])
	}
}

func TestService_BaselineReadError_WithPlanner_DoesNotMutate(t *testing.T) {
	// When a planner is configured, a transient baseline-read failure must abort
	// the update before GenerateIfChanged cancels the active plan. Otherwise a
	// subsequent RecordTimezone failure would have no captured baseline to
	// revert to, leaving the scheduler with no active plan and the stored
	// timezone pinned to an unapproved intermediate value.
	settings := newMockSettings("America/New_York")
	baseline := &mockPlanBaseline{err: errors.New("db transient")}
	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, baseline, planner, time.Now, nil)

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err == nil {
		t.Fatalf("expected baseline read error to abort update")
	}
	if result.Changed {
		t.Errorf("Changed must be false on baseline read error")
	}
	if result.PlanCreated {
		t.Errorf("PlanCreated must be false on baseline read error")
	}
	if calls := planner.calls(); len(calls) != 0 {
		t.Errorf("planner.GenerateIfChanged must not run when baseline read fails: %v", calls)
	}
	if cancels := planner.cancels(); len(cancels) != 0 {
		t.Errorf("planner.CancelActivePlan must not run when baseline read fails: %v", cancels)
	}
	if rec := settings.recordedCalls(); len(rec) != 0 {
		t.Errorf("RecordTimezone must not run when baseline read fails: %v", rec)
	}
}

func TestService_BaselineReadError_NoPlanner_StillRecords(t *testing.T) {
	// Without a planner, no plan mutations occur, so a baseline read failure is
	// non-fatal — the service still records the new timezone (logging the warning).
	settings := newMockSettings("America/New_York")
	baseline := &mockPlanBaseline{err: errors.New("db transient")}
	svc := NewService(settings, baseline, nil, time.Now, nil)

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err != nil {
		t.Fatalf("UpdateTimezone: %v", err)
	}
	if !result.Changed {
		t.Errorf("Changed must be true when TZ was recorded")
	}
	if result.PlanCreated {
		t.Errorf("PlanCreated must be false without a planner")
	}
	rec := settings.recordedCalls()
	if len(rec) != 1 || rec[0] != "Europe/Berlin" {
		t.Errorf("RecordTimezone calls = %v, want [Europe/Berlin]", rec)
	}
}

func TestService_RecordError_NoActivePlanBaseline_NoRevert(t *testing.T) {
	// When there's no superseded baseline to revert to, RecordTimezone failure
	// still triggers plan cancellation but no revert call.
	settings := newMockSettings("America/New_York")
	recordErr := errors.New("io error")
	settings.recordErrs["Europe/Berlin"] = recordErr

	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, nil)

	if _, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin"); err == nil {
		t.Fatalf("expected error")
	}
	if cancels := planner.cancels(); len(cancels) != 1 {
		t.Errorf("expected CancelActivePlan to be called once, got %v", cancels)
	}
	if rec := settings.recordedCalls(); len(rec) != 1 {
		t.Errorf("expected only the failed forward write, got %v", rec)
	}
}

func TestService_ConcurrentUpdates_Serialize(t *testing.T) {
	// Two goroutines call UpdateTimezone simultaneously. The second one must see
	// the first one's newTZ as its oldTZ, proving the service serializes via its
	// internal mutex.
	aEntered := make(chan struct{})
	aRelease := make(chan struct{})

	settings := newMockSettings("")
	// Block the FIRST GetCurrentTimezone call inside the service mutex so the
	// second goroutine has to wait for the lock.
	var firstCall sync.Once
	settings.beforeGetCurrentTZ = func() {
		first := false
		firstCall.Do(func() { first = true })
		if first {
			close(aEntered)
			<-aRelease
		}
	}

	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, nil)

	ctx := context.Background()
	errA := make(chan error, 1)
	errB := make(chan error, 1)

	go func() {
		_, err := svc.UpdateTimezone(ctx, "Europe/Berlin")
		errA <- err
	}()

	<-aEntered

	bDone := make(chan struct{})
	go func() {
		_, err := svc.UpdateTimezone(ctx, "Asia/Tokyo")
		errB <- err
		close(bDone)
	}()

	// B should be blocked at the service mutex.
	select {
	case <-bDone:
		t.Fatal("second UpdateTimezone completed before the first released the mutex — serialization broken")
	case <-time.After(50 * time.Millisecond):
	}

	close(aRelease)

	if err := <-errA; err != nil {
		t.Fatalf("goroutine A: %v", err)
	}
	if err := <-errB; err != nil {
		t.Fatalf("goroutine B: %v", err)
	}

	calls := planner.calls()
	if len(calls) != 2 {
		t.Fatalf("expected 2 planner calls, got %d (%v)", len(calls), calls)
	}
	if calls[0].OldTZ != "" || calls[0].NewTZ != "Europe/Berlin" {
		t.Errorf("first call = %+v, want OldTZ='' NewTZ=Europe/Berlin", calls[0])
	}
	if calls[1].OldTZ != "Europe/Berlin" || calls[1].NewTZ != "Asia/Tokyo" {
		t.Errorf("second call must see first call's newTZ as oldTZ — got %+v", calls[1])
	}

	rec := settings.recordedCalls()
	want := []string{"Europe/Berlin", "Asia/Tokyo"}
	if len(rec) != len(want) || rec[0] != want[0] || rec[1] != want[1] {
		t.Errorf("RecordTimezone calls = %v, want %v", rec, want)
	}
}

func TestService_ConcurrentSameTarget_OneChange(t *testing.T) {
	// Two clients accept the same TZ-change suggestion at almost the same
	// instant. Both calls hit UpdateTimezone with the identical newTZ. The
	// mutex must serialize them, the first call returns Changed=true, the
	// second short-circuits inside the mutex with Changed=false (oldTZ ==
	// newTZ from the store's perspective). This is the guard against
	// duplicate chat confirmations on cross-client accept races — the
	// notification decision must use UpdateResult.Changed, not a value the
	// caller captured BEFORE entering the serialized path.
	aEntered := make(chan struct{})
	aRelease := make(chan struct{})

	settings := newMockSettings("America/New_York")
	var firstCall sync.Once
	settings.beforeGetCurrentTZ = func() {
		first := false
		firstCall.Do(func() { first = true })
		if first {
			close(aEntered)
			<-aRelease
		}
	}

	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, nil)

	resA := make(chan UpdateResult, 1)
	resB := make(chan UpdateResult, 1)
	errA := make(chan error, 1)
	errB := make(chan error, 1)

	go func() {
		r, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
		resA <- r
		errA <- err
	}()

	<-aEntered

	go func() {
		r, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
		resB <- r
		errB <- err
	}()

	close(aRelease)

	if err := <-errA; err != nil {
		t.Fatalf("goroutine A: %v", err)
	}
	if err := <-errB; err != nil {
		t.Fatalf("goroutine B: %v", err)
	}

	a := <-resA
	b := <-resB
	if !a.Changed {
		t.Errorf("first call must report Changed=true, got %+v", a)
	}
	if b.Changed {
		t.Errorf("second concurrent call must report Changed=false (oldTZ already == newTZ), got %+v", b)
	}

	if rec := settings.recordedCalls(); len(rec) != 1 || rec[0] != "Europe/Berlin" {
		t.Errorf("RecordTimezone must run exactly once for concurrent same-target updates, got %v", rec)
	}
	if calls := planner.calls(); len(calls) != 1 {
		t.Errorf("planner must run exactly once for concurrent same-target updates, got %v", calls)
	}
}

func TestService_NoNotifiers_SkipsPlanCreation(t *testing.T) {
	// In a no-notifier deployment the user has no channel to receive an
	// approval prompt. The previous web-handler synchronously skipped plan
	// generation in this case so the medication scheduler picked up the new
	// timezone immediately. The service must preserve that behaviour: with
	// hasNotifiers returning false, the planner is NOT called and the new
	// timezone is recorded directly. Otherwise the medication checker tick
	// could observe a brief PENDING_APPROVAL plan and pin to OldTZ for up
	// to one minute until tz_plan_notifier cancels the orphan.
	settings := newMockSettings("America/New_York")
	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, func() bool { return false })

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err != nil {
		t.Fatalf("UpdateTimezone: %v", err)
	}
	if !result.Changed {
		t.Errorf("Changed must be true even when notifiers are absent — the TZ was still recorded")
	}
	if result.PlanCreated {
		t.Errorf("PlanCreated must be false when no notifiers are configured")
	}
	if calls := planner.calls(); len(calls) != 0 {
		t.Errorf("planner.GenerateIfChanged must NOT run when hasNotifiers returns false: %v", calls)
	}
	rec := settings.recordedCalls()
	if len(rec) != 1 || rec[0] != "Europe/Berlin" {
		t.Errorf("RecordTimezone calls = %v, want [Europe/Berlin]", rec)
	}
}

func TestService_HasNotifiers_PlanStillCreated(t *testing.T) {
	// When hasNotifiers returns true the gate is open: planner runs and a
	// plan is created exactly as in the default (nil-probe) configuration.
	settings := newMockSettings("America/New_York")
	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, func() bool { return true })

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err != nil {
		t.Fatalf("UpdateTimezone: %v", err)
	}
	if !result.Changed {
		t.Errorf("expected Changed=true when hasNotifiers returns true")
	}
	if !result.PlanCreated {
		t.Errorf("expected PlanCreated=true when hasNotifiers returns true")
	}
	if calls := planner.calls(); len(calls) != 1 {
		t.Errorf("expected 1 planner call when notifiers are configured, got %v", calls)
	}
}

func TestService_NoNotifiers_RecordError_Propagated(t *testing.T) {
	// When the gate skips plan creation but RecordTimezone fails, the error
	// must propagate. There's no plan to cancel (none was created) and no
	// baseline to revert to (the planner-cancellation path that captures it
	// was bypassed).
	settings := newMockSettings("America/New_York")
	recordErr := errors.New("disk full")
	settings.recordErrs["Europe/Berlin"] = recordErr

	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, func() bool { return false })

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err == nil {
		t.Fatalf("expected RecordTimezone error to propagate")
	}
	if !errors.Is(err, recordErr) {
		t.Errorf("error chain should wrap recordErr, got %v", err)
	}
	if result.Changed {
		t.Errorf("Changed must be false on RecordTimezone failure")
	}
	if result.PlanCreated {
		t.Errorf("PlanCreated must be false")
	}
	if calls := planner.calls(); len(calls) != 0 {
		t.Errorf("planner must not be called when hasNotifiers returns false: %v", calls)
	}
	if cancels := planner.cancels(); len(cancels) != 0 {
		t.Errorf("no plan was created so cancel must not be called: %v", cancels)
	}
}

func TestService_GetCurrentTimezoneError_Propagated(t *testing.T) {
	settings := newMockSettings("")
	settings.getTZErr = errors.New("db down")

	planner := &mockPlanner{generateReturn: true}
	svc := NewService(settings, &mockPlanBaseline{}, planner, time.Now, nil)

	result, err := svc.UpdateTimezone(context.Background(), "Europe/Berlin")
	if err == nil {
		t.Fatalf("expected error")
	}
	if result.Changed {
		t.Errorf("Changed must be false when oldTZ read fails")
	}
	if result.PlanCreated {
		t.Errorf("PlanCreated must be false")
	}
	if calls := planner.calls(); len(calls) != 0 {
		t.Errorf("planner must not be invoked when oldTZ read fails: %v", calls)
	}
	if rec := settings.recordedCalls(); len(rec) != 0 {
		t.Errorf("RecordTimezone must not be invoked when oldTZ read fails: %v", rec)
	}
}
