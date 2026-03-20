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

func createMCPFoodLogTestServer(t *testing.T, secret string) (*Server, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test store: %v", err)
	}
	srv := New(db, "test-token", "test-session-secret", 123456, OIDCConfig{}, "test-bot", "")
	srv.mcpAuditSecret = secret
	return srv, db
}

func signBody(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestHandleMCPFoodLog_ValidRequest(t *testing.T) {
	srv, db := createMCPFoodLogTestServer(t, "test-secret")
	defer db.Close()

	payload := MCPFoodLogRequest{
		Name:     "Pasta",
		EatenAt:  time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC),
		Calories: 500,
		CarbsG:   70,
		ProteinG: 20,
		FatG:     10,
		WeightG:  300,
	}
	body, _ := json.Marshal(payload)
	sig := signBody(body, "test-secret")

	req := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", sig)
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, req)

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

	// Verify entry exists in DB
	logs, err := db.GetFoodLogs(context.Background(), 123456, time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), 1)
	if err != nil {
		t.Fatalf("GetFoodLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log in DB, got %d", len(logs))
	}
	if logs[0].Name != "Pasta" {
		t.Errorf("expected name 'Pasta', got %q", logs[0].Name)
	}
	if logs[0].Calories != 500 {
		t.Errorf("expected calories 500, got %d", logs[0].Calories)
	}
}

func TestHandleMCPFoodLog_WrongSignature(t *testing.T) {
	srv, db := createMCPFoodLogTestServer(t, "test-secret")
	defer db.Close()

	payload := MCPFoodLogRequest{Name: "Pasta", EatenAt: time.Now()}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	req.Header.Set("X-Signature", "badsignature")
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestHandleMCPFoodLog_MissingSignature(t *testing.T) {
	srv, db := createMCPFoodLogTestServer(t, "test-secret")
	defer db.Close()

	payload := MCPFoodLogRequest{Name: "Pasta", EatenAt: time.Now()}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	// No X-Signature header
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestHandleMCPFoodLog_SecretNotConfigured(t *testing.T) {
	srv, db := createMCPFoodLogTestServer(t, "") // empty secret = not configured
	defer db.Close()

	payload := MCPFoodLogRequest{Name: "Pasta", EatenAt: time.Now()}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	req.Header.Set("X-Signature", signBody(body, ""))
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestHandleMCPFoodLog_MissingName(t *testing.T) {
	srv, db := createMCPFoodLogTestServer(t, "test-secret")
	defer db.Close()

	payload := MCPFoodLogRequest{EatenAt: time.Now()} // no Name
	body, _ := json.Marshal(payload)
	sig := signBody(body, "test-secret")

	req := httptest.NewRequest(http.MethodPost, "/api/mcp-food-log", bytes.NewReader(body))
	req.Header.Set("X-Signature", sig)
	w := httptest.NewRecorder()

	srv.handleMCPFoodLog(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing name, got %d", w.Code)
	}
}
