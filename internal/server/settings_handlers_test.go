package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleFeatureSettings(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	// Toggle BP off
	reqBody := map[string]interface{}{"enabled": false}
	body, _ := json.Marshal(reqBody)
	req := httptest.NewRequest("POST", "/api/settings/features/bp", bytes.NewReader(body))
	req = withUser(req, 123456)
	req.SetPathValue("feature", "bp")
	w := httptest.NewRecorder()
	srv.handleSetFeatureEnabled(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	enabled, err := db.GetBloodPressureEnabled(context.Background())
	if err != nil {
		t.Fatalf("GetBloodPressureEnabled failed: %v", err)
	}
	if enabled {
		t.Fatalf("Expected BP feature disabled")
	}

	// Read all feature settings
	getReq := httptest.NewRequest("GET", "/api/settings/features", nil)
	getReq = withUser(getReq, 123456)
	getW := httptest.NewRecorder()
	srv.handleGetFeatureSettings(getW, getReq)

	if getW.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", getW.Code)
	}

	var resp map[string]bool
	if err := json.NewDecoder(getW.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	if resp["bp"] {
		t.Fatalf("Expected bp=false in feature response")
	}
}
