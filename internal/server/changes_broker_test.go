package server

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestChangeBroker_SingleSubscriberReceivesNotify(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := b.Subscribe(ctx)
	b.Notify(42)

	select {
	case v, ok := <-ch:
		if !ok {
			t.Fatalf("channel closed unexpectedly")
		}
		if v != 42 {
			t.Fatalf("got cursor %d, want 42", v)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("subscriber did not receive notify within 200ms")
	}
}

func TestChangeBroker_MultiSubscriberFanOut(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const n = 5
	chans := make([]<-chan int64, n)
	for i := 0; i < n; i++ {
		chans[i] = b.Subscribe(ctx)
	}

	b.Notify(7)

	for i, ch := range chans {
		select {
		case v, ok := <-ch:
			if !ok {
				t.Fatalf("subscriber %d channel closed unexpectedly", i)
			}
			if v != 7 {
				t.Fatalf("subscriber %d got cursor %d, want 7", i, v)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("subscriber %d did not receive notify within 200ms", i)
		}
	}
}

func TestChangeBroker_DropOnFullChannelDoesNotBlock(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Subscribe once but never drain — the size-1 buffer fills on the first
	// Notify and subsequent Notifies must drop instead of blocking.
	_ = b.Subscribe(ctx)

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			b.Notify(int64(i))
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("Notify blocked on full subscriber buffer")
	}
}

func TestChangeBroker_UnsubscribeRemovesFromSet(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	chRecv := b.Subscribe(ctx)
	// Recover the chan int64 (write-side) handle: there is no public accessor,
	// so we exercise the same code path that the ctx-cancel goroutine uses.
	cancel()

	// After cancel, the goroutine should call Unsubscribe → channel closed.
	select {
	case _, ok := <-chRecv:
		if ok {
			// Channel may carry one in-flight value before close; drain and try again.
			select {
			case _, ok := <-chRecv:
				if ok {
					t.Fatalf("channel not closed after ctx cancel")
				}
			case <-time.After(200 * time.Millisecond):
				t.Fatalf("channel not closed after ctx cancel")
			}
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("channel not closed after ctx cancel")
	}

	// Notify after unsubscribe must not panic and must not deliver to the closed chan.
	b.Notify(99)
}

func TestChangeBroker_CtxCancelAutoUnsubscribes(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())

	ch := b.Subscribe(ctx)
	cancel()

	// Wait for the goroutine to call Unsubscribe and close the channel.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case _, ok := <-ch:
			if !ok {
				return // channel closed → unsubscribed
			}
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	t.Fatalf("channel not closed within 500ms of ctx cancel")
}

func TestChangeBroker_CloseAllClosesAllChannels(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const n = 4
	chans := make([]<-chan int64, n)
	for i := 0; i < n; i++ {
		chans[i] = b.Subscribe(ctx)
	}

	b.CloseAll()

	for i, ch := range chans {
		select {
		case _, ok := <-ch:
			if ok {
				t.Fatalf("subscriber %d channel not closed after CloseAll", i)
			}
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("subscriber %d not closed after CloseAll within 200ms", i)
		}
	}
}

func TestChangeBroker_SubscribeAfterCloseAllReturnsClosedChannel(t *testing.T) {
	b := NewChangeBroker()
	b.CloseAll()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := b.Subscribe(ctx)
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatalf("channel from post-CloseAll Subscribe should be closed")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatalf("post-CloseAll Subscribe did not return a closed channel")
	}
}

func TestChangeBroker_CloseAllIsIdempotent(t *testing.T) {
	b := NewChangeBroker()
	b.CloseAll()
	// Must not panic on second call.
	b.CloseAll()
}

func TestChangeBroker_ConcurrentSubscribeNotify(t *testing.T) {
	b := NewChangeBroker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ch := b.Subscribe(ctx)
			// Receive at least one value, then return — broker must not deadlock.
			select {
			case <-ch:
			case <-time.After(500 * time.Millisecond):
			}
		}()
	}

	// Hammer Notify concurrently with the Subscribes.
	for i := 0; i < 100; i++ {
		go b.Notify(int64(i))
	}

	wg.Wait()
}
