package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

const testRecipient = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsz9x7d8y"

func feedbackTestServer(t *testing.T, recipient string) (http.Handler, string, string, *http.Cookie, *cloudstore.Repo) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	secret := "test-session-secret-at-least-32-bytes-long"
	webauthnAPI := NewWebAuthnAPI(store, secret)
	feedbackAPI := NewFeedbackAPI(store, secret, recipient)
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
	h, host, accountID, session, store := feedbackTestServer(t, testRecipient)

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
	h, host, _, session, store := feedbackTestServer(t, testRecipient)

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
	h, host, _, session, store := feedbackTestServer(t, "")

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
	h, host, _, session, store := feedbackTestServer(t, testRecipient)

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
	h, host, _, session, store := feedbackTestServer(t, testRecipient)

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
	h, host, accountID, session, store := feedbackTestServer(t, testRecipient)

	ctx := context.Background()
	// Seed directly through the store until it reports the account is at the cap.
	for i := 0; ; i++ {
		cid := "seed-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
		err := store.AppendFeedback(ctx, accountID, cid, "", "", []byte("x"), time.Now())
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

// TestFeedback_RequiresSession: no session cookie → 401 (RequireSession).
func TestFeedback_RequiresSession(t *testing.T) {
	h, host, _, _, _ := feedbackTestServer(t, testRecipient)

	body, _ := json.Marshal(submitFeedbackRequest{ClientID: "c", Ciphertext: []byte("blob")})
	if rec := postFeedbackRaw(t, h, host, nil, body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no-session POST = %d, want 401", rec.Code)
	}
}
