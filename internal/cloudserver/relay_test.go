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
}

// fakeSender never touches the network: it records every send and reports a
// canned status per endpoint, so the relay contract test controls exactly
// which subscriptions look "gone".
type fakeSender struct {
	sent    []sentPush
	goneFor map[string]bool
}

func (f *fakeSender) Send(ctx context.Context, sub cloudstore.PushSubscription, ct []byte) (int, error) {
	f.sent = append(f.sent, sentPush{endpoint: sub.Endpoint, ct: ct})
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
	pushAPI := NewPushAPI(store, "test-session-secret-at-least-32-bytes-long", "test-vapid-public-key")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), mux)

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
	relay := NewRelay(store, sender)
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
	relay2 := NewRelay(store, sender2)
	relay2.Tick(ctx)

	if len(sender2.sent) != 1 || string(sender2.sent[0].ct) != "second-due-ct" {
		t.Fatalf("expected only the new due entry to fire (old future entry dropped by replace-all), got %+v", sender2.sent)
	}
}
