package cloudserver

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// mintToken stores a token live from `now` for `ttl` and returns the raw value
// the DM link would carry.
func mintToken(t *testing.T, store feedbackReaderMinter, now time.Time, ttl time.Duration) string {
	t.Helper()
	token := randomSecret()
	sum := sha256.Sum256([]byte(token))
	if err := store.MintFeedbackReaderToken(context.Background(), sum[:], now, now.Add(ttl)); err != nil {
		t.Fatalf("MintFeedbackReaderToken: %v", err)
	}
	return token
}

func getQueue(t *testing.T, h *Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, feedbackQueuePath, nil)
	r.Host = "localhost"
	if token != "" {
		r.Header.Set(feedbackReaderTokenHeader, token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// TestFeedbackQueue_TokenGate: a live token reads the queue; an unknown one and
// an expired one are both 401 with no detail distinguishing them.
func TestFeedbackQueue_TokenGate(t *testing.T) {
	store, _ := setupStoreWithDB(t)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetFeedbackReader(NewFeedbackReaderAPI(store))

	account, _ := setupInvite(t, store)
	if _, err := store.AppendFeedback(context.Background(), account.ID, "cid-1", "bug", "1.2.3",
		[]byte("opaque-age-blob"), time.Now().UTC()); err != nil {
		t.Fatalf("AppendFeedback: %v", err)
	}

	live := mintToken(t, store, time.Now().UTC(), feedbackReaderTokenTTL)
	rec := getQueue(t, h, live)
	if rec.Code != http.StatusOK {
		t.Fatalf("live token: got %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []feedbackQueueItem `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Items) != 1 || body.Items[0].Kind != "bug" || body.Items[0].AppVersion != "1.2.3" {
		t.Fatalf("unexpected items: %+v", body.Items)
	}
	if body.Items[0].CiphertextB64 == "" {
		t.Error("ciphertext_b64 empty")
	}

	if rec := getQueue(t, h, "not-a-real-token"); rec.Code != http.StatusUnauthorized {
		t.Errorf("unknown token: got %d, want 401", rec.Code)
	}
	if rec := getQueue(t, h, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("missing token: got %d, want 401", rec.Code)
	}

	// Expired: minted an hour ago with a TTL that has already elapsed.
	past := time.Now().UTC().Add(-2 * time.Hour)
	expired := mintToken(t, store, past, time.Minute)
	if rec := getQueue(t, h, expired); rec.Code != http.StatusUnauthorized {
		t.Errorf("expired token: got %d, want 401", rec.Code)
	}
	// The two 401s must be indistinguishable — this endpoint is unauthenticated.
	unknown := getQueue(t, h, "not-a-real-token").Body.String()
	if got := getQueue(t, h, expired).Body.String(); got != unknown {
		t.Errorf("401 bodies differ (expired %q vs unknown %q) — leaks token state", got, unknown)
	}
}

// TestFeedbackQueue_NewestFirstSoTheAnnouncedItemIsReachable: the per-account
// cap does not bound the queue globally, so an oldest-first window would push
// the item the DM just announced past the limit once enough rows sit undrained.
// The reader must always show it — and show it first.
func TestFeedbackQueue_NewestFirstSoTheAnnouncedItemIsReachable(t *testing.T) {
	store, _ := setupStoreWithDB(t)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetFeedbackReader(NewFeedbackReaderAPI(store))

	ctx := context.Background()
	base := time.Now().UTC().Add(-24 * time.Hour)
	// More rows than one response can carry, spread across accounts so the
	// per-account cap never trips.
	for i := 0; i < feedbackQueueLimit+5; i++ {
		account, _ := setupInvite(t, store)
		if _, err := store.AppendFeedback(ctx, account.ID, "cid", "bug", "1.2.3",
			[]byte("blob"), base.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	newest, _ := setupInvite(t, store)
	if _, err := store.AppendFeedback(ctx, newest.ID, "cid", "just-arrived", "9.9.9",
		[]byte("blob"), time.Now().UTC()); err != nil {
		t.Fatalf("append newest: %v", err)
	}

	token := mintToken(t, store, time.Now().UTC(), feedbackReaderTokenTTL)
	var body struct {
		Items []feedbackQueueItem `json:"items"`
	}
	if err := json.Unmarshal(getQueue(t, h, token).Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Items) != feedbackQueueLimit {
		t.Fatalf("got %d items, want the %d-row cap", len(body.Items), feedbackQueueLimit)
	}
	if body.Items[0].Kind != "just-arrived" {
		t.Fatalf("the just-announced item is not first: %+v", body.Items[0])
	}
}

// TestFeedbackQueue_NoAccountID: web feedback is anonymous, and this endpoint
// must not be the thing that de-anonymizes it. Asserted on the RAW JSON, not the
// struct, so an added field can't slip past a typed decode.
func TestFeedbackQueue_NoAccountID(t *testing.T) {
	store, _ := setupStoreWithDB(t)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetFeedbackReader(NewFeedbackReaderAPI(store))

	account, _ := setupInvite(t, store)
	if _, err := store.AppendFeedback(context.Background(), account.ID, "cid-1", "bug", "1.2.3",
		[]byte("blob"), time.Now().UTC()); err != nil {
		t.Fatalf("AppendFeedback: %v", err)
	}
	token := mintToken(t, store, time.Now().UTC(), feedbackReaderTokenTTL)
	raw := getQueue(t, h, token).Body.String()

	if strings.Contains(raw, "account_id") {
		t.Errorf("response carries an account_id field: %s", raw)
	}
	if strings.Contains(raw, account.ID) {
		t.Errorf("response leaks the account id value: %s", raw)
	}
	if strings.Contains(raw, "client_id") || strings.Contains(raw, "cid-1") {
		t.Errorf("response leaks the client id: %s", raw)
	}
}

// TestFeedbackQueue_TokenNotAcceptedAsQueryParam: the token travels in a header
// so it never lands in an access log or a Referer. A query param must not work.
func TestFeedbackQueue_TokenNotAcceptedAsQueryParam(t *testing.T) {
	store, _ := setupStoreWithDB(t)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetFeedbackReader(NewFeedbackReaderAPI(store))
	token := mintToken(t, store, time.Now().UTC(), feedbackReaderTokenTTL)

	r := httptest.NewRequest(http.MethodGet, feedbackQueuePath+"?t="+token+"&token="+token, nil)
	r.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("query-param token was accepted: got %d, want 401", rec.Code)
	}
}

// TestFeedbackReaderToken_StoredHashed: the raw token must never be at rest —
// scan every text/blob value in the table for it.
func TestFeedbackReaderToken_StoredHashed(t *testing.T) {
	store, db := setupStoreWithDB(t)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetFeedbackReader(NewFeedbackReaderAPI(store))
	token := mintToken(t, store, time.Now().UTC(), feedbackReaderTokenTTL)

	rows, err := db.QueryContext(context.Background(), `SELECT token_hash FROM feedback_reader_tokens`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	n := 0
	want := sha256.Sum256([]byte(token))
	for rows.Next() {
		var stored []byte
		if err := rows.Scan(&stored); err != nil {
			t.Fatalf("scan: %v", err)
		}
		n++
		if strings.Contains(string(stored), token) {
			t.Fatal("raw token found at rest in feedback_reader_tokens")
		}
		if string(stored) != string(want[:]) {
			t.Errorf("stored value is not the SHA-256 of the token")
		}
	}
	if n != 1 {
		t.Fatalf("want 1 stored token row, got %d", n)
	}
}

// TestFeedbackReaderToken_SweptOnMint: expired rows go away on the next mint —
// that is the whole retention policy (no background job).
func TestFeedbackReaderToken_SweptOnMint(t *testing.T) {
	store, db := setupStoreWithDB(t)
	past := time.Now().UTC().Add(-2 * time.Hour)
	old := sha256.Sum256([]byte("stale"))
	if err := store.MintFeedbackReaderToken(context.Background(), old[:], past, past.Add(time.Minute)); err != nil {
		t.Fatalf("mint stale: %v", err)
	}
	fresh := sha256.Sum256([]byte("fresh"))
	now := time.Now().UTC()
	if err := store.MintFeedbackReaderToken(context.Background(), fresh[:], now, now.Add(feedbackReaderTokenTTL)); err != nil {
		t.Fatalf("mint fresh: %v", err)
	}

	var count int
	if err := db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM feedback_reader_tokens`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expired row not swept on mint: %d rows remain", count)
	}
}

// TestFeedbackReaderToken_MultiUseWithinTTL: the developer reloads the page; a
// one-shot token would make that look like a bug.
func TestFeedbackReaderToken_MultiUseWithinTTL(t *testing.T) {
	store, _ := setupStoreWithDB(t)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	h.SetFeedbackReader(NewFeedbackReaderAPI(store))
	token := mintToken(t, store, time.Now().UTC(), feedbackReaderTokenTTL)

	for i := range 3 {
		if rec := getQueue(t, h, token); rec.Code != http.StatusOK {
			t.Fatalf("read %d: got %d, want 200", i+1, rec.Code)
		}
	}
}

// TestFeedbackQueue_NotMountedIs404: a deployment that never calls
// SetFeedbackReader answers like an unmounted route rather than erroring.
func TestFeedbackQueue_NotMountedIs404(t *testing.T) {
	store := setupStore(t)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), nil, "", false, false)
	if rec := getQueue(t, h, "anything"); rec.Code != http.StatusNotFound {
		t.Fatalf("unmounted queue: got %d, want 404", rec.Code)
	}
}

// TestFeedbackReaderPage_ServedOnBaseDomainOnly: /feedback is a base-domain
// shell page (web feedback is anonymous — there is no account to scope it to),
// and the vendored age bundle it decrypts with is served alongside it.
func TestFeedbackReaderPage_ServedOnBaseDomain(t *testing.T) {
	store := setupStore(t)
	shell := testFS()
	shell["feedback.html"] = &fstest.MapFile{Data: []byte("reader page")}
	app := testAppFS()
	app["vendor/age.min.js"] = &fstest.MapFile{Data: []byte("export const Decrypter = 1;")}
	h := New("localhost", store, shell, app, testDomainFS(), nil, "", false, false)

	for path, want := range map[string]string{
		feedbackReaderPath:    "reader page",
		feedbackAgeVendorPath: "export const Decrypter = 1;",
	} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Host = "localhost"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: got %d, want 200", path, rec.Code)
		}
		if got := rec.Body.String(); got != want {
			t.Errorf("GET %s = %q, want %q", path, got, want)
		}
		// The reader page makes exactly one same-origin fetch — no app-document
		// egress widening may leak onto the base domain.
		if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "connect-src 'self';") {
			t.Errorf("GET %s CSP is not connect-src 'self': %s", path, csp)
		}
	}
}

// TestFeedbackReaderPage_CSPAllowsBlobMediaOnly: decrypted screenshots and voice
// memos live only in page memory, so they render from blob: URLs — img-src and
// media-src must allow that, and nothing a script can execute through may.
func TestFeedbackReaderPage_CSPAllowsBlobMediaOnly(t *testing.T) {
	store := setupStore(t)
	shell := testFS()
	shell["feedback.html"] = &fstest.MapFile{Data: []byte("reader page")}
	h := New("localhost", store, shell, testAppFS(), testDomainFS(), nil, "", false, false)

	r := httptest.NewRequest(http.MethodGet, feedbackReaderPath, nil)
	r.Host = "localhost"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	csp := rec.Header().Get("Content-Security-Policy")

	for _, name := range []string{"img-src", "media-src"} {
		if got := cspDirective(csp, name); !strings.Contains(got, "blob:") {
			t.Errorf("%s = %q: decrypted attachments cannot render without blob:", name, got)
		}
	}
	// The script-execution half of the policy is untouched — an image is not code.
	for _, name := range []string{"default-src", "script-src", "worker-src"} {
		if got := cspDirective(csp, name); strings.Contains(got, "blob:") {
			t.Errorf("%s = %q carries blob: — the reader page must not widen script execution", name, got)
		}
	}
}
