package cloudserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// newTestTransferHandler mirrors newTestAPIHandler (envelope_test.go): wires
// WebAuthn + transfer routes onto one mux so the test can mint a real session
// via the register ceremony before exercising /api/transfer.
func newTestTransferHandler(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	transferAPI := NewTransferAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	transferAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), host, claimToken
}

func TestTransferSlot_CreateClaimLifecycle(t *testing.T) {
	h, host, claimToken := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)

	body, _ := json.Marshal(createTransferRequest{CT: []byte("dek-ciphertext-bytes")})
	createReq := httptest.NewRequest(http.MethodPost, "/api/transfer", bytes.NewReader(body))
	createReq.Host = host
	createReq.AddCookie(session)
	createRec := httptest.NewRecorder()
	h.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("POST /api/transfer status = %d, body %q", createRec.Code, createRec.Body.String())
	}
	var created createTransferResponse
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	if created.SlotID == "" {
		t.Fatalf("expected slot_id, got %+v", created)
	}

	claimReq := httptest.NewRequest(http.MethodPost, "/api/transfer/"+created.SlotID+"/claim", nil)
	claimReq.Host = host
	claimRec := httptest.NewRecorder()
	h.ServeHTTP(claimRec, claimReq)
	if claimRec.Code != http.StatusOK {
		t.Fatalf("first claim status = %d, body %q", claimRec.Code, claimRec.Body.String())
	}
	var claimed claimTransferResponse
	if err := json.Unmarshal(claimRec.Body.Bytes(), &claimed); err != nil {
		t.Fatalf("unmarshal claim response: %v", err)
	}
	if string(claimed.CT) != "dek-ciphertext-bytes" || claimed.EnrollmentToken == "" {
		t.Fatalf("unexpected claim response: %+v", claimed)
	}

	// Single use: a second claim of the same slot must be rejected.
	secondReq := httptest.NewRequest(http.MethodPost, "/api/transfer/"+created.SlotID+"/claim", nil)
	secondReq.Host = host
	secondRec := httptest.NewRecorder()
	h.ServeHTTP(secondRec, secondReq)
	if secondRec.Code != http.StatusGone {
		t.Fatalf("second claim status = %d, want 410", secondRec.Code)
	}
}

func TestTransferSlot_ExpiredSlot410(t *testing.T) {
	store := setupStore(t)
	account, _ := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	transferAPI := NewTransferAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	transferAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	// Insert an already-expired slot directly through the store, bypassing
	// the HTTP layer's fixed 10-minute TTL, so expiry can be exercised
	// without a real clock wait.
	now := time.Now().UTC()
	if err := store.CreateTransferSlot(t.Context(), "expired-slot", account.ID, []byte("enrollment-token-hash-32-bytes-x"), []byte("ct"), now.Add(-time.Hour), now.Add(-time.Minute)); err != nil {
		t.Fatalf("CreateTransferSlot: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/transfer/expired-slot/claim", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusGone {
		t.Fatalf("expired slot claim status = %d, want 410, body %q", rec.Code, rec.Body.String())
	}
}
