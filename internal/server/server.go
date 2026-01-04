package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"golang.org/x/oauth2"
)

type Server struct {
	store         *store.Store
	botToken      string
	allowedUserID int64
	oidcConfig    OIDCConfig
	oauthConfig   *oauth2.Config
}

func New(s *store.Store, botToken string, allowedUserID int64, oidc OIDCConfig) *Server {
	srv := &Server{
		store:         s,
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
	apiMux.HandleFunc("GET /api/history", s.handleHistory)

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

	id, err := s.store.CreateMedication(req.Name, req.Dosage, req.Schedule, req.StartDate, req.EndDate)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "status": "created"})
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

	if err := s.store.UpdateMedication(id, req.Name, req.Dosage, req.Schedule, req.Archived, req.StartDate, req.EndDate); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "updated"})
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

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	logs, err := s.store.GetIntakeHistory()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(logs)
}
