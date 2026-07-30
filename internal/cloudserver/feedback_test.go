package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

const testRecipient = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsz9x7d8y"

// feedbackTestServer builds the feedback endpoint behind a real session. notify
// is the optional admin-relay hook (nil = no relay, the default deployment).
func feedbackTestServer(t *testing.T, recipient string, notify func(kind, appVersion string)) (http.Handler, string, string, *http.Cookie, *cloudstore.Repo) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	secret := "test-session-secret-at-least-32-bytes-long"
	webauthnAPI := NewWebAuthnAPI(store, secret)
	feedbackAPI := NewFeedbackAPI(store, secret, recipient)
	feedbackAPI.SetNotifier(notify)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	feedbackAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)
	return h, host, account.ID, session, store
}

func postFeedbackRaw(t *testing.T, h http.Handler, host string, session *http.Cookie, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/feedback", bytes.NewReader(body))
	r.Host = host
	if session != nil {
		r.AddCookie(session)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// TestFeedback_HappyPathStoresOneBlindRow: a valid POST returns 204 and appends
// exactly one row, scoped to the session account, ciphertext preserved verbatim.
func TestFeedback_HappyPathStoresOneBlindRow(t *testing.T) {
	h, host, accountID, session, store := feedbackTestServer(t, testRecipient, nil)

	ct := []byte("age-armored-opaque-blob")
	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "cid-1", Kind: "bug", AppVersion: "1.2.3", Ciphertext: ct})
	if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusNoContent {
		t.Fatalf("POST /api/feedback = %d: %s", rec.Code, rec.Body.String())
	}

	items, err := store.ListFeedback(context.Background(), 10)
	if err != nil {
		t.Fatalf("ListFeedback: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 row, got %d", len(items))
	}
	it := items[0]
	if it.AccountID != accountID {
		t.Errorf("account_id = %q, want %q", it.AccountID, accountID)
	}
	if it.ClientID != "cid-1" || it.Kind != "bug" || it.AppVersion != "1.2.3" {
		t.Errorf("metadata mismatch: %+v", it)
	}
	if !bytes.Equal(it.Ciphertext, ct) {
		t.Errorf("ciphertext = %q, want %q (must be verbatim)", it.Ciphertext, ct)
	}
}

// TestFeedback_IdempotentOnClientID: re-POSTing the same client_id is still 204
// but never duplicates the row (the flaky-connection retry path).
func TestFeedback_IdempotentOnClientID(t *testing.T) {
	h, host, _, session, store := feedbackTestServer(t, testRecipient, nil)

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "dup", Ciphertext: []byte("blob")})
	for i := 0; i < 3; i++ {
		if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusNoContent {
			t.Fatalf("retry #%d = %d", i+1, rec.Code)
		}
	}
	items, _ := store.ListFeedback(context.Background(), 10)
	if len(items) != 1 {
		t.Fatalf("expected 1 row after 3 identical POSTs, got %d", len(items))
	}
}

// TestFeedback_DisabledWhenNoRecipient: unset recipient → 503 and nothing stored.
func TestFeedback_DisabledWhenNoRecipient(t *testing.T) {
	h, host, _, session, store := feedbackTestServer(t, "", nil)

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "cid", Ciphertext: []byte("blob")})
	if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled POST = %d, want 503", rec.Code)
	}
	if items, _ := store.ListFeedback(context.Background(), 10); len(items) != 0 {
		t.Fatalf("disabled feature stored %d rows", len(items))
	}
}

// TestFeedback_OversizedBody: a body past the cap is rejected with 413.
func TestFeedback_OversizedBody(t *testing.T) {
	h, host, _, session, store := feedbackTestServer(t, testRecipient, nil)

	// A raw JSON string field larger than the cap trips MaxBytesReader mid-decode.
	huge := bytes.Repeat([]byte("A"), maxFeedbackBodyBytes+1024)
	body := append([]byte(`{"client_id":"big","ciphertext":"`), huge...)
	body = append(body, []byte(`"}`)...)
	if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized POST = %d, want 413", rec.Code)
	}
	if items, _ := store.ListFeedback(context.Background(), 10); len(items) != 0 {
		t.Fatalf("oversized POST stored %d rows", len(items))
	}
}

// TestFeedback_BadInput: missing client_id, empty ciphertext, and non-base64
// ciphertext all 400.
func TestFeedback_BadInput(t *testing.T) {
	h, host, _, session, store := feedbackTestServer(t, testRecipient, nil)

	cases := map[string][]byte{
		"missing client_id": []byte(`{"ciphertext":"YmxvYg=="}`),
		"empty ciphertext":  []byte(`{"client_id":"c","ciphertext":""}`),
		"bad base64":        []byte(`{"client_id":"c","ciphertext":"not valid base64 !!!"}`),
	}
	for name, body := range cases {
		if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, rec.Code)
		}
	}
	if items, _ := store.ListFeedback(context.Background(), 10); len(items) != 0 {
		t.Fatalf("bad input stored %d rows", len(items))
	}
}

// TestFeedback_QueueFullReturns429: once the account is at the per-account cap, a
// genuinely new submission is rejected with 429 (the unbounded-write guard), while
// a retry of an already-queued client_id still succeeds.
func TestFeedback_QueueFullReturns429(t *testing.T) {
	h, host, accountID, session, store := feedbackTestServer(t, testRecipient, nil)

	ctx := context.Background()
	// Seed directly through the store until it reports the account is at the cap.
	for i := 0; ; i++ {
		cid := "seed-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
		_, err := store.AppendFeedback(ctx, accountID, cid, "", "", []byte("x"), time.Now())
		if errors.Is(err, cloudstore.ErrFeedbackQueueFull) {
			break
		}
		if err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
		if i > 10000 {
			t.Fatal("never hit feedback cap")
		}
	}
	seeded, _ := store.ListFeedback(ctx, 100000)

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "over-cap", Ciphertext: []byte("blob")})
	if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over-cap POST = %d, want 429", rec.Code)
	}
	if items, _ := store.ListFeedback(ctx, 100000); len(items) != len(seeded) {
		t.Fatalf("over-cap POST stored a row: len = %d, want %d", len(items), len(seeded))
	}
}

// TestFeedback_AdminPingIsMetadataOnly: with FEEDBACK_ADMIN_CHAT_ID wired, a web
// POST is still 204 and the admin DM carries kind + app version and NOTHING else
// — no content, no ciphertext, no account id. This is the E2EE invariant of
// bd med-orj: the server cannot read web feedback, so it must not pretend to.
func TestFeedback_AdminPingIsMetadataOnly(t *testing.T) {
	tg := newRecordingTG(t)
	// Its own store: NotifyFeedback also mints the reader token the DM links to
	// (bd med-rbl.1). Which DB that lands in is irrelevant to what this asserts.
	tgAPI := NewTelegramAPI(setupStore(t), tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", time.Hour)
	tgAPI.SetFeedbackAdminChat(feedbackAdminChat)
	h, host, accountID, session, store := feedbackTestServer(t, testRecipient, tgAPI.NotifyFeedback)

	ct := []byte("age-armored-opaque-blob")
	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "cid-1", Kind: "bug", AppVersion: "1.2.3", Ciphertext: ct})
	if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusNoContent {
		t.Fatalf("POST /api/feedback = %d: %s", rec.Code, rec.Body.String())
	}

	sent := waitForSent(t, tg, 1)
	if len(sent) != 1 {
		t.Fatalf("want exactly 1 admin DM, got %d: %v", len(sent), sent)
	}
	ping := sent[0]
	// The reader link replaced the old "run feedbackpull" tail (bd med-rbl.1);
	// the metadata it carries is unchanged.
	for _, want := range []string{`"chat_id":9001`, "New feedback (web)", "bug", "1.2.3", "/feedback#t="} {
		if !strings.Contains(ping, want) {
			t.Errorf("ping missing %q: %s", want, ping)
		}
	}
	for _, leak := range []string{accountID, "age-armored", "cid-1"} {
		if strings.Contains(ping, leak) {
			t.Fatalf("ping leaks %q: %s", leak, ping)
		}
	}
	if items, _ := store.ListFeedback(context.Background(), 10); len(items) != 1 {
		t.Fatalf("relay changed what was stored: %d items", len(items))
	}
}

// TestFeedback_RetryDoesNotRePing: the reliable-retry client re-POSTs the same
// client_id over a flaky connection. That stores nothing new, so it must not
// announce "new feedback" again.
func TestFeedback_RetryDoesNotRePing(t *testing.T) {
	pings := make(chan string, 8)
	h, host, _, session, _ := feedbackTestServer(t, testRecipient, func(kind, appVersion string) {
		pings <- kind
	})

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "dup", Kind: "bug", Ciphertext: []byte("blob")})
	for i := 0; i < 3; i++ {
		if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusNoContent {
			t.Fatalf("retry #%d = %d", i+1, rec.Code)
		}
	}
	select {
	case <-pings:
	case <-time.After(2 * time.Second):
		t.Fatal("the first submission never pinged")
	}
	select {
	case extra := <-pings:
		t.Fatalf("a retry re-pinged the admin (%q); one queued item = one DM", extra)
	case <-time.After(200 * time.Millisecond):
	}
}

// TestFeedback_RelayFailureStillStoresAndReturns204: Telegram 403s (the admin
// never pressed /start) — the item is still queued, the POST is still 204.
func TestFeedback_RelayFailureStillStoresAndReturns204(t *testing.T) {
	tg := newRecordingTG(t)
	tg.mu.Lock()
	tg.mu.sendFails = true
	tg.mu.Unlock()
	tgAPI := NewTelegramAPI(setupStore(t), tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", time.Hour)
	tgAPI.SetFeedbackAdminChat(feedbackAdminChat)
	h, host, _, session, store := feedbackTestServer(t, testRecipient, tgAPI.NotifyFeedback)

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "cid-1", Kind: "bug", Ciphertext: []byte("blob")})
	if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusNoContent {
		t.Fatalf("POST with a failing relay = %d, want 204: %s", rec.Code, rec.Body.String())
	}
	waitForSent(t, tg, 1) // the attempt happened and was swallowed into a warn
	if items, _ := store.ListFeedback(context.Background(), 10); len(items) != 1 {
		t.Fatalf("failing relay lost the feedback item: %d rows", len(items))
	}
}

// TestFeedback_SlowRelayDoesNotBlockResponse: the relay runs off the request
// path, so even a notifier that never returns can't hold the 204.
func TestFeedback_SlowRelayDoesNotBlockResponse(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	called := make(chan struct{}, 1)
	h, host, _, session, _ := feedbackTestServer(t, testRecipient, func(kind, appVersion string) {
		called <- struct{}{}
		<-release
	})

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "cid-1", Ciphertext: []byte("blob")})
	if rec := postFeedbackRaw(t, h, host, session, body); rec.Code != http.StatusNoContent {
		t.Fatalf("POST behind a blocked relay = %d, want 204", rec.Code)
	}
	select {
	case <-called:
	case <-time.After(2 * time.Second):
		t.Fatal("notifier was never called")
	}
}

// TestFeedback_RequiresSession: no session cookie → 401 (RequireSession).
func TestFeedback_RequiresSession(t *testing.T) {
	h, host, _, _, _ := feedbackTestServer(t, testRecipient, nil)

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "c", Ciphertext: []byte("blob")})
	if rec := postFeedbackRaw(t, h, host, nil, body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no-session POST = %d, want 401", rec.Code)
	}
}
