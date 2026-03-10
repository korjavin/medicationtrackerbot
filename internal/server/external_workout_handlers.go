package server

import (
	"bytes"
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type miNotifyPayload struct {
	WorkoutType string  `json:"workout_type"`
	StartTime   int64   `json:"start_time"`
	EndTime     int64   `json:"end_time"`
	Calories    int     `json:"calories"`
	Distance    float64 `json:"distance"`
	HeartRate   int     `json:"heart_rate"`
	SpO2        int     `json:"spo2"`
	Steps       int     `json:"steps"`
}

// externalAPIKeyMiddleware ensures the request has a valid Authorization header
// matching the configured externalAPIKey.
func (s *Server) externalAPIKeyMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.externalAPIKey == "" {
			http.Error(w, "External API not configured", http.StatusUnauthorized)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, "Missing Authorization header", http.StatusUnauthorized)
			return
		}

		key := strings.TrimPrefix(authHeader, "Bearer ")
		key = strings.TrimSpace(key)

		// Use constant-time comparison to prevent timing side-channels
		if !hmac.Equal([]byte(key), []byte(s.externalAPIKey)) {
			http.Error(w, "Invalid API key", http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	}
}

// handleExternalWorkout processes incoming external workout data (e.g. from Mi Notify).
func (s *Server) handleExternalWorkout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit request body size to 1MB
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		slog.Error("[external-workout] error reading body", "error", err)
		http.Error(w, "Error reading request", http.StatusBadRequest)
		return
	}

	slog.Info("[external-workout] raw body", "body", string(bodyBytes))

	var payload miNotifyPayload
	if err := json.NewDecoder(bytes.NewReader(bodyBytes)).Decode(&payload); err != nil {
		truncated := string(bodyBytes)
		if len(truncated) > 200 {
			truncated = truncated[:200] + "…"
		}
		slog.Error("[external-workout] error parsing JSON", "error", err, "body", truncated)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if payload.WorkoutType == "" {
		slog.Warn("[external-workout] missing WorkoutType", "body", string(bodyBytes))
		http.Error(w, "Missing required field: workout_type", http.StatusBadRequest)
		return
	}
	if payload.StartTime <= 0 {
		slog.Warn("[external-workout] missing or invalid StartTime", "body", string(bodyBytes))
		http.Error(w, "Missing required field: start_time", http.StatusBadRequest)
		return
	}

	// Detect timestamp unit
	startMs := payload.StartTime
	endMs := payload.EndTime
	isSecondsPrecision := false
	if startMs < 1e12 {
		isSecondsPrecision = true
		startMs *= 1000
		if endMs > 0 {
			endMs *= 1000
		}
	}

	// Perform fuzzy deduplication if the timestamp was in seconds
	if isSecondsPrecision {
		isDuplicate, err := s.miband.CheckDuplicateMiBandWorkout(r.Context(), s.allowedUserID, startMs, startMs+999)
		if err != nil {
			slog.Error("[external-workout] db error checking duplicate", "error", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		if isDuplicate {
			slog.Info("[external-workout] skipped duplicate workout (fuzzy check)", "workoutType", payload.WorkoutType, "startMs", startMs)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"status": "duplicate",
			})
			return
		}
	}

	durationSec := 0
	if endMs > startMs {
		durationSec = int((endMs - startMs) / 1000)
	}

	workout := &store.MiBandWorkout{
		UserID:        s.allowedUserID,
		SourceStartMs: startMs,
		SourceEndMs:   endMs,
		ActivityType:  0, // unknown
		ActivityName:  payload.WorkoutType,
		DurationSec:   durationSec,
		DistanceM:     payload.Distance,
		Steps:         payload.Steps,
		Calories:      payload.Calories,
		HeartRateAvg:  payload.HeartRate,
		SpO2Avg:       payload.SpO2,
	}

	inserted, err := s.miband.InsertMiBandWorkout(r.Context(), workout)
	if err != nil {
		slog.Error("[external-workout] db insert error", "error", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if !inserted {
		slog.Info("[external-workout] skipped duplicate workout", "activityName", workout.ActivityName, "startMs", workout.SourceStartMs)
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "duplicate",
		})
		return
	}

	durationMin := durationSec / 60
	s.notify(r.Context(), notifier.Notification{
		Text: fmt.Sprintf("🏃 Workout recorded: %s (%d min, %.2f km)", workout.ActivityName, durationMin, workout.DistanceM/1000),
		Tag:  "external-workout",
	})

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
		"id":     workout.ID,
	})
}

// handleBulkImportWorkouts processes an array of external workout data.
func (s *Server) handleBulkImportWorkouts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit request body size to 10MB for bulk imports
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		slog.Error("[bulk-workout-import] error reading body", "error", err)
		http.Error(w, "Error reading request", http.StatusBadRequest)
		return
	}

	var payloads []miNotifyPayload
	if err := json.NewDecoder(bytes.NewReader(bodyBytes)).Decode(&payloads); err != nil {
		slog.Error("[bulk-workout-import] error parsing JSON array", "error", err)
		http.Error(w, "Invalid JSON array", http.StatusBadRequest)
		return
	}

	imported := 0
	duplicates := 0
	errors := 0

	for _, payload := range payloads {
		if payload.WorkoutType == "" || payload.StartTime <= 0 {
			errors++
			continue
		}

		startMs := payload.StartTime
		endMs := payload.EndTime
		isSecondsPrecision := false
		if startMs < 1e12 {
			isSecondsPrecision = true
			startMs *= 1000
			if endMs > 0 {
				endMs *= 1000
			}
		}

		if isSecondsPrecision {
			isDup, err := s.miband.CheckDuplicateMiBandWorkout(r.Context(), s.allowedUserID, startMs, startMs+999)
			if err != nil {
				errors++
				continue
			}
			if isDup {
				duplicates++
				continue
			}
		}

		durationSec := 0
		if endMs > startMs {
			durationSec = int((endMs - startMs) / 1000)
		}

		workout := &store.MiBandWorkout{
			UserID:        s.allowedUserID,
			SourceStartMs: startMs,
			SourceEndMs:   endMs,
			ActivityType:  0, // unknown
			ActivityName:  payload.WorkoutType,
			DurationSec:   durationSec,
			DistanceM:     payload.Distance,
			Steps:         payload.Steps,
			Calories:      payload.Calories,
			HeartRateAvg:  payload.HeartRate,
			SpO2Avg:       payload.SpO2,
		}

		inserted, err := s.miband.InsertMiBandWorkout(r.Context(), workout)
		if err != nil {
			errors++
			continue
		}

		if !inserted {
			duplicates++
		} else {
			imported++
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"imported":   imported,
		"duplicates": duplicates,
		"errors":     errors,
	})
}
