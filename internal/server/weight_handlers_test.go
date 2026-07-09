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

	srv := newServer(db, "test-token", "test-secret", 123456, OIDCConfig{}, "test-bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
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
	db.Weight.CreateLog(ctx, wLog1)

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

// The edit flow POSTs the replacement first, then DELETEs the original. When
// the client signals the replacement via `?replaces=<id>` the server must
// exclude that row from the EMA baseline — otherwise the new row's trend is
// smoothed against a soon-to-be-deleted value and drifts on every edit.
func TestHandleCreateWeightReplacesExcludesOriginalFromTrend(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	ctx := weightCtxWithUser(123456)
	baseTrend := 80.0
	_, err := db.Weight.CreateLog(ctx, &store.WeightLog{
		UserID:      123456,
		MeasuredAt:  time.Now().Add(-48 * time.Hour),
		Weight:      80.0,
		WeightTrend: &baseTrend,
	})
	if err != nil {
		t.Fatalf("seed base log: %v", err)
	}

	// Original "latest" log with a trend already smoothed from the base.
	origTrend := 79.95
	origID, err := db.Weight.CreateLog(ctx, &store.WeightLog{
		UserID:      123456,
		MeasuredAt:  time.Now().Add(-24 * time.Hour),
		Weight:      79.5,
		WeightTrend: &origTrend,
	})
	if err != nil {
		t.Fatalf("seed original log: %v", err)
	}

	reqBody := map[string]interface{}{
		"measured_at": time.Now(),
		"weight":      79.5,
	}
	body, _ := json.Marshal(reqBody)

	url := fmt.Sprintf("/api/weight?replaces=%d", origID)
	req := httptest.NewRequest("POST", url, bytes.NewReader(body))
	req = weightReqWithUser(req, 123456)
	w := httptest.NewRecorder()

	srv.handleCreateWeight(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp store.WeightLog
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Baseline = base log (trend 80.0), NOT the original (trend 79.95).
	// Expected: 0.1 * 79.5 + 0.9 * 80.0 = 79.95.
	expected := 79.95
	if resp.WeightTrend == nil || *resp.WeightTrend != expected {
		t.Errorf("Expected trend %f (baseline excludes replaced row), got %v", expected, resp.WeightTrend)
	}
}

func TestHandleListWeight(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	ctx := weightCtxWithUser(123456)
	db.Weight.CreateLog(ctx, &store.WeightLog{
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
	id, _ := db.Weight.CreateLog(ctx, &store.WeightLog{
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
	logs, _ := db.Weight.ListLogs(ctx, 123456, time.Time{})
	if len(logs) != 0 {
		t.Errorf("Expected 0 logs, got %d", len(logs))
	}
}

func TestHandleExportWeight(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	ctx := weightCtxWithUser(123456)
	db.Weight.CreateLog(ctx, &store.WeightLog{
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

// TestHandleGetWeightGoal_IncludesSnapshotFields asserts the response surfaces
// goal_set_at + goal_start_weight when the latest goal comes from the
// per-user weight_goals history table.
func TestHandleGetWeightGoal_IncludesSnapshotFields(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	const userID = int64(123456)
	ctx := weightCtxWithUser(userID)

	if _, err := db.Weight.CreateLog(ctx, &store.WeightLog{
		UserID:     userID,
		MeasuredAt: time.Now().Add(-24 * time.Hour),
		Weight:     85.0,
	}); err != nil {
		t.Fatalf("seed weight log: %v", err)
	}

	target := time.Now().Add(60 * 24 * time.Hour)
	if err := db.Weight.SetGoal(ctx, userID, 75.0, target); err != nil {
		t.Fatalf("set goal: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/weight/goal", nil)
	req = weightReqWithUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetWeightGoal(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if g, ok := resp["goal"].(float64); !ok || g != 75.0 {
		t.Errorf("goal: got %v want 75.0", resp["goal"])
	}
	if _, ok := resp["goal_set_at"]; !ok {
		t.Errorf("goal_set_at missing: %v", resp)
	}
	sw, ok := resp["goal_start_weight"].(float64)
	if !ok {
		t.Fatalf("goal_start_weight missing or wrong type: %v", resp["goal_start_weight"])
	}
	if sw != 85.0 {
		t.Errorf("goal_start_weight: got %v want 85.0", sw)
	}
}

// TestHandleGetWeightGoal_OmitsSnapshotWhenLegacyFallback asserts the response
// omits goal_set_at + goal_start_weight when the goal comes from the legacy
// singleton settings.weight_goal* columns (no per-user history row exists).
func TestHandleGetWeightGoal_OmitsSnapshotWhenLegacyFallback(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	const userID = int64(123456)

	// Seed the legacy singleton settings row directly so the history table
	// stays empty for this user. GetGoal then falls back to settings.
	target := time.Now().Add(30 * 24 * time.Hour).Format("2006-01-02")
	if _, err := db.DB().ExecContext(weightCtxWithUser(userID),
		"UPDATE settings SET weight_goal = ?, weight_goal_date = ? WHERE id = 1",
		70.0, target,
	); err != nil {
		t.Fatalf("seed legacy goal: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/weight/goal", nil)
	req = weightReqWithUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleGetWeightGoal(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", w.Code, w.Body.String())
	}

	// Decode into a tolerant map so omitempty is observable as a missing key.
	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if g, ok := resp["goal"].(float64); !ok || g != 70.0 {
		t.Errorf("goal: got %v want 70.0", resp["goal"])
	}
	if _, ok := resp["goal_set_at"]; ok {
		t.Errorf("expected goal_set_at to be omitted on legacy fallback, got %v", resp["goal_set_at"])
	}
	if _, ok := resp["goal_start_weight"]; ok {
		t.Errorf("expected goal_start_weight to be omitted on legacy fallback, got %v", resp["goal_start_weight"])
	}
}

// TestHandleListWeightGoals_SortedDescAndScoped asserts the new history
// endpoint returns rows sorted by set_at_unix descending, honors ?limit, and
// stays per-user scoped.
func TestHandleListWeightGoals_SortedDescAndScoped(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	const userA = int64(1001)
	const userB = int64(1002)

	// User A: two history rows; the SetGoal-derived set_at_unix may be the
	// same second when both saves run inside one fast test. Force distinct
	// set_at_unix values via direct INSERT so the desc ordering is
	// deterministic.
	ctx := weightCtxWithUser(userA)
	now := time.Now().Unix()
	if _, err := db.DB().ExecContext(ctx,
		`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
		 VALUES (?, ?, ?, ?, ?)`,
		userA, now-100, 80.0, "2026-06-01", 90.0,
	); err != nil {
		t.Fatalf("seed userA old goal: %v", err)
	}
	if _, err := db.DB().ExecContext(ctx,
		`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
		 VALUES (?, ?, ?, ?, ?)`,
		userA, now, 75.0, "2026-07-01", 88.0,
	); err != nil {
		t.Fatalf("seed userA new goal: %v", err)
	}

	// User B has a goal of their own that must not leak into userA's list.
	if _, err := db.DB().ExecContext(weightCtxWithUser(userB),
		`INSERT INTO weight_goals (user_id, set_at_unix, target_weight, target_date, start_weight)
		 VALUES (?, ?, ?, ?, ?)`,
		userB, now, 65.0, "2026-08-01", 70.0,
	); err != nil {
		t.Fatalf("seed userB goal: %v", err)
	}

	// Default (no ?limit) returns both userA rows, newest first.
	req := httptest.NewRequest("GET", "/api/weight/goals/history", nil)
	req = weightReqWithUser(req, userA)
	w := httptest.NewRecorder()
	srv.handleListWeightGoals(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", w.Code, w.Body.String())
	}

	var resp struct {
		Goals []store.WeightGoalHistory `json:"goals"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Goals) != 2 {
		t.Fatalf("goals count: got %d want 2; goals=%v", len(resp.Goals), resp.Goals)
	}
	if resp.Goals[0].TargetWeight != 75.0 || resp.Goals[1].TargetWeight != 80.0 {
		t.Errorf("desc order broken: got %v then %v", resp.Goals[0].TargetWeight, resp.Goals[1].TargetWeight)
	}
	for _, g := range resp.Goals {
		if g.UserID != userA {
			t.Errorf("per-user scope leak: row user_id=%d (expected %d)", g.UserID, userA)
		}
	}

	// ?limit=1 caps to the newest row.
	req = httptest.NewRequest("GET", "/api/weight/goals/history?limit=1", nil)
	req = weightReqWithUser(req, userA)
	w = httptest.NewRecorder()
	srv.handleListWeightGoals(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("limit status: got %d want 200", w.Code)
	}
	resp = struct {
		Goals []store.WeightGoalHistory `json:"goals"`
	}{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode limit: %v", err)
	}
	if len(resp.Goals) != 1 {
		t.Fatalf("limit=1 count: got %d want 1", len(resp.Goals))
	}
	if resp.Goals[0].TargetWeight != 75.0 {
		t.Errorf("limit=1 newest: got %v want 75.0", resp.Goals[0].TargetWeight)
	}

	// User B sees only their own history (one row).
	req = httptest.NewRequest("GET", "/api/weight/goals/history", nil)
	req = weightReqWithUser(req, userB)
	w = httptest.NewRecorder()
	srv.handleListWeightGoals(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("userB status: got %d want 200", w.Code)
	}
	resp = struct {
		Goals []store.WeightGoalHistory `json:"goals"`
	}{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode userB: %v", err)
	}
	if len(resp.Goals) != 1 || resp.Goals[0].UserID != userB || resp.Goals[0].TargetWeight != 65.0 {
		t.Errorf("userB isolation broken: %v", resp.Goals)
	}
}

// TestHandleListWeightGoals_EmptyHistoryReturnsEmptyList asserts the endpoint
// returns {"goals": []} (not null) when the user has no history rows yet.
func TestHandleListWeightGoals_EmptyHistoryReturnsEmptyList(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/weight/goals/history", nil)
	req = weightReqWithUser(req, 999999)
	w := httptest.NewRecorder()
	srv.handleListWeightGoals(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200", w.Code)
	}

	body := w.Body.String()
	// Verify the JSON contains an empty array, not "null".
	if !strings.Contains(body, `"goals":[]`) {
		t.Errorf("expected empty goals array in body, got %s", body)
	}
}

func TestHandleSetWeightGoal_NoDate(t *testing.T) {
	srv, db := createWeightTestServer(t)
	defer db.Close()

	const userID = int64(12345)

	// Create request with NO target_date (which simulates what the UI sends)
	payload := `{"target_weight": 70.0}`
	req := httptest.NewRequest("POST", "/api/weight/goal", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	req = weightReqWithUser(req, userID)
	w := httptest.NewRecorder()

	srv.handleSetWeightGoal(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200; body=%s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Make sure the goal is set
	if goal, ok := resp["goal"].(float64); !ok || goal != 70.0 {
		t.Errorf("goal mismatch: %v", resp["goal"])
	}

	// Make sure goal_date is omitted
	if _, ok := resp["goal_date"]; ok {
		t.Errorf("expected goal_date to be omitted, got %v", resp["goal_date"])
	}

	// Check DB manually to make sure no 0001-01-01 was written
	var targetDate *string
	err := db.DB().QueryRowContext(context.Background(), "SELECT target_date FROM weight_goals WHERE user_id = ? ORDER BY set_at_unix DESC LIMIT 1", userID).Scan(&targetDate)
	if err != nil {
		t.Fatalf("query history: %v", err)
	}
	if targetDate != nil {
		t.Errorf("expected target_date in history table to be NULL, got %s", *targetDate)
	}
}
