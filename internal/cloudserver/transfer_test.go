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

// createSlot opens a transfer slot over HTTP for the given session and returns
// its id — the same path the "Add a device" screen takes.
func createSlot(t *testing.T, h http.Handler, host string, session *http.Cookie) string {
	t.Helper()
	body, _ := json.Marshal(createTransferRequest{CT: []byte("dek-ciphertext-bytes")})
	req := httptest.NewRequest(http.MethodPost, "/api/transfer", bytes.NewReader(body))
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/transfer status = %d, body %q", rec.Code, rec.Body.String())
	}
	var created createTransferResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("unmarshal create response: %v", err)
	}
	return created.SlotID
}

func doSlot(t *testing.T, h http.Handler, method, host, slotID string, session *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/api/transfer/"+slotID, nil)
	req.Host = host
	if session != nil {
		req.AddCookie(session)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func claimSlot(t *testing.T, h http.Handler, host, slotID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/transfer/"+slotID+"/claim", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// bd med-tuv — the originating "Add a device" screen kept counting down and
// offering Cancel long after the new device had enrolled, because there was no
// way to ask the server what had happened. GET /api/transfer/{slot_id} is that
// way.
func TestTransferSlot_StatusReportsPendingThenClaimed(t *testing.T) {
	h, host, claimToken := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	slotID := createSlot(t, h, host, session)

	rec := doSlot(t, h, http.MethodGet, host, slotID, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body %q", rec.Code, rec.Body.String())
	}
	var status transferStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if status.Status != "pending" {
		t.Errorf("status = %q, want pending", status.Status)
	}

	if rec := claimSlot(t, h, host, slotID); rec.Code != http.StatusOK {
		t.Fatalf("claim status = %d", rec.Code)
	}

	rec = doSlot(t, h, http.MethodGet, host, slotID, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET after claim status = %d, body %q", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if status.Status != "claimed" {
		t.Errorf("status = %q, want claimed", status.Status)
	}
}

// A slot id must not be a status oracle for whoever merely holds the QR code.
func TestTransferSlot_StatusRequiresTheOwningSession(t *testing.T) {
	h, host, claimToken := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	slotID := createSlot(t, h, host, session)

	if rec := doSlot(t, h, http.MethodGet, host, slotID, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("GET without a session status = %d, want 401", rec.Code)
	}

	// An unknown slot is indistinguishable from someone else's.
	if rec := doSlot(t, h, http.MethodGet, host, "no-such-slot", session); rec.Code != http.StatusNotFound {
		t.Errorf("GET unknown slot status = %d, want 404", rec.Code)
	}
}

func TestTransferSlot_StatusOfAnotherAccountsSlot404s(t *testing.T) {
	store := setupStore(t)
	victim, victimToken := setupInvite(t, store)
	attacker, attackerToken := setupInvite(t, store)

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	transferAPI := NewTransferAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	transferAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	victimHost := victim.Subdomain + ".localhost"
	victimSession := registerAndGetSession(t, h, victimHost, victimToken)
	victimSlot := createSlot(t, h, victimHost, victimSession)

	attackerHost := attacker.Subdomain + ".localhost"
	attackerSession := registerAndGetSession(t, h, attackerHost, attackerToken)

	// The attacker holds the victim's slot id (they photographed the QR) and a
	// valid session of their own. They must learn nothing about that slot.
	rec := doSlot(t, h, http.MethodGet, attackerHost, victimSlot, attackerSession)
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET another account's slot status = %d, want 404, body %q", rec.Code, rec.Body.String())
	}

	// And they cannot cancel it out from under the victim.
	if rec := doSlot(t, h, http.MethodDelete, attackerHost, victimSlot, attackerSession); rec.Code != http.StatusNoContent {
		t.Errorf("DELETE another account's slot status = %d, want 204 (no oracle)", rec.Code)
	}
	if rec := claimSlot(t, h, victimHost, victimSlot); rec.Code != http.StatusOK {
		t.Errorf("victim's slot was destroyed by another account's DELETE: claim status = %d, want 200", rec.Code)
	}
}

// The defect that matters: Cancel used to clear a local timer and navigate away,
// leaving the slot live and claimable for the rest of its window. A user who had
// shown the QR to the wrong person pressed Cancel and believed the code was
// dead. It was not.
func TestTransferSlot_CancelledSlotCannotBeClaimed(t *testing.T) {
	h, host, claimToken := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	slotID := createSlot(t, h, host, session)

	if rec := doSlot(t, h, http.MethodDelete, host, slotID, session); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d, body %q", rec.Code, rec.Body.String())
	}

	if rec := claimSlot(t, h, host, slotID); rec.Code != http.StatusGone {
		t.Fatalf("claim after cancel status = %d, want 410 — the code is still live", rec.Code)
	}

	// And the originating device sees it is gone.
	if rec := doSlot(t, h, http.MethodGet, host, slotID, session); rec.Code != http.StatusNotFound {
		t.Errorf("GET after cancel status = %d, want 404", rec.Code)
	}
}

func TestTransferSlot_CancelIsIdempotentAndNeedsASession(t *testing.T) {
	h, host, claimToken := newTestTransferHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	slotID := createSlot(t, h, host, session)

	if rec := doSlot(t, h, http.MethodDelete, host, slotID, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("DELETE without a session status = %d, want 401", rec.Code)
	}

	for i := range 2 {
		// Cancelling twice must not error: the user's intent ("this code must not
		// work") holds either way, and a 500 on the second press would be noise.
		if rec := doSlot(t, h, http.MethodDelete, host, slotID, session); rec.Code != http.StatusNoContent {
			t.Errorf("DELETE #%d status = %d, want 204", i+1, rec.Code)
		}
	}
}

// An expired slot is not "pending" — the countdown and the server must agree.
func TestTransferSlot_StatusOfExpiredSlot404s(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	transferAPI := NewTransferAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	transferAPI.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)

	// Insert an already-expired slot straight through the store, bypassing the
	// HTTP layer's fixed 10-minute TTL (as TestTransferSlot_ExpiredSlot410 does).
	now := time.Now().UTC()
	if err := store.CreateTransferSlot(t.Context(), "expired-slot", account.ID, []byte("enrollment-token-hash-32-bytes-x"), []byte("ct"), now.Add(-time.Hour), now.Add(-time.Minute)); err != nil {
		t.Fatalf("CreateTransferSlot: %v", err)
	}

	if rec := doSlot(t, h, http.MethodGet, host, "expired-slot", session); rec.Code != http.StatusNotFound {
		t.Errorf("GET expired slot status = %d, want 404", rec.Code)
	}
}
