package server

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"net/http"
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
}

func New(s *store.Store, botToken string, allowedUserID int64, oidc OIDCConfig) *Server {
	srv := &Server{
		store:         s,
		rxnorm:        rxnorm.New(),
		botToken:      botToken,
		allowedUserID: allowedUserID,
		oidcConfig:    oidc,
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

	// Main Page with no-cache headers
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		http.ServeFile(w, r, "./web/static/index.html")
	})

	// Auth Routes
	mux.HandleFunc("/auth/google/login", s.handleGoogleLogin)
	mux.HandleFunc("/auth/google/callback", s.handleGoogleCallback)

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
		Name      string     `json:"name"`
		Dosage    string     `json:"dosage"`
		Schedule  string     `json:"schedule"`
		Archived  bool       `json:"archived"`
		StartDate *time.Time `json:"start_date"`
		EndDate   *time.Time `json:"end_date"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Search RxNorm (Always update on edit to handle renames or missing data)
	rxcui, normalizedName, _ := s.rxnorm.SearchRxNorm(req.Name)

	if err := s.store.UpdateMedication(id, req.Name, req.Dosage, req.Schedule, req.Archived, req.StartDate, req.EndDate, rxcui, normalizedName); err != nil {
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

	limit := 100 // Default
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil {
			limit = l
		}
	}

	readings, err := s.store.GetBloodPressureReadings(r.Context(), userID, days)
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
	var days int
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil {
			days = d
		}
	}

	readings, err := s.store.GetBloodPressureReadings(r.Context(), userID, days)
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
