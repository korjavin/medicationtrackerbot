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

func createFoodTestServer(t *testing.T) (*Server, *store.Store) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}

	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
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
	logs, _ := db.GetFoodLogs(ctx, 123456, time.Now(), 1)
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

func TestMergeFoodProducts_DedupAndOrder(t *testing.T) {
	localBarcode := "111"
	local := []store.FoodProduct{
		{Name: "Cheese pancakes", Barcode: &localBarcode},
		{Name: "Oatmeal"},
	}

	remoteBarcodeDup := "111"
	remoteBarcodeUnique := "222"
	remote := []store.FoodProduct{
		{Name: "Cheese Pancakes OFF", Barcode: &remoteBarcodeDup}, // duplicate by barcode
		{Name: "Pancakes", Barcode: &remoteBarcodeUnique},
		{Name: "OATMEAL"}, // duplicate by name (case-insensitive)
	}

	merged := mergeFoodProducts(local, remote)
	if len(merged) != 3 {
		t.Fatalf("expected 3 merged products, got %d", len(merged))
	}

	if merged[0].Name != "Cheese pancakes" {
		t.Fatalf("expected local product to keep priority at index 0, got %q", merged[0].Name)
	}
	if merged[1].Name != "Oatmeal" {
		t.Fatalf("expected local product to keep priority at index 1, got %q", merged[1].Name)
	}
	if merged[2].Name != "Pancakes" {
		t.Fatalf("expected unique remote product to be appended, got %q", merged[2].Name)
	}
}

func TestMergeFoodProducts_Limit50(t *testing.T) {
	base := make([]store.FoodProduct, 0, 60)
	for i := 0; i < 60; i++ {
		base = append(base, store.FoodProduct{Name: fmt.Sprintf("Food %d", i)})
	}

	merged := mergeFoodProducts(base[:30], base[30:])
	if len(merged) != 50 {
		t.Fatalf("expected merged length 50, got %d", len(merged))
	}
	if !strings.EqualFold(merged[49].Name, "Food 49") {
		t.Fatalf("expected last kept item to be Food 49, got %q", merged[49].Name)
	}
}

func TestHandleCreateMealFromLogs(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)
	id1, _ := db.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(),
		Name:     "Apple",
		Weight:   100,
		Carbs:    14,
		Calories: 52,
	})
	id2, _ := db.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(),
		Name:     "Banana",
		Weight:   100,
		Carbs:    23,
		Calories: 89,
	})

	reqBody := map[string]interface{}{
		"name":    "Fruit Salad",
		"log_ids": []int64{id1, id2},
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/food/products/from-logs", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateMealFromLogs(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var product store.FoodProduct
	if err := json.NewDecoder(w.Body).Decode(&product); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if product.Name != "Fruit Salad" {
		t.Errorf("Expected name 'Fruit Salad', got %s", product.Name)
	}
	if !product.IsMeal {
		t.Errorf("Expected is_meal to be true")
	}
	if product.TotalWeightG != 200 {
		t.Errorf("Expected total_weight_g to be 200, got %d", product.TotalWeightG)
	}
}
