package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
)

// DataTypeSummary represents a single data type queried and its time range
type DataTypeSummary struct {
	Label string    `json:"label"`
	From  time.Time `json:"from"`
	To    time.Time `json:"to"`
}

// AuditPayload represents the JSON payload from the MCP container
type AuditPayload struct {
	DataTypes   []DataTypeSummary `json:"data_types"`
	RequestedAt time.Time         `json:"requested_at"`
}

// handleMCPAudit receives aggregated audit logs from the MCP container and sends a notification
func (s *Server) handleMCPAudit(w http.ResponseWriter, r *http.Request) {
	if s.mcpAuditSecret == "" {
		http.Error(w, "MCP audit endpoint not configured", http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	signature := r.Header.Get("X-Signature")
	if signature == "" {
		http.Error(w, "Missing X-Signature header", http.StatusUnauthorized)
		return
	}

	mac := hmac.New(sha256.New, []byte(s.mcpAuditSecret))
	mac.Write(body)
	expectedSignature := hex.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(signature), []byte(expectedSignature)) {
		log.Printf("[Server] Invalid MCP audit signature")
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	var payload AuditPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if len(payload.DataTypes) == 0 {
		w.WriteHeader(http.StatusOK)
		return
	}

	s.mcpAuditMutex.Lock()
	lastSent := s.lastMCPNotification

	// 2-hour snooze
	if time.Since(lastSent) < 2*time.Hour {
		s.mcpAuditMutex.Unlock()
		log.Printf("[Server] Suppressing MCP audit notification (snooze active)")
		w.WriteHeader(http.StatusOK)
		return
	}

	s.lastMCPNotification = time.Now()
	s.mcpAuditMutex.Unlock()

	// Format notification message
	var parts []string
	currentYear := time.Now().Year()

	for _, dt := range payload.DataTypes {
		fromStr := dt.From.Format("Jan 2")
		if dt.From.Year() != currentYear {
			fromStr = dt.From.Format("Jan 2 2006")
		}

		toStr := dt.To.Format("Jan 2")
		if dt.To.Year() != currentYear {
			toStr = dt.To.Format("Jan 2 2006")
		}

		if fromStr == toStr {
			parts = append(parts, fmt.Sprintf("%s (%s)", dt.Label, fromStr))
		} else {
			parts = append(parts, fmt.Sprintf("%s (%s–%s)", dt.Label, fromStr, toStr))
		}
	}

	msg := fmt.Sprintf("🔍 MCP queried: %s", strings.Join(parts, ", "))

	ctx := r.Context()
	notification := notifier.Notification{Text: msg}

	for _, n := range s.notifiers {
		_, err := n.Send(ctx, s.allowedUserID, notification)
		if err != nil {
			log.Printf("[Server] Failed to send MCP audit notification via %T: %v", n, err)
		}
	}

	w.WriteHeader(http.StatusOK)
}
