package cloudserver

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// inboxEventsTestServer mirrors inboxTestServer but wires a broker into the
// InboxAPI, so GET /api/inbox/events serves a live stream.
func inboxEventsTestServer(t *testing.T) (http.Handler, string, string, *http.Cookie, *InboxBroker) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	inboxAPI := NewInboxAPI(store, "test-session-secret-at-least-32-bytes-long")
	broker := NewInboxBroker()
	inboxAPI.SetEventBroker(broker)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	inboxAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)
	return h, host, account.ID, session, broker
}

// TestInboxBroker_FanOut pins the broker contract: every subscriber of the
// appended account wakes, other accounts hear nothing, Notify reports the
// count, and an unsubscribed tab stops waking.
func TestInboxBroker_FanOut(t *testing.T) {
	broker := NewInboxBroker()

	chA1, unsubA1, ok := broker.Subscribe("acct-a")
	if !ok {
		t.Fatal("Subscribe acct-a/1 rejected")
	}
	chA2, unsubA2, ok := broker.Subscribe("acct-a")
	if !ok {
		t.Fatal("Subscribe acct-a/2 rejected")
	}
	chB, _, ok := broker.Subscribe("acct-b")
	if !ok {
		t.Fatal("Subscribe acct-b rejected")
	}

	if n := broker.Notify("acct-a"); n != 2 {
		t.Fatalf("Notify(acct-a) = %d, want 2", n)
	}
	for i, ch := range []<-chan struct{}{chA1.Inbox, chA2.Inbox} {
		select {
		case <-ch:
		default:
			t.Fatalf("subscriber acct-a/%d got no wake", i+1)
		}
	}
	select {
	case <-chB.Inbox:
		t.Fatal("acct-b subscriber woken by acct-a append")
	default:
	}

	if n := broker.Notify("nobody"); n != 0 {
		t.Fatalf("Notify(nobody) = %d, want 0", n)
	}

	unsubA1()
	unsubA2()
	unsubA1() // idempotent
	if n := broker.Notify("acct-a"); n != 0 {
		t.Fatalf("Notify(acct-a) after unsubscribe = %d, want 0", n)
	}
	if got := broker.SubscriberCount("acct-a"); got != 0 {
		t.Fatalf("SubscriberCount(acct-a) = %d, want 0", got)
	}
}

// TestInboxBroker_BoundedPerAccount pins the fan-out cap: the 33rd concurrent
// stream for one account is rejected (the tab falls back to polling), other
// accounts are unaffected, and a freed slot re-admits.
func TestInboxBroker_BoundedPerAccount(t *testing.T) {
	broker := NewInboxBroker()
	var unsubs []func()
	for i := 0; i < maxInboxEventSubscribersPerAccount; i++ {
		_, unsub, ok := broker.Subscribe("crowded")
		if !ok {
			t.Fatalf("Subscribe %d/%d rejected", i+1, maxInboxEventSubscribersPerAccount)
		}
		unsubs = append(unsubs, unsub)
	}
	if _, _, ok := broker.Subscribe("crowded"); ok {
		t.Fatalf("Subscribe past the %d cap accepted", maxInboxEventSubscribersPerAccount)
	}
	if _, _, ok := broker.Subscribe("other"); !ok {
		t.Fatal("Subscribe for another account rejected by a crowded neighbor")
	}
	unsubs[0]()
	if _, _, ok := broker.Subscribe("crowded"); !ok {
		t.Fatal("Subscribe rejected after a slot freed")
	}
}

// TestInboxBroker_NotifyNeverBlocks pins the coalescing rule: a tab that never
// reads still never stalls an append — the second wake folds into the one
// pending slot, and the tab drains both with one GET.
func TestInboxBroker_NotifyNeverBlocks(t *testing.T) {
	broker := NewInboxBroker()
	ch, _, ok := broker.Subscribe("slow-tab")
	if !ok {
		t.Fatal("Subscribe rejected")
	}
	done := make(chan int, 2)
	go func() { done <- broker.Notify("slow-tab") }()
	go func() { done <- broker.Notify("slow-tab") }()
	timeout := time.After(5 * time.Second)
	for i := 0; i < 2; i++ {
		select {
		case n := <-done:
			if n != 1 {
				t.Fatalf("Notify = %d, want 1", n)
			}
		case <-timeout:
			t.Fatal("Notify blocked on an unread subscriber")
		}
	}
	<-ch.Inbox // exactly one pending wake, however many appends landed
	select {
	case <-ch.Inbox:
		t.Fatal("second wake queued instead of coalescing")
	default:
	}
}

// TestInboxBroker_KindsCoalesceIndependently pins bd med-eas.9: inbox and sync
// wakes share one stream but not one slot — a pending inbox wake never
// swallows a sync wake (or vice versa), and each kind still coalesces.
func TestInboxBroker_KindsCoalesceIndependently(t *testing.T) {
	broker := NewInboxBroker()
	sub, _, ok := broker.Subscribe("acct")
	if !ok {
		t.Fatal("Subscribe rejected")
	}
	broker.Notify("acct")
	if n := broker.NotifySync("acct"); n != 1 {
		t.Fatalf("NotifySync = %d, want 1", n)
	}
	broker.Notify("acct")
	broker.NotifySync("acct")
	for name, ch := range map[string]<-chan struct{}{"inbox": sub.Inbox, "sync": sub.Sync} {
		select {
		case <-ch:
		default:
			t.Fatalf("%s wake lost to the other kind", name)
		}
		select {
		case <-ch:
			t.Fatalf("%s wake queued twice instead of coalescing", name)
		default:
		}
	}
}

// TestInboxEvents_RequiresAuth pins that the stream is session-authed like
// every other account-scoped route: no cookie, no stream.
func TestInboxEvents_RequiresAuth(t *testing.T) {
	h, host, _, _, _ := inboxEventsTestServer(t)
	r := httptest.NewRequest(http.MethodGet, "/api/inbox/events", nil)
	r.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/inbox/events without a session = %d, want 401", rec.Code)
	}
}

// TestInboxEvents_DeliversContentFreeWake pins the wire shape: a session-authed
// stream emits a content-free `inbox-ready` (no `id:` field, no payload) on
// Notify, and ends cleanly when the tab disconnects.
func TestInboxEvents_DeliversContentFreeWake(t *testing.T) {
	h, host, accountID, session, broker := inboxEventsTestServer(t)

	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodGet, "/api/inbox/events", nil)
	r.Host = host
	r.AddCookie(session)
	r = r.WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(rec, r)
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for broker.SubscriberCount(accountID) == 0 {
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("stream never subscribed")
		}
		time.Sleep(5 * time.Millisecond)
	}

	broker.Notify(accountID)
	broker.Notify(accountID) // coalesces or double-delivers; either way at least one wake
	cancel()
	<-done

	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "event: inbox-ready") {
		t.Errorf("stream body has no inbox-ready event: %q", body)
	}

	// Zero-knowledge: the wake carries no event id and no payload — the tab
	// learns nothing here it couldn't learn from an empty poll.
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "id:") {
			t.Errorf("stream carries an event id line: %q (full body %q)", line, body)
		}
		if strings.HasPrefix(line, "data:") && strings.TrimSpace(strings.TrimPrefix(line, "data:")) != "" {
			t.Errorf("stream carries a data payload: %q (full body %q)", line, body)
		}
	}
	if got := broker.SubscriberCount(accountID); got != 0 {
		t.Errorf("SubscriberCount after disconnect = %d, want 0 (leaked subscription)", got)
	}
}

// TestInboxEvents_OverCapIsAPollFallback pins the 429: a tab past the per-account
// cap is rejected (and keeps polling) instead of silently missing wakes.
func TestInboxEvents_OverCapIsAPollFallback(t *testing.T) {
	h, host, accountID, session, broker := inboxEventsTestServer(t)
	for i := 0; i < maxInboxEventSubscribersPerAccount; i++ {
		if _, _, ok := broker.Subscribe(accountID); !ok {
			t.Fatalf("Subscribe %d rejected", i+1)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/api/inbox/events", nil)
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("GET /api/inbox/events over the cap = %d, want 429", rec.Code)
	}
}

// TestRelay_WakeInbox_NotifiesBrokerOnEveryAppend pins the med-j0tc split: the
// push half stays coalesced (one push per burst) while the SSE half fires on
// EVERY append — a second message inside the cooldown still wakes open tabs
// instantly.
func TestRelay_WakeInbox_NotifiesBrokerOnEveryAppend(t *testing.T) {
	store := setupStore(t)
	account, _ := setupInvite(t, store)
	ctx := context.Background()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/"+account.ID, "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	sender := &fakeSender{}
	relay := NewRelay(store, sender, nil, 0)
	relay.after = func(time.Duration, func()) {} // discard trailing timers; the trailing suite fires them deliberately
	broker := NewInboxBroker()
	relay.SetEventBroker(broker)
	ch, _, ok := broker.Subscribe(account.ID)
	if !ok {
		t.Fatal("Subscribe rejected")
	}

	relay.WakeInbox(ctx, account.ID)
	select {
	case <-ch.Inbox:
	default:
		t.Fatal("first append produced no SSE wake")
	}
	relay.WakeInbox(ctx, account.ID) // inside the push cooldown
	select {
	case <-ch.Inbox:
	default:
		t.Fatal("second append inside the push cooldown produced no SSE wake")
	}

	if len(sender.sent) != 1 {
		t.Fatalf("push sends = %d, want 1 (SSE must not un-coalesce push)", len(sender.sent))
	}
}

// fakeClock is the injected clock behind the trailing-wake tests: now is
// whatever the test last set, and after records timers for manual firing.
type fakeClock struct {
	now    time.Time
	delays []time.Duration
	funcs  []func()
}

func (f *fakeClock) Now() time.Time { return f.now }
func (f *fakeClock) After(d time.Duration, fn func()) {
	f.delays = append(f.delays, d)
	f.funcs = append(f.funcs, fn)
}

func trailingTestRelay(t *testing.T) (*Relay, *fakeSender, *fakeClock, string) {
	t.Helper()
	store := setupStore(t)
	account, _ := setupInvite(t, store)
	ctx := context.Background()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/"+account.ID, "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}
	sender := &fakeSender{}
	relay := NewRelay(store, sender, nil, 0)
	clock := &fakeClock{now: time.Now().UTC()}
	relay.now = clock.Now
	relay.after = clock.After
	return relay, sender, clock, account.ID
}

// TestRelay_TrailingWake_FiresAtBoundary pins the missed-later-event fix: an
// append inside the cooldown schedules ONE trailing wake at the boundary, and
// firing it pushes (the first wake's drain may already have run).
func TestRelay_TrailingWake_FiresAtBoundary(t *testing.T) {
	relay, sender, clock, accountID := trailingTestRelay(t)
	ctx := context.Background()

	relay.WakeInbox(ctx, accountID) // t0: immediate push
	if len(sender.sent) != 1 {
		t.Fatalf("sends after first wake = %d, want 1", len(sender.sent))
	}

	clock.now = clock.now.Add(3 * time.Second)
	relay.WakeInbox(ctx, accountID) // suppressed by the cooldown...
	relay.WakeInbox(ctx, accountID) // ...and so is the rest of the burst
	if len(sender.sent) != 1 {
		t.Fatalf("sends inside the cooldown = %d, want 1 (still coalesced)", len(sender.sent))
	}
	if len(clock.delays) != 1 {
		t.Fatalf("trailing timers scheduled = %d, want exactly 1 for the burst", len(clock.delays))
	}
	if want := 7 * time.Second; clock.delays[0] != want {
		t.Fatalf("trailing delay = %v, want %v (the cooldown remainder)", clock.delays[0], want)
	}

	clock.now = clock.now.Add(7 * time.Second) // t0+10s: the boundary
	clock.funcs[0]()
	if len(sender.sent) != 2 {
		t.Fatalf("sends after the trailing wake fired = %d, want 2", len(sender.sent))
	}
	var payload struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(sender.sent[1].ct, &payload); err != nil {
		t.Fatalf("unmarshal trailing payload: %v", err)
	}
	if payload.Kind != "inbox-wake" {
		t.Fatalf("trailing kind = %q, want inbox-wake", payload.Kind)
	}
}

// TestRelay_TrailingWake_NoneWhenWindowLapsed pins that a wake past the window
// goes out immediately and schedules no trailing timer.
func TestRelay_TrailingWake_NoneWhenWindowLapsed(t *testing.T) {
	relay, sender, clock, accountID := trailingTestRelay(t)
	ctx := context.Background()

	relay.WakeInbox(ctx, accountID)
	clock.now = clock.now.Add(11 * time.Second)
	relay.WakeInbox(ctx, accountID)

	if len(sender.sent) != 2 {
		t.Fatalf("sends = %d, want 2 (both immediate)", len(sender.sent))
	}
	if len(clock.delays) != 0 {
		t.Fatalf("trailing timers scheduled = %d, want 0", len(clock.delays))
	}
}

// TestRelay_TrailingWake_RearmsAfterFiring pins that the trailing slot is
// single-flight, not single-use: after a trailing wake fires, a new suppressed
// append schedules the next one.
func TestRelay_TrailingWake_RearmsAfterFiring(t *testing.T) {
	relay, sender, clock, accountID := trailingTestRelay(t)
	ctx := context.Background()

	relay.WakeInbox(ctx, accountID) // t0: immediate
	clock.now = clock.now.Add(time.Second)
	relay.WakeInbox(ctx, accountID) // suppressed -> trailing #1
	clock.now = clock.now.Add(9 * time.Second)
	clock.funcs[0]() // boundary: trailing #1 fires (claims the lapsed window)
	if len(sender.sent) != 2 {
		t.Fatalf("sends after first trailing = %d, want 2", len(sender.sent))
	}

	clock.now = clock.now.Add(time.Second)
	relay.WakeInbox(ctx, accountID) // suppressed by trailing #1's own window
	if len(clock.delays) != 2 {
		t.Fatalf("trailing timers scheduled = %d, want 2 (re-armed)", len(clock.delays))
	}
	if len(sender.sent) != 2 {
		t.Fatalf("sends = %d, want 2 (second burst still coalesced)", len(sender.sent))
	}
}

// TestInboxEvents_SurvivesServerWriteTimeout is the regression test for the
// send-back MAJOR: cmd/cloud's http.Server sets WriteTimeout 45s, which kills
// a long-lived stream on its first write past the deadline. ServeInboxEvents
// clears the write deadline for this route; here a real httptest server with a
// 200ms WriteTimeout proves a wake written after the timeout still arrives.
// (The heartbeat exercises the same write path on a 25s cadence — too slow to
// wait out here — so the test wakes instead.)
func TestInboxEvents_SurvivesServerWriteTimeout(t *testing.T) {
	h, host, accountID, session, broker := inboxEventsTestServer(t)
	srv := httptest.NewUnstartedServer(h)
	srv.Config.WriteTimeout = 200 * time.Millisecond
	srv.Start()
	defer srv.Close()

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/inbox/events", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Host = host // account subdomain; the URL host stays the test server
	req.AddCookie(session)
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatalf("GET /api/inbox/events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/inbox/events = %d, want 200", resp.StatusCode)
	}

	lines := make(chan string, 64)
	readErr := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(resp.Body)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				readErr <- err
				return
			}
			lines <- line
		}
	}()
	nextLine := func(want string) string {
		t.Helper()
		select {
		case line := <-lines:
			return line
		case err := <-readErr:
			t.Fatalf("stream ended waiting for %q: %v", want, err)
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for %q", want)
		}
		return ""
	}

	if line := nextLine("retry"); !strings.HasPrefix(line, "retry:") {
		t.Fatalf("first stream line = %q, want the retry hint", line)
	}
	if line := nextLine("blank"); line != "\n" {
		t.Fatalf("second stream line = %q, want a blank line", line)
	}

	// Sit idle past the server's write timeout, then wake: without the
	// deadline clear this write fails, net/http cancels the request, and the
	// client sees EOF instead of the event below.
	time.Sleep(400 * time.Millisecond)
	if n := broker.Notify(accountID); n != 1 {
		t.Fatalf("Notify = %d, want 1 (stream gone before the wake)", n)
	}
	if line := nextLine("event"); line != "event: inbox-ready\n" {
		t.Fatalf("wake line = %q, want the inbox-ready event", line)
	}
	if line := nextLine("data"); line != "data:\n" {
		t.Fatalf("data line = %q, want an empty data line", line)
	}
	if line := nextLine("terminator"); line != "\n" {
		t.Fatalf("terminator line = %q, want a blank line", line)
	}

	// bd med-eas.9: the same stream carries the content-free sync wake.
	if n := broker.NotifySync(accountID); n != 1 {
		t.Fatalf("NotifySync = %d, want 1", n)
	}
	for _, want := range []string{"event: sync-ready\n", "data:\n", "\n"} {
		if line := nextLine(want); line != want {
			t.Fatalf("sync wake line = %q, want %q", line, want)
		}
	}
}

// TestInboxBroker_CloseEndsStreams pins the shutdown path: Close returns every
// open handler (so http.Server.Shutdown never waits out its grace on a held
// stream), and afterwards Subscribe is rejected and Notify is a silent no-op.
func TestInboxBroker_CloseEndsStreams(t *testing.T) {
	h, host, accountID, session, broker := inboxEventsTestServer(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest(http.MethodGet, "/api/inbox/events", nil)
	r.Host = host
	r.AddCookie(session)
	r = r.WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(rec, r)
		close(done)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for broker.SubscriberCount(accountID) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("stream never subscribed")
		}
		time.Sleep(5 * time.Millisecond)
	}

	broker.Close()
	broker.Close() // idempotent
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stream handler did not return after broker Close")
	}

	if _, _, ok := broker.Subscribe(accountID); ok {
		t.Error("Subscribe accepted after Close")
	}
	if n := broker.Notify(accountID); n != 0 {
		t.Errorf("Notify after Close = %d, want 0", n)
	}
}
