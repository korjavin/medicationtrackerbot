package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
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
		EatenAt   string `json:"eaten_at"` // ISO8601
		Weight    int    `json:"weight"`   // grams
		Carbs     int    `json:"carbs"`    // total grams
		Protein   int    `json:"protein"`  // total grams
		Fat       int    `json:"fat"`      // total grams
		Calories  int    `json:"calories"` // total kcal
		Name      string `json:"name"`
		ProductID *int64 `json:"product_id"`
		Barcode   string `json:"barcode"`
		Per100g   bool   `json:"per_100g"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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

	if req.Weight < 0 {
		http.Error(w, "Weight cannot be negative", http.StatusBadRequest)
		return
	}
	if req.Carbs < 0 || req.Protein < 0 || req.Fat < 0 || req.Calories < 0 {
		http.Error(w, "Nutritional values cannot be negative", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	resolvedName := req.Name
	var resolvedProductID *int64
	var productForUsage *store.FoodProduct

	if req.ProductID != nil {
		product, err := s.food.GetFoodProductByID(ctx, userID, *req.ProductID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				http.Error(w, "invalid product_id: product does not exist or belongs to another user", http.StatusInternalServerError)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		gotID := product.ID
		resolvedProductID = &gotID
		productForUsage = product
		if resolvedName == "" {
			resolvedName = product.Name
		}
	} else if req.Name != "" {
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
		// Ignore error as this is a background optimization.
		_ = s.food.UpsertFoodProduct(ctx, p)

		if got, err := s.food.GetFoodProductByName(ctx, userID, req.Name); err == nil && got != nil {
			gotID := got.ID
			resolvedProductID = &gotID
		}
	}

	foodLog := &store.FoodLog{
		UserID:    userID,
		EatenAt:   eatenAt,
		Weight:    req.Weight,
		Carbs:     req.Carbs,
		Protein:   req.Protein,
		Fat:       req.Fat,
		Calories:  req.Calories,
		Name:      resolvedName,
		ProductID: resolvedProductID,
	}

	id, err := s.food.CreateFoodLog(ctx, foodLog)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if productForUsage != nil {
		_ = s.food.UpsertFoodProduct(ctx, &store.FoodProduct{
			UserID: userID,
			Name:   productForUsage.Name,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "created",
		"id":         id,
		"product_id": resolvedProductID,
		"name":       resolvedName,
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// maxFoodPhotoBytes caps uploaded food photos at ~8 MB. Larger images are
// rejected before the multipart parser consumes the body.
const maxFoodPhotoBytes = 8 << 20

func (s *Server) handleCreateFoodLogFromPhoto(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	enabled, err := s.settings.GetFoodIntakeEnabled(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !enabled {
		http.Error(w, "Food intake tracking is disabled", http.StatusForbidden)
		return
	}

	if s.foodAI == nil {
		http.Error(w, "AI food logging is not configured on this server", http.StatusServiceUnavailable)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxFoodPhotoBytes)
	if err := r.ParseMultipartForm(maxFoodPhotoBytes); err != nil {
		http.Error(w, "Invalid multipart upload: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("image")
	if err != nil {
		http.Error(w, "Missing 'image' file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	imageBytes, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read uploaded image", http.StatusBadRequest)
		return
	}
	if len(imageBytes) == 0 {
		http.Error(w, "Uploaded image is empty", http.StatusBadRequest)
		return
	}

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" || !strings.HasPrefix(mimeType, "image/") {
		mimeType = http.DetectContentType(imageBytes)
		if !strings.HasPrefix(mimeType, "image/") {
			http.Error(w, "Uploaded file is not an image", http.StatusBadRequest)
			return
		}
	}

	eatenAt := time.Now()
	if raw := strings.TrimSpace(r.FormValue("eaten_at")); raw != "" {
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			eatenAt = parsed
		} else if parsed, err := time.Parse("2006-01-02T15:04", raw); err == nil {
			eatenAt = parsed
		}
	}

	parseCtx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	parsedLogs, err := s.foodAI.ParseMealPhoto(parseCtx, imageBytes, mimeType)
	if err != nil {
		slog.Error("food photo: AI parse failed", "user_id", userID, "error", err)
		http.Error(w, "Failed to analyze food photo: "+err.Error(), http.StatusBadGateway)
		return
	}
	if len(parsedLogs) == 0 {
		http.Error(w, "No food items detected in photo", http.StatusUnprocessableEntity)
		return
	}

	saveCtx, saveCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer saveCancel()

	type savedItem struct {
		ID       int64  `json:"id"`
		Name     string `json:"name"`
		Weight   int    `json:"weight"`
		Carbs    int    `json:"carbs"`
		Protein  int    `json:"protein"`
		Fat      int    `json:"fat"`
		Calories int    `json:"calories"`
	}

	saved := make([]savedItem, 0, len(parsedLogs))
	var failed int
	for _, item := range parsedLogs {
		entry := &store.FoodLog{
			UserID:   userID,
			EatenAt:  eatenAt,
			Weight:   item.Weight,
			Carbs:    item.Carbs,
			Protein:  item.Protein,
			Fat:      item.Fat,
			Calories: item.Calories,
			Name:     item.Name,
		}
		id, err := s.food.CreateFoodLog(saveCtx, entry)
		if err != nil {
			slog.Error("food photo: save failed", "user_id", userID, "name", item.Name, "error", err)
			failed++
			continue
		}
		saved = append(saved, savedItem{
			ID:       id,
			Name:     item.Name,
			Weight:   item.Weight,
			Carbs:    item.Carbs,
			Protein:  item.Protein,
			Fat:      item.Fat,
			Calories: item.Calories,
		})
	}

	if len(saved) == 0 {
		http.Error(w, "Failed to save any food items", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"status": "created",
		"items":  saved,
		"failed": failed,
	}); err != nil {
		slog.Error("encode response", "error", err)
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
	date := parseDateInLocation(dateStr, r.URL.Query().Get("tz"), r.URL.Query().Get("tz_offset"))

	days := 1
	daysStr := r.URL.Query().Get("days")
	if daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
			days = d
		}
	}

	logs, err := s.food.GetFoodLogs(context.Background(), userID, date, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Group logs logic — pass client timezone so EatenAt is formatted in local time
	groups := groupFoodLogs(logs, days > 1, date.Location())

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(groups); err != nil {
		slog.Error("encode response", "error", err)
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

	if err := s.food.DeleteFoodLog(context.Background(), id, userID); err != nil {
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
		EatenAt   string `json:"eaten_at"` // ISO8601
		Weight    int    `json:"weight"`   // grams
		Carbs     int    `json:"carbs"`    // total grams
		Protein   int    `json:"protein"`  // total grams
		Fat       int    `json:"fat"`      // total grams
		Calories  int    `json:"calories"` // total kcal
		Name      string `json:"name"`
		ProductID *int64 `json:"product_id"`
		Barcode   string `json:"barcode"`
		Per100g   bool   `json:"per_100g"`
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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

	if req.Weight < 0 {
		http.Error(w, "Weight cannot be negative", http.StatusBadRequest)
		return
	}
	if req.Carbs < 0 || req.Protein < 0 || req.Fat < 0 || req.Calories < 0 {
		http.Error(w, "Nutritional values cannot be negative", http.StatusBadRequest)
		return
	}

	foodLog := &store.FoodLog{
		ID:        id,
		UserID:    userID,
		EatenAt:   eatenAt,
		Weight:    req.Weight,
		Carbs:     req.Carbs,
		Protein:   req.Protein,
		Fat:       req.Fat,
		Calories:  req.Calories,
		Name:      req.Name,
		ProductID: req.ProductID,
	}

	if err := s.food.UpdateFoodLog(context.Background(), foodLog); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
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
		_ = s.food.UpsertFoodProduct(context.Background(), p)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "updated",
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// groupFoodLogs groups logs into meals based on time proximity
// parseClientLocation resolves the client's *time.Location from query parameters.
// Prefers the IANA timezone name (tz= param) which is DST-aware; falls back to the
// numeric tz_offset (minutes west of UTC, JS convention) as a best-effort fixed zone.
// Returns time.UTC when neither is provided or parseable.
func parseClientLocation(tzName, tzOffsetStr string) *time.Location {
	if tzName != "" {
		if loc, err := time.LoadLocation(tzName); err == nil {
			return loc
		}
	}
	if tzOffsetStr != "" {
		if offsetMin, err := strconv.Atoi(tzOffsetStr); err == nil {
			// JS getTimezoneOffset() is positive west of UTC (opposite of standard)
			return time.FixedZone("client", -offsetMin*60)
		}
	}
	return time.UTC
}

// parseDateWithTzOffset parses a YYYY-MM-DD dateStr in the given location.
func parseDateWithTzOffset(dateStr, tzOffsetStr string) time.Time {
	loc := parseClientLocation("", tzOffsetStr)
	if dateStr != "" {
		parsed, err := time.Parse("2006-01-02", dateStr)
		if err == nil {
			return time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 0, 0, 0, 0, loc)
		}
	}
	return time.Now().In(loc)
}

// parseDateInLocation is the DST-aware version; prefers IANA tz name over fixed offset.
func parseDateInLocation(dateStr, tzName, tzOffsetStr string) time.Time {
	loc := parseClientLocation(tzName, tzOffsetStr)
	if dateStr != "" {
		parsed, err := time.Parse("2006-01-02", dateStr)
		if err == nil {
			return time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 0, 0, 0, 0, loc)
		}
	}
	return time.Now().In(loc)
}

func groupFoodLogs(logs []store.FoodLog, isMultiDay bool, loc *time.Location) []FoodGroup {
	if len(logs) == 0 {
		return []FoodGroup{}
	}

	if loc == nil {
		loc = time.Local
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
		// Convert to client timezone so time labels and meal names reflect local time
		t := log.EatenAt.In(loc)
		var timeStr string
		var groupName string

		if isMultiDay {
			timeStr = t.Format("Mon, Jan 02")
			groupName = t.Format("Mon, Jan 02") // Simplified for multi-day
		} else {
			timeStr = t.Format("15:04")
			groupName = getMealName(t)
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
				shouldGroup = log.EatenAt.In(loc).Format("2006-01-02") == lastLog.EatenAt.In(loc).Format("2006-01-02")
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
	date := parseDateInLocation(dateStr, r.URL.Query().Get("tz"), r.URL.Query().Get("tz_offset"))

	days := 7 // Default for week stats
	daysStr := r.URL.Query().Get("days")
	if daysStr != "" {
		if d, err := strconv.Atoi(daysStr); err == nil && d > 0 {
			days = d
		}
	}

	stats, err := s.food.GetFoodStats(context.Background(), userID, date, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(stats); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleGetFoodIntakeEnabled(w http.ResponseWriter, r *http.Request) {
	enabled, err := s.settings.GetFoodIntakeEnabled(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSetFoodIntakeEnabled(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.settings.SetFoodIntakeEnabled(context.Background(), req.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleGetFoodTargets(w http.ResponseWriter, r *http.Request) {
	targets, err := s.food.GetFoodTargets(context.Background())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(targets); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSetFoodTargets(w http.ResponseWriter, r *http.Request) {
	var req store.FoodTargets
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Calories < 0 || req.Carbs < 0 || req.Protein < 0 || req.Fat < 0 {
		http.Error(w, "Targets must be non-negative", http.StatusBadRequest)
		return
	}

	if err := s.food.SetFoodTargets(context.Background(), req); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleUpdateFoodProduct(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid product ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name           string  `json:"name"`
		Barcode        string  `json:"barcode"`
		Carbs100g      float64 `json:"carbs_100g"`
		Protein100g    float64 `json:"protein_100g"`
		Fat100g        float64 `json:"fat_100g"`
		EnergyKcal100g float64 `json:"energy_kcal_100g"`
		IsMeal         bool    `json:"is_meal"`
		TotalWeightG   int     `json:"total_weight_g"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}

	if req.Carbs100g < 0 || req.Protein100g < 0 || req.Fat100g < 0 || req.EnergyKcal100g < 0 {
		http.Error(w, "Nutritional values cannot be negative", http.StatusBadRequest)
		return
	}

	var barcodePtr *string
	if req.Barcode != "" {
		barcodePtr = &req.Barcode
	}

	p := &store.FoodProduct{
		ID:             id,
		UserID:         userID,
		Name:           req.Name,
		Barcode:        barcodePtr,
		Carbs100g:      req.Carbs100g,
		Protein100g:    req.Protein100g,
		Fat100g:        req.Fat100g,
		EnergyKcal100g: req.EnergyKcal100g,
		IsMeal:         req.IsMeal,
		TotalWeightG:   req.TotalWeightG,
	}

	if err := s.food.UpdateFoodProduct(context.Background(), p); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.clearFoodSearchCache()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "updated"}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleDeleteFoodProduct(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid product ID", http.StatusBadRequest)
		return
	}

	if err := s.food.DeleteFoodProduct(context.Background(), id, userID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.clearFoodSearchCache()

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleGetFoodProducts(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	query := r.URL.Query()

	limit := 100
	if l := query.Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}

	offset := 0
	if o := query.Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	var isMeal *bool
	if m := query.Get("is_meal"); m != "" {
		parsed := m == "true"
		isMeal = &parsed
	}

	filter := store.FoodProductsFilter{
		IsMeal: isMeal,
		Query:  query.Get("q"),
		Offset: offset,
		Limit:  limit,
		Sort:   query.Get("sort"),
	}

	products, total, err := s.food.GetFoodProducts(context.Background(), userID, filter)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if products == nil {
		products = []store.FoodProduct{}
	}

	response := struct {
		Products []store.FoodProduct `json:"products"`
		Total    int                 `json:"total"`
	}{
		Products: products,
		Total:    total,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		slog.Error("encode response", "error", err)
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
			slog.Error("encode response", "error", err)
		}
		flusher.Flush()
		return
	}

	remoteReq := r.URL.Query().Get("remote")
	cacheKey := s.foodSearchCacheKey(userID, query, remoteReq == "true")
	if cached, ok := s.getFoodSearchCache(cacheKey); ok {
		if err := json.NewEncoder(w).Encode(cached); err != nil {
			slog.Error("encode response", "error", err)
		}
		flusher.Flush()
		return
	}

	products, err := s.food.SearchFoodProducts(context.Background(), userID, query)
	if err != nil {
		slog.Debug("Local food search failed", "query", query, "error", err)
		products = []store.FoodProduct{}
	}
	if products == nil {
		products = []store.FoodProduct{}
	}

	// Send local results instantly
	if err := json.NewEncoder(w).Encode(products); err != nil {
		slog.Error("encode response", "error", err)
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

	apiProducts, err := s.food.SearchRemoteFoodAPI(ctx, query)
	if err != nil {
		slog.Debug("Remote food API fallback failed", "query", query, "error", err)
		return // Just stop streaming if remote fetch fails
	}

	if len(apiProducts) > 0 {
		merged := mergeFoodProducts(products, apiProducts)
		if err := json.NewEncoder(w).Encode(merged); err != nil {
			slog.Error("encode response", "error", err)
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

func (s *Server) clearFoodSearchCache() {
	if s.foodSearchCache == nil {
		return
	}
	s.foodSearchCache.Reset()
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

func (s *Server) handleCreateMealFromLogs(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Name   string  `json:"name"`
		LogIDs []int64 `json:"log_ids"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		http.Error(w, "Name is required", http.StatusBadRequest)
		return
	}
	if len(req.LogIDs) == 0 {
		http.Error(w, "At least one log_id is required", http.StatusBadRequest)
		return
	}

	product, err := s.food.CreateMealFromLogs(r.Context(), userID, name, req.LogIDs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.clearFoodSearchCache()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(product); err != nil {
		slog.Error("encode response", "error", err)
	}
}
