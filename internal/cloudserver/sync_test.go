package cloudserver

import (
	"bytes"
	"encoding/json"
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

	return New("localhost", store, testFS(), mux), host, claimToken
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
