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

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

type mockNotifier struct {
	sent []string
}

func (m *mockNotifier) Send(ctx context.Context, userID int64, n notifier.Notification) (int, error) {
	m.sent = append(m.sent, n.Text)
	return 1, nil
}

func (m *mockNotifier) Delete(ctx context.Context, userID int64, msgID int) error {
	return nil
}

func (m *mockNotifier) CloseNotification(ctx context.Context, userID int64, tag string) error {
	return nil
}

func TestHandleMCPAudit(t *testing.T) {
	secret := "test-secret"
	srv := &Server{
		mcpAuditSecret: secret,
	}

	mockNotif := &mockNotifier{}
	srv.SetNotifiers([]notifier.Notifier{mockNotif})

	now := time.Now()
	payload := AuditPayload{
		DataTypes: []DataTypeSummary{
			{Label: "Vitals", From: now.Add(-5 * 24 * time.Hour), To: now},
			{Label: "Weight", From: now.Add(-2 * 24 * time.Hour), To: now.Add(-2 * 24 * time.Hour)},
		},
		RequestedAt: now,
	}

	body, _ := json.Marshal(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	req := httptest.NewRequest("POST", "/api/mcp-audit", bytes.NewBuffer(body))
	req.Header.Set("X-Signature", sig)
	rec := httptest.NewRecorder()

	srv.handleMCPAudit(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	if len(mockNotif.sent) != 1 {
		t.Fatalf("Expected 1 notification sent, got %d", len(mockNotif.sent))
	}

	sentMsg := mockNotif.sent[0]
	if !bytes.Contains([]byte(sentMsg), []byte("Vitals")) || !bytes.Contains([]byte(sentMsg), []byte("Weight")) {
		t.Errorf("Notification missing data type labels: %s", sentMsg)
	}
}

func TestHandleMCPAudit_InvalidSignature(t *testing.T) {
	secret := "test-secret"
	srv := &Server{
		mcpAuditSecret: secret,
	}

	mockNotif := &mockNotifier{}
	srv.SetNotifiers([]notifier.Notifier{mockNotif})

	payload := AuditPayload{}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest("POST", "/api/mcp-audit", bytes.NewBuffer(body))
	req.Header.Set("X-Signature", "invalid-signature")
	rec := httptest.NewRecorder()

	srv.handleMCPAudit(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("Expected status 401, got %d", rec.Code)
	}

	if len(mockNotif.sent) != 0 {
		t.Error("Expected no notifications to be sent")
	}
}

func TestHandleMCPAudit_BodySizeLimit(t *testing.T) {
	srv, _ := createGenericTestServer(t)
	srv.SetMCPAuditSecret("test-secret")

	// Create body slightly larger than 1MB
	largeBody := make([]byte, (1<<20)+10)
	req := httptest.NewRequest("POST", "/api/mcp-audit", bytes.NewBuffer(largeBody))
	rec := httptest.NewRecorder()

	srv.handleMCPAudit(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 Bad Request for oversized body, got %d", rec.Code)
	}
}

func TestHandleMCPAudit_Snooze(t *testing.T) {
	secret := "test-secret"
	srv := &Server{
		mcpAuditSecret:      secret,
		lastMCPNotification: time.Now().Add(-1 * time.Hour), // Sent 1 hour ago
	}

	mockNotif := &mockNotifier{}
	srv.SetNotifiers([]notifier.Notifier{mockNotif})

	now := time.Now()
	payload := AuditPayload{
		DataTypes: []DataTypeSummary{
			{Label: "Vitals", From: now.Add(-5 * 24 * time.Hour), To: now},
		},
		RequestedAt: now,
	}

	body, _ := json.Marshal(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	req := httptest.NewRequest("POST", "/api/mcp-audit", bytes.NewBuffer(body))
	req.Header.Set("X-Signature", sig)
	rec := httptest.NewRecorder()

	srv.handleMCPAudit(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	if len(mockNotif.sent) != 0 {
		t.Error("Expected notification to be snoozed")
	}

	// Make sure the snooze period wasn't extended by the suppressed request
	srv.mcpAuditMutex.Lock()
	if time.Since(srv.lastMCPNotification) < 1*time.Hour {
		t.Error("Suppressed request extended the snooze window")
	}
	srv.mcpAuditMutex.Unlock()
}
