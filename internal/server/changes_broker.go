package server

import (
	"context"
	"sync"
)

// ChangeBroker is a process-wide pub/sub for change-events cursor updates.
//
// It lets the SSE /api/changes/stream handler receive immediate wake-ups when
// any write happens (via notifyOnWriteMiddleware) instead of polling the
// change_events table every 5 seconds.
//
// Fan-out semantics: Notify is non-blocking — if a subscriber's buffered
// channel is full, the update is dropped. This is safe because the cursor is
// monotonic and each handler reconciles via ListChangedTagsSince(lastCursor)
// on every received wake, so a missed wake just means the next one carries
// the missed work too.
type ChangeBroker struct {
	mu     sync.RWMutex
	subs   map[chan int64]struct{}
	closed bool
}

// NewChangeBroker returns a ready-to-use broker.
func NewChangeBroker() *ChangeBroker {
	return &ChangeBroker{subs: make(map[chan int64]struct{})}
}

// Subscribe registers a new subscriber and returns its receive channel.
// The channel is buffered (size 1) so a single missed-while-busy notify is
// always retained. The subscription is automatically removed when ctx is
// cancelled. The returned channel is closed when CloseAll runs.
func (b *ChangeBroker) Subscribe(ctx context.Context) <-chan int64 {
	ch := make(chan int64, 1)
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		close(ch)
		return ch
	}
	b.subs[ch] = struct{}{}
	b.mu.Unlock()

	go func() {
		<-ctx.Done()
		b.Unsubscribe(ch)
	}()

	return ch
}

// Unsubscribe removes ch from the subscriber set and closes it.
// Safe to call multiple times — subsequent calls are no-ops.
func (b *ChangeBroker) Unsubscribe(ch chan int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.subs[ch]; !ok {
		return
	}
	delete(b.subs, ch)
	close(ch)
}

// Notify fans out cursor to every subscriber without blocking.
// A subscriber whose buffer is full silently drops this update.
func (b *ChangeBroker) Notify(cursor int64) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs {
		select {
		case ch <- cursor:
		default:
		}
	}
}

// CloseAll closes every subscriber channel and prevents new subscriptions.
// Used by graceful shutdown so in-flight stream handlers exit cleanly before
// the listener is torn down.
func (b *ChangeBroker) CloseAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for ch := range b.subs {
		delete(b.subs, ch)
		close(ch)
	}
}
