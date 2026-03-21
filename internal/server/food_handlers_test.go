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

func TestParseDateWithTzOffset(t *testing.T) {
	cases := []struct {
		name        string
		dateStr     string
		tzOffsetStr string
		wantUTCHour int // expected UTC hour of the parsed midnight
	}{
		{
			name:        "UTC (tz_offset=0)",
			dateStr:     "2026-03-17",
			tzOffsetStr: "0",
			wantUTCHour: 0, // midnight UTC = 00:00 UTC
		},
		{
			name:        "California PDT (tz_offset=420, UTC-7)",
			dateStr:     "2026-03-17",
			tzOffsetStr: "420",
			wantUTCHour: 7, // midnight PDT = 07:00 UTC
		},
		{
			name:        "Berlin CET (tz_offset=-60, UTC+1)",
			dateStr:     "2026-03-17",
			tzOffsetStr: "-60",
			wantUTCHour: 23, // midnight CET = 23:00 UTC of previous day
		},
		{
			name:        "invalid tz_offset falls back to UTC",
			dateStr:     "2026-03-17",
			tzOffsetStr: "abc",
			wantUTCHour: 0, // falls back to UTC
		},
		{
			name:        "empty tz_offset uses UTC",
			dateStr:     "2026-03-17",
			tzOffsetStr: "",
			wantUTCHour: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := parseDateWithTzOffset(tc.dateStr, tc.tzOffsetStr)
			if result.IsZero() {
				t.Fatal("expected non-zero time")
			}
			if tc.tzOffsetStr == "0" || tc.tzOffsetStr == "420" || tc.tzOffsetStr == "" || tc.tzOffsetStr == "abc" {
				utc := result.UTC()
				if utc.Hour() != tc.wantUTCHour {
					t.Errorf("got UTC hour %d, want %d", utc.Hour(), tc.wantUTCHour)
				}
				if result.Day() != 17 || result.Month() != time.March || result.Year() != 2026 {
					t.Errorf("wrong date: %v", result)
				}
				if result.Hour() != 0 {
					t.Errorf("expected local midnight (hour=0), got %d", result.Hour())
				}
			}
			if tc.tzOffsetStr == "-60" {
				utc := result.UTC()
				if utc.Hour() != tc.wantUTCHour || utc.Day() != 16 {
					t.Errorf("got UTC %v, want 2026-03-16T23:00Z", utc)
				}
			}
		})
	}
}

func TestParseClientLocation_IANAPreferredOverOffset(t *testing.T) {
	// America/Los_Angeles on 2026-03-08 (US spring DST starts): midnight is UTC-8 (PST).
	// tz_offset=420 (UTC-7, PDT) would give the wrong boundary if IANA not used.
	loc := parseClientLocation("America/Los_Angeles", "420")
	if loc == nil {
		t.Fatal("expected non-nil location")
	}
	// Midnight on March 8 in LA should be 08:00 UTC (PST = UTC-8), not 07:00 (PDT = UTC-7)
	midnight := time.Date(2026, time.March, 8, 0, 0, 0, 0, loc)
	utc := midnight.UTC()
	if utc.Hour() != 8 {
		t.Errorf("IANA-derived midnight: got UTC hour %d, want 8 (PST midnight)", utc.Hour())
	}
}

func TestHandleGetFoodLogsTimezone_IANA(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)

	// Item at 2026-03-18T01:00Z = 18:00 PDT on 2026-03-17 (UTC-7 after DST started Mar 8)
	californiaEvening := time.Date(2026, time.March, 18, 1, 0, 0, 0, time.UTC)
	_, err := db.CreateFoodLog(ctx, &store.FoodLog{
		UserID: 123456, EatenAt: californiaEvening, Name: "Late dinner", Calories: 600,
	})
	if err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}

	// With tz=America/Los_Angeles: querying 2026-03-17 SHOULD return it.
	req := httptest.NewRequest("GET", "/api/food/log?date=2026-03-17&tz=America%2FLos_Angeles", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetFoodLogs(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
	var groups []FoodGroup
	if err := json.NewDecoder(w.Body).Decode(&groups); err != nil {
		t.Fatalf("decode: %v", err)
	}
	total := 0
	for _, g := range groups {
		total += len(g.Logs)
	}
	if total != 1 {
		t.Errorf("with tz=America/Los_Angeles: expected 1 item for 2026-03-17, got %d", total)
	}

	// Verify the time label uses local PDT time (18:00), not UTC (01:00)
	if len(groups) > 0 && groups[0].Time != "18:00" {
		t.Errorf("expected time label '18:00' (PDT), got %q", groups[0].Time)
	}
}

// TestHandleGetFoodLogsTimezone verifies that food items added in the evening
// in a western timezone (e.g. California PDT = UTC-7) still appear when
// querying with tz_offset. This is the core regression test for the bug where
// items added after 17:00 PDT were stored as the next UTC day and became invisible.
func TestHandleGetFoodLogsTimezone(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)

	// Simulate food added at 18:00 PDT on 2026-03-17.
	// 18:00 PDT (UTC-7) = 2026-03-18T01:00Z — next UTC day.
	californiaEvening := time.Date(2026, time.March, 18, 1, 0, 0, 0, time.UTC)
	_, err := db.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  californiaEvening,
		Name:     "Late dinner",
		Calories: 600,
	})
	if err != nil {
		t.Fatalf("CreateFoodLog: %v", err)
	}

	// Without tz_offset (UTC day boundaries): querying 2026-03-17 should NOT return it.
	req := httptest.NewRequest("GET", "/api/food/log?date=2026-03-17", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetFoodLogs(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
	var groups []FoodGroup
	if err := json.NewDecoder(w.Body).Decode(&groups); err != nil {
		t.Fatalf("decode: %v", err)
	}
	totalItems := 0
	for _, g := range groups {
		totalItems += len(g.Logs)
	}
	if totalItems != 0 {
		t.Errorf("without tz_offset: expected 0 items for UTC 2026-03-17, got %d (entry is on 2026-03-18 UTC)", totalItems)
	}

	// With tz_offset=420 (PDT, UTC-7): querying 2026-03-17 SHOULD return it.
	// PDT day 2026-03-17 spans [2026-03-17T07:00Z, 2026-03-18T07:00Z).
	// Our item at 2026-03-18T01:00Z falls within that range.
	req = httptest.NewRequest("GET", "/api/food/log?date=2026-03-17&tz_offset=420", nil)
	req = withUser(req, 123456)
	w = httptest.NewRecorder()
	srv.handleGetFoodLogs(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}
	groups = nil
	if err := json.NewDecoder(w.Body).Decode(&groups); err != nil {
		t.Fatalf("decode: %v", err)
	}
	totalItems = 0
	for _, g := range groups {
		totalItems += len(g.Logs)
	}
	if totalItems != 1 {
		t.Errorf("with tz_offset=420: expected 1 item for PDT 2026-03-17, got %d", totalItems)
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
