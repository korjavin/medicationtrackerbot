package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func createGenericTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	return srv, db
}

func TestServeConfigJS(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/static/config.js", nil)
	w := httptest.NewRecorder()

	srv.serveConfigJS(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	if ct := w.Header().Get("Content-Type"); ct != "application/javascript" {
		t.Errorf("Expected application/javascript, got %q", ct)
	}

	body := w.Body.String()
	if !strings.Contains(body, "window.BOT_USERNAME") {
		t.Errorf("Body missing window.BOT_USERNAME: %s", body)
	}
	if !strings.Contains(body, "window.OIDC_CONFIG") {
		t.Errorf("Body missing window.OIDC_CONFIG: %s", body)
	}
}

// --- Restock handlers ---

func TestHandleRestock(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	medID, _ := db.Medication.Create("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	count := 10
	db.Medication.SetInventory(medID, &count)

	reqBody := map[string]interface{}{
		"quantity": 20,
		"note":     "Monthly refill",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/medications/%d/restock", medID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprintf("%d", medID))
	w := httptest.NewRecorder()

	srv.handleRestock(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["status"] != "restocked" {
		t.Errorf("Expected status 'restocked', got %v", resp["status"])
	}
	if resp["quantity_added"] != float64(20) {
		t.Errorf("Expected quantity_added 20, got %v", resp["quantity_added"])
	}

	// Verify DB
	med, _ := db.Medication.Get(medID)
	if med.InventoryCount == nil || *med.InventoryCount != 30 {
		t.Errorf("Expected inventory 30, got %v", med.InventoryCount)
	}
}

func TestHandleRestock_InvalidQuantity(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	medID, _ := db.Medication.Create("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	reqBody := map[string]interface{}{"quantity": 0}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/medications/%d/restock", medID), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprintf("%d", medID))
	w := httptest.NewRecorder()

	srv.handleRestock(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for zero quantity, got %d", w.Code)
	}
}

func TestHandleListRestocks(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	medID, _ := db.Medication.Create("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	db.Medication.CreateRestock(medID, 30, "Initial")

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/medications/%d/restocks", medID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", medID))
	w := httptest.NewRecorder()

	srv.handleListRestocks(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var restocks []store.Restock
	json.NewDecoder(w.Body).Decode(&restocks)

	if len(restocks) != 1 {
		t.Fatalf("Expected 1 restock, got %d", len(restocks))
	}
	if restocks[0].Quantity != 30 {
		t.Errorf("Expected quantity 30, got %d", restocks[0].Quantity)
	}
}

func TestHandleGetLowStock(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Create a medication with low stock
	medID, _ := db.Medication.Create("LowMed", "10mg", `{"type":"daily","times":["09:00","21:00"]}`, nil, nil, "", "", "")
	count := 3
	db.Medication.SetInventory(medID, &count)

	req := httptest.NewRequest("GET", "/api/inventory/low?days=7", nil)
	w := httptest.NewRecorder()

	srv.handleGetLowStock(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var result []map[string]interface{}
	json.NewDecoder(w.Body).Decode(&result)

	if len(result) == 0 {
		t.Error("Expected at least 1 low stock medication")
	}
}

// --- Push subscription handlers ---

func TestHandleSubscribePush(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{
		"endpoint": "https://push.example.com/test",
		"keys": map[string]string{
			"auth":   "test-auth-key",
			"p256dh": "test-p256dh-key",
		},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/webpush/subscribe", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSubscribePush(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify in DB
	subs, _ := db.Push.List(123456)
	if len(subs) != 1 {
		t.Fatalf("Expected 1 subscription, got %d", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/test" {
		t.Errorf("Expected endpoint, got %q", subs[0].Endpoint)
	}
}

func TestHandleUnsubscribePush(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Create subscription first
	db.Push.Create(123456, "https://push.example.com/test", "auth", "p256dh")

	reqBody := map[string]interface{}{
		"endpoint": "https://push.example.com/test",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/webpush/unsubscribe", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleUnsubscribePush(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	subs, _ := db.Push.List(123456)
	if len(subs) != 0 {
		t.Errorf("Expected 0 subscriptions after unsubscribe, got %d", len(subs))
	}
}

func TestHandleListPushSubscriptions(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	db.Push.Create(123456, "https://push.example.com/1", "auth1", "p256dh1")
	db.Push.Create(123456, "https://push.example.com/2", "auth2", "p256dh2")

	req := httptest.NewRequest("GET", "/api/webpush/subscriptions", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListPushSubscriptions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var subs []store.PushSubscription
	json.NewDecoder(w.Body).Decode(&subs)

	if len(subs) != 2 {
		t.Errorf("Expected 2 subscriptions, got %d", len(subs))
	}
}

// --- Confirm schedule handler ---

func TestHandleConfirmSchedule_WithIntakeIDs(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.Create("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	count := 10
	db.Medication.SetInventory(medID, &count)

	schedTime := time.Now()
	intakeID, _ := db.Medication.CreateIntake(medID, userID, schedTime)

	reqBody := map[string]interface{}{
		"intake_ids": []int64{intakeID},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/confirm-schedule", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleConfirmSchedule(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify intake confirmed
	intake, _ := db.Medication.GetIntake(intakeID)
	if intake.Status != "TAKEN" {
		t.Errorf("Expected status TAKEN, got %s", intake.Status)
	}

	// Verify inventory decremented
	med, _ := db.Medication.Get(medID)
	if med.InventoryCount == nil || *med.InventoryCount != 9 {
		t.Errorf("Expected inventory 9, got %v", med.InventoryCount)
	}
}

func TestHandleConfirmSchedule_RevertsAllTakenIntakesWhenEmpty(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID1, _ := db.Medication.Create("TestMed1", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	count1 := 10
	db.Medication.SetInventory(medID1, &count1)

	schedTime := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intake1, _ := db.Medication.CreateIntake(medID1, userID, schedTime)

	// Mark as TAKEN initially
	db.Medication.ConfirmIntake(intake1, time.Now())
	db.Medication.DecrementInventory(medID1, 1) // Simulate inventory decremented

	// Client sends empty medication_ids to confirm-schedule
	reqBody := map[string]interface{}{
		"scheduled_at":   schedTime.Format(time.RFC3339),
		"medication_ids": []int64{},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/confirm-schedule", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleConfirmSchedule(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify med1 intake reverted to PENDING
	i1, _ := db.Medication.GetIntake(intake1)
	if i1.Status != "PENDING" {
		t.Errorf("Expected intake 1 status PENDING, got %s", i1.Status)
	}
	if i1.TakenAt != nil {
		t.Errorf("Expected intake 1 taken_at to be nil, got %v", i1.TakenAt)
	}

	// Verify inventory
	m1, _ := db.Medication.Get(medID1)
	if *m1.InventoryCount != 10 { // Should have incremented back from 9
		t.Errorf("Expected med1 inventory 10, got %v", m1.InventoryCount)
	}
}

func TestHandleConfirmSchedule_RevertsUncheckedTakenIntake(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID1, _ := db.Medication.Create("TestMed1", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	medID2, _ := db.Medication.Create("TestMed2", "20mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	count1 := 10
	db.Medication.SetInventory(medID1, &count1)
	count2 := 10
	db.Medication.SetInventory(medID2, &count2)

	schedTime := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intake1, _ := db.Medication.CreateIntake(medID1, userID, schedTime)
	intake2, _ := db.Medication.CreateIntake(medID2, userID, schedTime)

	// Mark both as TAKEN initially
	db.Medication.ConfirmIntake(intake1, time.Now())
	db.Medication.DecrementInventory(medID1, 1) // Simulate inventory decremented
	db.Medication.ConfirmIntake(intake2, time.Now())
	db.Medication.DecrementInventory(medID2, 1) // Simulate inventory decremented

	// Client sends only medID1 to confirm-schedule
	reqBody := map[string]interface{}{
		"scheduled_at":   schedTime.Format(time.RFC3339),
		"medication_ids": []int64{medID1},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/confirm-schedule", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleConfirmSchedule(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify med1 intake is still TAKEN
	i1, _ := db.Medication.GetIntake(intake1)
	if i1.Status != "TAKEN" {
		t.Errorf("Expected intake 1 status TAKEN, got %s", i1.Status)
	}

	// Verify med2 intake reverted to PENDING
	i2, _ := db.Medication.GetIntake(intake2)
	if i2.Status != "PENDING" {
		t.Errorf("Expected intake 2 status PENDING, got %s", i2.Status)
	}
	if i2.TakenAt != nil {
		t.Errorf("Expected intake 2 taken_at to be nil, got %v", i2.TakenAt)
	}

	// Verify inventory
	m1, _ := db.Medication.Get(medID1)
	if *m1.InventoryCount != 9 {
		t.Errorf("Expected med1 inventory 9, got %v", m1.InventoryCount)
	}
	m2, _ := db.Medication.Get(medID2)
	if *m2.InventoryCount != 10 { // Should have incremented back from 9
		t.Errorf("Expected med2 inventory 10, got %v", m2.InventoryCount)
	}
}

func TestHandleConfirmSchedule_ConfirmsAndRevertsInSameRequest(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID1, _ := db.Medication.Create("TestMed1", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	medID2, _ := db.Medication.Create("TestMed2", "20mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	count1 := 10
	db.Medication.SetInventory(medID1, &count1)
	count2 := 10
	db.Medication.SetInventory(medID2, &count2)

	schedTime := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intake1, _ := db.Medication.CreateIntake(medID1, userID, schedTime)
	intake2, _ := db.Medication.CreateIntake(medID2, userID, schedTime)

	// med1 is PENDING, med2 is TAKEN
	db.Medication.ConfirmIntake(intake2, time.Now())
	db.Medication.DecrementInventory(medID2, 1)

	// Client unchecks med2, checks med1
	reqBody := map[string]interface{}{
		"scheduled_at":   schedTime.Format(time.RFC3339),
		"medication_ids": []int64{medID1},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/confirm-schedule", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleConfirmSchedule(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify med1 intake is now TAKEN
	i1, _ := db.Medication.GetIntake(intake1)
	if i1.Status != "TAKEN" {
		t.Errorf("Expected intake 1 status TAKEN, got %s", i1.Status)
	}

	// Verify med2 intake reverted to PENDING
	i2, _ := db.Medication.GetIntake(intake2)
	if i2.Status != "PENDING" {
		t.Errorf("Expected intake 2 status PENDING, got %s", i2.Status)
	}

	// Verify inventory
	m1, _ := db.Medication.Get(medID1)
	if *m1.InventoryCount != 9 { // Should have decremented from 10
		t.Errorf("Expected med1 inventory 9, got %v", m1.InventoryCount)
	}
	m2, _ := db.Medication.Get(medID2)
	if *m2.InventoryCount != 10 { // Should have incremented back from 9
		t.Errorf("Expected med2 inventory 10, got %v", m2.InventoryCount)
	}
}

// --- Log past intake handler ---

func TestHandleLogPastIntake(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.Create("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	takenAt := time.Now().Add(-2 * time.Hour)
	reqBody := map[string]interface{}{
		"medication_id": medID,
		"taken_at":      takenAt.Format(time.RFC3339),
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/log-past", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleLogPastIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify in DB
	history, _ := db.Medication.ListIntakeHistory(int(medID), 1)
	if len(history) == 0 {
		t.Error("Expected at least 1 intake in history")
	}
}

// TestLogPastIntake_AppearsInListHistory reproduces the reported bug: a user
// logs a past intake via the schedule page's "Log" button (POST
// /api/medications/log-past) and expects to see it immediately when they
// open the intake history page (GET /api/history?days=3&med_id=0). This
// exercises both HTTP handlers in one flow so handler/serialization bugs are
// caught.
func TestLogPastIntake_AppearsInListHistory(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, err := db.Medication.Create("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	cases := []struct {
		name    string
		takenAt time.Time
	}{
		{name: "now", takenAt: time.Now()},
		{name: "a few hours ago", takenAt: time.Now().Add(-5 * time.Hour)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 1) POST /api/medications/log-past — mirror the frontend payload.
			reqBody := map[string]interface{}{
				"medication_id": medID,
				"taken_at":      tc.takenAt.Format(time.RFC3339),
			}
			body, _ := json.Marshal(reqBody)

			postReq := httptest.NewRequest("POST", "/api/medications/log-past", bytes.NewReader(body))
			postReq = withUser(postReq, userID)
			postW := httptest.NewRecorder()

			srv.handleLogPastIntake(postW, postReq)

			if postW.Code != http.StatusOK {
				t.Fatalf("log-past: expected 200, got %d. Body: %s", postW.Code, postW.Body.String())
			}

			var postResp store.IntakeLog
			if err := json.NewDecoder(postW.Body).Decode(&postResp); err != nil {
				t.Fatalf("decode log-past response: %v", err)
			}
			if postResp.ID == 0 {
				t.Fatalf("log-past: expected non-zero id, got 0")
			}
			if postResp.MedicationID != medID {
				t.Errorf("log-past: medication_id = %d, want %d", postResp.MedicationID, medID)
			}
			if postResp.Status != "TAKEN" {
				t.Errorf("log-past: status = %q, want TAKEN", postResp.Status)
			}
			if postResp.TakenAt == nil {
				t.Errorf("log-past: taken_at is nil, want non-nil")
			}
			if postResp.ScheduledAt.IsZero() {
				t.Errorf("log-past: scheduled_at is zero, want non-zero")
			}

			// 2) GET /api/history?days=3&med_id=0 — matches frontend defaults.
			getReq := httptest.NewRequest("GET", "/api/history?days=3&med_id=0", nil)
			getReq = withUser(getReq, userID)
			getW := httptest.NewRecorder()

			srv.handleListHistory(getW, getReq)

			if getW.Code != http.StatusOK {
				t.Fatalf("history: expected 200, got %d. Body: %s", getW.Code, getW.Body.String())
			}

			var logs []store.IntakeLog
			if err := json.NewDecoder(getW.Body).Decode(&logs); err != nil {
				t.Fatalf("decode history response: %v", err)
			}

			found := false
			for _, l := range logs {
				if l.ID == postResp.ID {
					if l.Status != "TAKEN" {
						t.Errorf("history entry status = %q, want TAKEN", l.Status)
					}
					if l.MedicationID != medID {
						t.Errorf("history entry medication_id = %d, want %d", l.MedicationID, medID)
					}
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("logged intake id=%d not found in history response (%d entries): %+v", postResp.ID, len(logs), logs)
			}
		})
	}
}

// --- Weight reminder handlers ---

func TestHandleGetWeightReminderStatus(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/weight/reminder/status", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetWeightReminderStatus(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)

	// Default state should have enabled field
	if _, ok := resp["enabled"]; !ok {
		t.Error("Expected 'enabled' field in response")
	}
}

func TestHandleToggleWeightReminder(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{"enabled": true}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/weight/reminder/toggle", bytes.NewReader(body))
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleToggleWeightReminder(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify state
	state, _ := db.Weight.GetReminderState(123456)
	if !state.Enabled {
		t.Error("Expected weight reminder to be enabled")
	}
}

func TestHandleSnoozeWeightReminder(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	// Enable first
	db.Weight.SetReminderEnabled(123456, true)

	req := httptest.NewRequest("POST", "/api/weight/reminder/snooze", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSnoozeWeightReminder(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	state, _ := db.Weight.GetReminderState(123456)
	if state.SnoozedUntil == nil {
		t.Error("Expected snooze to be set")
	}
}

func TestHandleDontBugMeWeightReminder(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	db.Weight.SetReminderEnabled(123456, true)

	req := httptest.NewRequest("POST", "/api/weight/reminder/dontbug", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleDontBugMeWeightReminder(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	state, _ := db.Weight.GetReminderState(123456)
	if state.DontRemindUntil == nil {
		t.Error("Expected dont-remind-until to be set")
	}
}

// --- Food handler extensions ---

func TestHandleUpdateFoodLog(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	logID, _ := db.Food.CreateLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(),
		Name:     "Original",
		Weight:   100,
		Calories: 200,
		Carbs:    30,
		Protein:  10,
		Fat:      5,
	})

	reqBody := map[string]interface{}{
		"eaten_at": time.Now().Format(time.RFC3339),
		"name":     "Updated",
		"weight":   150,
		"calories": 300,
		"carbs":    40,
		"protein":  15,
		"fat":      10,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("PUT", fmt.Sprintf("/api/food/log/%d", logID), bytes.NewReader(body))
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", logID))
	w := httptest.NewRecorder()

	srv.handleUpdateFoodLog(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleGetFoodStats(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	// Use an explicit UTC noon so the test is timezone-independent:
	// the query uses date=<UTC-date>&tz=UTC so boundaries are UTC midnights.
	mealTime := time.Date(time.Now().UTC().Year(), time.Now().UTC().Month(), time.Now().UTC().Day(), 12, 0, 0, 0, time.UTC)
	db.Food.CreateLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  mealTime,
		Name:     "Meal",
		Weight:   200,
		Calories: 500,
		Carbs:    60,
		Protein:  30,
		Fat:      20,
	})

	today := mealTime.Format("2006-01-02")
	req := httptest.NewRequest("GET", fmt.Sprintf("/api/food/stats?date=%s&days=1&tz=UTC", today), nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetFoodStats(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var stats store.FoodStats
	json.NewDecoder(w.Body).Decode(&stats)

	if stats.Calories != 500 {
		t.Errorf("Expected 500 calories, got %d", stats.Calories)
	}
}

func TestHandleGetFoodTargets(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	db.Food.SetTargets(context.Background(), store.FoodTargets{
		Calories: 2000, Carbs: 250, Protein: 100, Fat: 70,
	})

	req := httptest.NewRequest("GET", "/api/food/settings/targets", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetFoodTargets(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var targets store.FoodTargets
	json.NewDecoder(w.Body).Decode(&targets)

	if targets.Calories != 2000 {
		t.Errorf("Expected 2000 calories, got %d", targets.Calories)
	}
}

func TestHandleSetFoodTargets(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	reqBody := store.FoodTargets{Calories: 1800, Carbs: 200, Protein: 90, Fat: 60}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/food/settings/targets", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleSetFoodTargets(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify
	targets, _ := db.Food.GetTargets(context.Background())
	if targets.Calories != 1800 {
		t.Errorf("Expected 1800, got %d", targets.Calories)
	}
}

func TestHandleGetFoodProducts(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	db.Food.UpsertProduct(ctx, &store.FoodProduct{
		UserID:         123456,
		Name:           "Apple",
		Carbs100g:      14,
		Protein100g:    0.3,
		Fat100g:        0.2,
		EnergyKcal100g: 52,
	})

	req := httptest.NewRequest("GET", "/api/food/products", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetFoodProducts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var response struct {
		Products []store.FoodProduct `json:"products"`
		Total    int                 `json:"total"`
	}
	json.NewDecoder(w.Body).Decode(&response)

	if len(response.Products) == 0 {
		t.Error("Expected at least 1 product")
	}
	if response.Total == 0 {
		t.Error("Expected total > 0")
	}
}

func TestHandleUpdateFoodProduct(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	db.Food.UpsertProduct(ctx, &store.FoodProduct{
		UserID:         123456,
		Name:           "Apple",
		Carbs100g:      14,
		Protein100g:    0.3,
		Fat100g:        0.2,
		EnergyKcal100g: 52,
	})

	products, _, _ := db.Food.ListProducts(ctx, 123456, store.FoodProductsFilter{Limit: 10})
	if len(products) == 0 {
		t.Fatal("Expected at least 1 product")
	}
	productID := products[0].ID

	reqBody := map[string]interface{}{
		"name":             "Green Apple",
		"carbs_100g":       12,
		"protein_100g":     0.3,
		"fat_100g":         0.1,
		"energy_kcal_100g": 48,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("PUT", fmt.Sprintf("/api/food/products/%d", productID), bytes.NewReader(body))
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", productID))
	w := httptest.NewRecorder()

	srv.handleUpdateFoodProduct(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleDeleteFoodProduct(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	db.Food.UpsertProduct(ctx, &store.FoodProduct{
		UserID:         123456,
		Name:           "ToDelete",
		Carbs100g:      10,
		Protein100g:    1,
		Fat100g:        0.5,
		EnergyKcal100g: 40,
	})

	products, _, _ := db.Food.ListProducts(ctx, 123456, store.FoodProductsFilter{Limit: 10})
	productID := products[0].ID

	req := httptest.NewRequest("DELETE", fmt.Sprintf("/api/food/products/%d", productID), nil)
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", productID))
	w := httptest.NewRecorder()

	srv.handleDeleteFoodProduct(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	products, _, _ = db.Food.ListProducts(ctx, 123456, store.FoodProductsFilter{Limit: 10})
	if len(products) != 0 {
		t.Errorf("Expected 0 products after delete, got %d", len(products))
	}
}

// --- Workout group/variant/exercise CRUD ---

func TestHandleWorkoutGroupCRUD(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)

	// Create group
	reqBody := map[string]interface{}{
		"name":                         "Push Pull",
		"description":                  "PPL Split",
		"is_rotating":                  true,
		"days_of_week":                 "[1,3,5]",
		"scheduled_time":               "18:00",
		"notification_advance_minutes": 15,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/workout/groups/create", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleCreateWorkoutGroup(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Create group: expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	var createResp store.WorkoutGroup
	json.NewDecoder(w.Body).Decode(&createResp)
	groupID := createResp.ID
	if groupID == 0 {
		t.Fatal("Expected non-zero group ID")
	}

	// List groups
	req = httptest.NewRequest("GET", "/api/workout/groups", nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleListWorkoutGroups(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("List groups: expected 200, got %d", w.Code)
	}

	var groups []store.WorkoutGroup
	json.NewDecoder(w.Body).Decode(&groups)
	if len(groups) != 1 {
		t.Fatalf("Expected 1 group, got %d", len(groups))
	}

	// Update group
	updateBody := map[string]interface{}{
		"name":                         "Updated PPL",
		"description":                  "Updated",
		"is_rotating":                  true,
		"days_of_week":                 "[1,2,3,4,5]",
		"scheduled_time":               "19:00",
		"notification_advance_minutes": 30,
		"active":                       true,
	}
	body, _ = json.Marshal(updateBody)
	req = httptest.NewRequest("PUT", fmt.Sprintf("/api/workout/groups/update?id=%d", groupID), bytes.NewReader(body))
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleUpdateWorkoutGroup(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Update group: expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify update
	group, _ := db.Workout.GetGroup(groupID)
	if group.Name != "Updated PPL" {
		t.Errorf("Expected 'Updated PPL', got %q", group.Name)
	}
}

func TestHandleWorkoutVariantCRUD(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)

	// Create variant
	reqBody := map[string]interface{}{
		"group_id":    group.ID,
		"name":        "Variant A",
		"description": "First variant",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/workout/variants/create", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleCreateWorkoutVariant(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Create variant: expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	var variant store.WorkoutVariant
	json.NewDecoder(w.Body).Decode(&variant)
	if variant.ID == 0 {
		t.Fatal("Expected non-zero variant ID")
	}

	// List variants
	req = httptest.NewRequest("GET", fmt.Sprintf("/api/workout/variants?group_id=%d", group.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleListVariantsByGroup(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("List variants: expected 200, got %d", w.Code)
	}

	var variants []store.WorkoutVariant
	json.NewDecoder(w.Body).Decode(&variants)
	if len(variants) != 1 {
		t.Errorf("Expected 1 variant, got %d", len(variants))
	}

	// Update variant
	updateBody := map[string]interface{}{
		"name":        "Updated A",
		"description": "Updated",
	}
	body, _ = json.Marshal(updateBody)
	req = httptest.NewRequest("PUT", fmt.Sprintf("/api/workout/variants/update?id=%d", variant.ID), bytes.NewReader(body))
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleUpdateWorkoutVariant(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Update variant: expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Delete variant
	req = httptest.NewRequest("DELETE", fmt.Sprintf("/api/workout/variants/delete?id=%d", variant.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleDeleteWorkoutVariant(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Delete variant: expected 200, got %d", w.Code)
	}
}

func TestHandleWorkoutExerciseCRUD(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.Workout.CreateVariant(group.ID, "Variant A", &order, "")

	// Create exercise
	reqBody := map[string]interface{}{
		"variant_id":      variant.ID,
		"exercise_name":   "Bench Press",
		"target_sets":     3,
		"target_reps_min": 8,
		"order_index":     0,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/workout/exercises/create", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleCreateExercise(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("Create exercise: expected 201, got %d. Body: %s", w.Code, w.Body.String())
	}

	var exercise store.WorkoutExercise
	json.NewDecoder(w.Body).Decode(&exercise)
	if exercise.ID == 0 {
		t.Fatal("Expected non-zero exercise ID")
	}

	// List exercises
	req = httptest.NewRequest("GET", fmt.Sprintf("/api/workout/exercises?variant_id=%d", variant.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleListExercisesByVariant(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("List exercises: expected 200, got %d", w.Code)
	}

	var exercises []store.WorkoutExercise
	json.NewDecoder(w.Body).Decode(&exercises)
	if len(exercises) != 1 {
		t.Errorf("Expected 1 exercise, got %d", len(exercises))
	}

	// Delete exercise
	req = httptest.NewRequest("DELETE", fmt.Sprintf("/api/workout/exercises/delete?id=%d", exercise.ID), nil)
	req = withUser(req, userID)
	w = httptest.NewRecorder()
	srv.handleDeleteExercise(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Delete exercise: expected 200, got %d", w.Code)
	}
}

// --- Session management ---

func TestHandleStartWorkoutSession(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.Workout.CreateVariant(group.ID, "A", &order, "")
	session, _ := db.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/workout/sessions/%d/start", session.ID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", session.ID))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleStartWorkoutSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	s, _ := db.Workout.GetSession(session.ID)
	if s.Status != "in_progress" {
		t.Errorf("Expected status 'in_progress', got %q", s.Status)
	}
}

func TestHandleSkipWorkoutSession(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.Workout.CreateVariant(group.ID, "A", &order, "")
	session, _ := db.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/workout/sessions/%d/skip", session.ID), nil)
	req.SetPathValue("id", fmt.Sprintf("%d", session.ID))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleSkipWorkoutSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	s, _ := db.Workout.GetSession(session.ID)
	if s.Status != "skipped" {
		t.Errorf("Expected status 'skipped', got %q", s.Status)
	}
}

func TestHandleGetWorkoutStats(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.Workout.CreateVariant(group.ID, "A", &order, "")
	session, _ := db.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	db.Workout.CompleteSession(session.ID)

	req := httptest.NewRequest("GET", "/api/workout/stats", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetWorkoutStats(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var stats map[string]interface{}
	json.NewDecoder(w.Body).Decode(&stats)

	if stats["total_sessions"] != float64(1) {
		t.Errorf("Expected 1 total session, got %v", stats["total_sessions"])
	}
}

func TestHandleListWorkoutSessions(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.Workout.CreateVariant(group.ID, "A", &order, "")
	db.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("GET", "/api/workout/sessions?limit=30", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleListWorkoutSessions(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleGetSessionDetails(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", false, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.Workout.CreateVariant(group.ID, "A", &order, "")
	session, _ := db.Workout.CreateSession(group.ID, variant.ID, userID, time.Now(), "09:00")

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/workout/sessions/details?id=%d", session.ID), nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetSessionDetails(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleGetRotationState(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	group, _ := db.Workout.CreateGroup("Test", "desc", true, userID, "[1,3,5]", "09:00", 15)
	order := 0
	variant, _ := db.Workout.CreateVariant(group.ID, "A", &order, "")
	db.Workout.InitializeRotation(group.ID, variant.ID)

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/workout/rotation/state?group_id=%d", group.ID), nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetRotationState(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// --- Security Headers Middleware Test ---

func TestSecurityHeadersMiddleware(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()

	srv.Routes().ServeHTTP(w, req)

	expectedHeaders := map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "SAMEORIGIN",
		"Referrer-Policy":              "strict-origin-when-cross-origin",
		"Permissions-Policy":           "camera=(self), microphone=(self), geolocation=()",
		"Cross-Origin-Opener-Policy":   "same-origin-allow-popups",
		"Cross-Origin-Resource-Policy": "same-site",
		"Strict-Transport-Security":    "max-age=15552000; includeSubDomains",
		"Content-Security-Policy":      "default-src 'self'; script-src 'self' https://telegram.org https://esm.sh blob: data:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://telegram.org https://esm.sh https://api.us.elevenlabs.io https://api.elevenlabs.io wss://api.us.elevenlabs.io wss://api.elevenlabs.io; font-src 'self' https://fonts.gstatic.com; frame-src 'self' https://oauth.telegram.org; base-uri 'self'; frame-ancestors 'self'",
	}

	for header, expectedVal := range expectedHeaders {
		if val := w.Header().Get(header); val != expectedVal {
			t.Errorf("Expected %s header to be %q, got %q", header, expectedVal, val)
		}
	}
}

func TestAuthStatus(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	t.Run("unauthenticated without cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/auth/status", nil)
		w := httptest.NewRecorder()

		srv.Routes().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		var payload struct {
			Authenticated bool   `json:"authenticated"`
			Method        string `json:"method"`
		}
		if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if payload.Authenticated {
			t.Fatalf("expected unauthenticated response, got %+v", payload)
		}
	})

	t.Run("authenticated with valid cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/auth/status", nil)
		req.AddCookie(&http.Cookie{
			Name:  "auth_session",
			Value: createSessionToken("admin@example.com", srv.sessionSecret),
		})
		w := httptest.NewRecorder()

		srv.Routes().ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		var payload struct {
			Authenticated bool   `json:"authenticated"`
			Method        string `json:"method"`
		}
		if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if !payload.Authenticated || payload.Method != "cookie" {
			t.Fatalf("expected authenticated cookie response, got %+v", payload)
		}
	})
}
