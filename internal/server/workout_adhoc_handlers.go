package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// handleCreateAdHocWorkoutSession creates an unscheduled workout session
func (s *Server) handleCreateAdHocWorkoutSession(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	scheduledTime := now.Format("15:04")

	// Create ad-hoc workout session
	session, err := s.store.CreateAdHocWorkoutSession(s.allowedUserID, now, scheduledTime)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Return session data
	response := struct {
		Session     *store.WorkoutSession `json:"session"`
		GroupName   string                `json:"group_name"`
		VariantName string                `json:"variant_name"`
	}{
		Session:     session,
		GroupName:   "Ad-hoc Workout",
		VariantName: "",
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(response)
}
