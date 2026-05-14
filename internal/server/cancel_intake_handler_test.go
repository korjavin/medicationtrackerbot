package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHandleCancelIntake_Success(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	count := 10
	db.Medication.SetInventory(medID, &count)

	intakeID, _ := db.Medication.CreateIntake(medID, userID, time.Now())
	// Confirm so status = TAKEN, and simulate the inventory decrement that the HTTP confirm handler performs
	if err := db.Medication.ConfirmIntake(intakeID, time.Now()); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}
	if err := db.Medication.DecrementInventory(medID, 1); err != nil {
		t.Fatalf("DecrementInventory: %v", err)
	}

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{intakeID}})
	req := httptest.NewRequest("POST", "/api/medications/cancel-intake", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleCancelIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["cancelled_count"] != float64(1) {
		t.Errorf("Expected cancelled_count=1, got %v", resp["cancelled_count"])
	}
	if resp["status"] != "cancelled" {
		t.Errorf("Expected status='cancelled', got %v", resp["status"])
	}

	// Verify reverted to PENDING
	intake, _ := db.Medication.GetIntake(intakeID)
	if intake.Status != "PENDING" {
		t.Errorf("Expected PENDING after cancel, got %s", intake.Status)
	}

	// Inventory should be restored: was 10, decremented to 9 on confirm, incremented back to 10 on cancel
	med, _ := db.Medication.GetMedication(medID)
	if med.InventoryCount == nil {
		t.Error("Expected inventory count to be set")
	} else if *med.InventoryCount != 10 {
		t.Errorf("Expected inventory restored to 10, got %d", *med.InventoryCount)
	}
}

func TestHandleCancelIntake_NotTaken_Skipped(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	// Create intake but don't confirm it (stays PENDING)
	intakeID, _ := db.Medication.CreateIntake(medID, userID, time.Now())

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{intakeID}})
	req := httptest.NewRequest("POST", "/api/medications/cancel-intake", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleCancelIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	// PENDING intake can't be cancelled → count should be 0
	if resp["cancelled_count"] != float64(0) {
		t.Errorf("Expected cancelled_count=0 for PENDING intake, got %v", resp["cancelled_count"])
	}
}

func TestHandleCancelIntake_NonExistentID_Skipped(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{999999}})
	req := httptest.NewRequest("POST", "/api/medications/cancel-intake", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleCancelIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["cancelled_count"] != float64(0) {
		t.Errorf("Expected cancelled_count=0 for non-existent intake, got %v", resp["cancelled_count"])
	}
}

func TestHandleCancelIntake_EmptyList(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{}})
	req := httptest.NewRequest("POST", "/api/medications/cancel-intake", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCancelIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	if resp["cancelled_count"] != float64(0) {
		t.Errorf("Expected cancelled_count=0 for empty list, got %v", resp["cancelled_count"])
	}
	if resp["requested_count"] != float64(0) {
		t.Errorf("Expected requested_count=0 for empty list, got %v", resp["requested_count"])
	}
}

func TestHandleCancelIntake_InvalidJSON(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/medications/cancel-intake", bytes.NewReader([]byte("invalid json")))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCancelIntake(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for invalid JSON, got %d", w.Code)
	}
}
