package scheduler

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// mockLowStockStore counts ListLowOnStock invocations and lets
// tests configure the timezone returned by GetCurrent, plus an
// optional fixed result set for the low-stock query.
type mockLowStockStore struct {
	MedicationStore
	tz       string
	tzErr    error
	meds     []store.Medication
	lowCalls int32
}

func (m *mockLowStockStore) GetCurrent() (string, error) {
	return m.tz, m.tzErr
}

func (m *mockLowStockStore) ListLowOnStock(_ int) ([]store.Medication, error) {
	atomic.AddInt32(&m.lowCalls, 1)
	return m.meds, nil
}

func (m *mockLowStockStore) GetDaysOfStockRemaining(_ *store.Medication) *float64 {
	d := 3.0
	return &d
}

func (m *mockLowStockStore) callCount() int32 {
	return atomic.LoadInt32(&m.lowCalls)
}

// fires at 11:00 user TZ when the server clock is in a different zone (§4.1).
// 18:00 UTC = 11:00 PDT (PDT = UTC-7) — without the fix, the checker reads
// server-local hour (18) and skips; with the fix it converts to user TZ and fires.
func TestLowStockChecker_FiresAt11AMInUserTZ(t *testing.T) {
	count := 1
	mock := &mockLowStockStore{
		tz: "America/Los_Angeles",
		meds: []store.Medication{
			{ID: 1, Name: "Aspirin", InventoryCount: &count},
		},
	}
	checker := &LowStockChecker{store: mock, sink: NewWebPushSink(nil, 0)}
	// 18:00 UTC on 2026-05-14 = 11:00 PDT (PDT = UTC-7).
	checker.now = func() time.Time {
		return time.Date(2026, 5, 14, 18, 0, 0, 0, time.UTC)
	}

	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("Check returned err: %v", err)
	}
	if got := mock.callCount(); got != 1 {
		t.Errorf("ListLowOnStock calls = %d, want 1", got)
	}
}

// skips when the user-TZ hour is not 11 (§4.1 regression in the other
// direction): server in UTC at 18:00 = 10:00 PT — must not fire.
func TestLowStockChecker_SkipsOutside11AMUserTZ(t *testing.T) {
	mock := &mockLowStockStore{tz: "America/Los_Angeles"}
	checker := &LowStockChecker{store: mock, sink: NewWebPushSink(nil, 0)}
	checker.now = func() time.Time {
		return time.Date(2026, 5, 14, 17, 0, 0, 0, time.UTC) // 10:00 PDT
	}

	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("Check returned err: %v", err)
	}
	if got := mock.callCount(); got != 0 {
		t.Errorf("ListLowOnStock calls = %d, want 0", got)
	}
}

// once the daily check has fired, a second invocation on the same day must
// skip — and the date guard must operate in the user's TZ.
func TestLowStockChecker_SkipsWhenAlreadyCheckedToday(t *testing.T) {
	mock := &mockLowStockStore{tz: "America/Los_Angeles"}
	checker := &LowStockChecker{store: mock, sink: NewWebPushSink(nil, 0)}
	checker.now = func() time.Time {
		return time.Date(2026, 5, 14, 18, 0, 0, 0, time.UTC) // 11:00 PDT
	}

	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("first Check returned err: %v", err)
	}
	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("second Check returned err: %v", err)
	}

	if got := mock.callCount(); got != 1 {
		t.Errorf("ListLowOnStock calls = %d, want 1 (date guard)", got)
	}
}

// when there are no low-stock medications, lastCheck must still be updated
// (preserves the existing behavior so we don't re-poll every minute).
func TestLowStockChecker_EmptyMedsStillUpdatesLastCheck(t *testing.T) {
	mock := &mockLowStockStore{tz: "America/Los_Angeles" /* meds is nil */}
	checker := &LowStockChecker{store: mock, sink: NewWebPushSink(nil, 0)}
	checker.now = func() time.Time {
		return time.Date(2026, 5, 14, 18, 0, 0, 0, time.UTC) // 11:00 PDT
	}

	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("Check returned err: %v", err)
	}
	if checker.lastCheck.IsZero() {
		t.Error("expected lastCheck to be set after empty-meds run")
	}

	// And the date guard must still skip a second call.
	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("second Check returned err: %v", err)
	}
	if got := mock.callCount(); got != 1 {
		t.Errorf("ListLowOnStock calls = %d, want 1 (empty meds path should still take date guard)", got)
	}
}

// an invalid timezone string must fall back to the server timezone without
// panicking. We verify it falls through by setting `now` to a value that is
// 11 AM in the SERVER timezone — the call should proceed.
func TestLowStockChecker_InvalidTZFallsBack(t *testing.T) {
	mock := &mockLowStockStore{tz: "Not/A_Real_Zone"}
	checker := &LowStockChecker{store: mock, sink: NewWebPushSink(nil, 0)}
	// Compute "11 AM today in time.Local" so we exercise the fallback.
	now := time.Now()
	elevenAMLocal := time.Date(now.Year(), now.Month(), now.Day(), 11, 0, 0, 0, time.Local)
	checker.now = func() time.Time { return elevenAMLocal }

	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("Check returned err: %v", err)
	}
	if got := mock.callCount(); got != 1 {
		t.Errorf("ListLowOnStock calls = %d, want 1 (server-TZ fallback should fire at 11 local)", got)
	}
}

// store-level GetCurrent error must also fall back to server TZ
// rather than aborting Check.
func TestLowStockChecker_TZErrorFallsBack(t *testing.T) {
	mock := &mockLowStockStore{tzErr: errFakeTZ}
	checker := &LowStockChecker{store: mock, sink: NewWebPushSink(nil, 0)}
	now := time.Now()
	elevenAMLocal := time.Date(now.Year(), now.Month(), now.Day(), 11, 0, 0, 0, time.Local)
	checker.now = func() time.Time { return elevenAMLocal }

	if err := checker.Check(context.Background()); err != nil {
		t.Fatalf("Check returned err: %v", err)
	}
	if got := mock.callCount(); got != 1 {
		t.Errorf("ListLowOnStock calls = %d, want 1 on TZ-load error fallback", got)
	}
}

// race test (§4.2): 50 concurrent Check() calls. With the mutex around the
// read-decide-write critical section, ListLowOnStock must be
// invoked at most once even when many goroutines race, and the race
// detector must not fire.
func TestLowStockChecker_ConcurrentChecksDoNotDoubleFire(t *testing.T) {
	mock := &mockLowStockStore{tz: "America/Los_Angeles"}
	checker := &LowStockChecker{store: mock, sink: NewWebPushSink(nil, 0)}
	checker.now = func() time.Time {
		return time.Date(2026, 5, 14, 18, 0, 0, 0, time.UTC) // 11:00 PDT
	}

	var wg sync.WaitGroup
	const n = 50
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			_ = checker.Check(context.Background())
		}()
	}
	wg.Wait()

	if got := mock.callCount(); got != 1 {
		t.Errorf("ListLowOnStock calls = %d, want 1 (race / lock test)", got)
	}
}

var errFakeTZ = errors.New("boom")
