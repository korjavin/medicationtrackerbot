package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func createFoodTestServer(t *testing.T) (*Server, *store.Store) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}

	srv := New(db, nil, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", VAPIDConfig{})
	return srv, db
}

func TestHandleLogFood(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	// Valid request
	reqBody := map[string]interface{}{
		"eaten_at": time.Now(),
		"name":     "Apple",
		"weight":   150,
		"calories": 80,
		"carbs":    20,
		"protein":  1, // 0.5 -> 1 for int
		"fat":      0, // 0.2 -> 0 for int
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/food/log", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLog(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if resp["status"] != "created" {
		t.Errorf("Expected status created, got %v", resp["status"])
	}
}

func TestHandleGetFoodLogs(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	// Setup: Create logs
	ctx := ctxWithUser(123456)
	db.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(), // Today
		Name:     "Breakfast",
		Calories: 300,
	})

	// Test: Get logs for today
	req := httptest.NewRequest("GET", "/api/food/log", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetFoodLogs(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var groups []FoodGroup
	if err := json.NewDecoder(w.Body).Decode(&groups); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if len(groups) == 0 {
		t.Errorf("Expected at least 1 group")
	}
}

func TestHandleDeleteFoodLog(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	// Setup
	ctx := ctxWithUser(123456)
	logID, _ := db.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(),
		Name:     "To Delete",
		Calories: 100,
	})

	// Test: Delete
	url := fmt.Sprintf("/api/food/log/%d", logID)
	req := httptest.NewRequest("DELETE", url, nil)
	req = withUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", logID))

	w := httptest.NewRecorder()
	srv.handleDeleteFoodLog(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Verify
	logs, _ := db.GetFoodLogs(ctx, 123456, time.Now())
	if len(logs) != 0 {
		t.Errorf("Expected 0 logs, got %d", len(logs))
	}
}

func TestHandleToggleFoodIntake(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{"enabled": true}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/food/settings/toggle", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleSetFoodIntakeEnabled(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Verify
	enabled, _ := db.GetFoodIntakeEnabled(context.Background())
	if !enabled {
		t.Error("Expected food intake to be enabled")
	}
}

func TestHandleGetFoodIntakeStatus(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	db.SetFoodIntakeEnabled(context.Background(), true)

	req := httptest.NewRequest("GET", "/api/food/settings/status", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetFoodIntakeEnabled(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	if enabled, ok := resp["enabled"].(bool); !ok || !enabled {
		t.Error("Expected enabled=true")
	}
}
