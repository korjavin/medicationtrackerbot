package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// stubFoodAI is a minimal FoodAIService used to drive the photo upload and
// natural-language description handlers in tests without depending on a real
// OpenAI-compatible provider.
type stubFoodAI struct {
	photoLogs       []domain.FoodLog
	photoErr        error
	descLogs        []domain.FoodLog
	descErr         error
	lastDescription string
}

func (s *stubFoodAI) ParseMealDescription(ctx context.Context, description string) ([]domain.FoodLog, error) {
	s.lastDescription = description
	if s.descErr != nil {
		return nil, s.descErr
	}
	return s.descLogs, nil
}

func (s *stubFoodAI) ParseMealPhoto(ctx context.Context, imageBytes []byte, mimeType string) ([]domain.FoodLog, error) {
	if s.photoErr != nil {
		return nil, s.photoErr
	}
	return s.photoLogs, nil
}

func createFoodTestServer(t *testing.T) (*Server, *store.Store) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}

	srv := New(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
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

func TestHandleLogFoodNameOnlyAttachesResolvedProductID(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	reqBody := map[string]interface{}{
		"eaten_at": time.Now(),
		"name":     "Apple",
		"weight":   150,
		"calories": 80,
		"carbs":    20,
		"protein":  1,
		"fat":      0,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/food/log", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLog(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ProductID *int64 `json:"product_id"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}
	if resp.ProductID == nil {
		t.Fatal("expected response product_id to be resolved")
	}
	if resp.Name != "Apple" {
		t.Fatalf("expected response name Apple, got %q", resp.Name)
	}

	logs, err := db.Food.ListLogs(context.Background(), 123456, time.Now(), 1)
	if err != nil {
		t.Fatalf("ListLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].ProductID == nil || *logs[0].ProductID != *resp.ProductID {
		t.Fatalf("expected log product_id %v, got %v", *resp.ProductID, logs[0].ProductID)
	}
}

func TestHandleLogFoodProductIDOnlyPersistsProductName(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()
	if err := db.Food.UpsertProduct(ctx, &store.FoodProduct{
		UserID:         123456,
		Name:           "Chicken Rice Bowl",
		Carbs100g:      25,
		Protein100g:    8,
		Fat100g:        4,
		EnergyKcal100g: 170,
	}); err != nil {
		t.Fatalf("UpsertProduct: %v", err)
	}
	product, err := db.Food.GetProductByName(ctx, 123456, "Chicken Rice Bowl")
	if err != nil {
		t.Fatalf("GetProductByName: %v", err)
	}

	reqBody := map[string]interface{}{
		"eaten_at":   time.Now(),
		"product_id": product.ID,
		"weight":     220,
		"calories":   420,
		"carbs":      55,
		"protein":    18,
		"fat":        12,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/food/log", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLog(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ProductID *int64 `json:"product_id"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}
	if resp.ProductID == nil || *resp.ProductID != product.ID {
		t.Fatalf("expected response product_id %d, got %v", product.ID, resp.ProductID)
	}
	if resp.Name != "Chicken Rice Bowl" {
		t.Fatalf("expected response name from product, got %q", resp.Name)
	}

	logs, err := db.Food.ListLogs(ctx, 123456, time.Now(), 1)
	if err != nil {
		t.Fatalf("ListLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].Name != "Chicken Rice Bowl" {
		t.Fatalf("expected log name from product, got %q", logs[0].Name)
	}
	if logs[0].ProductID == nil || *logs[0].ProductID != product.ID {
		t.Fatalf("expected log product_id %d, got %v", product.ID, logs[0].ProductID)
	}
}

func TestHandleGetFoodLogs(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	// Setup: Create logs
	ctx := ctxWithUser(123456)
	db.Food.CreateLog(ctx, &store.FoodLog{
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
	logID, _ := db.Food.CreateLog(ctx, &store.FoodLog{
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
	logs, _ := db.Food.ListLogs(ctx, 123456, time.Now(), 1)
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
	enabled, _ := db.Settings.GetFoodIntakeEnabled(context.Background())
	if !enabled {
		t.Error("Expected food intake to be enabled")
	}
}

func TestHandleGetFoodIntakeStatus(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	db.Settings.SetFoodIntakeEnabled(context.Background(), true)

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
	_, err := db.Food.CreateLog(ctx, &store.FoodLog{
		UserID: 123456, EatenAt: californiaEvening, Name: "Late dinner", Calories: 600,
	})
	if err != nil {
		t.Fatalf("CreateLog: %v", err)
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
	_, err := db.Food.CreateLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  californiaEvening,
		Name:     "Late dinner",
		Calories: 600,
	})
	if err != nil {
		t.Fatalf("CreateLog: %v", err)
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
	id1, _ := db.Food.CreateLog(ctx, &store.FoodLog{
		UserID:   123456,
		EatenAt:  time.Now(),
		Name:     "Apple",
		Weight:   100,
		Carbs:    14,
		Calories: 52,
	})
	id2, _ := db.Food.CreateLog(ctx, &store.FoodLog{
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

// TestHandleGetFoodStats_DST verifies that /api/food/stats uses DST-aware calendar
// day boundaries when tz=America/Los_Angeles is supplied.
//
// Scenario: US spring-forward on 2026-03-08 (clocks jump from 02:00 PST → 03:00 PDT).
// A meal logged at 2026-03-08T09:30:00Z (01:30 PST, still pre-transition) and another
// at 2026-03-08T20:00:00Z (13:00 PDT, post-transition) both belong to local March 8.
// An item on 2026-03-09T08:00:00Z (01:00 PDT) belongs to local March 9 and must NOT
// be counted when querying days=1 for 2026-03-08.
//
// With a fixed tz_offset=480 (PST = UTC-8 throughout), endOfDay would be
// 2026-03-09T08:00:00Z — accidentally including the March 9 item. The IANA-aware path
// sets endOfDay to 2026-03-09T07:00:00Z (PDT midnight), correctly excluding it.
func TestHandleGetFoodStats_DST(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := ctxWithUser(123456)

	entries := []struct {
		utc      time.Time
		calories int
	}{
		// 01:30 PST on March 8 — pre-DST, belongs to local March 8
		{time.Date(2026, time.March, 8, 9, 30, 0, 0, time.UTC), 400},
		// 13:00 PDT on March 8 — post-DST, belongs to local March 8
		{time.Date(2026, time.March, 8, 20, 0, 0, 0, time.UTC), 600},
		// 01:00 PDT on March 9 — belongs to local March 9, must be excluded
		{time.Date(2026, time.March, 9, 8, 0, 0, 0, time.UTC), 999},
	}
	for _, e := range entries {
		if _, err := db.Food.CreateLog(ctx, &store.FoodLog{
			UserID: 123456, EatenAt: e.utc, Name: "test", Calories: e.calories,
		}); err != nil {
			t.Fatalf("CreateLog: %v", err)
		}
	}

	// Fixed offset (PST = UTC-8 = tz_offset=480) incorrectly includes the March 9 item
	// because it computes endOfDay as 2026-03-09T08:00Z instead of 07:00Z.
	req := httptest.NewRequest("GET", "/api/food/stats?date=2026-03-08&days=1&tz_offset=480", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetFoodStats(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("stats (tz_offset): expected 200, got %d", w.Code)
	}
	var statsFixed store.FoodStats
	if err := json.NewDecoder(w.Body).Decode(&statsFixed); err != nil {
		t.Fatalf("decode (tz_offset): %v", err)
	}
	if statsFixed.Calories == 400+600+999 {
		t.Errorf("tz_offset=480: incorrectly included the March 9 item (got %d calories)", statsFixed.Calories)
	}

	// IANA timezone correctly computes endOfDay = 2026-03-09T07:00Z (PDT midnight).
	req = httptest.NewRequest("GET", "/api/food/stats?date=2026-03-08&days=1&tz=America%2FLos_Angeles", nil)
	req = withUser(req, 123456)
	w = httptest.NewRecorder()
	srv.handleGetFoodStats(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("stats (IANA): expected 200, got %d", w.Code)
	}
	var statsIANA store.FoodStats
	if err := json.NewDecoder(w.Body).Decode(&statsIANA); err != nil {
		t.Fatalf("decode (IANA): %v", err)
	}
	if statsIANA.Calories != 400+600 {
		t.Errorf("tz=America/Los_Angeles: expected %d calories for March 8, got %d", 400+600, statsIANA.Calories)
	}
}

// TestHandleCreateFoodLogFromPhoto_ReturnsItemIDs locks in the contract that
// each item in the response carries a non-zero "id" field, which the frontend
// summary card relies on to issue Undo deletes via DELETE /api/food/log/{id}.
func TestHandleCreateFoodLogFromPhoto_ReturnsItemIDs(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	srv.SetFoodAIService(&stubFoodAI{
		photoLogs: []domain.FoodLog{
			{Name: "Apple", Weight: 150, Carbs: 20, Protein: 1, Fat: 0, Calories: 80},
			{Name: "Toast", Weight: 60, Carbs: 30, Protein: 5, Fat: 2, Calories: 160},
		},
	})

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	hdr := make(textproto.MIMEHeader)
	hdr.Set("Content-Disposition", `form-data; name="image"; filename="meal.jpg"`)
	hdr.Set("Content-Type", "image/jpeg")
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write([]byte("fake-jpeg-bytes")); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	req := httptest.NewRequest("POST", "/api/food/log/from-photo", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromPhoto(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Status string `json:"status"`
		Items  []struct {
			ID       int64  `json:"id"`
			Name     string `json:"name"`
			Weight   int    `json:"weight"`
			Calories int    `json:"calories"`
		} `json:"items"`
		Failed int `json:"failed"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if resp.Status != "created" {
		t.Errorf("expected status 'created', got %q", resp.Status)
	}
	if resp.Failed != 0 {
		t.Errorf("expected failed=0, got %d", resp.Failed)
	}
	if len(resp.Items) != 2 {
		t.Fatalf("expected 2 items in response, got %d", len(resp.Items))
	}

	seen := map[int64]bool{}
	for i, item := range resp.Items {
		if item.ID == 0 {
			t.Errorf("item %d (%q): expected non-zero id, got 0", i, item.Name)
		}
		if seen[item.ID] {
			t.Errorf("item %d (%q): duplicate id %d in response", i, item.Name, item.ID)
		}
		seen[item.ID] = true
	}

	// The IDs must point to real rows so that the frontend Undo path
	// (DELETE /api/food/log/{id}) actually removes them.
	logs, err := db.Food.ListLogs(context.Background(), 123456, time.Now(), 1)
	if err != nil {
		t.Fatalf("ListLogs: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("expected 2 persisted logs, got %d", len(logs))
	}
	for _, log := range logs {
		if !seen[log.ID] {
			t.Errorf("persisted log id %d not present in response items", log.ID)
		}
	}
}

// TestHandleCreateFoodLogFromDescription_HappyPath verifies that the
// description endpoint parses a natural-language meal, persists the parsed
// items via the food store, and returns each with a non-zero ID.
func TestHandleCreateFoodLogFromDescription_HappyPath(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	stub := &stubFoodAI{
		descLogs: []domain.FoodLog{
			{Name: "Grilled chicken", Weight: 200, Carbs: 0, Protein: 60, Fat: 8, Calories: 320},
			{Name: "White rice (cooked)", Weight: 158, Carbs: 44, Protein: 4, Fat: 0, Calories: 200},
		},
	}
	srv.SetFoodAIService(stub)

	body := map[string]string{
		"description": "200g grilled chicken with a cup of rice",
	}
	bodyJSON, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/food/log/from-description", bytes.NewReader(bodyJSON))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Status string `json:"status"`
		Items  []struct {
			ID       int64  `json:"id"`
			Name     string `json:"name"`
			Weight   int    `json:"weight"`
			Calories int    `json:"calories"`
		} `json:"items"`
		Failed int `json:"failed"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if resp.Status != "created" {
		t.Errorf("expected status 'created', got %q", resp.Status)
	}
	if resp.Failed != 0 {
		t.Errorf("expected failed=0, got %d", resp.Failed)
	}
	if len(resp.Items) != 2 {
		t.Fatalf("expected 2 items in response, got %d", len(resp.Items))
	}

	if stub.lastDescription != "200g grilled chicken with a cup of rice" {
		t.Errorf("expected description forwarded to AI service, got %q", stub.lastDescription)
	}

	seen := map[int64]bool{}
	for i, item := range resp.Items {
		if item.ID == 0 {
			t.Errorf("item %d (%q): expected non-zero id, got 0", i, item.Name)
		}
		if seen[item.ID] {
			t.Errorf("item %d (%q): duplicate id %d in response", i, item.Name, item.ID)
		}
		seen[item.ID] = true
	}

	logs, err := db.Food.ListLogs(context.Background(), 123456, time.Now(), 1)
	if err != nil {
		t.Fatalf("ListLogs: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("expected 2 persisted logs, got %d", len(logs))
	}
}

// TestHandleCreateFoodLogFromDescription_NoAIService verifies the handler
// returns 503 when the AI service is not configured.
func TestHandleCreateFoodLogFromDescription_NoAIService(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"description": "an apple"})
	req := httptest.NewRequest("POST", "/api/food/log/from-description", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("Expected 503, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// TestHandleCreateFoodLogFromDescription_AIError verifies that an AI parse
// error is surfaced as 502 Bad Gateway, mirroring the photo handler.
func TestHandleCreateFoodLogFromDescription_AIError(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	srv.SetFoodAIService(&stubFoodAI{descErr: fmt.Errorf("AI unreachable")})

	body, _ := json.Marshal(map[string]string{"description": "an apple"})
	req := httptest.NewRequest("POST", "/api/food/log/from-description", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("Expected 502, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// TestHandleCreateFoodLogFromDescription_EmptyResult verifies the handler
// returns 422 when the AI returns no parsed items.
func TestHandleCreateFoodLogFromDescription_EmptyResult(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	srv.SetFoodAIService(&stubFoodAI{descLogs: nil})

	body, _ := json.Marshal(map[string]string{"description": "asdfqwer"})
	req := httptest.NewRequest("POST", "/api/food/log/from-description", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("Expected 422, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// TestHandleCreateFoodLogFromDescription_MalformedJSON verifies the handler
// rejects malformed JSON bodies with 400.
func TestHandleCreateFoodLogFromDescription_MalformedJSON(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	srv.SetFoodAIService(&stubFoodAI{})

	req := httptest.NewRequest("POST", "/api/food/log/from-description", strings.NewReader("not json"))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d. Body: %s", w.Code, w.Body.String())
	}
}

// TestHandleCreateFoodLogFromDescription_InvalidEatenAt verifies the handler
// rejects a non-empty but unparseable eaten_at with 400 rather than silently
// falling back to time.Now(). MCP/API callers that send a malformed timestamp
// should get a clear error, not a meal logged at the wrong time.
func TestHandleCreateFoodLogFromDescription_InvalidEatenAt(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	srv.SetFoodAIService(&stubFoodAI{descLogs: []domain.FoodLog{{Name: "X", Weight: 1}}})

	body, _ := json.Marshal(map[string]string{
		"description": "an apple",
		"eaten_at":    "not-a-real-timestamp",
	})
	req := httptest.NewRequest("POST", "/api/food/log/from-description", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d. Body: %s", w.Code, w.Body.String())
	}

	// Nothing should have been persisted.
	logs, err := db.Food.ListLogs(context.Background(), 123456, time.Now(), 1)
	if err != nil {
		t.Fatalf("ListLogs: %v", err)
	}
	if len(logs) != 0 {
		t.Errorf("expected no persisted logs on validation failure, got %d", len(logs))
	}
}

// TestHandleCreateFoodLogFromPhoto_InvalidEatenAt mirrors the description-handler
// test above: a non-empty unparseable eaten_at must return 400 rather than
// silently substituting time.Now().
func TestHandleCreateFoodLogFromPhoto_InvalidEatenAt(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	srv.SetFoodAIService(&stubFoodAI{
		photoLogs: []domain.FoodLog{{Name: "Apple", Weight: 150}},
	})

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	hdr := make(textproto.MIMEHeader)
	hdr.Set("Content-Disposition", `form-data; name="image"; filename="meal.jpg"`)
	hdr.Set("Content-Type", "image/jpeg")
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write([]byte("fake-jpeg-bytes")); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.WriteField("eaten_at", "not-a-real-timestamp"); err != nil {
		t.Fatalf("WriteField: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	req := httptest.NewRequest("POST", "/api/food/log/from-photo", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromPhoto(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d. Body: %s", w.Code, w.Body.String())
	}

	logs, err := db.Food.ListLogs(context.Background(), 123456, time.Now(), 1)
	if err != nil {
		t.Fatalf("ListLogs: %v", err)
	}
	if len(logs) != 0 {
		t.Errorf("expected no persisted logs on validation failure, got %d", len(logs))
	}
}

// TestHandleCreateFoodLogFromDescription_TooLong verifies the handler caps
// the description payload and never forwards an oversized prompt to the AI
// service. Without this cap an authenticated caller can burn provider credit
// by POSTing arbitrarily large strings.
func TestHandleCreateFoodLogFromDescription_TooLong(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	stub := &stubFoodAI{descLogs: []domain.FoodLog{{Name: "X", Weight: 1}}}
	srv.SetFoodAIService(stub)

	body, _ := json.Marshal(map[string]string{
		"description": strings.Repeat("a", 4097),
	})
	req := httptest.NewRequest("POST", "/api/food/log/from-description", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d. Body: %s", w.Code, w.Body.String())
	}
	if stub.lastDescription != "" {
		t.Errorf("AI service must not be invoked for oversized descriptions; got %q", stub.lastDescription)
	}
}

// TestHandleCreateFoodLogFromDescription_MissingDescription verifies the
// handler rejects an empty/whitespace-only description with 400.
func TestHandleCreateFoodLogFromDescription_MissingDescription(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("SetFoodIntakeEnabled: %v", err)
	}

	srv.SetFoodAIService(&stubFoodAI{})

	body, _ := json.Marshal(map[string]string{"description": "   "})
	req := httptest.NewRequest("POST", "/api/food/log/from-description", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateFoodLogFromDescription(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d. Body: %s", w.Code, w.Body.String())
	}
}
