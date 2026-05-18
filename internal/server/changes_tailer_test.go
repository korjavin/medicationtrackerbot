package server

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeChangeStore is a controllable ChangeStore for tailer unit tests.
// cursor() returns the value of the atomic counter so the test can advance
// the simulated MAX(id) at will. Other ChangeStore methods are unused by the
// tailer but stubbed to satisfy the interface.
type fakeChangeStore struct {
	cursor   atomic.Int64
	readErr  atomic.Pointer[error]
	readHits atomic.Int64
}

func (f *fakeChangeStore) GetLatestChangeCursor(ctx context.Context) (int64, error) {
	f.readHits.Add(1)
	if errp := f.readErr.Load(); errp != nil && *errp != nil {
		return 0, *errp
	}
	return f.cursor.Load(), nil
}

func (f *fakeChangeStore) PruneChangeEvents(ctx context.Context, keepLast, maxAgeDays int) error {
	return nil
}

func (f *fakeChangeStore) ListChangedTagsSince(ctx context.Context, since int64) (int64, []string, error) {
	return f.cursor.Load(), nil, nil
}

// newTailerHarness constructs a minimal Server populated only with the
// fields the tailer needs (changes + changesBroker) plus a started fakeChangeStore.
func newTailerHarness() (*Server, *fakeChangeStore) {
	fake := &fakeChangeStore{}
	srv := &Server{
		changes:       fake,
		changesBroker: NewChangeBroker(),
	}
	return srv, fake
}

// drain waits up to timeout for a notify on sub and returns the cursor and
// true; on timeout returns (0, false).
func drainOne(sub <-chan int64, timeout time.Duration) (int64, bool) {
	select {
	case v, ok := <-sub:
		if !ok {
			return 0, false
		}
		return v, true
	case <-time.After(timeout):
		return 0, false
	}
}

// waitForInitRead blocks until the tailer's pre-loop seed read has completed
// (or t.Fatal on timeout). This eliminates the race between starting the
// tailer goroutine and the test mutating the simulated cursor: without this,
// a Store(42) that lands BEFORE the init read causes lastCursor=42 and the
// tailer never observes an advance.
func waitForInitRead(t *testing.T, fake *fakeChangeStore, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fake.readHits.Load() >= 1 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("tailer did not perform initial cursor read within %v", timeout)
}

func TestTailerNotifiesOnCursorAdvance(t *testing.T) {
	srv, fake := newTailerHarness()
	subCtx, subCancel := context.WithCancel(context.Background())
	defer subCancel()
	sub := srv.changesBroker.Subscribe(subCtx)

	tailerCtx, tailerCancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.runChangeTailer(tailerCtx)
	}()
	defer func() {
		tailerCancel()
		<-done
	}()

	// Wait for the seed read so the bump that follows is unambiguously an advance.
	waitForInitRead(t, fake, time.Second)
	fake.cursor.Store(42)

	// Expect a notify within ~3× the tick interval (with margin for scheduler jitter).
	cursor, ok := drainOne(sub, 5*changeTailerInterval)
	if !ok {
		t.Fatalf("tailer did not notify within %v of cursor advance", 5*changeTailerInterval)
	}
	if cursor != 42 {
		t.Fatalf("got cursor %d, want 42", cursor)
	}
}

func TestTailerSilentWithoutWrites(t *testing.T) {
	srv, _ := newTailerHarness()
	subCtx, subCancel := context.WithCancel(context.Background())
	defer subCancel()
	sub := srv.changesBroker.Subscribe(subCtx)

	tailerCtx, tailerCancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.runChangeTailer(tailerCtx)
	}()
	defer func() {
		tailerCancel()
		<-done
	}()

	// Cursor stays at 0; no notify should fire within several tick windows.
	if _, ok := drainOne(sub, 4*changeTailerInterval); ok {
		t.Fatal("tailer sent a notify even though cursor never advanced")
	}
}

func TestTailerStopsOnContextCancel(t *testing.T) {
	srv, _ := newTailerHarness()

	tailerCtx, tailerCancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.runChangeTailer(tailerCtx)
	}()

	// Let the tailer run at least one tick so it's inside the select loop.
	time.Sleep(2 * changeTailerInterval)
	tailerCancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("tailer goroutine did not exit within 1s of context cancel")
	}
}

func TestTailerCoalescesNotifications(t *testing.T) {
	srv, fake := newTailerHarness()

	// Use a synchronous recorder of broker fan-outs so we can count exactly
	// how many Notify calls produced an observable delivery.
	subCtx, subCancel := context.WithCancel(context.Background())
	defer subCancel()
	sub := srv.changesBroker.Subscribe(subCtx)

	var mu sync.Mutex
	var received []int64
	recvDone := make(chan struct{})
	go func() {
		defer close(recvDone)
		for v := range sub {
			mu.Lock()
			received = append(received, v)
			mu.Unlock()
		}
	}()

	tailerCtx, tailerCancel := context.WithCancel(context.Background())
	tailerDone := make(chan struct{})
	go func() {
		defer close(tailerDone)
		srv.runChangeTailer(tailerCtx)
	}()

	// Wait for the seed read so the burst is unambiguously an advance.
	waitForInitRead(t, fake, time.Second)
	// Simulate a burst: many rows inserted between two ticks. The tailer
	// must observe the latest cursor on its next tick and notify exactly once
	// for the whole batch.
	fake.cursor.Store(10)

	// Wait long enough for at least one tick to observe the bump.
	time.Sleep(3 * changeTailerInterval)

	tailerCancel()
	<-tailerDone
	subCancel()
	<-recvDone

	mu.Lock()
	got := append([]int64(nil), received...)
	mu.Unlock()

	if len(got) < 1 {
		t.Fatalf("expected at least one notify after burst, got none")
	}
	// Every observed notify must carry the latest cursor — cursor is
	// monotonic and the tailer never sends stale values. Coalescing means
	// the tailer sent ≤ ⌈elapsed/interval⌉ notifies, NOT one per simulated
	// row write.
	for _, v := range got {
		if v != 10 {
			t.Fatalf("tailer notify carried cursor %d, want 10 (coalesced burst)", v)
		}
	}
	// Verify coalescing bound: ~3 ticks elapsed, so at most ~3 notifies.
	// In practice cursor only advanced once so exactly one notify is expected.
	if len(got) > 3 {
		t.Fatalf("tailer fired %d notifies for a single cursor advance; expected ≤ 1 (with slack ≤ 3 for ticker jitter)", len(got))
	}
}
