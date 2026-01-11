package server

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/rxnorm"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"golang.org/x/oauth2"
)

type Server struct {
	store         *store.Store
	rxnorm        *rxnorm.Client
	botToken      string
	allowedUserID int64
	oidcConfig    OIDCConfig
	oauthConfig   *oauth2.Config
	botUsername   string
}

func New(s *store.Store, botToken string, allowedUserID int64, oidc OIDCConfig, botUsername string) *Server {
	srv := &Server{
		store:         s,
		rxnorm:        rxnorm.New(),
		botToken:      botToken,
		allowedUserID: allowedUserID,
		oidcConfig:    oidc,
		botUsername:   botUsername,
	}
	srv.initOAUTH()
	return srv
}

// noCacheMiddleware adds headers to prevent caching
func noCacheMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Static Files with no-cache headers
	fs := http.FileServer(http.Dir("./web/static"))
	mux.Handle("/static/", noCacheMiddleware(http.StripPrefix("/static/", fs)))

	// Main Page with no-cache headers and bot username injection
	mux.HandleFunc("/", s.serveIndexWithBotUsername)

	// Deep link routes - serve SPA, JS handles the path
	mux.HandleFunc("/bp_add", s.serveIndexWithBotUsername)

	// Auth Routes
	mux.HandleFunc("/auth/google/login", s.handleGoogleLogin)
	mux.HandleFunc("/auth/google/callback", s.handleGoogleCallback)
	mux.HandleFunc("/auth/telegram/callback", s.handleTelegramCallback)

	// API
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/medications", s.handleListMedications)
	apiMux.HandleFunc("POST /api/medications", s.handleCreateMedication)
	apiMux.HandleFunc("POST /api/medications/{id}", s.handleUpdateMedication)
	apiMux.HandleFunc("DELETE /api/medications/{id}", s.handleDeleteMedication)
	apiMux.HandleFunc("GET /api/history", s.handleListHistory)

	// Blood Pressure endpoints
	apiMux.HandleFunc("POST /api/bp", s.handleCreateBloodPressure)
	apiMux.HandleFunc("GET /api/bp", s.handleListBloodPressure)
	apiMux.HandleFunc("DELETE /api/bp/{id}", s.handleDeleteBloodPressure)
	apiMux.HandleFunc("POST /api/bp/import", s.handleImportBloodPressure)
	apiMux.HandleFunc("GET /api/bp/export", s.handleExportBloodPressure)
	apiMux.HandleFunc("GET /api/bp/goal", s.handleGetBPGoal)

	// Weight endpoints
	apiMux.HandleFunc("POST /api/weight", s.handleCreateWeight)
	apiMux.HandleFunc("GET /api/weight", s.handleListWeight)
	apiMux.HandleFunc("DELETE /api/weight/{id}", s.handleDeleteWeight)
	apiMux.HandleFunc("GET /api/weight/export", s.handleExportWeight)
	apiMux.HandleFunc("GET /api/weight/goal", s.handleGetWeightGoal)

	// Inventory endpoints
	apiMux.HandleFunc("POST /api/medications/{id}/restock", s.handleRestock)
	apiMux.HandleFunc("GET /api/medications/{id}/restocks", s.handleGetRestockHistory)
	apiMux.HandleFunc("GET /api/inventory/low", s.handleGetLowStock)

	// Apply Middleware to API
	authMW := AuthMiddleware(s.botToken, s.allowedUserID)
	mux.Handle("/api/", authMW(apiMux))

	return mux
}

// -- Handlers --

func (s *Server) handleListMedications(w http.ResponseWriter, r *http.Request) {
	showArchived := r.URL.Query().Get("archived") == "true"
	meds, err := s.store.ListMedications(showArchived)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(meds)
}

func (s *Server) handleCreateMedication(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name      string     `json:"name"`
		Dosage    string     `json:"dosage"`
		Schedule  string     `json:"schedule"`
		StartDate *time.Time `json:"start_date"`
		EndDate   *time.Time `json:"end_date"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// 1. Search RxNorm
	rxcui, normalizedName, _ := s.rxnorm.SearchRxNorm(req.Name)

	// 2. Create in DB
	id, err := s.store.CreateMedication(req.Name, req.Dosage, req.Schedule, req.StartDate, req.EndDate, rxcui, normalizedName)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// 3. Check Interactions
	var warning string
	if rxcui != "" {
		meds, err := s.store.ListMedications(false) // Only active
		if err == nil {
			var rxcuis []string
			for _, m := range meds {
				if m.RxCUI != "" {
					rxcuis = append(rxcuis, m.RxCUI)
				}
			}
			// Only check if we have > 1 meds totally (since we just added one, list includes it)
			if len(rxcuis) > 1 {
				warnings, _ := s.rxnorm.CheckInteractions(rxcuis)
				if len(warnings) > 0 {
					warning = warnings[0] // Just take the first one or join them
					// Maybe join top 3
					if len(warnings) > 1 {
						warning += " (+ " + strconv.Itoa(len(warnings)-1) + " more)"
					}
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":      id,
		"status":  "created",
		"warning": warning,
	})
}

func (s *Server) handleUpdateMedication(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name           string     `json:"name"`
		Dosage         string     `json:"dosage"`
		Schedule       string     `json:"schedule"`
		Archived       bool       `json:"archived"`
		StartDate      *time.Time `json:"start_date"`
		EndDate        *time.Time `json:"end_date"`
		InventoryCount *int       `json:"inventory_count"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Search RxNorm (Always update on edit to handle renames or missing data)
	rxcui, normalizedName, _ := s.rxnorm.SearchRxNorm(req.Name)

	if err := s.store.UpdateMedication(id, req.Name, req.Dosage, req.Schedule, req.Archived, req.StartDate, req.EndDate, rxcui, normalizedName, req.InventoryCount); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Check interactions if unarchiving OR just updating (e.g. name change might trigger interaction)
	// Strategy: If active (not archived), check interactions.
	var warning string
	if !req.Archived {
		// We have the new RxCUI now
		if rxcui != "" {
			meds, err := s.store.ListMedications(false) // Active only
			if err == nil {
				var rxcuis []string
				for _, m := range meds {
					// We need to exclude the current med from the list fetched from DB
					// because the DB list technically has the OLD data for this ID if read before commit,
					// BUT we just committed the update above. So DB list SHOULD have the new data.
					// Let's rely on ListMedications returning the updated state.
					if m.RxCUI != "" {
						rxcuis = append(rxcuis, m.RxCUI)
					}
				}
				if len(rxcuis) > 1 {
					warnings, _ := s.rxnorm.CheckInteractions(rxcuis)
					if len(warnings) > 0 {
						warning = warnings[0]
						if len(warnings) > 1 {
							warning += " (+ " + strconv.Itoa(len(warnings)-1) + " more)"
						}
					}
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "updated",
		"warning": warning,
	})
}

func (s *Server) handleDeleteMedication(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.store.DeleteMedication(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// -- Blood Pressure Handlers --

func (s *Server) handleCreateBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		MeasuredAt time.Time `json:"measured_at"`
		Systolic   int       `json:"systolic"`
		Diastolic  int       `json:"diastolic"`
		Pulse      *int      `json:"pulse,omitempty"`
		Site       string    `json:"site,omitempty"`
		Position   string    `json:"position,omitempty"`
		Notes      string    `json:"notes,omitempty"`
		Tag        string    `json:"tag,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	bp := &store.BloodPressure{
		UserID:     userID,
		MeasuredAt: req.MeasuredAt,
		Systolic:   req.Systolic,
		Diastolic:  req.Diastolic,
		Pulse:      req.Pulse,
		Site:       req.Site,
		Position:   req.Position,
		Notes:      req.Notes,
		Tag:        req.Tag,
	}

	id, err := s.store.CreateBloodPressureReading(r.Context(), bp)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	bp.ID = id
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(bp)
}

func (s *Server) handleListBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Parse query params
	days := 30 // Default
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil {
			days = d
		}
	}

	var since time.Time
	if days > 0 {
		since = time.Now().AddDate(0, 0, -days)
	}

	limit := 100 // Default
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil {
			limit = l
		}
	}

	readings, err := s.store.GetBloodPressureReadings(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if limit > 0 && len(readings) > limit {
		readings = readings[:limit]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(readings)
}

func (s *Server) handleDeleteBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.store.DeleteBloodPressureReading(r.Context(), id, userID); err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "Reading not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleImportBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Readings []struct {
			MeasuredAt time.Time `json:"measured_at"`
			Systolic   int       `json:"systolic"`
			Diastolic  int       `json:"diastolic"`
			Pulse      *int      `json:"pulse,omitempty"`
			Site       string    `json:"site,omitempty"`
			Position   string    `json:"position,omitempty"`
			Notes      string    `json:"notes,omitempty"`
			Tag        string    `json:"tag,omitempty"`
		} `json:"readings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	readings := make([]store.BloodPressure, len(req.Readings))
	for i, r := range req.Readings {
		readings[i] = store.BloodPressure{
			MeasuredAt: r.MeasuredAt,
			Systolic:   r.Systolic,
			Diastolic:  r.Diastolic,
			Pulse:      r.Pulse,
			Site:       r.Site,
			Position:   r.Position,
			Notes:      r.Notes,
			Tag:        r.Tag,
		}
	}

	if err := s.store.ImportBloodPressureReadings(r.Context(), userID, readings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"imported": len(readings),
		"status":   "success",
	})
}

func (s *Server) handleExportBloodPressure(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Parse query params
	var since time.Time
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if days, err := strconv.Atoi(dStr); err == nil && days > 0 {
			since = time.Now().AddDate(0, 0, -days)
		}
	}

	readings, err := s.store.GetBloodPressureReadings(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=blood_pressure_export.csv")

	wr := csv.NewWriter(w)
	defer wr.Flush()

	// Write CSV header
	header := []string{"Date", "Systolic", "Diastolic", "Pulse", "Site", "Position", "Category", "Notes", "Tag"}
	if err := wr.Write(header); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Write data rows
	for _, bp := range readings {
		pulse := ""
		if bp.Pulse != nil {
			pulse = strconv.Itoa(*bp.Pulse)
		}

		notes := strings.ReplaceAll(bp.Notes, "\n", " ")
		notes = strings.ReplaceAll(notes, "\r", "")

		row := []string{
			bp.MeasuredAt.Format(time.RFC3339),
			strconv.Itoa(bp.Systolic),
			strconv.Itoa(bp.Diastolic),
			pulse,
			bp.Site,
			bp.Position,
			bp.Category,
			notes,
			bp.Tag,
		}
		if err := wr.Write(row); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
}

func (s *Server) handleListHistory(w http.ResponseWriter, r *http.Request) {
	// Parse query params
	days := 3 // Default
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil {
			days = d
		}
	}

	medID := 0
	if mStr := r.URL.Query().Get("med_id"); mStr != "" {
		if m, err := strconv.Atoi(mStr); err == nil {
			medID = m
		}
	}

	logs, err := s.store.GetIntakeHistory(medID, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(logs)
}

// -- Weight Handlers --

func (s *Server) handleCreateWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		MeasuredAt time.Time `json:"measured_at"`
		Weight     float64   `json:"weight"`
		BodyFat    *float64  `json:"body_fat,omitempty"`
		MuscleMass *float64  `json:"muscle_mass,omitempty"`
		Notes      string    `json:"notes,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Get last weight log to calculate trend
	lastLog, err := s.store.GetLastWeightLog(r.Context(), userID)
	if err != nil {
		// Log error but continue
	}

	var previousTrend *float64
	if lastLog != nil && lastLog.WeightTrend != nil {
		previousTrend = lastLog.WeightTrend
	}

	weightTrend := store.CalculateWeightTrend(req.Weight, previousTrend)

	wLog := &store.WeightLog{
		UserID:      userID,
		MeasuredAt:  req.MeasuredAt,
		Weight:      req.Weight,
		WeightTrend: &weightTrend,
		BodyFat:     req.BodyFat,
		MuscleMass:  req.MuscleMass,
		Notes:       req.Notes,
	}

	id, err := s.store.CreateWeightLog(r.Context(), wLog)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	wLog.ID = id
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(wLog)
}

func (s *Server) handleListWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Parse query params
	days := 30 // Default
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil {
			days = d
		}
	}

	var since time.Time
	if days > 0 {
		since = time.Now().AddDate(0, 0, -days)
	}

	limit := 100 // Default
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil {
			limit = l
		}
	}

	logs, err := s.store.GetWeightLogs(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if limit > 0 && len(logs) > limit {
		logs = logs[:limit]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(logs)
}

func (s *Server) handleDeleteWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	if err := s.store.DeleteWeightLog(r.Context(), id, userID); err != nil {
		if err == sql.ErrNoRows {
			http.Error(w, "Weight log not found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleExportWeight(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	// Parse query params
	var since time.Time
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if days, err := strconv.Atoi(dStr); err == nil && days > 0 {
			since = time.Now().AddDate(0, 0, -days)
		}
	}

	logs, err := s.store.GetWeightLogs(r.Context(), userID, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=weight_export.csv")

	wr := csv.NewWriter(w)
	defer wr.Flush()

	// Write CSV header in Libra format
	wr.Write([]string{"#Version: 6"})
	wr.Write([]string{"#Units: kg"})
	wr.Write([]string{""})
	wr.Write([]string{"#date;weight;weight trend;body fat;body fat trend;muscle mass;muscle mass trend;log"})

	// Write data rows
	for _, wLog := range logs {
		weight := fmt.Sprintf("%.1f", wLog.Weight)
		weightTrend := ""
		if wLog.WeightTrend != nil {
			weightTrend = fmt.Sprintf("%.1f", *wLog.WeightTrend)
		}

		bodyFat := ""
		if wLog.BodyFat != nil {
			bodyFat = fmt.Sprintf("%.1f", *wLog.BodyFat)
		}

		bodyFatTrend := ""
		if wLog.BodyFatTrend != nil {
			bodyFatTrend = fmt.Sprintf("%.1f", *wLog.BodyFatTrend)
		}

		muscleMass := ""
		if wLog.MuscleMass != nil {
			muscleMass = fmt.Sprintf("%.1f", *wLog.MuscleMass)
		}

		muscleMassTrend := ""
		if wLog.MuscleMassTrend != nil {
			muscleMassTrend = fmt.Sprintf("%.1f", *wLog.MuscleMassTrend)
		}

		notes := strings.ReplaceAll(wLog.Notes, "\n", " ")
		notes = strings.ReplaceAll(notes, "\r", "")

		row := []string{
			wLog.MeasuredAt.Format("2006-01-02T15:04:05.000Z") + ";" + weight + ";" + weightTrend + ";" + bodyFat + ";" + bodyFatTrend + ";" + muscleMass + ";" + muscleMassTrend + ";" + notes,
		}
		if err := wr.Write(row); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
}

func (s *Server) handleGetWeightGoal(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	goal, err := s.store.GetWeightGoal()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get highest weight record for diet plan line
	highestRecord, err := s.store.GetHighestWeightRecord(r.Context(), userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Extended response with highest weight metadata
	type WeightGoalResponse struct {
		Goal          *float64   `json:"goal,omitempty"`
		GoalDate      *time.Time `json:"goal_date,omitempty"`
		HighestWeight *float64   `json:"highest_weight,omitempty"`
		HighestDate   *time.Time `json:"highest_date,omitempty"`
	}

	response := WeightGoalResponse{
		Goal:     goal.Goal,
		GoalDate: goal.GoalDate,
	}

	if highestRecord != nil {
		response.HighestWeight = &highestRecord.Weight
		response.HighestDate = &highestRecord.MeasuredAt
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (s *Server) handleGetBPGoal(w http.ResponseWriter, r *http.Request) {
	goal, err := s.store.GetBPGoal()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(goal)
}

// -- Inventory Handlers --

func (s *Server) handleRestock(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Quantity int    `json:"quantity"`
		Note     string `json:"note,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.Quantity <= 0 {
		http.Error(w, "Quantity must be positive", http.StatusBadRequest)
		return
	}

	if err := s.store.AddRestock(id, req.Quantity, req.Note); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get updated medication to return new count
	med, err := s.store.GetMedication(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          "restocked",
		"quantity_added":  req.Quantity,
		"inventory_count": med.InventoryCount,
	})
}

func (s *Server) handleGetRestockHistory(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	restocks, err := s.store.GetRestockHistory(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(restocks)
}

func (s *Server) handleGetLowStock(w http.ResponseWriter, r *http.Request) {
	// Default to 7 days threshold
	days := 7
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil && d > 0 {
			days = d
		}
	}

	meds, err := s.store.GetMedicationsLowOnStock(days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Enrich with days remaining info
	type LowStockMed struct {
		store.Medication
		DaysRemaining *float64 `json:"days_remaining,omitempty"`
	}

	result := make([]LowStockMed, 0, len(meds))
	for _, m := range meds {
		lsm := LowStockMed{
			Medication:    m,
			DaysRemaining: s.store.GetDaysOfStockRemaining(&m),
		}
		result = append(result, lsm)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// serveIndexWithBotUsername serves index.html with bot username injected
func (s *Server) serveIndexWithBotUsername(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	// Read index.html
	f, err := os.Open("./web/static/index.html")
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	content, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	// Inject bot username
	html := strings.ReplaceAll(string(content), "BOT_USERNAME_PLACEHOLDER", s.botUsername)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(html))
}

// handleTelegramCallback handles Telegram Login Widget authentication
func (s *Server) handleTelegramCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var data TelegramLoginData
	if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
		log.Printf("[TG-LOGIN] Invalid JSON from %s: %v", r.RemoteAddr, err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	log.Printf("[TG-LOGIN] Attempt from %s: user_id=%d username=%s first_name=%s auth_date=%d",
		r.RemoteAddr, data.ID, data.Username, data.FirstName, data.AuthDate)

	valid, user, err := ValidateTelegramLoginWidget(s.botToken, data)
	if !valid || err != nil {
		log.Printf("[TG-LOGIN] Validation failed for user_id=%d from %s: %v", data.ID, r.RemoteAddr, err)
		http.Error(w, "Invalid Telegram login data: "+err.Error(), http.StatusUnauthorized)
		return
	}

	// Check if user is allowed
	if user.ID != s.allowedUserID {
		log.Printf("[TG-LOGIN] Unauthorized user_id=%d (username=%s) from %s - allowed is %d",
			user.ID, user.Username, r.RemoteAddr, s.allowedUserID)
		http.Error(w, "Forbidden: User not allowed", http.StatusForbidden)
		return
	}

	// Create session (same as Google auth)
	sessionValue := createSessionToken(user.Username, s.botToken)
	http.SetCookie(w, &http.Cookie{
		Name:     "auth_session",
		Value:    sessionValue,
		Expires:  time.Now().Add(24 * time.Hour * 30), // 30 days
		HttpOnly: true,
		Path:     "/",
	})

	log.Printf("[TG-LOGIN] Success for user_id=%d username=%s from %s", user.ID, user.Username, r.RemoteAddr)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
