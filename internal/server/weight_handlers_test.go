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

func createWeightTestServer(t *testing.T) (*Server, *store.Store) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}

	srv := New(db, nil, "test-token", 123456, OIDCConfig{}, "test-bot", VAPIDConfig{})
	return srv, db
}

func weightCtxWithUser(userID int64) context.Context {
	return context.WithValue(context.Background(), UserCtxKey, &TelegramUser{ID: userID})
}

func weightReqWithUser(r *http.Request, userID int64) *http.Request {
	ctx := context.WithValue(r.Context(), UserCtxKey, &TelegramUser{ID: userID})
	return r.WithContext(ctx)
}

func TestHandleCreateWeight(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	// Initial weight to check trend
	ctx := weightCtxWithUser(123456)
	initialTrend := 80.0
	wLog1 := &store.WeightLog{
		UserID:      123456,
		MeasuredAt:  time.Now().Add(-24 * time.Hour),
		Weight:      80.0,
		WeightTrend: &initialTrend,
	}
	db.CreateWeightLog(ctx, wLog1)

	reqBody := map[string]interface{}{
		"measured_at": time.Now(),
		"weight":      79.5,
		"body_fat":    20.0,
		"notes":       "Morning weight",
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/weight", bytes.NewReader(body))
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateWeight(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp store.WeightLog
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if resp.Weight != 79.5 {
		t.Errorf("Expected weight 79.5, got %f", resp.Weight)
	}

	// Expected Trend: 0.1 * 79.5 + 0.9 * 80.0 = 7.95 + 72.0 = 79.95
	expectedTrend := 79.95
	if resp.WeightTrend == nil || *resp.WeightTrend != expectedTrend {
		t.Errorf("Expected trend %f, got %v", expectedTrend, resp.WeightTrend)
	}
}

func TestHandleListWeight(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	ctx := weightCtxWithUser(123456)
	db.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Weight:     80.0,
	})

	req := httptest.NewRequest("GET", "/api/weight", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleListWeight(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var logs []store.WeightLog
	if err := json.NewDecoder(w.Body).Decode(&logs); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if len(logs) != 1 {
		t.Errorf("Expected 1 log, got %d", len(logs))
	}
}

func TestHandleDeleteWeight(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	ctx := weightCtxWithUser(123456)
	id, _ := db.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Weight:     90.0,
	})

	url := fmt.Sprintf("/api/weight/%d", id)
	req := httptest.NewRequest("DELETE", url, nil)
	req = weightReqWithUser(req, 123456)
	req.SetPathValue("id", fmt.Sprintf("%d", id))

	w := httptest.NewRecorder()
	srv.handleDeleteWeight(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Verify deletion
	logs, _ := db.GetWeightLogs(ctx, 123456, time.Time{})
	if len(logs) != 0 {
		t.Errorf("Expected 0 logs, got %d", len(logs))
	}
}

func TestHandleExportWeight(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	ctx := weightCtxWithUser(123456)
	db.CreateWeightLog(ctx, &store.WeightLog{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Weight:     80.0,
		Notes:      "Test Note",
	})

	req := httptest.NewRequest("GET", "/api/weight/export", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleExportWeight(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	if w.Header().Get("Content-Type") != "text/csv" {
		t.Errorf("Expected Content-Type text/csv, got %s", w.Header().Get("Content-Type"))
	}

	if !strings.Contains(w.Body.String(), "80.0") {
		t.Errorf("Expected body to contain '80.0', got %s", w.Body.String())
	}
}

func TestHandleGetWeightGoal(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	// Initial goal setup if possible (might need store method if exported)
	// For now just test the handler creates default or whatever

	req := httptest.NewRequest("GET", "/api/weight/goal", nil)
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleGetWeightGoal(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Simple check, real data might not exist
	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}
}
