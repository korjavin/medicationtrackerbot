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

func createTestServer(t *testing.T) (*Server, *store.Store) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}

	srv := newServer(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	return srv, db
}

func TestHandleList(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// 1. Create test data
	_, err := db.Medication.Create("Med A", "10mg", "Wait", nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Failed to create med: %v", err)
	}
	idB, err := db.Medication.Create("Med B", "20mg", "Wait", nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Failed to create med: %v", err)
	}

	// Archive one
	err = db.Medication.Update(idB, "Med B", "20mg", "Wait", true, nil, nil, "", "", nil, "")
	if err != nil {
		t.Fatalf("Failed to archive med: %v", err)
	}

	// 2. Test fetching active only (default)
	req := httptest.NewRequest("GET", "/api/medications", nil)
	w := httptest.NewRecorder()
	srv.handleList(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var meds []store.Medication
	if err := json.NewDecoder(w.Body).Decode(&meds); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if len(meds) != 1 {
		t.Errorf("Expected 1 active medication, got %d", len(meds))
	} else if meds[0].Name != "Med A" {
		t.Errorf("Expected Med A, got %s", meds[0].Name)
	}

	// 3. Test fetching all (including archived)
	reqAll := httptest.NewRequest("GET", "/api/medications?archived=true", nil)
	wAll := httptest.NewRecorder()
	srv.handleList(wAll, reqAll)

	var medsAll []store.Medication
	if err := json.NewDecoder(wAll.Body).Decode(&medsAll); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if len(medsAll) != 2 {
		t.Errorf("Expected 2 medications, got %d", len(medsAll))
	}
}

func TestHandleCreate(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{
		"name":       "Test Med",
		"dosage":     "500mg",
		"schedule":   "Every day",
		"supplement": true,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications", bytes.NewReader(body))
	w := httptest.NewRecorder()

	srv.handleCreate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if resp["status"] != "created" {
		t.Errorf("Expected status 'created', got %v", resp["status"])
	}

	// Verify in DB
	meds, _ := db.Medication.List(false)
	if len(meds) != 1 {
		t.Errorf("Expected 1 medication in DB, got %d", len(meds))
	}
	if meds[0].Name != "Test Med" {
		t.Errorf("Expected medication name 'Test Med', got %s", meds[0].Name)
	}
	if !meds[0].Supplement {
		t.Errorf("Expected supplement=true, got false")
	}
}

func TestHandleCreateMedication_Duplicate(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Create initial medication
	_, err := db.Medication.Create("Aspirin", "100mg", "daily", nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Failed to create med: %v", err)
	}

	tests := []struct {
		name       string
		medName    string
		dosage     string
		wantStatus int
	}{
		{"exact duplicate", "Aspirin", "100mg", http.StatusConflict},
		{"case-insensitive duplicate", "aspirin", "100mg", http.StatusConflict},
		{"same name different dosage", "Aspirin", "200mg", http.StatusOK},
		{"different name same dosage", "Ibuprofen", "100mg", http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reqBody := map[string]interface{}{
				"name":     tt.medName,
				"dosage":   tt.dosage,
				"schedule": "daily",
			}
			body, _ := json.Marshal(reqBody)
			req := httptest.NewRequest("POST", "/api/medications", bytes.NewReader(body))
			w := httptest.NewRecorder()

			srv.handleCreate(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("Expected status %d, got %d. Body: %s", tt.wantStatus, w.Code, w.Body.String())
			}
			if tt.wantStatus == http.StatusConflict {
				body := strings.TrimSpace(w.Body.String())
				if body != "Medication with this name and dosage already exists" {
					t.Errorf("Expected duplicate error message, got: %s", body)
				}
			}
		})
	}

	// Also test duplicate against archived medication
	idArchived, _ := db.Medication.Create("ArchivedMed", "50mg", "daily", nil, nil, "", "", "")
	_ = db.Medication.Update(idArchived, "ArchivedMed", "50mg", "daily", true, nil, nil, "", "", nil, "")

	reqBody := map[string]interface{}{
		"name":     "archivedmed",
		"dosage":   "50mg",
		"schedule": "daily",
	}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/medications", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.handleCreate(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("Expected 409 for archived duplicate, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleCreateMedication_InvalidJSON(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/medications", strings.NewReader("invalid json"))
	w := httptest.NewRecorder()

	srv.handleCreate(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", w.Code)
	}
}

func TestHandleUpdate(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Setup: Create a medication
	id, _ := db.Medication.Create("Old Name", "10mg", "Wait", nil, nil, "", "", "")

	// Test: Update it
	reqBody := map[string]interface{}{
		"name":       "New Name",
		"dosage":     "20mg",
		"schedule":   "Wait",
		"archived":   false,
		"supplement": true,
	}
	body, _ := json.Marshal(reqBody)

	url := fmt.Sprintf("/api/medications/%d", id)
	req := httptest.NewRequest("POST", url, bytes.NewReader(body))
	// Emulate path value routing
	req.SetPathValue("id", fmt.Sprintf("%d", id))

	w := httptest.NewRecorder()
	srv.handleUpdateMedication(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify
	med, _ := db.Medication.Get(id)
	if med.Name != "New Name" {
		t.Errorf("Expected name 'New Name', got '%s'", med.Name)
	}
	if med.Dosage != "20mg" {
		t.Errorf("Expected dosage '20mg', got '%s'", med.Dosage)
	}
	if !med.Supplement {
		t.Errorf("Expected supplement=true after update, got false")
	}
}

func TestHandleUpdateMedication_Duplicate(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Create two medications
	idA, _ := db.Medication.Create("Aspirin", "100mg", "daily", nil, nil, "", "", "")
	idB, _ := db.Medication.Create("Ibuprofen", "200mg", "daily", nil, nil, "", "", "")

	// Test: renaming B to match A's name+dosage should return 409
	reqBody := map[string]interface{}{
		"name":     "aspirin",
		"dosage":   "100mg",
		"schedule": "daily",
		"archived": false,
	}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", fmt.Sprintf("/api/medications/%d", idB), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprintf("%d", idB))
	w := httptest.NewRecorder()
	srv.handleUpdateMedication(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("Expected 409 when renaming to match existing, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Test: updating A while keeping its own name+dosage should succeed (self-exclusion)
	reqBody = map[string]interface{}{
		"name":     "Aspirin",
		"dosage":   "100mg",
		"schedule": "weekly",
		"archived": false,
	}
	body, _ = json.Marshal(reqBody)
	req = httptest.NewRequest("POST", fmt.Sprintf("/api/medications/%d", idA), bytes.NewReader(body))
	req.SetPathValue("id", fmt.Sprintf("%d", idA))
	w = httptest.NewRecorder()
	srv.handleUpdateMedication(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected 200 when updating self with same name+dosage, got %d. Body: %s", w.Code, w.Body.String())
	}

	_ = idA // suppress unused warning
	_ = idB
}

func TestHandleDelete(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Setup: Create a medication without history and archive it
	id, _ := db.Medication.Create("To Delete", "10mg", "Wait", nil, nil, "", "", "")
	err := db.Medication.Update(id, "To Delete", "10mg", "Wait", true, nil, nil, "", "", nil, "")
	if err != nil {
		t.Fatalf("Failed to archive med: %v", err)
	}

	// Test: Delete it
	url := fmt.Sprintf("/api/medications/%d", id)
	req := httptest.NewRequest("DELETE", url, nil)
	// Emulate path value routing
	req.SetPathValue("id", fmt.Sprintf("%d", id))

	w := httptest.NewRecorder()
	srv.handleDeleteMedication(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Verify
	med, _ := db.Medication.Get(id)
	if med != nil {
		t.Errorf("Expected nil, got %v", med)
	}

	// Setup: Create an active medication without history
	idActive, _ := db.Medication.Create("Active Med", "10mg", "Wait", nil, nil, "", "", "")

	// Test: Delete it should fail because it's not archived
	urlActive := fmt.Sprintf("/api/medications/%d", idActive)
	reqActive := httptest.NewRequest("DELETE", urlActive, nil)
	reqActive.SetPathValue("id", fmt.Sprintf("%d", idActive))

	wActive := httptest.NewRecorder()
	srv.handleDeleteMedication(wActive, reqActive)

	if wActive.Code != http.StatusConflict {
		t.Errorf("Expected status 409 Conflict for active med, got %d", wActive.Code)
	}

	// Verify it was not deleted
	medActive, _ := db.Medication.Get(idActive)
	if medActive == nil {
		t.Errorf("Expected active medication to still exist, got nil")
	}

	// Setup: Create a medication with history
	id2, _ := db.Medication.Create("With History", "10mg", "Wait", nil, nil, "", "", "")
	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	_, _ = db.Medication.CreateIntake(id2, 12345, scheduled)

	// Test: Delete it should fail
	url2 := fmt.Sprintf("/api/medications/%d", id2)
	req2 := httptest.NewRequest("DELETE", url2, nil)
	req2.SetPathValue("id", fmt.Sprintf("%d", id2))

	w2 := httptest.NewRecorder()
	srv.handleDeleteMedication(w2, req2)

	if w2.Code != http.StatusConflict {
		t.Errorf("Expected status 409 Conflict, got %d", w2.Code)
	}

	// Verify it was not deleted
	med2, _ := db.Medication.Get(id2)
	if med2 == nil {
		t.Errorf("Expected medication to still exist, got nil")
	}
}

func TestHandleSnoozeMedication(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.Create("Med A", "10mg", "Wait", nil, nil, "", "", "")
	intakeID, _ := db.Medication.CreateIntake(medID, userID, time.Now())

	reqBody := map[string]interface{}{
		"intake_id":        intakeID,
		"duration_minutes": 15,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/snooze", bytes.NewReader(body))
	ctx := context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID})
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	srv.handleSnoozeMedication(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	intake, _ := db.Medication.GetIntake(intakeID)
	if intake.SnoozedUntil == nil {
		t.Error("Expected SnoozedUntil to be set")
	}
}

func TestHandleSkipMedication(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.Create("Med A", "10mg", "Wait", nil, nil, "", "", "")
	intakeID, _ := db.Medication.CreateIntake(medID, userID, time.Now())

	reqBody := map[string]interface{}{
		"intake_id": intakeID,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/medications/skip", bytes.NewReader(body))
	ctx := context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID})
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	srv.handleSkipMedication(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	intake, _ := db.Medication.GetIntake(intakeID)
	if intake.Status != "SKIPPED" {
		t.Errorf("Expected status SKIPPED, got %s", intake.Status)
	}
}

func TestHandleDeleteMedication_InvalidID(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("DELETE", "/api/medications/invalid", nil)
	req.SetPathValue("id", "invalid")
	w := httptest.NewRecorder()

	srv.handleDeleteMedication(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", w.Code)
	}
}

func TestHandleUpdateIntake(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// 1. Setup Data
	medID, _ := db.Medication.Create("Med A", "10mg", "Wait", nil, nil, "", "", "")
	userID := int64(123456)
	schedule := time.Now().Add(-1 * time.Hour)
	intakeID, _ := db.Medication.CreateIntake(medID, userID, schedule)

	// 2. Test: Mark as TAKEN
	reqBody := map[string]interface{}{
		"updates": []map[string]interface{}{
			{
				"id":       intakeID,
				"status":   "TAKEN",
				"taken_at": time.Now().Format(time.RFC3339),
			},
		},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/intakes/update", bytes.NewReader(body))

	// Inject User Context
	ctx := context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID})
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	srv.handleUpdateIntake(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify in DB
	intake, _ := db.Medication.GetIntake(intakeID)
	if intake.Status != "TAKEN" {
		t.Errorf("Expected status TAKEN, got %s", intake.Status)
	}
	if intake.TakenAt == nil {
		t.Error("Expected TakenAt to be set")
	}

	// 3. Test: Revert to PENDING
	reqBodyRevert := map[string]interface{}{
		"updates": []map[string]interface{}{
			{
				"id":     intakeID,
				"status": "PENDING",
			},
		},
	}
	bodyRevert, _ := json.Marshal(reqBodyRevert)
	reqRevert := httptest.NewRequest("POST", "/api/intakes/update", bytes.NewReader(bodyRevert))
	reqRevert = reqRevert.WithContext(ctx)
	wRevert := httptest.NewRecorder()

	srv.handleUpdateIntake(wRevert, reqRevert)

	if wRevert.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", wRevert.Code)
	}

	// Verify Revert
	intakeReverted, _ := db.Medication.GetIntake(intakeID)
	if intakeReverted.Status != "PENDING" {
		t.Errorf("Expected status PENDING, got %s", intakeReverted.Status)
	}
}

// TestHandleUpdateIntake_OrphanTZStepDoesNotDecrementInventory pins the
// fix for the silent-rejection inventory leak: when /api/intakes/update
// targets a PENDING source='tz_step' row whose owning plan is CANCELLED,
// UpdateIntake returns sql.ErrNoRows (the gate blocked the mutation), the
// row stays PENDING, AND the handler must NOT decrement inventory off the
// stale pre-read intake.Status="PENDING". Without the sql.ErrNoRows-aware
// branch the handler would post-decrement against a row it failed to
// transition to TAKEN.
func TestHandleUpdateIntake_OrphanTZStepDoesNotDecrementInventory(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close() //nolint:errcheck

	userID := int64(123456)
	medID, err := db.Medication.Create("Aspirin", "100mg",
		`{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	initialStock := 30
	if err := db.Medication.Update(medID, "Aspirin", "100mg",
		`{"type":"daily","times":["08:00"]}`, false, nil, nil, "", "", &initialStock, ""); err != nil {
		t.Fatalf("Update (set inventory): %v", err)
	}

	planID, err := db.TZ.CreateTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "UTC", NewTZ: "Asia/Tokyo",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-orphan-update",
	})
	if err != nil {
		t.Fatalf("CreateTransitionPlan: %v", err)
	}
	stepAt := time.Now().Add(1 * time.Hour).UTC()
	if _, err := db.DB().Exec(`
		INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, 1)`,
		medID, userID, stepAt.Unix(), planID); err != nil {
		t.Fatalf("insert orphan step row: %v", err)
	}
	var orphanID int64
	if err := db.DB().QueryRow(`SELECT id FROM intake_log WHERE tz_plan_id = ?`, planID).Scan(&orphanID); err != nil {
		t.Fatalf("lookup orphan row: %v", err)
	}
	// Flip the plan to CANCELLED so the gate blocks UpdateIntake.
	if err := db.TZ.UpdateTransitionPlanStatus(planID, "CANCELLED", "test", "PENDING_APPROVAL"); err != nil {
		t.Fatalf("UpdateTransitionPlanStatus: %v", err)
	}

	reqBody := map[string]interface{}{
		"updates": []map[string]interface{}{
			{"id": orphanID, "status": "TAKEN", "taken_at": time.Now().Format(time.RFC3339)},
		},
	}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/intakes/update", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))
	w := httptest.NewRecorder()
	srv.handleUpdateIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	intake, _ := db.Medication.GetIntake(orphanID)
	if intake == nil || intake.Status != "PENDING" {
		t.Errorf("orphan row should remain PENDING after blocked UpdateIntake, got %+v", intake)
	}
	med, _ := db.Medication.Get(medID)
	if med == nil || med.InventoryCount == nil || *med.InventoryCount != initialStock {
		t.Errorf("inventory must NOT decrement when UpdateIntake gate blocks the mutation, got %+v (initial %d)", med, initialStock)
	}
}

// TestHandleUpdateIntake_GroupRevertReportsOutcomes pins the success path of the
// per-update outcome reporting: a single POST that re-confirms one TAKEN med and
// reverts another to PENDING returns {updated:2, failed:0} and persists both.
func TestHandleUpdateIntake_GroupRevertReportsOutcomes(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close() //nolint:errcheck

	userID := int64(123456)
	medA, _ := db.Medication.Create("Aspirin", "100mg", "Wait", nil, nil, "", "", "")
	medB, _ := db.Medication.Create("Magnesium", "200mg", "Wait", nil, nil, "", "", "")
	sched := time.Now().Add(-1 * time.Hour)
	intakeA, _ := db.Medication.CreateIntake(medA, userID, sched)
	intakeB, _ := db.Medication.CreateIntake(medB, userID, sched)
	// Both already TAKEN (a grouped TAKEN cluster in History).
	if err := db.Medication.ConfirmIntake(intakeA, time.Now()); err != nil {
		t.Fatalf("ConfirmIntake A: %v", err)
	}
	if err := db.Medication.ConfirmIntake(intakeB, time.Now()); err != nil {
		t.Fatalf("ConfirmIntake B: %v", err)
	}

	// One POST: re-confirm A as TAKEN, revert B to PENDING.
	reqBody := map[string]interface{}{
		"updates": []map[string]interface{}{
			{"id": intakeA, "status": "TAKEN", "taken_at": time.Now().Format(time.RFC3339)},
			{"id": intakeB, "status": "PENDING"},
		},
	}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/intakes/update", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))
	w := httptest.NewRecorder()
	srv.handleUpdateIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected Content-Type application/json, got %q", ct)
	}
	var res intakeUpdateResult
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, w.Body.String())
	}
	if res.Updated != 2 || res.Failed != 0 || len(res.Failures) != 0 {
		t.Errorf("expected updated:2 failed:0 failures:[], got %+v", res)
	}

	if a, _ := db.Medication.GetIntake(intakeA); a == nil || a.Status != "TAKEN" {
		t.Errorf("intake A should stay TAKEN, got %+v", a)
	}
	if b, _ := db.Medication.GetIntake(intakeB); b == nil || b.Status != "PENDING" {
		t.Errorf("intake B should revert to PENDING, got %+v", b)
	}
}

// TestHandleUpdateIntake_ForcedFailureReportsNoRowMatched pins the failure path:
// an orphan PENDING tz_step row whose plan is CANCELLED cannot transition to
// TAKEN (the dedup gate blocks it → sql.ErrNoRows), so the handler reports
// {updated:0, failed:1} with reason "no_row_matched" and leaves the row PENDING
// instead of returning a bare 200 that the frontend would read as success.
func TestHandleUpdateIntake_ForcedFailureReportsNoRowMatched(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close() //nolint:errcheck

	userID := int64(123456)
	medID, err := db.Medication.Create("Aspirin", "100mg",
		`{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	planID, err := db.TZ.CreateTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "UTC", NewTZ: "Asia/Tokyo",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-orphan-report",
	})
	if err != nil {
		t.Fatalf("CreateTransitionPlan: %v", err)
	}
	stepAt := time.Now().Add(1 * time.Hour).UTC()
	if _, err := db.DB().Exec(`
		INSERT INTO intake_log (medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, 1)`,
		medID, userID, stepAt.Unix(), planID); err != nil {
		t.Fatalf("insert orphan step row: %v", err)
	}
	var orphanID int64
	if err := db.DB().QueryRow(`SELECT id FROM intake_log WHERE tz_plan_id = ?`, planID).Scan(&orphanID); err != nil {
		t.Fatalf("lookup orphan row: %v", err)
	}
	// Flip the plan to CANCELLED so the dedup gate blocks UpdateIntake.
	if err := db.TZ.UpdateTransitionPlanStatus(planID, "CANCELLED", "test", "PENDING_APPROVAL"); err != nil {
		t.Fatalf("UpdateTransitionPlanStatus: %v", err)
	}

	reqBody := map[string]interface{}{
		"updates": []map[string]interface{}{
			{"id": orphanID, "status": "TAKEN", "taken_at": time.Now().Format(time.RFC3339)},
		},
	}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/intakes/update", bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), UserCtxKey, &TelegramUser{ID: userID}))
	w := httptest.NewRecorder()
	srv.handleUpdateIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var res intakeUpdateResult
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, w.Body.String())
	}
	if res.Updated != 0 || res.Failed != 1 || len(res.Failures) != 1 {
		t.Fatalf("expected updated:0 failed:1 with one failure, got %+v", res)
	}
	if res.Failures[0].ID != orphanID || res.Failures[0].Reason != "no_row_matched" {
		t.Errorf("expected failure {id:%d reason:no_row_matched}, got %+v", orphanID, res.Failures[0])
	}
	if intake, _ := db.Medication.GetIntake(orphanID); intake == nil || intake.Status != "PENDING" {
		t.Errorf("orphan row should remain PENDING after blocked UpdateIntake, got %+v", intake)
	}
}
