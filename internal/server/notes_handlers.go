package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func (s *Server) handleListNotes(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	limit := 50
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil && l > 0 && l <= 200 {
			limit = l
		}
	}

	var beforeID int64
	if bStr := r.URL.Query().Get("before_id"); bStr != "" {
		if b, err := strconv.ParseInt(bStr, 10, 64); err == nil && b > 0 {
			beforeID = b
		}
	}

	notes, err := s.notes.ListDiaryNotes(r.Context(), userID, time.Time{}, time.Time{}, limit, beforeID)
	if err != nil {
		slog.Error("list diary notes", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	if notes == nil {
		notes = []store.DiaryNote{}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(notes); err != nil {
		slog.Error("encode notes response", "error", err)
	}
}

func (s *Server) handleCreateNote(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Content string `json:"content"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		http.Error(w, "content is required", http.StatusBadRequest)
		return
	}
	if utf8.RuneCountInString(req.Content) > 10000 {
		http.Error(w, "content too long", http.StatusBadRequest)
		return
	}

	note, err := s.notes.CreateDiaryNote(r.Context(), userID, req.Content)
	if err != nil {
		slog.Error("create diary note", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(note); err != nil {
		slog.Error("encode note response", "error", err)
	}
}

func (s *Server) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	if err := s.notes.DeleteDiaryNote(r.Context(), userID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "note not found", http.StatusNotFound)
			return
		}
		slog.Error("delete diary note", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
