package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// TestGetVapidPublicKey_PerAccount guards the per-account VAPID design: two
// accounts must see their own distinct key on their own subdomain, and a
// base-domain request (no account resolved) 404s rather than leaking any key.
func TestGetVapidPublicKey_PerAccount(t *testing.T) {
	store := setupStore(t)
	accountA, _ := setupInvite(t, store)
	accountB, _ := setupInvite(t, store)

	pushAPI := NewPushAPI(store, &fakeSender{}, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	getKey := func(host string) (int, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/push/vapid-public-key", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var resp vapidPublicKeyResponse
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
		}
		return rec.Code, resp.PublicKey
	}

	codeA, keyA := getKey(accountA.Subdomain + ".localhost")
	codeB, keyB := getKey(accountB.Subdomain + ".localhost")
	if codeA != http.StatusOK || codeB != http.StatusOK {
		t.Fatalf("expected 200 for both accounts, got %d and %d", codeA, codeB)
	}
	if keyA == "" || keyB == "" {
		t.Fatalf("expected non-empty keys, got %q and %q", keyA, keyB)
	}
	if keyA == keyB {
		t.Fatalf("expected distinct per-account keys, both were %q", keyA)
	}
	if accountA.VAPIDPublicKey == nil || keyA != *accountA.VAPIDPublicKey {
		t.Fatalf("returned key %q does not match account A's stored key", keyA)
	}

	codeBase, _ := getKey("localhost")
	if codeBase != http.StatusNotFound {
		t.Fatalf("base-domain request status = %d, want 404 (no account in context)", codeBase)
	}
}

// TestValidatePushEndpoint guards the authenticated-SSRF filter: real push
// hosts pass; loopback / metadata / private literal-IP targets and non-https
// schemes are rejected before the endpoint can be stored and relayed to.
func TestValidatePushEndpoint(t *testing.T) {
	ok := []string{
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://web.push.apple.com/xyz",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAA",
	}
	for _, e := range ok {
		if err := validatePushEndpoint(e); err != nil {
			t.Errorf("validatePushEndpoint(%q) = %v, want nil", e, err)
		}
	}

	bad := []string{
		"http://fcm.googleapis.com/fcm/send/abc",    // not https
		"https://127.0.0.1/x",                       // loopback
		"https://169.254.169.254/latest/meta-data/", // cloud metadata (link-local)
		"https://10.0.0.5/x",                        // private
		"https://192.168.1.1/x",                     // private
		"https://[::1]/x",                           // loopback v6
		"https://0.0.0.0/x",                         // unspecified
		"",                                          // empty
		"://nonsense",                               // unparseable / no scheme
	}
	for _, e := range bad {
		if err := validatePushEndpoint(e); err == nil {
			t.Errorf("validatePushEndpoint(%q) = nil, want error", e)
		}
	}
}

func postTestPush(t *testing.T, h http.Handler, host string, session *http.Cookie, req testPushRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(req)
	r := httptest.NewRequest(http.MethodPost, "/api/push/test", bytes.NewReader(body))
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// TestPostTestPush_TargetsOnlyNamedEndpoint guards the this-device-only test
// affordance: with two subscriptions on the same account, POST
// /api/push/test must send to exactly the named endpoint (never fan out to
// the other device), forward ct verbatim (the server stays blind to
// plaintext), and 404 an endpoint that isn't registered to the account.
func TestPostTestPush_TargetsOnlyNamedEndpoint(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	sender := &fakeSender{}
	pushAPI := NewPushAPI(store, sender, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)

	ctx := t.Context()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/device-a", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription A: %v", err)
	}
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/device-b", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription B: %v", err)
	}

	rec := postTestPush(t, h, host, session, testPushRequest{Endpoint: "https://push.example/device-a", CT: []byte("test-ct")})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("POST /api/push/test status = %d, body %q", rec.Code, rec.Body.String())
	}
	if len(sender.sent) != 1 {
		t.Fatalf("expected exactly 1 send (this-device-only), got %d: %+v", len(sender.sent), sender.sent)
	}
	if sender.sent[0].endpoint != "https://push.example/device-a" {
		t.Fatalf("sent to %q, want only device-a (device-b must not receive the test)", sender.sent[0].endpoint)
	}
	if string(sender.sent[0].ct) != "test-ct" {
		t.Fatalf("sent ct = %q, want %q — server must forward ciphertext verbatim (blind)", sender.sent[0].ct, "test-ct")
	}

	recUnknown := postTestPush(t, h, host, session, testPushRequest{Endpoint: "https://push.example/unknown-device", CT: []byte("test-ct")})
	if recUnknown.Code != http.StatusNotFound {
		t.Fatalf("POST /api/push/test to unknown endpoint status = %d, want 404", recUnknown.Code)
	}
}

// TestPostTestPush_GoneDisablesSubscription guards the stale-subscription path
// the client's "subscription expired — re-enable" UX depends on: when the push
// service returns 410, PostTestPush must respond 410 and disable the row so it
// stops being relayed to.
func TestPostTestPush_GoneDisablesSubscription(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	sender := &fakeSender{goneFor: map[string]bool{"https://push.example/gone": true}}
	pushAPI := NewPushAPI(store, sender, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	pushAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)

	ctx := t.Context()
	if err := store.UpsertPushSubscription(ctx, account.ID, "https://push.example/gone", "p256dh", "auth", time.Now().UTC()); err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	rec := postTestPush(t, h, host, session, testPushRequest{Endpoint: "https://push.example/gone", CT: []byte("test-ct")})
	if rec.Code != http.StatusGone {
		t.Fatalf("POST /api/push/test to gone endpoint status = %d, want 410", rec.Code)
	}

	sub, err := store.GetByEndpoint(ctx, account.ID, "https://push.example/gone")
	if err != nil {
		t.Fatalf("GetByEndpoint: %v", err)
	}
	if sub != nil {
		t.Fatalf("subscription should be disabled after 410 (GetByEndpoint filters disabled), got %+v", sub)
	}
}

// TestPutSchedule_DeliveryValidation guards the C3b wire contract: each channel
// requires its own payload, unknown channels are rejected, and an entry with no
// delivery field (every pre-C3b client) still persists as webpush.
func TestPutSchedule_DeliveryValidation(t *testing.T) {
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
	fireAt := time.Now().Add(time.Hour).Unix()

	put := func(e scheduleEntryWire) int {
		body, _ := json.Marshal(putScheduleRequest{Entries: []scheduleEntryWire{e}})
		r := httptest.NewRequest(http.MethodPut, "/api/push/schedule", bytes.NewReader(body))
		r.Host = host
		r.AddCookie(session)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		return rec.Code
	}

	bad := []struct {
		name  string
		entry scheduleEntryWire
	}{
		{"unknown channel", scheduleEntryWire{FireAtUnix: fireAt, CT: []byte("ct"), Delivery: "carrier-pigeon"}},
		{"telegram without text", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "telegram"}},
		{"both without text", scheduleEntryWire{FireAtUnix: fireAt, CT: []byte("ct"), Delivery: "both"}},
		{"both without ct", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "both", TGText: "hi"}},
		{"webpush without ct", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "webpush"}},
		{"tg text too long", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "telegram", TGText: strings.Repeat("x", maxScheduleTGTextLen+1)}},
		// med-kbpf: tg_med_ids is bare decimal ids, bounded, and only on a med row.
		{"med ids not numeric", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "telegram", TGText: "hi", TGCallback: "s:1767225600", TGMedIDs: "2,abc"}},
		{"med ids malformed", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "telegram", TGText: "hi", TGCallback: "s:1767225600", TGMedIDs: "2,"}},
		{"med ids too long", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "telegram", TGText: "hi", TGCallback: "s:1767225600", TGMedIDs: strings.Repeat("1,", maxScheduleTGMedIDsLen) + "1"}},
		{"med ids on a non-med callback", scheduleEntryWire{FireAtUnix: fireAt, Delivery: "telegram", TGText: "hi", TGCallback: "w:6:20260720", TGMedIDs: "2,9"}},
	}
	for _, tc := range bad {
		if code := put(tc.entry); code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", tc.name, code)
		}
	}

	// No delivery field at all → stored as webpush (backward compatibility).
	if code := put(scheduleEntryWire{FireAtUnix: time.Now().Add(-time.Minute).Unix(), CT: []byte("legacy-ct")}); code != http.StatusNoContent {
		t.Fatalf("legacy entry status = %d, want 204", code)
	}
	due, err := store.DueScheduledPushes(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(due) != 1 || due[0].Delivery != cloudstore.DeliveryWebPush {
		t.Fatalf("legacy entry did not default to webpush: %+v", due)
	}

	// A well-formed med row stores its identity verbatim — that is what a Confirm
	// tap seals (med-kbpf).
	if code := put(scheduleEntryWire{FireAtUnix: time.Now().Add(-time.Minute).Unix(), Delivery: "telegram", TGText: "Time to take (2)", TGCallback: "s:1767225600", TGMedIDs: "2,9"}); code != http.StatusNoContent {
		t.Fatalf("med-ids entry status = %d, want 204", code)
	}
	due, err = store.DueScheduledPushes(context.Background(), time.Now().UTC())
	if err != nil {
		t.Fatalf("DueScheduledPushes: %v", err)
	}
	if len(due) != 1 || due[0].TGMedIDs != "2,9" {
		t.Fatalf("stored med ids = %+v, want one row with tg_med_ids 2,9", due)
	}
}
