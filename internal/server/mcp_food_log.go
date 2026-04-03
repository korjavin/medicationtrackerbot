package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// MCPFoodLogRequest is the JSON body sent by the MCP container to log a food entry.
type MCPFoodLogRequest struct {
	Name     string    `json:"name"`
	EatenAt  time.Time `json:"eaten_at"`
	Calories int       `json:"calories"`
	CarbsG   int       `json:"carbs_g"`
	ProteinG int       `json:"protein_g"`
	FatG     int       `json:"fat_g"`
	WeightG  int       `json:"weight_g"`
}

// MCPFoodLogResponse is the JSON response containing the new food log ID.
type MCPFoodLogResponse struct {
	ID int64 `json:"id"`
}

// handleMCPFoodLog receives an HMAC-signed food log request from the MCP container
// and writes the entry to the database.
func (s *Server) handleMCPFoodLog(w http.ResponseWriter, r *http.Request) {
	if s.mcpAuditSecret == "" {
		http.Error(w, "MCP food log endpoint not configured", http.StatusServiceUnavailable)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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
	expectedSignatureBytes := mac.Sum(nil)

	signatureBytes, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(signatureBytes, expectedSignatureBytes) {
		slog.Warn("[Server] Invalid MCP food log signature")
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	var req MCPFoodLogRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	if req.EatenAt.IsZero() {
		http.Error(w, "eaten_at is required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	id, err := s.food.CreateFoodLog(ctx, &store.FoodLog{
		UserID:   s.allowedUserID,
		EatenAt:  req.EatenAt,
		Name:     req.Name,
		Weight:   req.WeightG,
		Calories: req.Calories,
		Carbs:    req.CarbsG,
		Protein:  req.ProteinG,
		Fat:      req.FatG,
	})
	if err != nil {
		slog.Error("[Server] Failed to create food log via MCP", "error", err)
		http.Error(w, "Failed to create food log", http.StatusInternalServerError)
		return
	}

	slog.Info("[Server] MCP food log created", "id", id, "name", req.Name)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(MCPFoodLogResponse{ID: id}); err != nil {
		slog.Error("encode response", "error", err)
	}
}
