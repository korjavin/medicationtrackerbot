package cloudserver

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestSyncHandler mirrors cmd/cloud/main.go's wiring for the WebAuthn +
// transfer + device + sync routes, so the test can enroll a second device and
// drive the real sync contract end to end.
func newTestSyncHandler(t *testing.T, quotaBytes int64) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	transferAPI := NewTransferAPI(store, "test-session-secret-at-least-32-bytes-long")
	deviceAPI := NewDeviceAPI(store, "test-session-secret-at-least-32-bytes-long")
	syncAPI := NewSyncAPI(store, "test-session-secret-at-least-32-bytes-long", quotaBytes)
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	transferAPI.RegisterRoutes(mux)
	deviceAPI.RegisterRoutes(mux)
	syncAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), host, claimToken
}

func postOpsBatch(t *testing.T, h http.Handler, host string, session *http.Cookie, ops []opWire) (*http.Response, postOpsResponse) {
	t.Helper()
	body, _ := json.Marshal(postOpsRequest{Ops: ops})
	req := httptest.NewRequest(http.MethodPost, "/api/sync/ops", bytes.NewReader(body))
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out postOpsResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("unmarshal postOpsResponse: %v", err)
		}
	}
	return rec.Result(), out
}

func getOpsPage(t *testing.T, h http.Handler, host string, session *http.Cookie, query string) getOpsResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/sync/ops"+query, nil)
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/sync/ops%s status = %d, body %q", query, rec.Code, rec.Body.String())
	}
	var out getOpsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal getOpsResponse: %v", err)
	}
	return out
}

// TestSyncAPI_AppendAndListContract guards the oplog append/cursor contract:
// batches from two different devices (sessions) on the same account get
// strictly increasing, non-overlapping seqs, and paginated GETs replay the
// exact same ordered sequence.
func TestSyncAPI_AppendAndListContract(t *testing.T) {
	h, host, claimToken := newTestSyncHandler(t, 0) // quota disabled
	session1 := registerAndGetSession(t, h, host, claimToken)
	session2 := enrollSecondDevice(t, h, host, session1)

	resp, first := postOpsBatch(t, h, host, session1, []opWire{
		{RecordTypeTag: "note", Nonce: []byte("nonce-a"), CT: []byte("ciphertext-a")},
		{RecordTypeTag: "note", Nonce: []byte("nonce-b"), CT: []byte("ciphertext-b")},
		{RecordTypeTag: "note", Nonce: []byte("nonce-c"), CT: []byte("ciphertext-c")},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first POST /api/sync/ops status = %d", resp.StatusCode)
	}
	if len(first.Assigned) != 3 || first.Assigned[0] != 1 || first.Assigned[1] != 2 || first.Assigned[2] != 3 {
		t.Fatalf("expected seqs [1 2 3], got %v", first.Assigned)
	}

	resp, second := postOpsBatch(t, h, host, session2, []opWire{
		{RecordTypeTag: "note", Nonce: []byte("nonce-d"), CT: []byte("ciphertext-d")},
		{RecordTypeTag: "note", Nonce: []byte("nonce-e"), CT: []byte("ciphertext-e")},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("second POST /api/sync/ops status = %d", resp.StatusCode)
	}
	if len(second.Assigned) != 2 || second.Assigned[0] != 4 || second.Assigned[1] != 5 {
		t.Fatalf("expected seqs [4 5] continuing from the first device's batch, got %v", second.Assigned)
	}

	// Cursor pagination: a small page size must walk the full 5-op log
	// exactly once, in order, with next advancing to the last returned seq.
	page1 := getOpsPage(t, h, host, session1, "?since=0&limit=2")
	if len(page1.Ops) != 2 || page1.Ops[0].Seq != 1 || page1.Ops[1].Seq != 2 {
		t.Fatalf("page1 = %+v, want seqs [1 2]", page1.Ops)
	}
	if page1.Next == nil || *page1.Next != 2 {
		t.Fatalf("page1.Next = %v, want 2", page1.Next)
	}

	page2 := getOpsPage(t, h, host, session1, "?since=2&limit=2")
	if len(page2.Ops) != 2 || page2.Ops[0].Seq != 3 || page2.Ops[1].Seq != 4 {
		t.Fatalf("page2 = %+v, want seqs [3 4]", page2.Ops)
	}
	if page2.Next == nil || *page2.Next != 4 {
		t.Fatalf("page2.Next = %v, want 4", page2.Next)
	}

	page3 := getOpsPage(t, h, host, session1, "?since=4&limit=2")
	if len(page3.Ops) != 1 || page3.Ops[0].Seq != 5 {
		t.Fatalf("page3 = %+v, want seq [5]", page3.Ops)
	}
	if page3.Next != nil {
		t.Fatalf("page3.Next = %v, want nil (caught up)", *page3.Next)
	}
	if page3.Ops[0].RecordTypeTag != "note" || string(page3.Ops[0].CT) != "ciphertext-e" {
		t.Fatalf("page3 op = %+v, want the last-appended ciphertext", page3.Ops[0])
	}
}

// TestSyncAPI_QuotaRejected guards the per-account storage quota: a batch
// that would push total stored ciphertext past the account's quota is
// rejected wholesale (413), and nothing from the rejected batch is persisted.
func TestSyncAPI_QuotaRejected(t *testing.T) {
	h, host, claimToken := newTestSyncHandler(t, 32) // tiny quota
	session := registerAndGetSession(t, h, host, claimToken)

	resp, _ := postOpsBatch(t, h, host, session, []opWire{
		{RecordTypeTag: "note", Nonce: []byte("nonce-a"), CT: bytes.Repeat([]byte("x"), 64)},
	})
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}

	// Rejected batch must not have persisted anything.
	page := getOpsPage(t, h, host, session, "?since=0")
	if len(page.Ops) != 0 {
		t.Fatalf("expected no ops persisted after quota rejection, got %+v", page.Ops)
	}
}

func putSnapshot(t *testing.T, h http.Handler, host string, session *http.Cookie, req putSnapshotRequest) *http.Response {
	t.Helper()
	body, _ := json.Marshal(req)
	r := httptest.NewRequest(http.MethodPost, "/api/sync/snapshot", bytes.NewReader(body))
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Result()
}

func getSnapshot(t *testing.T, h http.Handler, host string, session *http.Cookie) *http.Response {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/sync/snapshot", nil)
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Result()
}

// TestSyncAPI_SnapshotCompaction guards the compaction contract: a snapshot
// uploaded at seq N compacts every oplog row <= N while later rows survive,
// and a fresh device can bootstrap from snapshot + ops-since alone.
func TestSyncAPI_SnapshotCompaction(t *testing.T) {
	h, host, claimToken := newTestSyncHandler(t, 0)
	session := registerAndGetSession(t, h, host, claimToken)

	// No snapshot yet.
	resp := getSnapshot(t, h, host, session)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("GET /api/sync/snapshot before upload: status = %d, want 204", resp.StatusCode)
	}

	_, appended := postOpsBatch(t, h, host, session, []opWire{
		{RecordTypeTag: "note", Nonce: []byte("nonce-a"), CT: []byte("ciphertext-a")},
		{RecordTypeTag: "note", Nonce: []byte("nonce-b"), CT: []byte("ciphertext-b")},
		{RecordTypeTag: "note", Nonce: []byte("nonce-c"), CT: []byte("ciphertext-c")},
	})
	if len(appended.Assigned) != 3 {
		t.Fatalf("expected 3 assigned seqs, got %v", appended.Assigned)
	}

	// Reject a snapshot_seq beyond the account's last_seq.
	resp = putSnapshot(t, h, host, session, putSnapshotRequest{SnapshotSeq: 99, Nonce: []byte("n"), CT: []byte("snapshot-ahead")})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("PUT snapshot ahead of last_seq: status = %d, want 400", resp.StatusCode)
	}

	// Compact seq <= 2.
	resp = putSnapshot(t, h, host, session, putSnapshotRequest{SnapshotSeq: 2, Nonce: []byte("snap-nonce"), CT: []byte("snapshot-ct")})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("PUT /api/sync/snapshot: status = %d, want 204", resp.StatusCode)
	}

	// Op 3 (seq > snapshot_seq) survives; ops 1-2 are gone.
	tail := getOpsPage(t, h, host, session, "?since=0")
	if len(tail.Ops) != 1 || tail.Ops[0].Seq != 3 {
		t.Fatalf("oplog after compaction = %+v, want only seq 3 to survive", tail.Ops)
	}
	// The compaction floor is surfaced so a lagging device (cursor below 2) can
	// detect it was compacted past and re-bootstrap instead of skipping ops 1-2.
	if tail.SnapshotSeq != 2 {
		t.Fatalf("GET ops snapshot_seq = %d, want 2 (the compaction floor)", tail.SnapshotSeq)
	}

	// A fresh device bootstraps from snapshot + ops-since alone.
	resp = getSnapshot(t, h, host, session)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/sync/snapshot after upload: status = %d, want 200", resp.StatusCode)
	}
	var snap getSnapshotResponse
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		t.Fatalf("decode getSnapshotResponse: %v", err)
	}
	if snap.SnapshotSeq != 2 || string(snap.CT) != "snapshot-ct" {
		t.Fatalf("snapshot = %+v, want seq 2 / ct 'snapshot-ct'", snap)
	}
	bootstrapTail := getOpsPage(t, h, host, session, fmt.Sprintf("?since=%d", snap.SnapshotSeq))
	if len(bootstrapTail.Ops) != 1 || bootstrapTail.Ops[0].Seq != 3 || string(bootstrapTail.Ops[0].CT) != "ciphertext-c" {
		t.Fatalf("bootstrap tail = %+v, want only seq 3 / ciphertext-c", bootstrapTail.Ops)
	}
}

// TestSyncAPI_SnapshotCompressRoundTrip guards the compress-before-encrypt
// snapshot format at its real server boundary (the size caps). The server
// treats ct as opaque bytes, so the client's gzip(JSON) ciphertext must POST
// under the raised cap and GET back byte-identical; a legacy uncompressed
// ciphertext must still round-trip. The plaintext gzip magic-byte assertion
// stands in for the client's decrypt-time sniff — 0x1f 0x8b means gunzip,
// '[' means raw JSON.
func TestSyncAPI_SnapshotCompressRoundTrip(t *testing.T) {
	h, host, claimToken := newTestSyncHandler(t, 0)
	session := registerAndGetSession(t, h, host, claimToken)

	// A vault plaintext bigger than the OLD 8 MiB cap, so an uncompressed
	// upload would have been truncated → 400. Varied per-record content keeps
	// the gzip ratio realistic rather than degenerate.
	type record struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
		Note string `json:"note"`
	}
	recs := make([]record, 0, 80000)
	for i := 0; i < 80000; i++ {
		recs = append(recs, record{
			ID:   i,
			Name: fmt.Sprintf("medication-%d-%x", i, i*2654435761),
			Note: fmt.Sprintf("took dose %d at hour %d, felt %d/10, next refill in %d days", i, i%24, i%11, i%90),
		})
	}
	plaintext, err := json.Marshal(recs)
	if err != nil {
		t.Fatalf("marshal vault: %v", err)
	}
	const oldCap = 8 << 20
	if len(plaintext) <= oldCap {
		t.Fatalf("test vault plaintext = %d bytes, want > old 8 MiB cap to be representative", len(plaintext))
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(plaintext); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	gzipped := buf.Bytes()

	// Compression is what makes the vault fit: gzip shrinks it well under the
	// raised cap, and the magic bytes are what the client sniffs on decrypt.
	if len(gzipped) >= maxSnapshotBodyBytes {
		t.Fatalf("gzipped vault = %d bytes, not under raised cap %d", len(gzipped), maxSnapshotBodyBytes)
	}
	if len(gzipped) >= len(plaintext) {
		t.Fatalf("gzip did not shrink the vault: %d >= %d", len(gzipped), len(plaintext))
	}
	if gzipped[0] != 0x1f || gzipped[1] != 0x8b {
		t.Fatalf("gzip magic bytes = %#x %#x, want 0x1f 0x8b", gzipped[0], gzipped[1])
	}

	// Need last_seq >= 1 before a snapshot at seq 1 is accepted.
	postOpsBatch(t, h, host, session, []opWire{
		{RecordTypeTag: "note", Nonce: []byte("nonce-a"), CT: []byte("ciphertext-a")},
	})

	resp := putSnapshot(t, h, host, session, putSnapshotRequest{SnapshotSeq: 1, Nonce: []byte("snap-nonce"), CT: gzipped})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("POST compressed snapshot: status = %d, want 204", resp.StatusCode)
	}

	resp = getSnapshot(t, h, host, session)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET snapshot: status = %d, want 200", resp.StatusCode)
	}
	var got getSnapshotResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if !bytes.Equal(got.CT, gzipped) {
		t.Fatalf("snapshot ct not byte-identical: got %d bytes, want %d", len(got.CT), len(gzipped))
	}

	// A legacy uncompressed snapshot (raw JSON ciphertext starting with '[')
	// must still round-trip so already-deployed accounts keep bootstrapping.
	// The compaction floor is monotonic, so advance the oplog and snapshot at a
	// higher seq to replace the compressed one above.
	postOpsBatch(t, h, host, session, []opWire{
		{RecordTypeTag: "note", Nonce: []byte("nonce-b"), CT: []byte("ciphertext-b")},
	})
	legacy := []byte(`[{"id":1,"name":"legacy"}]`)
	if legacy[0] != '[' {
		t.Fatalf("legacy fixture must start with '[' to model a raw-JSON snapshot")
	}
	resp = putSnapshot(t, h, host, session, putSnapshotRequest{SnapshotSeq: 2, Nonce: []byte("legacy-nonce"), CT: legacy})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("POST legacy snapshot: status = %d, want 204", resp.StatusCode)
	}
	resp = getSnapshot(t, h, host, session)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET legacy snapshot: status = %d, want 200", resp.StatusCode)
	}
	var gotLegacy getSnapshotResponse
	if err := json.NewDecoder(resp.Body).Decode(&gotLegacy); err != nil {
		t.Fatalf("decode legacy snapshot: %v", err)
	}
	if !bytes.Equal(gotLegacy.CT, legacy) {
		t.Fatalf("legacy snapshot ct not byte-identical: got %q, want %q", gotLegacy.CT, legacy)
	}
}

// TestSyncAPI_SnapshotCapBoundary directly guards the 8→64 MiB cap raise, which
// the round-trip test above does NOT: its gzipped body is ~1.5 MiB (well under
// the old cap), so it would still pass if maxSnapshotBodyBytes regressed. Here
// the CT is opaque bytes sized against the boundary — a ~16 MiB CT (base64 body
// ~21 MiB, over the old 8 MiB cap) must be accepted, and a body past 64 MiB must
// be rejected because io.LimitReader truncates it into an invalid JSON decode.
func TestSyncAPI_SnapshotCapBoundary(t *testing.T) {
	h, host, claimToken := newTestSyncHandler(t, 0)
	session := registerAndGetSession(t, h, host, claimToken)

	// last_seq >= 1 so a snapshot at seq 1 is accepted.
	postOpsBatch(t, h, host, session, []opWire{
		{RecordTypeTag: "note", Nonce: []byte("nonce-a"), CT: []byte("ciphertext-a")},
	})

	// ~16 MiB opaque CT: base64-encoded body exceeds the old 8 MiB cap but sits
	// under the raised 64 MiB one. If the cap regressed to 8 MiB, LimitReader
	// would truncate this into a decode failure → 400, failing the test.
	const midCap = 16 << 20
	if midCap <= 8<<20 || midCap >= maxSnapshotBodyBytes {
		t.Fatalf("midCap %d must sit between old 8 MiB cap and raised cap %d", midCap, maxSnapshotBodyBytes)
	}
	resp := putSnapshot(t, h, host, session, putSnapshotRequest{
		SnapshotSeq: 1, Nonce: []byte("snap-nonce"), CT: bytes.Repeat([]byte{0xAB}, midCap),
	})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("POST 16 MiB snapshot under raised cap: status = %d, want 204", resp.StatusCode)
	}

	// A body past the 64 MiB cap is truncated by LimitReader → invalid JSON → 400.
	resp = putSnapshot(t, h, host, session, putSnapshotRequest{
		SnapshotSeq: 2, Nonce: []byte("snap-nonce"), CT: bytes.Repeat([]byte{0xCD}, maxSnapshotBodyBytes+(1<<20)),
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST over-cap snapshot: status = %d, want 400", resp.StatusCode)
	}
}
