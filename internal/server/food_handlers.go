package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// -- Food Intake Handlers --

func (s *Server) handleCreateFoodLog(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		EatenAt  string `json:"eaten_at"` // ISO8601
		Weight   int    `json:"weight"`   // grams
		Carbs    int    `json:"carbs"`    // total grams
		Protein  int    `json:"protein"`  // total grams
		Fat      int    `json:"fat"`      // total grams
		Calories int    `json:"calories"` // total kcal
		Name     string `json:"name"`
		Barcode  string `json:"barcode"`
		Per100g  bool   `json:"per_100g"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	eatenAt, err := time.Parse(time.RFC3339, req.EatenAt)
	if err != nil {
		// Try without timezone
		eatenAt, err = time.Parse("2006-01-02T15:04", req.EatenAt)
		if err != nil {
			http.Error(w, "Invalid time format", http.StatusBadRequest)
			return
		}
	}

	log := &store.FoodLog{
		UserID:   userID,
		EatenAt:  eatenAt,
		Weight:   req.Weight,
		Carbs:    req.Carbs,
		Protein:  req.Protein,
		Fat:      req.Fat,
		Calories: req.Calories,
		Name:     req.Name,
	}

	id, err := s.store.CreateFoodLog(context.Background(), log)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Upsert to food_products
	if req.Name != "" {
		carbs, protein, fat, kcal := float64(req.Carbs), float64(req.Protein), float64(req.Fat), float64(req.Calories)
		var c100, p100, f100, k100 float64
		if req.Per100g {
			c100, p100, f100, k100 = carbs, protein, fat, kcal
		} else if req.Weight > 0 {
			mult := 100.0 / float64(req.Weight)
			c100, p100, f100, k100 = carbs*mult, protein*mult, fat*mult, kcal*mult
		}

		var barcodePtr *string
		if req.Barcode != "" {
			barcodePtr = &req.Barcode
		}
		p := &store.FoodProduct{
			UserID:         userID,
			Name:           req.Name,
			Barcode:        barcodePtr,
			Carbs100g:      c100,
			Protein100g:    p100,
			Fat100g:        f100,
			EnergyKcal100g: k100,
		}
		// Ignore error as this is a background optimization
		_ = s.store.UpsertFoodProduct(context.Background(), p)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "created",
		"id":     id,
	})
}

type FoodGroup struct {
	Name     string          `json:"name"` // "Breakfast", "Lunch", "Dinner", "Snack"
	Time     string          `json:"time"` // Approximate time (e.g. "08:30")
	Logs     []store.FoodLog `json:"logs"`
	Calories int             `json:"calories"` // Total for group
	Carbs    int             `json:"carbs"`
	Protein  int             `json:"protein"`
	Fat      int             `json:"fat"`
}

func (s *Server) handleGetFoodLogs(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	dateStr := r.URL.Query().Get("date")
	date := time.Now()
	if dateStr != "" {
		parsed, err := time.Parse("2006-01-02", dateStr)
		if err == nil {
			date = parsed
		}
	}

	logs, err := s.store.GetFoodLogs(context.Background(), userID, date)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Group logs logic
	groups := groupFoodLogs(logs)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(groups)
}

func (s *Server) handleDeleteFoodLog(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.store.DeleteFoodLog(context.Background(), id, userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleUpdateFoodLog(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var req struct {
		EatenAt  string `json:"eaten_at"` // ISO8601
		Weight   int    `json:"weight"`   // grams
		Carbs    int    `json:"carbs"`    // total grams
		Protein  int    `json:"protein"`  // total grams
		Fat      int    `json:"fat"`      // total grams
		Calories int    `json:"calories"` // total kcal
		Name     string `json:"name"`
		Barcode  string `json:"barcode"`
		Per100g  bool   `json:"per_100g"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	eatenAt, err := time.Parse(time.RFC3339, req.EatenAt)
	if err != nil {
		// Try without timezone
		eatenAt, err = time.Parse("2006-01-02T15:04", req.EatenAt)
		if err != nil {
			http.Error(w, "Invalid time format", http.StatusBadRequest)
			return
		}
	}

	log := &store.FoodLog{
		ID:       id,
		UserID:   userID,
		EatenAt:  eatenAt,
		Weight:   req.Weight,
		Carbs:    req.Carbs,
		Protein:  req.Protein,
		Fat:      req.Fat,
		Calories: req.Calories,
		Name:     req.Name,
	}

	if err := s.store.UpdateFoodLog(context.Background(), log); err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "Not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Upsert to food_products
	if req.Name != "" {
		carbs, protein, fat, kcal := float64(req.Carbs), float64(req.Protein), float64(req.Fat), float64(req.Calories)
		var c100, p100, f100, k100 float64
		if req.Per100g {
			c100, p100, f100, k100 = carbs, protein, fat, kcal
		} else if req.Weight > 0 {
			mult := 100.0 / float64(req.Weight)
			c100, p100, f100, k100 = carbs*mult, protein*mult, fat*mult, kcal*mult
		}

		var barcodePtr *string
		if req.Barcode != "" {
			barcodePtr = &req.Barcode
		}
		p := &store.FoodProduct{
			UserID:         userID,
			Name:           req.Name,
			Barcode:        barcodePtr,
			Carbs100g:      c100,
			Protein100g:    p100,
			Fat100g:        f100,
			EnergyKcal100g: k100,
		}
		_ = s.store.UpsertFoodProduct(context.Background(), p)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "updated",
	})
}

// groupFoodLogs groups logs into meals based on time proximity
func groupFoodLogs(logs []store.FoodLog) []FoodGroup {
	if len(logs) == 0 {
		return []FoodGroup{}
	}

	var groups []FoodGroup

	// Helper to determine meal name based on time
	getMealName := func(t time.Time) string {
		hour := t.Hour()
		if hour >= 5 && hour < 11 {
			return "Breakfast"
		} else if hour >= 11 && hour < 16 {
			return "Lunch"
		} else if hour >= 16 && hour < 22 {
			return "Dinner"
		}
		return "Snack"
	}

	// Simple clustering: if logs are within 30 mins of previous, add to group.
	// Otherwise start new group.

	currentGroup := FoodGroup{}

	for i, log := range logs {
		if i == 0 {
			currentGroup = FoodGroup{
				Name: getMealName(log.EatenAt),
				Time: log.EatenAt.Format("15:04"),
				Logs: []store.FoodLog{log},
			}
		} else {
			lastLog := logs[i-1]
			diff := log.EatenAt.Sub(lastLog.EatenAt)
			if diff < 30*time.Minute && diff > -30*time.Minute {
				// Add to current group
				currentGroup.Logs = append(currentGroup.Logs, log)
			} else {
				// Close current group and start new one
				// Calculate totals
				groups = append(groups, calculateGroupTotals(currentGroup))

				currentGroup = FoodGroup{
					Name: getMealName(log.EatenAt),
					Time: log.EatenAt.Format("15:04"),
					Logs: []store.FoodLog{log},
				}
			}
		}
	}

	// Append last group
	if len(currentGroup.Logs) > 0 {
		groups = append(groups, calculateGroupTotals(currentGroup))
	}

	return groups
}

func calculateGroupTotals(g FoodGroup) FoodGroup {
	for _, l := range g.Logs {
		g.Calories += l.Calories
		g.Carbs += l.Carbs
		g.Protein += l.Protein
		g.Fat += l.Fat
	}
	return g
}

// -- Settings Handlers --

func (s *Server) handleGetFoodIntakeEnabled(w http.ResponseWriter, r *http.Request) {
	enabled, err := s.store.GetFoodIntakeEnabled(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled})
}

func (s *Server) handleSetFoodIntakeEnabled(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.store.SetFoodIntakeEnabled(context.Background(), req.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleGetFoodProducts(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	products, err := s.store.GetFoodProducts(context.Background(), userID, 100)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if products == nil {
		products = []store.FoodProduct{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(products)
}

func (s *Server) handleSearchFoodProducts(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	query := r.URL.Query().Get("q")
	if len(query) < 2 {
		json.NewEncoder(w).Encode([]store.FoodProduct{})
		return
	}

	products, err := s.store.SearchFoodProducts(context.Background(), userID, query)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if products == nil {
		products = []store.FoodProduct{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(products)
}
