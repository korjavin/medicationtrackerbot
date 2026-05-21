package demotopup

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// fakeStore satisfies the *store.Store pointer requirement without
// constructing a real SQLite database. The runner only forwards the pointer
// to the TopUpFunc stub, which ignores it, so a sentinel address is enough
// for the contract Run honours: nil → bail out, non-nil → call TopUp.
func fakeStore() *store.Store { return &store.Store{} }

// TestRunBailsOutOnInvalidConfig verifies the guard arms: zero UserID,
// non-positive Interval, and nil Store all log a warning and return without
// scheduling a ticker.
func TestRunBailsOutOnInvalidConfig(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		cfg  Config
	}{
		{
			name: "zero user id",
			cfg:  Config{Store: fakeStore(), UserID: 0, Interval: time.Hour},
		},
		{
			name: "zero interval",
			cfg:  Config{Store: fakeStore(), UserID: 42, Interval: 0},
		},
		{
			name: "negative interval",
			cfg:  Config{Store: fakeStore(), UserID: 42, Interval: -1 * time.Second},
		},
		{
			name: "nil store",
			cfg:  Config{Store: nil, UserID: 42, Interval: time.Hour},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls int32
			tc.cfg.TopUp = func(ctx context.Context, s *store.Store, opts seeddemo.TopUpOptions) (*seeddemo.Summary, error) {
				atomic.AddInt32(&calls, 1)
				return &seeddemo.Summary{}, nil
			}

			done := make(chan struct{})
			go func() {
				Run(context.Background(), tc.cfg)
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatalf("Run did not return for invalid config %q", tc.name)
			}

			if got := atomic.LoadInt32(&calls); got != 0 {
				t.Errorf("expected zero TopUp calls for invalid config %q, got %d", tc.name, got)
			}
		})
	}
}

// TestRunFirstTickFiresImmediately asserts the loop calls TopUp once before
// the ticker even has a chance to fire. The contract is documented: a
// freshly-deployed demo must not have to wait one full interval for data.
func TestRunFirstTickFiresImmediately(t *testing.T) {
	t.Parallel()

	called := make(chan seeddemo.TopUpOptions, 1)
	stub := func(ctx context.Context, s *store.Store, opts seeddemo.TopUpOptions) (*seeddemo.Summary, error) {
		called <- opts
		return &seeddemo.Summary{HeartSamples: 5}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg := Config{
		Store:    fakeStore(),
		UserID:   42,
		Interval: time.Hour, // long enough that we won't see a second tick
		Seed:     7,
		Days:     30,
		TopUp:    stub,
		Now:      func() time.Time { return time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC) },
	}
	go Run(ctx, cfg)

	select {
	case opts := <-called:
		if opts.UserID != 42 {
			t.Errorf("opts.UserID = %d, want 42", opts.UserID)
		}
		if opts.Seed != 7 {
			t.Errorf("opts.Seed = %d, want 7", opts.Seed)
		}
		if opts.Days != 30 {
			t.Errorf("opts.Days = %d, want 30", opts.Days)
		}
		if !opts.Now.Equal(time.Date(2026, 5, 21, 12, 0, 0, 0, time.UTC)) {
			t.Errorf("opts.Now = %v, want 2026-05-21 12:00 UTC", opts.Now)
		}
	case <-time.After(time.Second):
		t.Fatal("first tick did not fire within 1s")
	}
}

// TestRunTicksAtInterval drives the loop with a very short interval and
// asserts multiple ticks fire before context cancel. We measure ticks via a
// channel so the test exits as soon as the threshold is reached rather than
// sleeping for a fixed wall-clock duration.
func TestRunTicksAtInterval(t *testing.T) {
	t.Parallel()

	ticks := make(chan struct{}, 8)
	stub := func(ctx context.Context, s *store.Store, opts seeddemo.TopUpOptions) (*seeddemo.Summary, error) {
		ticks <- struct{}{}
		return &seeddemo.Summary{}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go Run(ctx, Config{
		Store:    fakeStore(),
		UserID:   42,
		Interval: 10 * time.Millisecond,
		TopUp:    stub,
	})

	// Wait for the immediate first tick plus at least two more ticks driven
	// by the ticker. 250ms is generous (~25 intervals) so a CI scheduler
	// jitter spike doesn't flake the assertion.
	deadline := time.After(250 * time.Millisecond)
	got := 0
	for got < 3 {
		select {
		case <-ticks:
			got++
		case <-deadline:
			t.Fatalf("only %d ticks fired within 250ms (want ≥3)", got)
		}
	}
}

// TestRunExitsOnContextCancel asserts the goroutine returns after the parent
// context is cancelled, even if the ticker would otherwise keep firing.
func TestRunExitsOnContextCancel(t *testing.T) {
	t.Parallel()

	var calls int32
	stub := func(ctx context.Context, s *store.Store, opts seeddemo.TopUpOptions) (*seeddemo.Summary, error) {
		atomic.AddInt32(&calls, 1)
		return &seeddemo.Summary{}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		Run(ctx, Config{
			Store:    fakeStore(),
			UserID:   42,
			Interval: 5 * time.Millisecond,
			TopUp:    stub,
		})
		close(done)
	}()

	// Let at least the immediate tick + one ticker tick fire.
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Run did not return within 500ms after context cancel")
	}

	// Snapshot the call count, then make sure no further ticks happen after
	// cancel. We can't directly check "the loop is gone" but if calls
	// doesn't grow after another wait window, the ticker is dead.
	snapshot := atomic.LoadInt32(&calls)
	time.Sleep(40 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != snapshot {
		t.Errorf("TopUp called %d more times after cancel (snapshot %d → final %d)", got-snapshot, snapshot, got)
	}
}

// TestRunSwallowsErrors guarantees a TopUp error doesn't crash the loop: the
// runner logs and keeps ticking. We verify subsequent ticks still fire after
// the stub returns an error.
func TestRunSwallowsErrors(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var calls int
	stub := func(ctx context.Context, s *store.Store, opts seeddemo.TopUpOptions) (*seeddemo.Summary, error) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			return nil, errors.New("synthetic top-up failure")
		}
		return &seeddemo.Summary{}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go Run(ctx, Config{
		Store:    fakeStore(),
		UserID:   42,
		Interval: 5 * time.Millisecond,
		TopUp:    stub,
	})

	// Wait until we've observed at least 3 calls — call 1 errors, calls 2+
	// prove the loop survived.
	deadline := time.After(500 * time.Millisecond)
	for {
		mu.Lock()
		n := calls
		mu.Unlock()
		if n >= 3 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("only %d calls fired within 500ms; loop did not survive error", n)
		case <-time.After(5 * time.Millisecond):
		}
	}
}
