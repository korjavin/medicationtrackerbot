package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
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

func TestHandleBootstrap(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	if _, err := db.CreateMedication("Bootstrap Med", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", ""); err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/bootstrap", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleBootstrap(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	var payload map[string]any
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}

	if _, ok := payload["features"].(map[string]any); !ok {
		t.Fatalf("Expected features object in bootstrap payload")
	}
	if meds, ok := payload["medications"].([]any); !ok || len(meds) == 0 {
		t.Fatalf("Expected non-empty medications in bootstrap payload")
	}
	if _, ok := payload["bp"].(map[string]any); !ok {
		t.Fatalf("Expected bp object in bootstrap payload")
	}
	if _, ok := payload["weight"].(map[string]any); !ok {
		t.Fatalf("Expected weight object in bootstrap payload")
	}
	if _, ok := payload["settings"].(map[string]any); !ok {
		t.Fatalf("Expected settings object in bootstrap payload")
	}
	if _, ok := payload["cursor"].(float64); !ok {
		t.Fatalf("Expected numeric cursor in bootstrap payload")
	}
}

func TestHandleChanges(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()

	reqInitial := httptest.NewRequest("GET", "/api/changes?since=0", nil)
	reqInitial = withUser(reqInitial, 123456)
	wInitial := httptest.NewRecorder()
	srv.handleChanges(wInitial, reqInitial)

	if wInitial.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", wInitial.Code)
	}

	var first map[string]any
	if err := json.NewDecoder(wInitial.Body).Decode(&first); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	cursor, ok := first["cursor"].(float64)
	if !ok {
		t.Fatalf("Expected numeric cursor")
	}

	// Simulate a write-side mutation in DB, should be captured by change_events trigger.
	if _, err := db.CreateBloodPressureReading(ctxWithUser(123456), &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}); err != nil {
		t.Fatalf("CreateBloodPressureReading failed: %v", err)
	}

	reqDelta := httptest.NewRequest("GET", "/api/changes?since="+strconv.FormatUint(uint64(cursor), 10), nil)
	reqDelta = withUser(reqDelta, 123456)
	wDelta := httptest.NewRecorder()
	srv.handleChanges(wDelta, reqDelta)

	if wDelta.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", wDelta.Code)
	}

	var second struct {
		Cursor      float64  `json:"cursor"`
		ChangedTags []string `json:"changed_tags"`
	}
	if err := json.NewDecoder(wDelta.Body).Decode(&second); err != nil {
		t.Fatalf("Decode failed: %v", err)
	}
	if second.Cursor <= cursor {
		t.Fatalf("Expected cursor to increase: before=%v after=%v", cursor, second.Cursor)
	}
	found := false
	for _, tag := range second.ChangedTags {
		if tag == "bp" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Expected changed_tags to include bp, got %v", second.ChangedTags)
	}
}
