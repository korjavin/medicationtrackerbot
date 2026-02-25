package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
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

	foodLog := &store.FoodLog{
		UserID:   userID,
		EatenAt:  eatenAt,
		Weight:   req.Weight,
		Carbs:    req.Carbs,
		Protein:  req.Protein,
		Fat:      req.Fat,
		Calories: req.Calories,
		Name:     req.Name,
	}

	id, err := s.store.CreateFoodLog(context.Background(), foodLog)
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
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "created",
		"id":     id,
	}); err != nil {
		log.Printf("encode response: %v", err)
	}
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

	days := 1
	daysStr := r.URL.Query().Get("days")
	if daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
			days = d
		}
	}

	logs, err := s.store.GetFoodLogs(context.Background(), userID, date, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Group logs logic
	groups := groupFoodLogs(logs, days > 1)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(groups); err != nil {
		log.Printf("encode response: %v", err)
	}
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

	foodLog := &store.FoodLog{
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

	if err := s.store.UpdateFoodLog(context.Background(), foodLog); err != nil {
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
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "updated",
	}); err != nil {
		log.Printf("encode response: %v", err)
	}
}

// groupFoodLogs groups logs into meals based on time proximity
func groupFoodLogs(logs []store.FoodLog, isMultiDay bool) []FoodGroup {
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

	currentGroup := FoodGroup{}

	for i, log := range logs {
		var timeStr string
		var groupName string

		if isMultiDay {
			timeStr = log.EatenAt.Format("Mon, Jan 02")
			groupName = log.EatenAt.Format("Mon, Jan 02") // Simplified for multi-day
		} else {
			timeStr = log.EatenAt.Format("15:04")
			groupName = getMealName(log.EatenAt)
		}

		if i == 0 {
			currentGroup = FoodGroup{
				Name: groupName,
				Time: timeStr,
				Logs: []store.FoodLog{log},
			}
		} else {
			lastLog := logs[i-1]
			var shouldGroup bool

			if isMultiDay {
				shouldGroup = log.EatenAt.Format("2006-01-02") == lastLog.EatenAt.Format("2006-01-02")
			} else {
				diff := log.EatenAt.Sub(lastLog.EatenAt)
				shouldGroup = diff < 30*time.Minute && diff > -30*time.Minute
			}

			if shouldGroup {
				// Add to current group
				currentGroup.Logs = append(currentGroup.Logs, log)
			} else {
				// Close current group and start new one
				// Calculate totals
				groups = append(groups, calculateGroupTotals(currentGroup))

				currentGroup = FoodGroup{
					Name: groupName,
					Time: timeStr,
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

func (s *Server) handleGetFoodStats(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	dateStr := r.URL.Query().Get("date")
	date := time.Now()
	if dateStr != "" {
		parsed, err := time.Parse("2006-01-02", dateStr)
		if err == nil {
			date = parsed
		}
	}

	days := 7 // Default for week stats
	daysStr := r.URL.Query().Get("days")
	if daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
			days = d
		}
	}

	stats, err := s.store.GetFoodStats(context.Background(), userID, date, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleGetFoodIntakeEnabled(w http.ResponseWriter, r *http.Request) {
	enabled, err := s.store.GetFoodIntakeEnabled(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled}); err != nil {
		log.Printf("encode response: %v", err)
	}
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

func (s *Server) handleGetFoodTargets(w http.ResponseWriter, r *http.Request) {
	targets, err := s.store.GetFoodTargets(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(targets); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleSetFoodTargets(w http.ResponseWriter, r *http.Request) {
	var req store.FoodTargets
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Calories < 0 || req.Carbs < 0 || req.Protein < 0 || req.Fat < 0 {
		http.Error(w, "Targets must be non-negative", http.StatusBadRequest)
		return
	}

	if err := s.store.SetFoodTargets(context.Background(), req); err != nil {
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
	if err := json.NewEncoder(w).Encode(products); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (s *Server) handleSearchFoodProducts(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	query := strings.TrimSpace(r.URL.Query().Get("q"))

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	if len(query) < 2 {
		if err := json.NewEncoder(w).Encode([]store.FoodProduct{}); err != nil {
			log.Printf("encode response: %v", err)
		}
		flusher.Flush()
		return
	}

	remoteReq := r.URL.Query().Get("remote")
	cacheKey := s.foodSearchCacheKey(userID, query, remoteReq == "true")
	if cached, ok := s.getFoodSearchCache(cacheKey); ok {
		if err := json.NewEncoder(w).Encode(cached); err != nil {
			log.Printf("encode response: %v", err)
		}
		flusher.Flush()
		return
	}

	products, err := s.store.SearchFoodProducts(context.Background(), userID, query)
	if err != nil {
		log.Printf("Debug: Local food search failed for query %q: %v", query, err)
		products = []store.FoodProduct{}
	}
	if products == nil {
		products = []store.FoodProduct{}
	}

	// Send local results instantly
	if err := json.NewEncoder(w).Encode(products); err != nil {
		log.Printf("encode response: %v", err)
	}
	flusher.Flush()

	// Optionally try live OpenFoodFacts and merge with local/offline matches if requested.
	if remoteReq != "true" {
		s.setFoodSearchCache(cacheKey, products)
		return // Skip remote search unless explicitly requested via 'Load more'
	}

	fallbackTimeout := 5 * time.Second
	if !isBarcodeQuery(query) {
		fallbackTimeout = 30 * time.Second
	}

	ctx, cancel := context.WithTimeout(r.Context(), fallbackTimeout)
	defer cancel()

	apiProducts, err := s.store.SearchRemoteFoodAPI(ctx, query)
	if err != nil {
		log.Printf("Debug: Remote food API fallback failed for query %q: %v", query, err)
		return // Just stop streaming if remote fetch fails
	}

	if len(apiProducts) > 0 {
		merged := mergeFoodProducts(products, apiProducts)
		if err := json.NewEncoder(w).Encode(merged); err != nil {
			log.Printf("encode response: %v", err)
		}
		flusher.Flush()
		s.setFoodSearchCache(cacheKey, merged)
		return
	}
	s.setFoodSearchCache(cacheKey, products)
}

func (s *Server) foodSearchCacheKey(userID int64, query string, withRemote bool) string {
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	return fmt.Sprintf("u:%d|remote:%t|q:%s", userID, withRemote, normalizedQuery)
}

func (s *Server) getFoodSearchCache(key string) ([]store.FoodProduct, bool) {
	if s.foodSearchCache == nil {
		return nil, false
	}

	raw := s.foodSearchCache.Get(nil, []byte(key))
	if len(raw) == 0 {
		return nil, false
	}

	var entry struct {
		ExpiresAt time.Time           `json:"expires_at"`
		Products  []store.FoodProduct `json:"products"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		return nil, false
	}
	if time.Now().After(entry.ExpiresAt) {
		s.foodSearchCache.Del([]byte(key))
		return nil, false
	}

	cached := make([]store.FoodProduct, len(entry.Products))
	copy(cached, entry.Products)
	return cached, true
}

func (s *Server) setFoodSearchCache(key string, products []store.FoodProduct) {
	if s.foodSearchCache == nil {
		return
	}

	copied := make([]store.FoodProduct, len(products))
	copy(copied, products)

	entry := struct {
		ExpiresAt time.Time           `json:"expires_at"`
		Products  []store.FoodProduct `json:"products"`
	}{
		ExpiresAt: time.Now().Add(s.foodSearchTTL),
		Products:  copied,
	}

	raw, err := json.Marshal(entry)
	if err != nil {
		return
	}
	s.foodSearchCache.Set([]byte(key), raw)
}

func mergeFoodProducts(base []store.FoodProduct, extra []store.FoodProduct) []store.FoodProduct {
	if len(extra) == 0 {
		return base
	}

	merged := make([]store.FoodProduct, 0, len(base)+len(extra))
	seen := make(map[string]struct{}, len(base)+len(extra))

	add := func(p store.FoodProduct) {
		key := foodProductUniqueKey(p)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		merged = append(merged, p)
	}

	for _, p := range base {
		add(p)
	}
	for _, p := range extra {
		add(p)
	}

	if len(merged) > 50 {
		merged = merged[:50]
	}
	return merged
}

func foodProductUniqueKey(p store.FoodProduct) string {
	if p.Barcode != nil {
		barcode := strings.TrimSpace(*p.Barcode)
		if barcode != "" {
			return "barcode:" + strings.ToLower(barcode)
		}
	}
	return "name:" + strings.ToLower(strings.TrimSpace(p.Name))
}

func isBarcodeQuery(query string) bool {
	if len(query) < 8 {
		return false
	}
	for _, c := range query {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
