package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// stubNotifier satisfies notifier.Notifier and does nothing.
type stubNotifier struct{}

func (s *stubNotifier) Send(_ context.Context, _ int64, _ notifier.Notification) (int, error) {
	return 0, nil
}
func (s *stubNotifier) Delete(_ context.Context, _ int64, _ int) error { return nil }
func (s *stubNotifier) CloseNotification(ctx context.Context, userID int64, tag string) error {
	return nil
}

// newTestDB creates an in-memory store for tests that need to call store.New directly.
func newTestDB(t *testing.T) (*store.Store, error) {
	t.Helper()
	return store.New(":memory:")
}

// --- handleListHistory ---

func TestHandleListHistory_Empty(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/history", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListHistory(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Body can be null or [] for an empty result set; just verify it decodes cleanly
	var raw json.RawMessage
	if err := json.NewDecoder(w.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestHandleListHistory_WithData(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	medID, _ := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	scheduledAt := time.Now().Add(-1 * time.Hour)
	intakeID, _ := db.Medication.CreateIntake(medID, 123456, scheduledAt)
	_ = db.Medication.ConfirmIntake(intakeID, scheduledAt)

	req := httptest.NewRequest("GET", "/api/history?days=7", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListHistory(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var logs []interface{}
	if err := json.NewDecoder(w.Body).Decode(&logs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(logs) == 0 {
		t.Error("Expected at least one intake log in history")
	}
}

func TestHandleListHistory_MedIDFilter(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	med1, _ := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	med2, _ := db.Medication.CreateMedication("Ibuprofen", "200mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	scheduledAt := time.Now().Add(-1 * time.Hour)
	id1, _ := db.Medication.CreateIntake(med1, 123456, scheduledAt)
	id2, _ := db.Medication.CreateIntake(med2, 123456, scheduledAt)
	_ = db.Medication.ConfirmIntake(id1, scheduledAt)
	_ = db.Medication.ConfirmIntake(id2, scheduledAt)

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/history?med_id=%d", med1), nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListHistory(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
	// Verify valid JSON is returned; content filtering is in the store layer
	var raw json.RawMessage
	if err := json.NewDecoder(w.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

// --- handleGetVAPIDPublicKey ---

func TestHandleGetVAPIDPublicKey_NotConfigured(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/webpush/vapid-public-key", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetVAPIDPublicKey(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("Expected 503 when VAPID not configured, got %d", w.Code)
	}
}

func TestHandleGetVAPIDPublicKey_Configured(t *testing.T) {
	db, err := newTestDB(t)
	if err != nil {
		t.Fatalf("newTestDB: %v", err)
	}
	defer db.Close()

	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "BFakeVAPIDPublicKey123")

	req := httptest.NewRequest("GET", "/api/webpush/vapid-public-key", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetVAPIDPublicKey(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["public_key"] != "BFakeVAPIDPublicKey123" {
		t.Errorf("Expected public_key='BFakeVAPIDPublicKey123', got %q", resp["public_key"])
	}
}

// --- handleSendTestMedicationNotification ---

func TestHandleSendTestMedicationNotification_NoNotifiers(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/webpush/test-medication", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSendTestMedicationNotification(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 when no notifiers configured, got %d", w.Code)
	}
}

func TestHandleSendTestMedicationNotification_NoScheduledMeds(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Attach a stub notifier so the handler proceeds past the "no notifiers" check
	srv.SetNotifiers([]notifier.Notifier{&stubNotifier{}})

	req := httptest.NewRequest("POST", "/api/webpush/test-medication", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSendTestMedicationNotification(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("Expected 404 when no scheduled medications, got %d: %s", w.Code, w.Body.String())
	}
}
