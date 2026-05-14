package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestHandleChanges_Empty(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/changes", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Decode error: %v", err)
	}

	if resp["cursor"] == nil {
		t.Error("Expected 'cursor' field in response")
	}
	if resp["changed_tags"] == nil {
		t.Error("Expected 'changed_tags' field in response")
	}
}

func TestHandleChanges_WithSinceParam(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/changes?since=0", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
}

func TestHandleChanges_InvalidSinceIgnored(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	// Invalid since param should be treated as 0
	req := httptest.NewRequest("GET", "/api/changes?since=notanumber", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
}

func TestHandleChanges_AfterBPCreate_ReturnsBPTag(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx := context.Background()

	// Create a BP reading — triggers the change_events entry for 'bp'
	bp := &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}
	_, err := db.BP.CreateBloodPressureReading(ctx, bp)
	if err != nil {
		t.Fatalf("CreateBloodPressureReading: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/changes?since=0", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	cursor, ok := resp["cursor"].(float64)
	if !ok || cursor <= 0 {
		t.Errorf("Expected cursor > 0, got %v", resp["cursor"])
	}

	tags, ok := resp["changed_tags"].([]any)
	if !ok {
		t.Fatalf("Expected changed_tags array, got %T", resp["changed_tags"])
	}

	found := false
	for _, tag := range tags {
		if tag == "bp" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("Expected 'bp' in changed_tags, got %v", tags)
	}
}

func TestHandleChanges_SinceCurrentCursorReturnsEmpty(t *testing.T) {
	srv, db := createGenericTestServer(t)
	defer db.Close()

	ctx := context.Background()

	// Insert some change data
	bp := &store.BloodPressure{
		UserID:     123456,
		MeasuredAt: time.Now(),
		Systolic:   120,
		Diastolic:  80,
	}
	db.BP.CreateBloodPressureReading(ctx, bp)

	// Get current cursor
	cursor, err := db.Settings.GetLatestChangeCursor(ctx)
	if err != nil {
		t.Fatalf("GetLatestChangeCursor: %v", err)
	}

	// Query with since = current cursor → nothing new
	req := httptest.NewRequest("GET", fmt.Sprintf("/api/changes?since=%d", cursor), nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleChanges(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)

	tags, _ := resp["changed_tags"].([]any)
	if len(tags) != 0 {
		t.Errorf("Expected 0 tags when since=current cursor, got %v", tags)
	}
}
