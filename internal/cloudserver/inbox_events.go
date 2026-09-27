package cloudserver

import (
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

const (
	// maxInboxEventSubscribersPerAccount bounds the fan-out of one Notify: at
	// most this many open tabs per account hold a stream. A stream past the cap
	// is rejected with 429 and the tab falls back to the 5s poll, so a tab farm
	// can neither OOM the broker nor turn one append into an unbounded write
	// burst.
	maxInboxEventSubscribersPerAccount = 32
	// inboxEventsHeartbeatInterval is the SSE comment cadence that keeps
	// intermediaries from idle-timing-out the stream. It carries no data.
	inboxEventsHeartbeatInterval = 25 * time.Second
	// inboxEventsRetryMillis is the EventSource reconnect hint. The client
	// reconnects manually with its own backoff (inbox.js), so this only governs
	// a native reconnect if that ever changes.
	inboxEventsRetryMillis = 3000
)

// InboxBroker is the account-scoped fan-out behind GET /api/inbox/events (bd
// med-j0tc): after sealAndQueue's durable append, WakeInbox calls Notify and
// every open unlocked tab holding a stream drains immediately, without waiting
// on the 5s poll (throttled to ~1/min in a hidden tab) or a Web Push wake
// (needs permission+subscription and an external delivery hop).
//
// The wake is content-free — Notify carries no event id, no ciphertext, no
// plaintext — so the zero-knowledge posture is unchanged: the tab still fetches
// ciphertext over authenticated GET /api/inbox and decrypts locally.
//
// ponytail: single-process in-memory, like Relay's wake-cooldown map. A
// multi-replica deploy would fan out only to the tabs pinned to the replica
// that sealed the event; the 5s poll still covers the rest, so the ceiling is
// latency, not loss. A shared pub/sub (or sticky routing) if replicas arrive.
type InboxBroker struct {
	mu   sync.Mutex
	subs map[string]map[*inboxSubscription]struct{}
}

// inboxSubscription is one open stream. ch is buffered size 1 and Notify never
// blocks on it: a pending wake already covers a newer one, since a drain is
// per-account, not per-message.
type inboxSubscription struct {
	ch chan struct{}
}

// NewInboxBroker builds an empty broker. cmd/cloud wires one instance into both
// the InboxAPI (which serves the streams) and the Relay (which notifies them).
func NewInboxBroker() *InboxBroker {
	return &InboxBroker{subs: make(map[string]map[*inboxSubscription]struct{})}
}

// Subscribe registers one stream for accountID. ok is false when the account
// already holds maxInboxEventSubscribersPerAccount streams — the caller must
// reject the stream (the tab falls back to polling). The returned unsubscribe
// is idempotent and must be called when the stream ends.
func (b *InboxBroker) Subscribe(accountID string) (ch <-chan struct{}, unsubscribe func(), ok bool) {
	sub := &inboxSubscription{ch: make(chan struct{}, 1)}
	b.mu.Lock()
	set := b.subs[accountID]
	if len(set) >= maxInboxEventSubscribersPerAccount {
		b.mu.Unlock()
		return nil, nil, false
	}
	if set == nil {
		set = make(map[*inboxSubscription]struct{})
		b.subs[accountID] = set
	}
	set[sub] = struct{}{}
	b.mu.Unlock()

	var once sync.Once
	unsubscribe = func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			if set := b.subs[accountID]; set != nil {
				delete(set, sub)
				if len(set) == 0 {
					delete(b.subs, accountID)
				}
			}
		})
	}
	return sub.ch, unsubscribe, true
}

// Notify wakes every stream subscribed for accountID. It never blocks — a
// slow reader coalesces into its one pending slot — and returns the subscriber
// count so the caller can log the fan-out.
func (b *InboxBroker) Notify(accountID string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for sub := range b.subs[accountID] {
		select {
		case sub.ch <- struct{}{}:
		default: // a wake is already pending; one drain covers both
		}
		n++
	}
	return n
}

// SubscriberCount reports how many streams accountID holds. Tests (and only
// tests) use it to wait for a subscribe before notifying.
func (b *InboxBroker) SubscriberCount(accountID string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs[accountID])
}

// ServeInboxEvents is the authenticated GET /api/inbox/events stream: one per
// open unlocked tab. Each durable inbox append is fanned out here as a
// content-free `inbox-ready` event — no `id:` field (a wake is a nudge, not
// news; there is nothing to resume) and an empty data line. Session auth rides
// the ordinary cookie (RequireSession); EventSource sends it same-origin, and
// the stream inherits the origin's connect-src 'self' — no CSP change.
//
// On disconnect (tab closed, navigated away, logged out) the request context
// ends and the subscription is dropped.
func (a *InboxAPI) ServeInboxEvents(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if a.broker == nil {
		// Unwired (tests that build InboxAPI without a broker): the tab falls
		// back to the 5s poll, same as when the stream is down.
		http.Error(w, "inbox events unavailable", http.StatusServiceUnavailable)
		return
	}
	ch, unsubscribe, ok := a.broker.Subscribe(session.AccountID)
	if !ok {
		slog.Warn("inbox events: subscriber cap reached", "accountID", session.AccountID)
		http.Error(w, "too many streams", http.StatusTooManyRequests)
		return
	}
	defer unsubscribe()

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // don't let a buffering proxy hold the stream
	fmt.Fprintf(w, "retry: %d\n\n", inboxEventsRetryMillis)
	flusher.Flush()

	heartbeat := time.NewTicker(inboxEventsHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			fmt.Fprint(w, "event: inbox-ready\ndata:\n\n")
			flusher.Flush()
		case <-heartbeat.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}
