package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

type sentPush struct {
	endpoint string
	ct       []byte
	keys     cloudstore.AccountVAPIDKeys
}

// fakeSender never touches the network: it records every send and reports a
// canned status per endpoint, so the relay contract test controls exactly
// which subscriptions look "gone".
type fakeSender struct {
	sent    []sentPush
	goneFor map[string]bool
}

func (f *fakeSender) Send(ctx context.Context, sub cloudstore.PushSubscription, keys cloudstore.AccountVAPIDKeys, ct []byte) (int, error) {
	f.sent = append(f.sent, sentPush{endpoint: sub.Endpoint, ct: ct, keys: keys})
	if f.goneFor[sub.Endpoint] {
		return http.StatusGone, nil
	}
	return http.StatusCreated, nil
}

func putSchedule(t *testing.T, h http.Handler, host string, session *http.Cookie, req putScheduleRequest) {
	t.Helper()
	body, _ := json.Marshal(req)
	r := httptest.NewRequest(http.MethodPut, "/api/push/schedule", bytes.NewReader(body))
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("PUT /api/push/schedule status = %d, body %q", rec.Code, rec.Body.String())
	}
}

// TestRelay_DueSelection_ReplaceAll_DisablesGone guards the relay contract:
// only due-and-only-due entries fire, replace-all drops old unsent future
// entries but never already-sent ones, and a 410-reporting endpoint gets
// disabled.
func TestRelay_DueSelection_ReplaceAll_DisablesGone(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)

	ctx := context.Background()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/ok", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/gone", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(-time.Minute).Unix(), CT: []byte("due-ct")},
		{FireAtUnix: time.Now().Add(24 * time.Hour).Unix(), CT: []byte("future-ct")},
	}})

	sender := &fakeSender{goneFor: map[string]bool{"https://push.example/gone": true}}
	relay := NewRelay(store, sender, nil, 0)
	relay.Tick(ctx)

	if len(sender.sent) != 2 {
		t.Fatalf("expected 2 sends (1 due entry x 2 subscriptions), got %d: %+v", len(sender.sent), sender.sent)
	}
	for _, s := range sender.sent {
		if string(s.ct) != "due-ct" {
			t.Errorf("sent ct = %q, want %q — future entry must not fire yet", s.ct, "due-ct")
		}
	}

	subs, err := store.List(ctx, account.ID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(subs) != 1 || subs[0].Endpoint != "https://push.example/ok" {
		t.Fatalf("expected only the healthy subscription to remain enabled, got %+v", subs)
	}

	// Replace-all: the already-sent "due-ct" entry must survive (relay never
	// re-sends it); the still-unsent "future-ct" entry must be dropped.
	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(-time.Minute).Unix(), CT: []byte("second-due-ct")},
	}})

	sender2 := &fakeSender{goneFor: map[string]bool{}}
	relay2 := NewRelay(store, sender2, nil, 0)
	relay2.Tick(ctx)

	if len(sender2.sent) != 1 || string(sender2.sent[0].ct) != "second-due-ct" {
		t.Fatalf("expected only the new due entry to fire (old future entry dropped by replace-all), got %+v", sender2.sent)
	}
}

// TestRelay_StaleSyncSweep guards Task 7's dry-queue safety net: an account
// whose queue is about to run dry gets warned, and a second sweep within the
// cooldown doesn't re-warn it.
//
// The account here is synced RIGHT NOW on purpose (bd med-2lx). The sweep used
// to additionally require last_sync_unix <= now-24h, which every inbox drain
// pushed forward — so an account tapping Telegram Confirm buttons daily looked
// permanently fresh while its reminder horizon rotted. Horizon exhaustion is the
// signal; user absence is not.
func TestRelay_StaleSyncSweep(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)

	ctx := context.Background()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/ok", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	// Queue's only entry fires soon (within the warn horizon).
	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(time.Hour).Unix(), CT: []byte("soon-ct")},
	}})

	// Freshly synced, on purpose — see the note above.
	if _, err := store.ListOps(ctx, account.ID, 0, 100, time.Now().UTC()); err != nil {
		t.Fatalf("ListOps (touch sync): %v", err)
	}

	sender := &fakeSender{goneFor: map[string]bool{}}
	relay := NewRelay(store, sender, nil, 120*time.Hour)
	relay.StaleSyncSweep(ctx)

	if len(sender.sent) != 1 {
		t.Fatalf("expected 1 warning send, got %d: %+v", len(sender.sent), sender.sent)
	}
	var payload struct {
		Kind  string `json:"kind"`
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if err := json.Unmarshal(sender.sent[0].ct, &payload); err != nil {
		t.Fatalf("unmarshal warning payload: %v", err)
	}
	if payload.Kind != "server-warning" || payload.Body == "" {
		t.Fatalf("unexpected warning payload: %+v", payload)
	}

	// A second sweep right away must not re-warn within the cooldown.
	sender2 := &fakeSender{goneFor: map[string]bool{}}
	relay2 := NewRelay(store, sender2, nil, 120*time.Hour)
	relay2.StaleSyncSweep(ctx)
	if len(sender2.sent) != 0 {
		t.Fatalf("expected no re-warn within cooldown, got %+v", sender2.sent)
	}
}

// TestRelay_StaleSyncSweep_DryQueueVsNeverArmed pins the med-2lx fix at the
// sweep level, on the two states the old query got exactly backwards.
//
// An account whose queue has FULLY drained (every row sent, none pending) is the
// production failure — reminders have already stopped — and the old INNER JOIN
// over unsent rows made it literally unreachable: no unsent rows, no join row,
// no warning, ever. It must now be warned.
//
// An account that never armed reminders has the same empty queue, and must NOT
// be warned, or the fix trades a silent failure for a daily nag to everyone who
// never asked for reminders.
func TestRelay_StaleSyncSweep_DryQueueVsNeverArmed(t *testing.T) {
	store := setupStore(t)
	dry, dryClaim := setupInvite(t, store)
	never, neverClaim := setupInvite(t, store)

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	dryHost := dry.Subdomain + ".localhost"
	drySession := registerAndGetSession(t, h, dryHost, dryClaim)
	registerAndGetSession(t, h, never.Subdomain+".localhost", neverClaim)

	ctx := context.Background()
	for _, id := range []string{dry.ID, never.ID} {
		if err := store.UpsertPushSubscription(ctx, id, "https://push.example/"+id, "p256dh", "auth", time.Now().UTC()); err != nil {
			t.Fatalf("UpsertPushSubscription: %v", err)
		}
		// Both accounts are freshly synced. The sweep is keyed off sync_state
		// (that is where last_warned_unix lives), and any browser that could have
		// computed a horizon has necessarily read the vault through the sync API.
		if _, err := store.ListOps(ctx, id, 0, 100, time.Now().UTC()); err != nil {
			t.Fatalf("ListOps (touch sync): %v", err)
		}
	}

	// Drain the one account's queue the way production drained it: its last
	// queued reminder fires, and the browser never uploads a new horizon.
	putSchedule(t, h, dryHost, drySession, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(-time.Minute).Unix(), CT: []byte("last-reminder-ct")},
	}})
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, nil, 0).Tick(ctx)

	sender := &fakeSender{goneFor: map[string]bool{}}
	NewRelay(store, sender, nil, 120*time.Hour).StaleSyncSweep(ctx)

	if len(sender.sent) != 1 {
		t.Fatalf("expected exactly 1 warning (the drained account), got %d: %+v", len(sender.sent), sender.sent)
	}
	if got, want := sender.sent[0].endpoint, "https://push.example/"+dry.ID; got != want {
		t.Fatalf("warning went to %q, want the drained account's endpoint %q", got, want)
	}
}

// TestRelay_WakeInboxCoalescesABurst pins the coalescing half of the inbox wake
// (bd med-5fo): repeated wakes inside the cooldown collapse to one push (a drain
// is per-account, not per-message), and the window is per-account so one busy
// account never silences another.
func TestRelay_WakeInboxCoalescesABurst(t *testing.T) {
	store := setupStore(t)
	accountA, _ := setupInvite(t, store)
	accountB, _ := setupInvite(t, store)

	ctx := context.Background()
	for _, a := range []string{accountA.ID, accountB.ID} {
		if err := store.UpsertPushSubscription(ctx, a, "https://push.example/"+a, "p256dh", "auth", time.Now().UTC()); err != nil {
			t.Fatalf("UpsertPushSubscription: %v", err)
		}
	}

	sender := &fakeSender{}
	relay := NewRelay(store, sender, nil, 0)
	relay.WakeInbox(ctx, accountA.ID)
	relay.WakeInbox(ctx, accountA.ID)
	relay.WakeInbox(ctx, accountA.ID)
	relay.WakeInbox(ctx, accountB.ID)

	if len(sender.sent) != 2 {
		t.Fatalf("sends = %d, want 2 (one per account, burst coalesced): %+v", len(sender.sent), sender.sent)
	}
	var payload struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(sender.sent[0].ct, &payload); err != nil {
		t.Fatalf("unmarshal wake payload: %v", err)
	}
	if payload.Kind != "inbox-wake" {
		t.Fatalf("wake kind = %q, want inbox-wake", payload.Kind)
	}

	// Past the window the next event wakes again — coalescing must not turn into
	// a permanent mute.
	relay.wakeCooldown = 0
	relay.WakeInbox(ctx, accountA.ID)
	if len(sender.sent) != 3 {
		t.Fatalf("sends after the cooldown lapsed = %d, want 3", len(sender.sent))
	}
}

// TestRelay_SendsWithPerAccountVAPIDKeys guards the per-account-key design
// upgrade: each account's own keypair (generated at Provision) must reach the
// sender for that account's sends, and two accounts must never see each
// other's keys.
func TestRelay_SendsWithPerAccountVAPIDKeys(t *testing.T) {
	store := setupStore(t)
	accountA, claimTokenA := setupInvite(t, store)
	accountB, claimTokenB := setupInvite(t, store)
	hostA := accountA.Subdomain + ".localhost"
	hostB := accountB.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	sessionA := registerAndGetSession(t, h, hostA, claimTokenA)
	sessionB := registerAndGetSession(t, h, hostB, claimTokenB)

	ctx := context.Background()
	if err := store.UpsertPushSubscription(ctx, accountA.ID, "https://push.example/a", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription A: %v", err)
	}
	if err := store.UpsertPushSubscription(ctx, accountB.ID, "https://push.example/b", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription B: %v", err)
	}

	putSchedule(t, h, hostA, sessionA, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(-time.Minute).Unix(), CT: []byte("ct-a")},
	}})
	putSchedule(t, h, hostB, sessionB, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(-time.Minute).Unix(), CT: []byte("ct-b")},
	}})

	sender := &fakeSender{goneFor: map[string]bool{}}
	relay := NewRelay(store, sender, nil, 0)
	relay.Tick(ctx)

	if len(sender.sent) != 2 {
		t.Fatalf("expected 2 sends, got %d: %+v", len(sender.sent), sender.sent)
	}

	keysA, err := store.AccountVAPIDKeysByID(ctx, accountA.ID)
	if err != nil {
		t.Fatalf("AccountVAPIDKeysByID A: %v", err)
	}
	keysB, err := store.AccountVAPIDKeysByID(ctx, accountB.ID)
	if err != nil {
		t.Fatalf("AccountVAPIDKeysByID B: %v", err)
	}
	if keysA.PublicKey == "" || keysB.PublicKey == "" || keysA.PublicKey == keysB.PublicKey {
		t.Fatalf("expected distinct, non-empty per-account keys, got A=%q B=%q", keysA.PublicKey, keysB.PublicKey)
	}

	for _, s := range sender.sent {
		switch s.endpoint {
		case "https://push.example/a":
			if s.keys != keysA {
				t.Errorf("send to A carried keys %+v, want %+v", s.keys, keysA)
			}
		case "https://push.example/b":
			if s.keys != keysB {
				t.Errorf("send to B carried keys %+v, want %+v", s.keys, keysB)
			}
		default:
			t.Errorf("unexpected send to %q", s.endpoint)
		}
	}
}

// TestVAPIDSubjectFor guards the iOS subject-fragility fix: Apple's push
// service requires an https:// subject while FCM/Mozilla expect the
// configured mailto:, so sending the wrong one for an endpoint permanently
// kills that platform's subscriptions (4xx -> Disable).
func TestVAPIDSubjectFor(t *testing.T) {
	const (
		configuredSubject = "mailto:noreply@example.com"
		baseDomain        = "example.com"
	)
	cases := []struct {
		name     string
		endpoint string
		want     string
	}{
		{"apple endpoint gets https subject", "https://web.push.apple.com/abc123", "https://" + baseDomain},
		{"fcm endpoint gets configured mailto subject", "https://fcm.googleapis.com/fcm/send/xyz", configuredSubject},
		{"mozilla endpoint gets configured mailto subject", "https://updates.push.services.mozilla.com/wpush/v2/xyz", configuredSubject},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := vapidSubjectFor(c.endpoint, configuredSubject, baseDomain)
			if got != c.want {
				t.Errorf("vapidSubjectFor(%q) = %q, want %q", c.endpoint, got, c.want)
			}
		})
	}
}

// fakeTGSender records every reminder the relay forwards to Telegram, and can
// fail on demand so the "never wedge the queue" contract is observable.
type fakeTGSender struct {
	sent      []string
	callbacks []string
	err       error

	nextID    int64   // id handed to the next successful send (auto-increments from 1)
	deleted   []int64 // message ids passed to DeleteReminder
	deleteErr error   // force a best-effort delete failure
}

func (f *fakeTGSender) SendReminder(ctx context.Context, accountID, text, callbackStem string) (int64, error) {
	f.sent = append(f.sent, text)
	f.callbacks = append(f.callbacks, callbackStem)
	if f.err != nil {
		return 0, f.err
	}
	f.nextID++
	return f.nextID, nil
}

func (f *fakeTGSender) DeleteReminder(ctx context.Context, accountID string, messageID int64) error {
	f.deleted = append(f.deleted, messageID)
	return f.deleteErr
}

// TestRelay_DeliveryChannelRouting guards the C3b outbound contract: each due
// entry fires on exactly the channels its delivery flag names, and no others.
func TestRelay_DeliveryChannelRouting(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)

	ctx := context.Background()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/ok", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	past := time.Now().Add(-time.Minute).Unix()
	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: past, CT: []byte("web-only"), Delivery: "webpush"},
		{FireAtUnix: past, Delivery: "telegram", TGText: "tg-only"},
		{FireAtUnix: past, CT: []byte("both-ct"), Delivery: "both", TGText: "both-text"},
	}})

	sender := &fakeSender{goneFor: map[string]bool{}}
	tg := &fakeTGSender{}
	NewRelay(store, sender, tg, 0).Tick(ctx)

	var webCTs []string
	for _, s := range sender.sent {
		webCTs = append(webCTs, string(s.ct))
	}
	if len(webCTs) != 2 || webCTs[0] != "web-only" || webCTs[1] != "both-ct" {
		t.Fatalf("web push must fire for webpush+both only, got %v", webCTs)
	}
	if len(tg.sent) != 2 || tg.sent[0] != "tg-only" || tg.sent[1] != "both-text" {
		t.Fatalf("telegram must fire for telegram+both only, got %v", tg.sent)
	}

	// Everything is marked sent, so a second tick is a no-op — no duplicates.
	sender2, tg2 := &fakeSender{goneFor: map[string]bool{}}, &fakeTGSender{}
	NewRelay(store, sender2, tg2, 0).Tick(ctx)
	if len(sender2.sent) != 0 || len(tg2.sent) != 0 {
		t.Fatalf("second tick re-sent entries: web=%v tg=%v", sender2.sent, tg2.sent)
	}
}

// TestRelay_TelegramFailureDoesNotWedgeQueue: a permanently-failing Telegram
// send (unlinked chat, revoked token) must still mark the row sent, or the
// relay would re-fire that reminder on every tick forever.
func TestRelay_TelegramFailureDoesNotWedgeQueue(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)
	ctx := context.Background()

	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(-time.Minute).Unix(), Delivery: "telegram", TGText: "never-delivers"},
	}})

	tg := &fakeTGSender{err: ErrNoLinkedChat}
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, tg, 0).Tick(ctx)
	if len(tg.sent) != 1 {
		t.Fatalf("expected one attempted send, got %v", tg.sent)
	}

	tg2 := &fakeTGSender{err: ErrNoLinkedChat}
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, tg2, 0).Tick(ctx)
	if len(tg2.sent) != 0 {
		t.Fatalf("failed telegram entry re-fired on the next tick: %v", tg2.sent)
	}
}

// TestRelay_TelegramEntryWithNoSenderIsDropped: a deployment with no manager
// bot must not wedge on telegram entries either.
func TestRelay_TelegramEntryWithNoSenderIsDropped(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)
	ctx := context.Background()

	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(-time.Minute).Unix(), Delivery: "telegram", TGText: "no-sender"},
	}})

	// nil TelegramSender — must not panic, must mark sent.
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, nil, 0).Tick(ctx)

	due, err := store.DueScheduledPushes(ctx, time.Now().UTC())
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(due) != 0 {
		t.Fatalf("telegram entry left unsent with no sender configured: %+v", due)
	}
}

// med-76c.2 part 2: a medication entry carries an "s:<slotUnix>" stem, which the
// relay hands to the Telegram sender so it can render Confirm/Snooze. BP/weight
// entries carry none and must stay button-less.
func TestRelay_ForwardsCallbackStemForButtons(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)

	past := time.Now().Add(-time.Minute).Unix()
	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: past, Delivery: "telegram", TGText: "Time to take: Lisinopril", TGCallback: "s:1767225600"},
		{FireAtUnix: past, Delivery: "telegram", TGText: "Time to measure your BP"},
	}})

	tg := &fakeTGSender{}
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, tg, 0).Tick(context.Background())

	if len(tg.callbacks) != 2 {
		t.Fatalf("forwarded %d entries, want 2", len(tg.callbacks))
	}
	byText := map[string]string{}
	for i, text := range tg.sent {
		byText[text] = tg.callbacks[i]
	}
	if got := byText["Time to take: Lisinopril"]; got != "s:1767225600" {
		t.Errorf("medication stem = %q, want s:1767225600", got)
	}
	if got := byText["Time to measure your BP"]; got != "" {
		t.Errorf("BP reminder carried a stem %q — it has no intake to confirm", got)
	}
}

// The stem becomes callback_data on a button the relay sends as the user. Only
// the grammar the webhook can parse back may be stored.
func TestPutSchedule_RejectsMalformedCallbackStem(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)

	past := time.Now().Add(-time.Minute).Unix()
	for _, stem := range []string{"i:intake-7-1", "s:abc", "s:", "s:1:confirm", strings.Repeat("s:1", 20)} {
		body, _ := json.Marshal(putScheduleRequest{Entries: []scheduleEntryWire{
			{FireAtUnix: past, Delivery: "telegram", TGText: "x", TGCallback: stem},
		}})
		rec := doReq(t, h, http.MethodPut, "http://"+host+"/api/push/schedule", host, session, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("stem %q accepted (status %d), want 400", stem, rec.Code)
		}
	}

	// The legal shapes still pass.
	for _, stem := range []string{"", "s:1767225600"} {
		body, _ := json.Marshal(putScheduleRequest{Entries: []scheduleEntryWire{
			{FireAtUnix: past, Delivery: "telegram", TGText: "x", TGCallback: stem},
		}})
		rec := doReq(t, h, http.MethodPut, "http://"+host+"/api/push/schedule", host, session, body)
		if rec.Code != http.StatusNoContent {
			t.Errorf("stem %q rejected (status %d)", stem, rec.Code)
		}
	}
}

// med-eas.74: sending a med reminder whose dose slot is still within the ~6h cap
// schedules the next hourly re-fire (server-owned, so an unopened PWA keeps being
// nagged); a slot past the cap stops the chain.
func TestRelay_MedRefireChain(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)
	ctx := context.Background()
	now := time.Now().UTC()

	// A med reminder whose dose slot is 30m old — comfortably inside the 6h cap.
	freshSlot := now.Add(-30 * time.Minute).Unix()
	freshStem := fmt.Sprintf("s:%d", freshSlot)
	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: now.Add(-time.Minute).Unix(), Delivery: "telegram", TGText: "Time to take: X", TGCallback: freshStem},
	}})

	tg := &fakeTGSender{}
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, tg, 0).Tick(ctx)
	if len(tg.sent) != 1 {
		t.Fatalf("expected the med reminder to send once, got %v", tg.sent)
	}

	// The re-fire is queued at ~now+1h, so it is due only in the future and it
	// re-uses the same "s:<slot>" stem so a re-delivered Confirm still converges.
	future, err := store.DueScheduledPushes(ctx, now.Add(90*time.Minute))
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(future) != 1 || future[0].TGCallback != freshStem {
		t.Fatalf("expected one queued re-fire for %q, got %+v", freshStem, future)
	}
	if delta := future[0].FireAt.Sub(now); delta < 55*time.Minute || delta > 65*time.Minute {
		t.Fatalf("re-fire scheduled at now+%v, want ~1h", delta)
	}
	// Nothing is due right now (the just-sent primary is marked sent, the re-fire
	// is an hour out).
	if dueNow, _ := store.DueScheduledPushes(ctx, now); len(dueNow) != 0 {
		t.Fatalf("re-fire fired immediately: %+v", dueNow)
	}

	// A second account whose slot is 7h old — past the cap — must NOT re-fire.
	account2, claim2 := setupInvite(t, store)
	host2 := account2.Subdomain + ".localhost"
	session2 := registerAndGetSession(t, h, host2, claim2)
	staleStem := fmt.Sprintf("s:%d", now.Add(-7*time.Hour).Unix())
	putSchedule(t, h, host2, session2, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: now.Add(-time.Minute).Unix(), Delivery: "telegram", TGText: "Time to take: Y", TGCallback: staleStem},
	}})
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, &fakeTGSender{}, 0).Tick(ctx)
	future2, err := store.DueScheduledPushes(ctx, now.Add(90*time.Minute))
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	for _, p := range future2 {
		if p.TGCallback == staleStem {
			t.Fatalf("stale-slot med re-fired past the cap: %+v", p)
		}
	}
}

// medRefireChainSetup wires an account + linked host + session and returns the
// store/handler/session (plus account id) for a med-refire chain test.
func medRefireChainSetup(t *testing.T) (*cloudstore.Repo, http.Handler, string, *http.Cookie, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)
	return store, h, host, session, account.ID
}

// TestRelay_RefireDeletesPriorMessage (med-eas.79 Task 6) pins the core behavior:
// the primary send deletes nothing and threads its own message id as the next
// re-fire's supersedes; when that re-fire fires it DELETES the prior send's
// message so exactly one live reminder remains per chain.
func TestRelay_RefireDeletesPriorMessage(t *testing.T) {
	store, h, host, session, _ := medRefireChainSetup(t)
	ctx := context.Background()
	now := time.Now().UTC()

	freshStem := fmt.Sprintf("s:%d", now.Add(-30*time.Minute).Unix())
	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: now.Add(-time.Minute).Unix(), Delivery: "telegram", TGText: "Time to take: X", TGCallback: freshStem},
	}})

	tg := &fakeTGSender{}
	relay := NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, tg, 0)

	// Tick 1: the primary send (message id 1) supersedes nothing.
	relay.Tick(ctx)
	if len(tg.deleted) != 0 {
		t.Fatalf("primary send deleted a message %v; it supersedes nothing", tg.deleted)
	}
	// The chain threads the just-sent id: the queued re-fire supersedes send #1.
	future, err := store.DueScheduledPushes(ctx, now.Add(90*time.Minute))
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(future) != 1 || future[0].SupersedesMessageID != 1 {
		t.Fatalf("re-fire must supersede the primary send id 1, got %+v", future)
	}

	// Make that queued re-fire due now (same DELETE-then-INSERT the chain uses,
	// backdated so a second tick fires it without a 1h wait).
	if err := store.RescheduleRelayRefire(ctx, future[0].AccountID, now.Add(-time.Second), future[0].TGText, freshStem, future[0].SupersedesMessageID); err != nil {
		t.Fatalf("RescheduleRelayRefire (seed due): %v", err)
	}

	// Tick 2: the re-fire (message id 2) deletes the prior send #1.
	relay.Tick(ctx)
	if len(tg.deleted) != 1 || tg.deleted[0] != 1 {
		t.Fatalf("re-fire must delete the prior send id 1, got deleted=%v", tg.deleted)
	}
}

// TestRelay_RefireDeleteFailureDoesNotAbortChain (med-eas.79 Task 6) pins the
// best-effort contract: a delete that fails (prior message already gone / >48h
// old) must not abort the send or stop the chain — the new reminder still sends
// and the next re-fire is still queued.
func TestRelay_RefireDeleteFailureDoesNotAbortChain(t *testing.T) {
	store, _, _, _, accountID := medRefireChainSetup(t)
	ctx := context.Background()
	now := time.Now().UTC()

	freshStem := fmt.Sprintf("s:%d", now.Add(-30*time.Minute).Unix())
	// Seed a due re-fire that supersedes a (doomed) prior message id 5.
	if err := store.RescheduleRelayRefire(ctx, accountID, now.Add(-time.Second), "Time to take: X", freshStem, 5); err != nil {
		t.Fatalf("RescheduleRelayRefire (seed due): %v", err)
	}

	// nextID starts at 5 so the send returns 6 — TG message ids are monotonic, so a
	// re-fire superseding message 5 always sends a higher id than the one it deletes.
	tg := &fakeTGSender{deleteErr: fmt.Errorf("message can't be deleted"), nextID: 5}
	NewRelay(store, &fakeSender{goneFor: map[string]bool{}}, tg, 0).Tick(ctx)

	if len(tg.sent) != 1 {
		t.Fatalf("failed delete must not abort the send, got sent=%v", tg.sent)
	}
	if len(tg.deleted) != 1 || tg.deleted[0] != 5 {
		t.Fatalf("delete of prior message should have been attempted, got deleted=%v", tg.deleted)
	}
	// The chain continues: the next re-fire is queued, superseding this send (id 6).
	future, err := store.DueScheduledPushes(ctx, now.Add(90*time.Minute))
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(future) != 1 || future[0].SupersedesMessageID != 6 {
		t.Fatalf("chain must continue despite the failed delete, got %+v", future)
	}
}
