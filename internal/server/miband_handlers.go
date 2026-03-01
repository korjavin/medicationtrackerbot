package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// handleListMiBandWorkouts returns imported Mi Band outdoor workouts for the authenticated user.
// Query params:
//   - limit (int, default 100): maximum number of records to return
func (s *Server) handleListMiBandWorkouts(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	limit := 100
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil && l > 0 {
			limit = l
		}
	}

	workouts, err := s.miband.ListMiBandWorkouts(r.Context(), userID, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if workouts == nil {
		workouts = []store.MiBandWorkout{}
	}

	// Enrich with human-readable timestamps
	type enriched struct {
		ID            int64   `json:"id"`
		ActivityType  int     `json:"activity_type"`
		ActivityName  string  `json:"activity_name"`
		StartTime     string  `json:"start_time"`
		EndTime       string  `json:"end_time"`
		DurationSec   int     `json:"duration_sec"`
		DistanceM     float64 `json:"distance_m"`
		Steps         int     `json:"steps"`
		Calories      int     `json:"calories"`
		HeartRateAvg  int     `json:"heart_rate_avg"`
		SpO2Avg       int     `json:"spo2_avg"`
		SourceStartMs int64   `json:"source_start_ms"`
	}

	result := make([]enriched, 0, len(workouts))
	for _, wo := range workouts {
		startTime := time.UnixMilli(wo.SourceStartMs).UTC()
		endTime := time.UnixMilli(wo.SourceEndMs).UTC()
		// Apply timezone offset so the frontend shows local time.
		// tz_offset is stored in seconds (e.g. 3600 = UTC+1).
		if wo.TzOffset != 0 {
			loc := time.FixedZone("local", wo.TzOffset)
			startTime = startTime.In(loc)
			endTime = endTime.In(loc)
		}
		result = append(result, enriched{
			ID:            wo.ID,
			ActivityType:  wo.ActivityType,
			ActivityName:  wo.ActivityName,
			StartTime:     startTime.Format(time.RFC3339),
			EndTime:       endTime.Format(time.RFC3339),
			DurationSec:   wo.DurationSec,
			DistanceM:     wo.DistanceM,
			Steps:         wo.Steps,
			Calories:      wo.Calories,
			HeartRateAvg:  wo.HeartRateAvg,
			SpO2Avg:       wo.SpO2Avg,
			SourceStartMs: wo.SourceStartMs,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("encode miband workouts: %v", err)
	}
}

// handleGetMiBandWorkoutGPS returns the GPS track for a specific Mi Band workout.
func (s *Server) handleGetMiBandWorkoutGPS(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid workout ID", http.StatusBadRequest)
		return
	}

	// Verify the workout exists and belongs to this user
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	wo, err := s.miband.GetMiBandWorkout(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if wo == nil || wo.UserID != userID {
		http.Error(w, "Workout not found", http.StatusNotFound)
		return
	}

	pts, err := s.miband.GetMiBandWorkoutGPS(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if pts == nil {
		pts = []store.MiBandGPSPoint{}
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(pts); err != nil {
		log.Printf("encode miband gps: %v", err)
	}
}
