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

// MCPFoodLogRequest is the payload sent by the MCP container to log a food intake.
type MCPFoodLogRequest struct {
	Name     string    `json:"name"`
	EatenAt  time.Time `json:"eaten_at"`
	Calories int       `json:"calories"`
	CarbsG   int       `json:"carbs_g"`
	ProteinG int       `json:"protein_g"`
	FatG     int       `json:"fat_g"`
	WeightG  int       `json:"weight_g"`
}

// MCPFoodLogResponse is returned to the MCP container after a successful write.
type MCPFoodLogResponse struct {
	ID int64 `json:"id"`
}

// handleMCPFoodLog receives a food intake log from the MCP container and persists it.
// Authentication is the same HMAC-SHA256 scheme used by the audit endpoint.
func (s *Server) handleMCPFoodLog(w http.ResponseWriter, r *http.Request) {
	if s.mcpAuditSecret == "" {
		http.Error(w, "MCP endpoint not configured", http.StatusServiceUnavailable)
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
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(signature), []byte(expected)) {
		slog.Warn("[Server] Invalid MCP food-log signature")
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
	log := &store.FoodLog{
		UserID:   s.allowedUserID,
		EatenAt:  req.EatenAt,
		Name:     req.Name,
		Weight:   req.WeightG,
		Calories: req.Calories,
		Carbs:    req.CarbsG,
		Protein:  req.ProteinG,
		Fat:      req.FatG,
	}

	id, err := s.food.CreateFoodLog(ctx, log)
	if err != nil {
		slog.Error("[Server] MCP food-log: failed to create food log", "error", err)
		http.Error(w, "Failed to create food log", http.StatusInternalServerError)
		return
	}

	slog.Info("[Server] MCP food-log created", "id", id, "name", req.Name, "eaten_at", req.EatenAt.Format("2006-01-02 15:04"))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(MCPFoodLogResponse{ID: id}); err != nil {
		slog.Error("[Server] MCP food-log: failed to encode response", "error", err)
	}
}
