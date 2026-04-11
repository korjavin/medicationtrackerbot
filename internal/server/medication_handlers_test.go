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

	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	return srv, db
}

func TestHandleListMedications(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// 1. Create test data
	_, err := db.CreateMedication("Med A", "10mg", "Wait", nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Failed to create med: %v", err)
	}
	idB, err := db.CreateMedication("Med B", "20mg", "Wait", nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Failed to create med: %v", err)
	}

	// Archive one
	err = db.UpdateMedication(idB, "Med B", "20mg", "Wait", true, nil, nil, "", "", nil, "")
	if err != nil {
		t.Fatalf("Failed to archive med: %v", err)
	}

	// 2. Test fetching active only (default)
	req := httptest.NewRequest("GET", "/api/medications", nil)
	w := httptest.NewRecorder()
	srv.handleListMedications(w, req)

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
	srv.handleListMedications(wAll, reqAll)

	var medsAll []store.Medication
	if err := json.NewDecoder(wAll.Body).Decode(&medsAll); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if len(medsAll) != 2 {
		t.Errorf("Expected 2 medications, got %d", len(medsAll))
	}
}

func TestHandleCreateMedication(t *testing.T) {
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

	srv.handleCreateMedication(w, req)

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
	meds, _ := db.ListMedications(false)
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
	_, err := db.CreateMedication("Aspirin", "100mg", "daily", nil, nil, "", "", "")
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

			srv.handleCreateMedication(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("Expected status %d, got %d. Body: %s", tt.wantStatus, w.Code, w.Body.String())
			}
		})
	}

	// Also test duplicate against archived medication
	idArchived, _ := db.CreateMedication("ArchivedMed", "50mg", "daily", nil, nil, "", "", "")
	_ = db.UpdateMedication(idArchived, "ArchivedMed", "50mg", "daily", true, nil, nil, "", "", nil, "")

	reqBody := map[string]interface{}{
		"name":     "archivedmed",
		"dosage":   "50mg",
		"schedule": "daily",
	}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/medications", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.handleCreateMedication(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("Expected 409 for archived duplicate, got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestHandleCreateMedication_InvalidJSON(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/medications", strings.NewReader("invalid json"))
	w := httptest.NewRecorder()

	srv.handleCreateMedication(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", w.Code)
	}
}

func TestHandleUpdateMedication(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Setup: Create a medication
	id, _ := db.CreateMedication("Old Name", "10mg", "Wait", nil, nil, "", "", "")

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
	med, _ := db.GetMedication(id)
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

func TestHandleDeleteMedication(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Setup: Create a medication without history and archive it
	id, _ := db.CreateMedication("To Delete", "10mg", "Wait", nil, nil, "", "", "")
	err := db.UpdateMedication(id, "To Delete", "10mg", "Wait", true, nil, nil, "", "", nil, "")
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
	med, _ := db.GetMedication(id)
	if med != nil {
		t.Errorf("Expected nil, got %v", med)
	}

	// Setup: Create an active medication without history
	idActive, _ := db.CreateMedication("Active Med", "10mg", "Wait", nil, nil, "", "", "")

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
	medActive, _ := db.GetMedication(idActive)
	if medActive == nil {
		t.Errorf("Expected active medication to still exist, got nil")
	}

	// Setup: Create a medication with history
	id2, _ := db.CreateMedication("With History", "10mg", "Wait", nil, nil, "", "", "")
	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	_, _ = db.CreateIntake(id2, 12345, scheduled)

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
	med2, _ := db.GetMedication(id2)
	if med2 == nil {
		t.Errorf("Expected medication to still exist, got nil")
	}
}

func TestHandleSnoozeMedication(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.CreateMedication("Med A", "10mg", "Wait", nil, nil, "", "", "")
	intakeID, _ := db.CreateIntake(medID, userID, time.Now())

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

	intake, _ := db.GetIntake(intakeID)
	if intake.SnoozedUntil == nil {
		t.Error("Expected SnoozedUntil to be set")
	}
}

func TestHandleSkipMedication(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.CreateMedication("Med A", "10mg", "Wait", nil, nil, "", "", "")
	intakeID, _ := db.CreateIntake(medID, userID, time.Now())

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

	intake, _ := db.GetIntake(intakeID)
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
	medID, _ := db.CreateMedication("Med A", "10mg", "Wait", nil, nil, "", "", "")
	userID := int64(123456)
	schedule := time.Now().Add(-1 * time.Hour)
	intakeID, _ := db.CreateIntake(medID, userID, schedule)

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
	intake, _ := db.GetIntake(intakeID)
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
	intakeReverted, _ := db.GetIntake(intakeID)
	if intakeReverted.Status != "PENDING" {
		t.Errorf("Expected status PENDING, got %s", intakeReverted.Status)
	}
}
