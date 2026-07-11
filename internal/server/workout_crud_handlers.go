package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

// Trivial entity-CRUD handlers for workout variants, exercises, and the
// exercise library. These are thin store pass-throughs with no business logic,
// split out of workout_handlers.go so that file stays focused on the
// session-lifecycle handlers that route through the domain service. Behavior is
// unchanged — routes are registered in server.go by method reference, which is
// file-agnostic.

// -- Workout Variant Handlers --

func (s *Server) handleListVariantsByGroup(w http.ResponseWriter, r *http.Request) {
	groupIDStr := r.URL.Query().Get("group_id")
	groupID, err := strconv.ParseInt(groupIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid group ID", http.StatusBadRequest)
		return
	}

	variants, err := s.workouts.ListVariantsByGroup(groupID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(variants); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GroupID       int64  `json:"group_id"`
		Name          string `json:"name"`
		RotationOrder *int   `json:"rotation_order"`
		Description   string `json:"description"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	variant, err := s.workouts.CreateVariant(
		req.GroupID,
		req.Name,
		req.RotationOrder,
		req.Description,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(variant); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name          string `json:"name"`
		RotationOrder *int   `json:"rotation_order"`
		Description   string `json:"description"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateVariant(id, req.Name, req.RotationOrder, req.Description)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteWorkoutVariant(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	err = s.workouts.DeleteVariant(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// -- Exercise Handlers --

func (s *Server) handleListExercisesByVariant(w http.ResponseWriter, r *http.Request) {
	variantIDStr := r.URL.Query().Get("variant_id")
	variantID, err := strconv.ParseInt(variantIDStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid variant ID", http.StatusBadRequest)
		return
	}

	exercises, err := s.workouts.ListExercisesByVariant(variantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(exercises); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateExercise(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VariantID      int64    `json:"variant_id"`
		ExerciseName   string   `json:"exercise_name"`
		TargetSets     int      `json:"target_sets"`
		TargetRepsMin  int      `json:"target_reps_min"`
		TargetRepsMax  *int     `json:"target_reps_max"`
		TargetWeightKg *float64 `json:"target_weight_kg"`
		OrderIndex     int      `json:"order_index"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	exercise, err := s.workouts.CreateExerciseInVariant(
		req.VariantID,
		req.ExerciseName,
		req.TargetSets,
		req.TargetRepsMin,
		req.TargetRepsMax,
		req.TargetWeightKg,
		req.OrderIndex,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(exercise); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateExercise(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid exercise ID", http.StatusBadRequest)
		return
	}

	var req struct {
		ExerciseName   string   `json:"exercise_name"`
		TargetSets     int      `json:"target_sets"`
		TargetRepsMin  int      `json:"target_reps_min"`
		TargetRepsMax  *int     `json:"target_reps_max"`
		TargetWeightKg *float64 `json:"target_weight_kg"`
		OrderIndex     int      `json:"order_index"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.workouts.UpdateExercise(
		id,
		req.ExerciseName,
		req.TargetSets,
		req.TargetRepsMin,
		req.TargetRepsMax,
		req.TargetWeightKg,
		req.OrderIndex,
	)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteExercise(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid exercise ID", http.StatusBadRequest)
		return
	}

	err = s.workouts.DeleteExercise(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// -- Exercise Library Handlers --

func (s *Server) handleListExerciseLibrary(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	items, err := s.workouts.ListExerciseLibrary(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(items); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleCreateExerciseLibraryItem(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		Name            string   `json:"name"`
		DefaultSets     int      `json:"default_sets"`
		DefaultRepsMin  int      `json:"default_reps_min"`
		DefaultRepsMax  *int     `json:"default_reps_max"`
		DefaultWeightKg *float64 `json:"default_weight_kg"`
		Notes           string   `json:"notes"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if strings.TrimSpace(req.Name) == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}

	item, err := s.workouts.CreateExerciseLibraryItem(userID, req.Name, req.DefaultSets, req.DefaultRepsMin, req.DefaultRepsMax, req.DefaultWeightKg, req.Notes)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(item); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleUpdateExerciseLibraryItem(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name            string   `json:"name"`
		DefaultSets     int      `json:"default_sets"`
		DefaultRepsMin  int      `json:"default_reps_min"`
		DefaultRepsMax  *int     `json:"default_reps_max"`
		DefaultWeightKg *float64 `json:"default_weight_kg"`
		Notes           string   `json:"notes"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if strings.TrimSpace(req.Name) == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}

	if err := s.workouts.UpdateExerciseLibraryItem(userID, id, req.Name, req.DefaultSets, req.DefaultRepsMin, req.DefaultRepsMax, req.DefaultWeightKg, req.Notes); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDeleteExerciseLibraryItem(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idStr := r.URL.Query().Get("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.workouts.DeleteExerciseLibraryItem(userID, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}
