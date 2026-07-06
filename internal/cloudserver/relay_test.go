package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "")

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
	relay := NewRelay(store, sender, 0)
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
	relay2 := NewRelay(store, sender2, 0)
	relay2.Tick(ctx)

	if len(sender2.sent) != 1 || string(sender2.sent[0].ct) != "second-due-ct" {
		t.Fatalf("expected only the new due entry to fire (old future entry dropped by replace-all), got %+v", sender2.sent)
	}
}

// TestRelay_StaleSyncSweep guards Task 7's dry-queue safety net: only an
// account whose queue is about to run dry AND hasn't synced recently gets
// warned, and a second sweep within the cooldown doesn't re-warn it.
func TestRelay_StaleSyncSweep(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "")

	session := registerAndGetSession(t, h, host, claimToken)

	ctx := context.Background()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/ok", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	// Queue's only entry fires soon (within the warn horizon).
	putSchedule(t, h, host, session, putScheduleRequest{Entries: []scheduleEntryWire{
		{FireAtUnix: time.Now().Add(time.Hour).Unix(), CT: []byte("soon-ct")},
	}})

	// Backdate last_sync_unix past staleSyncAfter (24h) via ListOps' now param
	// — the only way to set it without reaching into cloudstore internals.
	if _, err := store.ListOps(ctx, account.ID, 0, 100, time.Now().Add(-25*time.Hour)); err != nil {
		t.Fatalf("ListOps (backdate sync): %v", err)
	}

	sender := &fakeSender{goneFor: map[string]bool{}}
	relay := NewRelay(store, sender, 120*time.Hour)
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
	relay2 := NewRelay(store, sender2, 120*time.Hour)
	relay2.StaleSyncSweep(ctx)
	if len(sender2.sent) != 0 {
		t.Fatalf("expected no re-warn within cooldown, got %+v", sender2.sent)
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
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "")

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
	relay := NewRelay(store, sender, 0)
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
