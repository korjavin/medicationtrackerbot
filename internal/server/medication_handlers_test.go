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

	srv := New(db, nil, "test-token", 123456, OIDCConfig{}, "test-bot", VAPIDConfig{})
	return srv, db
}

func TestHandleListMedications(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// 1. Create test data
	_, err := db.CreateMedication("Med A", "10mg", "Wait", nil, nil, "", "")
	if err != nil {
		t.Fatalf("Failed to create med: %v", err)
	}
	idB, err := db.CreateMedication("Med B", "20mg", "Wait", nil, nil, "", "")
	if err != nil {
		t.Fatalf("Failed to create med: %v", err)
	}

	// Archive one
	err = db.UpdateMedication(idB, "Med B", "20mg", "Wait", true, nil, nil, "", "", nil)
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
		"name":     "Test Med",
		"dosage":   "500mg",
		"schedule": "Every day",
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
	id, _ := db.CreateMedication("Old Name", "10mg", "Wait", nil, nil, "", "")

	// Test: Update it
	reqBody := map[string]interface{}{
		"name":     "New Name",
		"dosage":   "20mg",
		"schedule": "Wait",
		"archived": false,
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
}

func TestHandleDeleteMedication(t *testing.T) {
	srv, db := createTestServer(t)
	defer db.Close()

	// Setup: Create a medication
	id, _ := db.CreateMedication("To Delete", "10mg", "Wait", nil, nil, "", "")

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
	meds, _ := db.ListMedications(true)
	if len(meds) != 0 {
		t.Errorf("Expected 0 medications, got %d", len(meds))
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
	medID, _ := db.CreateMedication("Med A", "10mg", "Wait", nil, nil, "", "")
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
