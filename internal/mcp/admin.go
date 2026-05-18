package mcp

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/store/auth"
)

const (
	maxAPITokenNameLen = 100
)

// AdminStore is the subset of the store needed by the admin API to manage
// long-lived API tokens. *store.Store satisfies this interface.
type AdminStore interface {
	CreateToken(ctx context.Context, name, tokenHash string) (int64, error)
	ListTokens(ctx context.Context) ([]store.APIToken, error)
	DeleteToken(ctx context.Context, id int64) error
}

// AdminHandler exposes a small JSON HTTP API for managing api_tokens. It is
// intended to be served on a loopback-only listener; it has no authentication
// of its own.
type AdminHandler struct {
	store AdminStore
}

// NewAdminHandler constructs an AdminHandler.
func NewAdminHandler(s AdminStore) *AdminHandler {
	return &AdminHandler{store: s}
}

// Mux returns an http.Handler with the admin routes mounted.
func (h *AdminHandler) Mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /admin/tokens", h.handleCreate)
	mux.HandleFunc("GET /admin/tokens", h.handleList)
	mux.HandleFunc("DELETE /admin/tokens/{id}", h.handleDelete)
	return mux
}

type createTokenRequest struct {
	Name string `json:"name"`
}

type createTokenResponse struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Token string `json:"token"`
}

func (h *AdminHandler) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createTokenRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeJSONError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(name) > maxAPITokenNameLen {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("name must be at most %d characters", maxAPITokenNameLen))
		return
	}
	if !isValidAPITokenName(name) {
		writeJSONError(w, http.StatusBadRequest, "name must contain only ASCII letters, digits, space, '-', '_', '.'")
		return
	}

	plaintext, err := generateAPIToken()
	if err != nil {
		slog.Error("[MCP/Admin] generate token", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}
	sum := sha256.Sum256([]byte(plaintext))
	hash := hex.EncodeToString(sum[:])

	id, err := h.store.CreateToken(r.Context(), name, hash)
	if err != nil {
		slog.Error("[MCP/Admin] create api token", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to create token")
		return
	}
	slog.Info("[MCP/Admin] API token created", "id", id, "name", name)

	writeJSON(w, http.StatusCreated, createTokenResponse{
		ID:    id,
		Name:  name,
		Token: plaintext,
	})
}

type listedToken struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	CreatedAt  string  `json:"created_at"`
	LastUsedAt *string `json:"last_used_at"`
}

func (h *AdminHandler) handleList(w http.ResponseWriter, r *http.Request) {
	tokens, err := h.store.ListTokens(r.Context())
	if err != nil {
		slog.Error("[MCP/Admin] list api tokens", "error", err)
		writeJSONError(w, http.StatusInternalServerError, "failed to list tokens")
		return
	}
	out := make([]listedToken, 0, len(tokens))
	for _, t := range tokens {
		entry := listedToken{
			ID:        t.ID,
			Name:      t.Name,
			CreatedAt: t.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		}
		if t.LastUsedAt.Valid {
			s := t.LastUsedAt.Time.UTC().Format("2006-01-02T15:04:05Z")
			entry.LastUsedAt = &s
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *AdminHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeJSONError(w, http.StatusBadRequest, "id must be a positive integer")
		return
	}
	if err := h.store.DeleteToken(r.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "token not found")
			return
		}
		slog.Error("[MCP/Admin] delete api token", "error", err, "id", id)
		writeJSONError(w, http.StatusInternalServerError, "failed to delete token")
		return
	}
	slog.Info("[MCP/Admin] API token deleted", "id", id)
	w.WriteHeader(http.StatusNoContent)
}

// isValidAPITokenName allows ASCII letters, digits, space, '-', '_', '.'. The
// restrictive charset avoids log forging via embedded newlines / control bytes
// (the name is logged on every authorized request and forms the request
// subject identifier "api-token:<name>").
func isValidAPITokenName(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z':
		case c >= 'A' && c <= 'Z':
		case c >= '0' && c <= '9':
		case c == ' ' || c == '-' || c == '_' || c == '.':
		default:
			return false
		}
	}
	return true
}

// generateAPIToken returns a fresh plaintext token of the form
// "mcp_" + 32 random bytes hex-encoded (68 chars total). Wraps the shared
// auth.GeneratePlaintextToken helper so the elevenlabs voice-session mint
// endpoint and the loopback admin endpoint produce identically-shaped tokens.
func generateAPIToken() (string, error) {
	return auth.GeneratePlaintextToken()
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Error("[MCP/Admin] encode response", "error", err)
	}
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
