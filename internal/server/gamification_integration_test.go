package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TestGamification_FoodLogReflectsInSummary proves the read-rescore wires the
// food → nourishment-ring → today_hp flow end-to-end: POST a food log for
// today, then GET summary and assert today_hp > 0 (floor HP from logging any
// meal is 2).
func TestGamification_FoodLogReflectsInSummary(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	srv := newServer(db, "tok", "sec", 123456, OIDCConfig{}, "bot", "")
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })

	userID := int64(123456)

	// Enable food intake feature (defaults to 0/disabled; the handler still
	// runs when called directly but gamification scoring reads the food store —
	// the flag only gates the API route, not the store writes).
	if err := db.Settings.SetFoodIntakeEnabled(context.Background(), true); err != nil {
		t.Fatalf("enable food: %v", err)
	}

	// POST a food log for today.
	body, _ := json.Marshal(map[string]interface{}{
		"eaten_at": time.Now(),
		"name":     "test meal",
		"weight":   200,
		"calories": 500,
		"carbs":    60,
		"protein":  30,
		"fat":      15,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/food/log", bytes.NewReader(body))
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	srv.handleCreateFoodLog(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST food/log: got %d, body: %s", w.Code, w.Body.String())
	}

	// GET gamification summary — read-rescore (Task 2) runs inside the handler.
	req2 := httptest.NewRequest(http.MethodGet, "/api/gamification/summary", nil)
	req2 = withUser(req2, userID)
	w2 := httptest.NewRecorder()
	srv.handleGamificationSummary(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("GET gamification/summary: got %d, body: %s", w2.Code, w2.Body.String())
	}

	var sum struct {
		Enabled bool `json:"enabled"`
		TodayHP int  `json:"today_hp"`
	}
	if err := json.NewDecoder(w2.Body).Decode(&sum); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	if !sum.Enabled {
		t.Fatal("gamification should be enabled (default-ON)")
	}
	if sum.TodayHP <= 0 {
		t.Errorf("today_hp = %d after food log; want > 0", sum.TodayHP)
	}
}
