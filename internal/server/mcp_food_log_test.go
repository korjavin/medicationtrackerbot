package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func newMCPFoodLogServer(t *testing.T, secret string) (*Server, *store.Store) {
	t.Helper()
	st, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	srv := &Server{
		mcpAuditSecret: secret,
		allowedUserID:  123456,
		food:           st,
	}
	return srv, st
}

func signBody(t *testing.T, body []byte, secret string) string {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestHandleMCPFoodLog_Success(t *testing.T) {
	secret := "test-secret"
	srv, st := newMCPFoodLogServer(t, secret)
	defer st.Close()

	payload := MCPFoodLogRequest{
		Name:     "Grilled Chicken",
		EatenAt:  time.Date(2026, 2, 18, 12, 30, 0, 0, time.UTC),
		Calories: 400,
		CarbsG:   5,
		ProteinG: 60,
		FatG:     10,
		WeightG:  200,
	}
	body, _ := json.Marshal(payload)
	sig := signBody(t, body, secret)

	r := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Signature", sig)
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPFoodLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ID == 0 {
		t.Error("expected non-zero ID")
	}

	// Verify persisted in DB
	logs, err := st.GetFoodLogs(context.Background(), 123456, time.Date(2026, 2, 18, 0, 0, 0, 0, time.UTC), 1)
	if err != nil {
		t.Fatalf("GetFoodLogs: %v", err)
	}
	if len(logs) != 1 || logs[0].Name != "Grilled Chicken" {
		t.Errorf("unexpected logs: %+v", logs)
	}
}

func TestHandleMCPFoodLog_InvalidSignature(t *testing.T) {
	srv, st := newMCPFoodLogServer(t, "correct-secret")
	defer st.Close()

	body, _ := json.Marshal(MCPFoodLogRequest{
		Name:    "Pizza",
		EatenAt: time.Now(),
	})

	r := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Signature", "bad-sig")
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestHandleMCPFoodLog_MissingSignature(t *testing.T) {
	srv, st := newMCPFoodLogServer(t, "secret")
	defer st.Close()

	body, _ := json.Marshal(MCPFoodLogRequest{Name: "Salad", EatenAt: time.Now()})
	r := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestHandleMCPFoodLog_NotConfigured(t *testing.T) {
	srv := &Server{mcpAuditSecret: ""} // not configured
	r := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", nil)
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, r)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", w.Code)
	}
}

func TestHandleMCPFoodLog_MissingName(t *testing.T) {
	secret := "s"
	srv, st := newMCPFoodLogServer(t, secret)
	defer st.Close()

	payload := MCPFoodLogRequest{EatenAt: time.Now()} // no name
	body, _ := json.Marshal(payload)
	r := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	r.Header.Set("X-Signature", signBody(t, body, secret))
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
