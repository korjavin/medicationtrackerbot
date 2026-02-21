package server

import (
	"context"
	"encoding/json"
	"net/http"
)

func (s *Server) getFeatureMap(ctx context.Context) (map[string]bool, error) {
	foodEnabled, err := s.store.GetFoodIntakeEnabled(ctx)
	if err != nil {
		return nil, err
	}
	bpEnabled, err := s.store.GetBloodPressureEnabled(ctx)
	if err != nil {
		return nil, err
	}
	weightEnabled, err := s.store.GetWeightEnabled(ctx)
	if err != nil {
		return nil, err
	}
	medicationEnabled, err := s.store.GetMedicationEnabled(ctx)
	if err != nil {
		return nil, err
	}
	workoutEnabled, err := s.store.GetWorkoutEnabled(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]bool{
		"food":       foodEnabled,
		"bp":         bpEnabled,
		"weight":     weightEnabled,
		"medication": medicationEnabled,
		"workout":    workoutEnabled,
	}, nil
}

func (s *Server) handleGetFeatureSettings(w http.ResponseWriter, r *http.Request) {
	features, err := s.getFeatureMap(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(features)
}

// handleInit returns all data needed to render the app on first load.
func (s *Server) handleInit(w http.ResponseWriter, r *http.Request) {
	features, err := s.getFeatureMap(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"features": features,
	})
}

func (s *Server) handleSetFeatureEnabled(w http.ResponseWriter, r *http.Request) {
	feature := r.PathValue("feature")
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	var err error
	switch feature {
	case "food":
		err = s.store.SetFoodIntakeEnabled(ctx, req.Enabled)
	case "bp":
		err = s.store.SetBloodPressureEnabled(ctx, req.Enabled)
	case "weight":
		err = s.store.SetWeightEnabled(ctx, req.Enabled)
	case "medication":
		err = s.store.SetMedicationEnabled(ctx, req.Enabled)
	case "workout":
		err = s.store.SetWorkoutEnabled(ctx, req.Enabled)
	default:
		http.Error(w, "Unknown feature", http.StatusBadRequest)
		return
	}

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}
