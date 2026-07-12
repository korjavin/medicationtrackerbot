package cloudserver

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

func inboxTestServer(t *testing.T) (http.Handler, string, string, *http.Cookie, *cloudstore.Repo) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	inboxAPI := NewInboxAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	inboxAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	session := registerAndGetSession(t, h, host, claimToken)
	return h, host, account.ID, session, store
}

func putInboxKey(t *testing.T, h http.Handler, host string, session *http.Cookie, pub []byte) int {
	t.Helper()
	body, _ := json.Marshal(putInboxKeyRequest{PublicKey: pub})
	r := httptest.NewRequest(http.MethodPut, "/api/inbox/key", bytes.NewReader(body))
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code
}

func listInbox(t *testing.T, h http.Handler, host string, session *http.Cookie) listInboxResponse {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/inbox", nil)
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/inbox = %d: %s", rec.Code, rec.Body.String())
	}
	var res listInboxResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal inbox: %v", err)
	}
	return res
}

func ackInbox(t *testing.T, h http.Handler, host string, session *http.Cookie, id int64) int {
	t.Helper()
	r := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/inbox/%d", id), nil)
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code
}

// TestInbox_PublishSealDrainAck walks the whole foundation: a client publishes
// its public key, the server seals an event it cannot read, the client lists it,
// opens it with the private key, and acks it.
func TestInbox_PublishSealDrainAck(t *testing.T) {
	h, host, accountID, session, store := inboxTestServer(t)
	ctx := context.Background()

	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if code := putInboxKey(t, h, host, session, priv.PublicKey().Bytes()); code != http.StatusNoContent {
		t.Fatalf("PUT /api/inbox/key = %d", code)
	}

	plaintext := []byte(`{"kind":"intake_slot_action","action":"confirm"}`)
	now := time.Now().UTC().Truncate(time.Second)
	if err := SealAndQueue(ctx, store, accountID, plaintext, now); err != nil {
		t.Fatalf("SealAndQueue: %v", err)
	}

	res := listInbox(t, h, host, session)
	if len(res.Events) != 1 {
		t.Fatalf("expected 1 pending event, got %d", len(res.Events))
	}
	ev := res.Events[0]
	if ev.CreatedAtUnix != now.Unix() {
		t.Errorf("created_at_unix = %d, want %d", ev.CreatedAtUnix, now.Unix())
	}
	if bytes.Contains(ev.CT, plaintext) {
		t.Fatal("the mailbox row leaks its plaintext")
	}

	opened, err := openInbox(priv.Bytes(), accountID, ev.CT)
	if err != nil {
		t.Fatalf("client could not open its own event: %v", err)
	}
	if !bytes.Equal(opened, plaintext) {
		t.Fatalf("opened %q", opened)
	}

	if code := ackInbox(t, h, host, session, ev.ID); code != http.StatusNoContent {
		t.Fatalf("DELETE /api/inbox/%d = %d", ev.ID, code)
	}
	if got := listInbox(t, h, host, session); len(got.Events) != 0 {
		t.Fatalf("event survived its ack: %+v", got.Events)
	}
}

// Concurrent drainers are expected: the first ack wins, the second is a no-op
// rather than a 404/500 that would abort the other device's drain loop.
func TestInbox_AckIsIdempotent(t *testing.T) {
	h, host, accountID, session, store := inboxTestServer(t)
	ctx := context.Background()

	priv, _ := ecdh.X25519().GenerateKey(rand.Reader)
	putInboxKey(t, h, host, session, priv.PublicKey().Bytes())
	if err := SealAndQueue(ctx, store, accountID, []byte("x"), time.Now().UTC()); err != nil {
		t.Fatalf("SealAndQueue: %v", err)
	}
	id := listInbox(t, h, host, session).Events[0].ID

	for i := 0; i < 3; i++ {
		if code := ackInbox(t, h, host, session, id); code != http.StatusNoContent {
			t.Fatalf("ack #%d = %d, want 204", i+1, code)
		}
	}
}

// Events drain oldest-first by id, so two taps in the same second keep their
// arrival order — the drain applies them in server-timestamp order.
func TestInbox_DrainsOldestFirst(t *testing.T) {
	h, host, accountID, session, store := inboxTestServer(t)
	ctx := context.Background()

	priv, _ := ecdh.X25519().GenerateKey(rand.Reader)
	putInboxKey(t, h, host, session, priv.PublicKey().Bytes())

	sameSecond := time.Now().UTC().Truncate(time.Second)
	for _, body := range []string{"first", "second", "third"} {
		if err := SealAndQueue(ctx, store, accountID, []byte(body), sameSecond); err != nil {
			t.Fatalf("SealAndQueue(%s): %v", body, err)
		}
	}

	res := listInbox(t, h, host, session)
	if len(res.Events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(res.Events))
	}
	var got []string
	for _, e := range res.Events {
		pt, err := openInbox(priv.Bytes(), accountID, e.CT)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		got = append(got, string(pt))
	}
	if got[0] != "first" || got[1] != "second" || got[2] != "third" {
		t.Fatalf("drain order = %v", got)
	}
}

// Without a published key the server has nothing to seal to. It must refuse and
// drop the event — never persist the plaintext.
func TestInbox_SealAndQueueRequiresPublishedKey(t *testing.T) {
	h, host, accountID, session, store := inboxTestServer(t)

	err := SealAndQueue(context.Background(), store, accountID, []byte("secret"), time.Now().UTC())
	if !errors.Is(err, ErrNoInboxKey) {
		t.Fatalf("SealAndQueue with no key = %v, want ErrNoInboxKey", err)
	}
	if got := listInbox(t, h, host, session); len(got.Events) != 0 {
		t.Fatalf("an event was queued without a key: %+v", got.Events)
	}
}

func TestInbox_RejectsMalformedKey(t *testing.T) {
	h, host, _, session, _ := inboxTestServer(t)
	for _, bad := range [][]byte{nil, make([]byte, 31), make([]byte, 33)} {
		if code := putInboxKey(t, h, host, session, bad); code != http.StatusBadRequest {
			t.Errorf("PUT /api/inbox/key with %d-byte key = %d, want 400", len(bad), code)
		}
	}
}

// One account must never see, nor ack, another's events.
func TestInbox_IsolatedPerAccount(t *testing.T) {
	store := setupStore(t)
	accountA, claimA := setupInvite(t, store)
	accountB, claimB := setupInvite(t, store)
	hostA := accountA.Subdomain + ".localhost"
	hostB := accountB.Subdomain + ".localhost"

	secret := "test-session-secret-at-least-32-bytes-long"
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, secret).RegisterRoutes(mux)
	NewInboxAPI(store, secret).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	sessionA := registerAndGetSession(t, h, hostA, claimA)
	sessionB := registerAndGetSession(t, h, hostB, claimB)

	privA, _ := ecdh.X25519().GenerateKey(rand.Reader)
	privB, _ := ecdh.X25519().GenerateKey(rand.Reader)
	putInboxKey(t, h, hostA, sessionA, privA.PublicKey().Bytes())
	putInboxKey(t, h, hostB, sessionB, privB.PublicKey().Bytes())

	ctx := context.Background()
	if err := SealAndQueue(ctx, store, accountA.ID, []byte("for-a"), time.Now().UTC()); err != nil {
		t.Fatalf("SealAndQueue: %v", err)
	}

	if got := listInbox(t, h, hostB, sessionB); len(got.Events) != 0 {
		t.Fatalf("account B sees account A's events: %+v", got.Events)
	}
	eventA := listInbox(t, h, hostA, sessionA).Events[0]

	// B's ack of A's id must not delete it (scoped DELETE), and must not error.
	if code := ackInbox(t, h, hostB, sessionB, eventA.ID); code != http.StatusNoContent {
		t.Fatalf("cross-account ack = %d", code)
	}
	if got := listInbox(t, h, hostA, sessionA); len(got.Events) != 1 {
		t.Fatal("account B acked account A's event")
	}

	// B's key cannot open A's ciphertext either.
	if _, err := openInbox(privB.Bytes(), accountA.ID, eventA.CT); err == nil {
		t.Fatal("account B opened account A's sealed event")
	}
}

// A backlog of huge sealed events must not return one ~160MB body: the response
// is byte-capped, so a drain pages through it (ack → re-fetch → next chunk) even
// though the count cap alone would let all 200 through.
func TestInbox_ByteCapsResponse(t *testing.T) {
	h, host, accountID, session, store := inboxTestServer(t)
	ctx := context.Background()

	priv, _ := ecdh.X25519().GenerateKey(rand.Reader)
	putInboxKey(t, h, host, session, priv.PublicKey().Bytes())

	// Each sealed CT is a bit over 600 KiB, so any two together exceed the 1 MiB
	// budget — the cap must return exactly one per fetch.
	const events = 3
	now := time.Now().UTC().Truncate(time.Second)
	for i := 0; i < events; i++ {
		if err := SealAndQueue(ctx, store, accountID, bytes.Repeat([]byte{byte('a' + i)}, 600<<10), now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("SealAndQueue(%d): %v", i, err)
		}
	}

	// Page through the backlog: each fetch returns a byte-bounded prefix (here 1),
	// in id order, and acking it uncovers the next chunk.
	var seenIDs []int64
	for range make([]struct{}, events) {
		res := listInbox(t, h, host, session)
		if len(res.Events) != 1 {
			t.Fatalf("byte cap returned %d events, want 1 (budget=%d)", len(res.Events), maxInboxDrainBytes)
		}
		id := res.Events[0].ID
		if len(seenIDs) > 0 && id <= seenIDs[len(seenIDs)-1] {
			t.Fatalf("ids out of order: %d after %v", id, seenIDs)
		}
		seenIDs = append(seenIDs, id)
		if code := ackInbox(t, h, host, session, id); code != http.StatusNoContent {
			t.Fatalf("ack %d = %d", id, code)
		}
	}
	if got := listInbox(t, h, host, session); len(got.Events) != 0 {
		t.Fatalf("backlog not drained: %d events remain", len(got.Events))
	}
}

// TestInbox_ClearAll is the recovery escape hatch: DELETE /api/inbox drops the
// whole backlog, returns the count, and is account-scoped so it cannot touch
// another account's mailbox (med-eas.51).
func TestInbox_ClearAll(t *testing.T) {
	store := setupStore(t)
	accountA, claimA := setupInvite(t, store)
	accountB, claimB := setupInvite(t, store)
	hostA := accountA.Subdomain + ".localhost"
	hostB := accountB.Subdomain + ".localhost"

	secret := "test-session-secret-at-least-32-bytes-long"
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, secret).RegisterRoutes(mux)
	NewInboxAPI(store, secret).RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	sessionA := registerAndGetSession(t, h, hostA, claimA)
	sessionB := registerAndGetSession(t, h, hostB, claimB)

	privA, _ := ecdh.X25519().GenerateKey(rand.Reader)
	privB, _ := ecdh.X25519().GenerateKey(rand.Reader)
	putInboxKey(t, h, hostA, sessionA, privA.PublicKey().Bytes())
	putInboxKey(t, h, hostB, sessionB, privB.PublicKey().Bytes())

	ctx := context.Background()
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		if err := SealAndQueue(ctx, store, accountA.ID, []byte(fmt.Sprintf("a-%d", i)), now); err != nil {
			t.Fatalf("SealAndQueue A: %v", err)
		}
	}
	if err := SealAndQueue(ctx, store, accountB.ID, []byte("b-0"), now); err != nil {
		t.Fatalf("SealAndQueue B: %v", err)
	}

	// Clear A's mailbox: returns the count and empties it.
	r := httptest.NewRequest(http.MethodDelete, "/api/inbox", nil)
	r.Host = hostA
	r.AddCookie(sessionA)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE /api/inbox = %d: %s", rec.Code, rec.Body.String())
	}
	var res clearInboxResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal clear response: %v", err)
	}
	if res.Cleared != 3 {
		t.Fatalf("cleared = %d, want 3", res.Cleared)
	}
	if got := listInbox(t, h, hostA, sessionA); len(got.Events) != 0 {
		t.Fatalf("account A mailbox not empty after clear: %d", len(got.Events))
	}

	// Account B's event is untouched — clear is scoped.
	if got := listInbox(t, h, hostB, sessionB); len(got.Events) != 1 {
		t.Fatalf("clear on A affected B: %d events", len(got.Events))
	}
}

func TestInbox_RequiresSession(t *testing.T) {
	h, host, _, _, _ := inboxTestServer(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/inbox"},
		{http.MethodPut, "/api/inbox/key"},
		{http.MethodDelete, "/api/inbox/1"},
		{http.MethodDelete, "/api/inbox"},
	} {
		r := httptest.NewRequest(tc.method, tc.path, bytes.NewReader([]byte(`{}`)))
		r.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without a session = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

// Guards the base64 wire encoding of `ct` — the JS drain does fromBase64 on it.
func TestInbox_CTIsBase64OnTheWire(t *testing.T) {
	h, host, accountID, session, store := inboxTestServer(t)

	priv, _ := ecdh.X25519().GenerateKey(rand.Reader)
	putInboxKey(t, h, host, session, priv.PublicKey().Bytes())
	if err := SealAndQueue(context.Background(), store, accountID, []byte("x"), time.Now().UTC()); err != nil {
		t.Fatalf("SealAndQueue: %v", err)
	}

	r := httptest.NewRequest(http.MethodGet, "/api/inbox", nil)
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)

	var raw struct {
		Events []struct {
			CT string `json:"ct"`
		} `json:"events"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, err := base64.StdEncoding.DecodeString(raw.Events[0].CT); err != nil {
		t.Fatalf("ct is not std-base64: %v", err)
	}
}
