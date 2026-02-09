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

func createBPTestServer(t *testing.T) (*Server, *store.Store) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}

	srv := New(db, nil, "test-token", 123456, OIDCConfig{}, "test-bot", VAPIDConfig{})
	return srv, db
}

func withUser(r *http.Request, userID int64) *http.Request {
	ctx := context.WithValue(r.Context(), UserCtxKey, &TelegramUser{ID: userID})
	return r.WithContext(ctx)
}

func ctxWithUser(userID int64) context.Context {
	return context.WithValue(context.Background(), UserCtxKey, &TelegramUser{ID: userID})
}

func TestHandleCreateBloodPressure(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// Valid request
	reqBody := map[string]interface{}{
		"measured_at": time.Now(),
		"systolic":    120,
		"diastolic":   80,
		"pulse":       70,
		"site":        "Left Arm",
		"position":    "Sitting",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/bp", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateBloodPressure(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp store.BloodPressure
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if resp.Systolic != 120 || resp.Diastolic != 80 {
		t.Errorf("Expected 120/80, got %d/%d", resp.Systolic, resp.Diastolic)
	}
}

func TestHandleCreateBloodPressure_InvalidJSON(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("POST", "/api/bp", strings.NewReader("invalid json"))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateBloodPressure(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", w.Code)
	}
}

func TestHandleListBloodPressure(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// Setup: Create readings
	ctx := ctxWithUser(123456)
	db.CreateBloodPressureReading(ctx, &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now().Add(-1 * time.Hour),
		Systolic:   120, Diastolic: 80,
	})
	db.CreateBloodPressureReading(ctx, &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now().Add(-25 * time.Hour),
		Systolic:   130, Diastolic: 85,
	})

	// Test: List all (default 30 days)
	req := httptest.NewRequest("GET", "/api/bp", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleListBloodPressure(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var readings []store.BloodPressure
	if err := json.NewDecoder(w.Body).Decode(&readings); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if len(readings) != 2 {
		t.Errorf("Expected 2 readings, got %d", len(readings))
	}
}

func TestHandleDeleteBloodPressure(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// Setup
	ctx := ctxWithUser(123456)
	id, _ := db.CreateBloodPressureReading(ctx, &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120, Diastolic: 80,
	})

	// Test: Delete
	url := fmt.Sprintf("/api/bp/%d", id)
	req := httptest.NewRequest("DELETE", url, nil)
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", id))

	w := httptest.NewRecorder()
	srv.handleDeleteBloodPressure(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Verify
	readings, _ := db.GetBloodPressureReadings(ctx, 123456, time.Time{})
	if len(readings) != 0 {
		t.Errorf("Expected 0 readings, got %d", len(readings))
	}
}

func TestHandleGetBPGoal(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/bp/goal", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetBPGoal(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Just verify JSON structure/success as goal might be hardcoded/default
	var goal map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&goal); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}
}

func TestHandleGetBPStats(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// Setup data
	ctx := ctxWithUser(123456)
	db.CreateBloodPressureReading(ctx, &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120, Diastolic: 80,
	})

	req := httptest.NewRequest("GET", "/api/bp/stats", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetBPStats(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// Helper to create context with user - removed redundant reqWithUser at bottom

func TestHandleImportBloodPressure(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{
		"readings": []map[string]interface{}{
			{
				"measured_at": time.Now(),
				"systolic":    120,
				"diastolic":   80,
				"pulse":       70,
			},
		},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/bp/import", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleImportBloodPressure(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Verify DB
	ctx := ctxWithUser(123456)
	readings, _ := db.GetBloodPressureReadings(ctx, 123456, time.Time{})
	if len(readings) != 1 {
		t.Errorf("Expected 1 reading, got %d", len(readings))
	}
}

func TestHandleExportBloodPressure(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	// Setup
	ctx := ctxWithUser(123456)
	db.CreateBloodPressureReading(ctx, &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120, Diastolic: 80,
	})

	req := httptest.NewRequest("GET", "/api/bp/export", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleExportBloodPressure(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	if w.Header().Get("Content-Type") != "text/csv" {
		t.Errorf("Expected Content-Type text/csv, got %s", w.Header().Get("Content-Type"))
	}

	if !strings.Contains(w.Body.String(), "120") {
		t.Errorf("Expected body to contain '120', got %s", w.Body.String())
	}
}
