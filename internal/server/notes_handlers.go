package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
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

	var since time.Time
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil && d > 0 {
			since = time.Now().AddDate(0, 0, -d)
		}
	}

	notes, err := s.notesSvc.ListNotes(r.Context(), userID, since, time.Time{}, limit, beforeID)
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
		Content string  `json:"content"`
		Tag     *string `json:"tag"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	note, err := s.notesSvc.CreateNote(r.Context(), userID, req.Content, req.Tag)
	if err != nil {
		if errors.Is(err, domain.ErrEmptyContent) {
			http.Error(w, "content is required", http.StatusBadRequest)
			return
		}
		if errors.Is(err, domain.ErrContentTooLong) {
			http.Error(w, "content too long", http.StatusBadRequest)
			return
		}
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

	if err := s.notesSvc.DeleteNote(r.Context(), userID, id); err != nil {
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
