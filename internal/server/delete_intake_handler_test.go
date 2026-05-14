package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHandleDeleteFutureIntake_Success(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	future := time.Now().Add(2 * time.Hour)
	intakeID, err := db.Medication.CreateIntake(medID, userID, future)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{intakeID}})
	req := httptest.NewRequest("POST", "/api/medications/delete-intake", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleDeleteFutureIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)

	if resp["deleted_count"] != float64(1) {
		t.Errorf("Expected deleted_count=1, got %v", resp["deleted_count"])
	}
	if resp["status"] != "deleted" {
		t.Errorf("Expected status='deleted', got %v", resp["status"])
	}

	intake, _ := db.Medication.GetIntake(intakeID)
	if intake != nil {
		t.Errorf("Expected intake to be deleted, found %+v", intake)
	}
}

func TestHandleDeleteFutureIntake_PastIntake_Skipped(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	past := time.Now().Add(-2 * time.Hour)
	intakeID, _ := db.Medication.CreateIntake(medID, userID, past)

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{intakeID}})
	req := httptest.NewRequest("POST", "/api/medications/delete-intake", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleDeleteFutureIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)

	if resp["deleted_count"] != float64(0) {
		t.Errorf("Expected deleted_count=0 for past intake, got %v", resp["deleted_count"])
	}

	intake, _ := db.Medication.GetIntake(intakeID)
	if intake == nil {
		t.Errorf("Expected past intake preserved, but it was deleted")
	}
}

func TestHandleDeleteFutureIntake_TakenIntake_Skipped(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	future := time.Now().Add(2 * time.Hour)
	intakeID, _ := db.Medication.CreateIntake(medID, userID, future)
	if err := db.Medication.ConfirmIntake(intakeID, time.Now()); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{intakeID}})
	req := httptest.NewRequest("POST", "/api/medications/delete-intake", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleDeleteFutureIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)

	if resp["deleted_count"] != float64(0) {
		t.Errorf("Expected deleted_count=0 for TAKEN intake, got %v", resp["deleted_count"])
	}

	intake, _ := db.Medication.GetIntake(intakeID)
	if intake == nil {
		t.Errorf("Expected TAKEN intake preserved, but it was deleted")
	}
}

func TestHandleDeleteFutureIntake_OtherUserIntake_Skipped(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ownerID := int64(123456)
	otherID := int64(999999)
	medID, _ := db.Medication.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	future := time.Now().Add(2 * time.Hour)
	intakeID, _ := db.Medication.CreateIntake(medID, ownerID, future)

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{intakeID}})
	req := httptest.NewRequest("POST", "/api/medications/delete-intake", bytes.NewReader(body))
	req = withUser(req, otherID)
	w := httptest.NewRecorder()

	srv.handleDeleteFutureIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)

	if resp["deleted_count"] != float64(0) {
		t.Errorf("Expected deleted_count=0 when caller does not own intake, got %v", resp["deleted_count"])
	}

	intake, _ := db.Medication.GetIntake(intakeID)
	if intake == nil {
		t.Errorf("Expected intake preserved when caller does not own it")
	}
}

func TestHandleDeleteFutureIntake_DoesNotTouchInventory(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	userID := int64(123456)
	medID, _ := db.Medication.CreateMedication("TestMed", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	count := 10
	db.Medication.SetInventory(medID, &count)

	future := time.Now().Add(2 * time.Hour)
	intakeID, _ := db.Medication.CreateIntake(medID, userID, future)

	body, _ := json.Marshal(map[string]any{"intake_ids": []int64{intakeID}})
	req := httptest.NewRequest("POST", "/api/medications/delete-intake", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleDeleteFutureIntake(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	med, _ := db.Medication.GetMedication(medID)
	if med == nil || med.InventoryCount == nil {
		t.Fatalf("Expected inventory to remain set")
	}
	if *med.InventoryCount != 10 {
		t.Errorf("Expected inventory unchanged at 10, got %d", *med.InventoryCount)
	}
}

func TestHandleDeleteFutureIntake_InvalidJSON(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/medications/delete-intake", bytes.NewReader([]byte("not json")))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleDeleteFutureIntake(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for invalid JSON, got %d", w.Code)
	}
}
