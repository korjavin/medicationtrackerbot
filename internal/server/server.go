package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/VictoriaMetrics/fastcache"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/rxnorm"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
	"golang.org/x/oauth2"
)

// WorkoutInteractor defines the operations needed to interact with the chat
// interface when a workout is started from the web UI.
type WorkoutInteractor interface {
	// UpdateWorkoutMessage edits a notification message text and removes buttons.
	UpdateWorkoutMessage(msgID int, text string) error
	// StartWorkoutFlowFromWeb initiates the exercise-by-exercise flow in the chat.
	StartWorkoutFlowFromWeb(sessionID int64) error
	// CleanupWorkoutSessionMessages removes tracked chat messages related to this workout session.
	CleanupWorkoutSessionMessages(sessionID int64) error
}

type Server struct {
	meds            MedicationStore
	bp              BloodPressureStore
	weight          WeightStore
	workouts        WorkoutStore
	workoutSvc      workoutsvc.WorkoutService
	food            FoodStore
	settings        SettingsStore
	health          HealthStore
	changes         ChangeStore
	push            PushStore
	miband          MiBandStore
	workout         WorkoutInteractor
	notifiers       []notifier.Notifier
	rxnorm          *rxnorm.Client
	botToken        string
	sessionSecret   string
	allowedUserID   int64
	oidcConfig      OIDCConfig
	oauthConfig     *oauth2.Config
	oidcUserInfo    string
	botUsername     string
	vapidPublicKey  string
	foodSearchTTL       time.Duration
	foodSearchCache     *fastcache.Cache
	changeStreamSem     chan struct{}
	changePruning       atomic.Bool
	externalAPIKey      string
	mcpAuditSecret      string
	lastMCPNotification time.Time
	mcpAuditMutex       sync.Mutex
}

type rateLimiter struct {
	mu     sync.Mutex
	window time.Duration
	max    int
	hits   map[string][]time.Time
}

func newRateLimiter(max int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		window: window,
		max:    max,
		hits:   make(map[string][]time.Time),
	}
	rl.startCleanup()
	return rl
}

func (r *rateLimiter) startCleanup() {
	ticker := time.NewTicker(r.window)
	go func() {
		for range ticker.C {
			r.cleanup()
		}
	}()
}

func (r *rateLimiter) cleanup() {
	now := time.Now()
	cutoff := now.Add(-r.window)
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, hits := range r.hits {
		if len(hits) == 0 {
			delete(r.hits, key)
			continue
		}
		if hits[len(hits)-1].Before(cutoff) {
			delete(r.hits, key)
		}
	}
}

func (r *rateLimiter) Allow(key string) bool {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	hits := r.hits[key]
	cutoff := now.Add(-r.window)
	pruned := hits[:0]
	for _, t := range hits {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}
	if len(pruned) >= r.max {
		r.hits[key] = pruned
		return false
	}
	pruned = append(pruned, now)
	if len(pruned) == 0 {
		delete(r.hits, key)
	} else {
		r.hits[key] = pruned
	}
	return true
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if len(parts) > 0 {
				return strings.TrimSpace(parts[0])
			}
		}
		if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
			return xrip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func rateLimitMiddleware(limiter *rateLimiter, trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r, trustProxy)
			if !limiter.Allow(ip) {
				http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func parseBoolEnv(key string, defaultValue bool) bool {
	val := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if val == "" {
		return defaultValue
	}
	return val == "1" || val == "true" || val == "yes" || val == "y"
}

func parseIntEnv(key string, defaultValue int) int {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" {
		return defaultValue
	}
	parsed, err := strconv.Atoi(val)
	if err != nil || parsed <= 0 {
		return defaultValue
	}
	return parsed
}

func New(s *store.Store, botToken, sessionSecret string, allowedUserID int64, oidc OIDCConfig, botUsername string, vapidPublicKey string) *Server {
	foodSearchCacheSizeMB := parseIntEnv("FOOD_SEARCH_CACHE_MB", 40)
	changeStreamMaxConn := parseIntEnv("CHANGES_STREAM_MAX_CONN", 40)

	srv := &Server{
		meds:            s,
		bp:              s,
		weight:          s,
		workouts:        s,
		workoutSvc:      workoutsvc.New(s),
		food:            s,
		settings:        s,
		health:          s,
		changes:         s,
		push:            s,
		miband:          s,
		rxnorm:          rxnorm.New(),
		botToken:        botToken,
		sessionSecret:   sessionSecret,
		allowedUserID:   allowedUserID,
		oidcConfig:      oidc,
		botUsername:     botUsername,
		vapidPublicKey:  vapidPublicKey,
		foodSearchTTL:   30 * time.Minute,
		foodSearchCache: fastcache.New(foodSearchCacheSizeMB * 1024 * 1024),
		changeStreamSem: make(chan struct{}, changeStreamMaxConn),
		externalAPIKey:  os.Getenv("EXTERNAL_WORKOUT_API_KEY"),
	}

	if srv.externalAPIKey == "" {
		slog.Warn("EXTERNAL_WORKOUT_API_KEY is not set. The external workout endpoint will reject all requests.")
	}

	srv.initOAUTH()
	return srv
}

// SetWorkoutInteractor configures the chat interaction for web-started workouts.
func (s *Server) SetWorkoutInteractor(w WorkoutInteractor) {
	s.workout = w
}

// SetMCPAuditSecret sets the secret used to authenticate MCP audit payloads.
func (s *Server) SetMCPAuditSecret(secret string) {
	s.mcpAuditSecret = secret
}

// SetNotifiers configures the notification channels after construction.
func (s *Server) SetNotifiers(notifiers []notifier.Notifier) {
	s.notifiers = notifiers
}

// deleteNotification deletes a previously sent notification from all notifiers.
func (s *Server) deleteNotification(ctx context.Context, msgID int) {
	if msgID == 0 {
		return
	}
	for _, nr := range s.notifiers {
		go func(nr notifier.Notifier) {
			if err := nr.Delete(ctx, s.allowedUserID, msgID); err != nil {
				slog.Error("notification delete failed", "notifier", nr, "error", err)
			}
		}(nr)
	}
}

// closeNotification closes a notification by tag (e.g. WebPush) across all notifiers.
func (s *Server) closeNotification(ctx context.Context, tag string) {
	if tag == "" {
		return
	}
	for _, nr := range s.notifiers {
		go func(nr notifier.Notifier) {
			if err := nr.CloseNotification(ctx, s.allowedUserID, tag); err != nil {
				slog.Error("notification close failed", "notifier", nr, "error", err)
			}
		}(nr)
	}
}

// notify sends a notification through all configured notifiers.
func (s *Server) notify(ctx context.Context, n notifier.Notification) {
	for _, nr := range s.notifiers {
		go func(nr notifier.Notifier) {
			if _, err := nr.Send(ctx, s.allowedUserID, n); err != nil {
				slog.Error("notification send failed", "notifier", nr, "error", err)
			}
		}(nr)
	}
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

// securityHeadersMiddleware adds headers to improve application security
func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-site")
		w.Header().Set("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
		// Note: 'unsafe-inline' is currently required in style-src because the application dynamically
		// injects styles for various components (like charts, modals, and dynamic themes).
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' https://telegram.org; font-src 'self' https://fonts.gstatic.com; base-uri 'self'; frame-ancestors 'self'")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Service Worker with special headers (must be at root scope)
	mux.HandleFunc("/static/sw.js", s.serveServiceWorker)

	// Server-generated config
	mux.HandleFunc("/static/config.js", s.serveConfigJS)

	// Static Files with no-cache headers
	fs := http.FileServer(http.Dir("./web/static"))
	mux.Handle("/static/", noCacheMiddleware(http.StripPrefix("/static/", fs)))
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./web/static/icons/favicon.ico")
	})

	// Pitch Deck Presentation
	mux.HandleFunc("/pitch", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "web/static/pitch.html")
	})

	// OIDC Setup Helper
	mux.HandleFunc("/oidc-setup", s.serveOIDCSetup)

	// Main Page with no-cache headers and bot username injection
	mux.HandleFunc("/", s.serveIndexWithBotUsername)

	// Deep link routes - serve SPA, JS handles the path (see web/static/js/app.js)
	mux.HandleFunc("/bp_add", s.serveIndexWithBotUsername)
	mux.HandleFunc("/weight_add", s.serveIndexWithBotUsername)

	// Auth Routes (rate-limited)
	authLimiter := newRateLimiter(10, time.Minute)
	// Must be explicitly set to true when behind a trusted reverse proxy
	trustProxy := parseBoolEnv("AUTH_TRUST_PROXY", false)
	authLimit := rateLimitMiddleware(authLimiter, trustProxy)
	mux.HandleFunc("/auth/status", s.handleAuthStatus)
	mux.Handle("/auth/oidc/login", authLimit(http.HandlerFunc(s.handleOIDCLogin)))
	mux.Handle("/auth/oidc/callback", authLimit(http.HandlerFunc(s.handleOIDCCallback)))
	// Backward compatibility for older Google-only URLs
	mux.HandleFunc("/auth/google/login", s.handleOIDCLogin)
	mux.HandleFunc("/auth/google/callback", s.handleOIDCCallback)
	mux.HandleFunc("/auth/telegram/callback", s.handleTelegramCallback)

	// API
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /api/medications", s.handleListMedications)
	apiMux.HandleFunc("POST /api/medications", s.handleCreateMedication)
	apiMux.HandleFunc("POST /api/medications/{id}", s.handleUpdateMedication)
	apiMux.HandleFunc("DELETE /api/medications/{id}", s.handleDeleteMedication)
	apiMux.HandleFunc("GET /api/history", s.handleListHistory)
	apiMux.HandleFunc("POST /api/medications/trigger-next-intake", s.handleTriggerNextIntake)
	apiMux.HandleFunc("GET /api/medications/next-intake", s.handleGetNextIntake)
	apiMux.HandleFunc("POST /api/medications/log-past", s.handleLogPastIntake)
	apiMux.HandleFunc("POST /api/medications/cancel-intake", s.handleCancelIntake)
	apiMux.HandleFunc("POST /api/medications/snooze", s.handleSnoozeMedication)
	apiMux.HandleFunc("POST /api/medications/skip", s.handleSkipMedication)

	// Blood Pressure endpoints
	apiMux.HandleFunc("POST /api/bp", s.handleCreateBloodPressure)
	apiMux.HandleFunc("GET /api/bp", s.handleListBloodPressure)
	apiMux.HandleFunc("DELETE /api/bp/{id}", s.handleDeleteBloodPressure)
	apiMux.HandleFunc("POST /api/bp/import", s.handleImportBloodPressure)
	apiMux.HandleFunc("GET /api/bp/export", s.handleExportBloodPressure)
	apiMux.HandleFunc("GET /api/bp/goal", s.handleGetBPGoal)
	apiMux.HandleFunc("GET /api/bp/stats", s.handleGetBPStats)

	// BP Reminder endpoints
	apiMux.HandleFunc("GET /api/bp/reminder/status", s.handleGetBPReminderStatus)
	apiMux.HandleFunc("POST /api/bp/reminder/toggle", s.handleToggleBPReminder)
	apiMux.HandleFunc("POST /api/bp/reminder/snooze", s.handleSnoozeBPReminder)
	apiMux.HandleFunc("POST /api/bp/reminder/dontbug", s.handleDontBugMeBPReminder)
	apiMux.HandleFunc("POST /api/bp/reminder/test", s.handleSendTestBPNotification)

	// Weight endpoints
	apiMux.HandleFunc("POST /api/weight", s.handleCreateWeight)
	apiMux.HandleFunc("GET /api/weight", s.handleListWeight)
	apiMux.HandleFunc("DELETE /api/weight/{id}", s.handleDeleteWeight)
	apiMux.HandleFunc("GET /api/weight/export", s.handleExportWeight)
	apiMux.HandleFunc("GET /api/weight/goal", s.handleGetWeightGoal)

	// Weight Reminder endpoints
	apiMux.HandleFunc("GET /api/weight/reminder/status", s.handleGetWeightReminderStatus)
	apiMux.HandleFunc("POST /api/weight/reminder/toggle", s.handleToggleWeightReminder)
	apiMux.HandleFunc("POST /api/weight/reminder/snooze", s.handleSnoozeWeightReminder)
	apiMux.HandleFunc("POST /api/weight/reminder/dontbug", s.handleDontBugMeWeightReminder)

	// Inventory endpoints
	apiMux.HandleFunc("POST /api/medications/{id}/restock", s.handleRestock)
	apiMux.HandleFunc("GET /api/medications/{id}/restocks", s.handleGetRestockHistory)
	apiMux.HandleFunc("GET /api/inventory/low", s.handleGetLowStock)

	// Workout endpoints
	apiMux.HandleFunc("GET /api/workout/groups", s.handleListWorkoutGroups)
	apiMux.HandleFunc("POST /api/workout/groups/create", s.handleCreateWorkoutGroup)
	apiMux.HandleFunc("PUT /api/workout/groups/update", s.handleUpdateWorkoutGroup)
	apiMux.HandleFunc("DELETE /api/workout/groups/delete", s.handleDeleteWorkoutGroup)
	apiMux.HandleFunc("GET /api/workout/variants", s.handleListVariantsByGroup)
	apiMux.HandleFunc("POST /api/workout/variants/create", s.handleCreateWorkoutVariant)
	apiMux.HandleFunc("PUT /api/workout/variants/update", s.handleUpdateWorkoutVariant)
	apiMux.HandleFunc("DELETE /api/workout/variants/delete", s.handleDeleteWorkoutVariant)
	apiMux.HandleFunc("GET /api/workout/exercises", s.handleListExercisesByVariant)
	apiMux.HandleFunc("POST /api/workout/exercises/create", s.handleCreateExercise)
	apiMux.HandleFunc("PUT /api/workout/exercises/update", s.handleUpdateExercise)
	apiMux.HandleFunc("DELETE /api/workout/exercises/delete", s.handleDeleteExercise)
	apiMux.HandleFunc("DELETE /api/workout/sessions/delete", s.handleDeleteWorkoutSession)
	apiMux.HandleFunc("GET /api/workout/sessions", s.handleListWorkoutSessions)
	apiMux.HandleFunc("GET /api/workout/sessions/next", s.handleGetNextWorkout)
	apiMux.HandleFunc("GET /api/workout/sessions/details", s.handleGetSessionDetails)
	apiMux.HandleFunc("POST /api/workout/sessions/adhoc", s.handleCreateAdHocWorkoutSession) // Ad-hoc workout
	apiMux.HandleFunc("GET /api/workout/stats", s.handleGetWorkoutStats)
	apiMux.HandleFunc("GET /api/workout/rotation/state", s.handleGetRotationState)
	apiMux.HandleFunc("POST /api/workout/rotation/initialize", s.handleInitializeRotation)
	apiMux.HandleFunc("POST /api/workout/sessions/logs/update", s.handleUpdateExerciseLog)
	apiMux.HandleFunc("DELETE /api/workout/sessions/logs/delete", s.handleDeleteExerciseLog)
	apiMux.HandleFunc("POST /api/workout/session/snooze", s.handleSnoozeWorkoutSessionCompat)
	apiMux.HandleFunc("POST /api/workout/session/skip", s.handleSkipWorkoutSessionCompat)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/snooze", s.handleSnoozeWorkoutSession)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/skip", s.handleSkipWorkoutSession)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/preskip", s.handlePreSkipWorkoutSession)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/cancel-preskip", s.handleCancelPreSkipWorkoutSession)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/next-variant", s.handleNextVariantWorkoutSession)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/start", s.handleStartWorkoutSession)
	apiMux.HandleFunc("PUT /api/workout/sessions/status", s.handleUpdateSessionStatus)
	apiMux.HandleFunc("GET /api/workout/exercises/unique", s.handleGetUniqueExercises)
	apiMux.HandleFunc("POST /api/workout/sessions/logs/create", s.handleAddExerciseToSession)
	apiMux.HandleFunc("GET /api/workout/exercise-library", s.handleListExerciseLibrary)
	apiMux.HandleFunc("POST /api/workout/exercise-library/create", s.handleCreateExerciseLibraryItem)
	apiMux.HandleFunc("PUT /api/workout/exercise-library/update", s.handleUpdateExerciseLibraryItem)
	apiMux.HandleFunc("DELETE /api/workout/exercise-library/delete", s.handleDeleteExerciseLibraryItem)

	// Mi Band outdoor workout endpoints
	apiMux.HandleFunc("GET /api/workout/miband", s.handleListMiBandWorkouts)
	apiMux.HandleFunc("GET /api/workout/miband/{id}/gps", s.handleGetMiBandWorkoutGPS)
	apiMux.HandleFunc("DELETE /api/workout/miband/{id}", s.handleDeleteMiBandWorkout)
	apiMux.HandleFunc("PATCH /api/workout/miband/{id}", s.handleUpdateMiBandWorkout)

	// Web Push endpoints
	apiMux.HandleFunc("GET /api/webpush/vapid-public-key", s.handleGetVAPIDPublicKey)
	apiMux.HandleFunc("POST /api/webpush/subscribe", s.handleSubscribePush)
	apiMux.HandleFunc("POST /api/webpush/unsubscribe", s.handleUnsubscribePush)
	apiMux.HandleFunc("GET /api/webpush/subscriptions", s.handleListPushSubscriptions)
	apiMux.HandleFunc("POST /api/webpush/test-medication", s.handleSendTestMedicationNotification)
	apiMux.HandleFunc("POST /api/medications/confirm-schedule", s.handleConfirmSchedule)
	apiMux.HandleFunc("POST /api/intakes/update", s.handleUpdateIntake)

	// Food Intake endpoints
	apiMux.HandleFunc("POST /api/food/log", s.handleCreateFoodLog)
	apiMux.HandleFunc("PUT /api/food/log/{id}", s.handleUpdateFoodLog)
	apiMux.HandleFunc("GET /api/food/log", s.handleGetFoodLogs)
	apiMux.HandleFunc("GET /api/food/stats", s.handleGetFoodStats)
	apiMux.HandleFunc("DELETE /api/food/log/{id}", s.handleDeleteFoodLog)
	apiMux.HandleFunc("GET /api/food/products", s.handleGetFoodProducts)
	apiMux.HandleFunc("PUT /api/food/products/{id}", s.handleUpdateFoodProduct)
	apiMux.HandleFunc("DELETE /api/food/products/{id}", s.handleDeleteFoodProduct)
	apiMux.HandleFunc("GET /api/food/products/search", s.handleSearchFoodProducts)
	apiMux.HandleFunc("POST /api/food/products/from-logs", s.handleCreateMealFromLogs)

	// Init endpoint (returns all data needed for first render)
	apiMux.HandleFunc("GET /api/init", s.handleInit)
	apiMux.HandleFunc("GET /api/bootstrap", s.handleBootstrap)
	apiMux.HandleFunc("GET /api/changes", s.handleChanges)
	apiMux.HandleFunc("GET /api/changes/stream", s.handleChangesStream)

	// Settings endpoints
	apiMux.HandleFunc("GET /api/food/settings/status", s.handleGetFoodIntakeEnabled)
	apiMux.HandleFunc("POST /api/food/settings/toggle", s.handleSetFoodIntakeEnabled)
	apiMux.HandleFunc("GET /api/food/settings/targets", s.handleGetFoodTargets)
	apiMux.HandleFunc("POST /api/food/settings/targets", s.handleSetFoodTargets)
	apiMux.HandleFunc("GET /api/settings/features", s.handleGetFeatureSettings)
	apiMux.HandleFunc("POST /api/settings/features/{feature}", s.handleSetFeatureEnabled)
	apiMux.HandleFunc("POST /api/settings/tab-order", s.handleSetTabOrder)
	apiMux.HandleFunc("GET /api/health/overview", s.handleGetHealthOverview)

	// External routes (bypass AuthMiddleware)
	mux.HandleFunc("POST /api/workout/external", s.externalAPIKeyMiddleware(s.handleExternalWorkout))
	mux.HandleFunc("POST /api/mcp-audit", s.handleMCPAudit)
	mux.HandleFunc("POST /api/mcp-food-log", s.handleMCPFoodLog)

	// Apply Middleware to API
	authMW := AuthMiddleware(s.botToken, s.sessionSecret, s.allowedUserID)
	mux.Handle("/api/", authMW(apiMux))

	return securityHeadersMiddleware(mux)
}

// -- Blood Pressure Handlers --

// -- Blood Pressure Handlers --

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

	logs, err := s.meds.GetIntakeHistory(medID, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := json.NewEncoder(w).Encode(logs); err != nil {
		slog.Error("encode response", "error", err)
	}
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.Quantity <= 0 {
		http.Error(w, "Quantity must be positive", http.StatusBadRequest)
		return
	}

	if err := s.meds.AddRestock(id, req.Quantity, req.Note); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Get updated medication to return new count
	med, err := s.meds.GetMedication(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":          "restocked",
		"quantity_added":  req.Quantity,
		"inventory_count": med.InventoryCount,
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleGetRestockHistory(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid ID", http.StatusBadRequest)
		return
	}

	restocks, err := s.meds.GetRestockHistory(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(restocks); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleGetLowStock(w http.ResponseWriter, r *http.Request) {
	// Default to 7 days threshold
	days := 7
	if dStr := r.URL.Query().Get("days"); dStr != "" {
		if d, err := strconv.Atoi(dStr); err == nil && d > 0 {
			days = d
		}
	}

	meds, err := s.meds.GetMedicationsLowOnStock(days)
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
			DaysRemaining: s.meds.GetDaysOfStockRemaining(&m),
		}
		result = append(result, lsm)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// serveServiceWorker serves the service worker with correct headers for PWA
func (s *Server) serveServiceWorker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Service-Worker-Allowed", "/")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	http.ServeFile(w, r, "./web/static/sw.js")
}

// serveConfigJS serves dynamic configuration variables as a JavaScript file
func (s *Server) serveConfigJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	oidcClient := struct {
		Enabled     bool   `json:"enabled"`
		Label       string `json:"label,omitempty"`
		LoginURL    string `json:"loginUrl,omitempty"`
		ButtonColor string `json:"buttonColor,omitempty"`
		ButtonText  string `json:"buttonText,omitempty"`
	}{
		Enabled: s.oauthConfig != nil && s.oidcConfig.ClientID != "",
	}
	if oidcClient.Enabled {
		oidcClient.Label = defaultOIDCButtonLabel(s.oidcConfig)
		oidcClient.LoginURL = "/auth/oidc/login"
		oidcClient.ButtonColor = s.oidcConfig.ButtonColor
		oidcClient.ButtonText = s.oidcConfig.ButtonText
	}
	oidcJSON, err := json.Marshal(oidcClient)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	js := fmt.Sprintf("window.BOT_USERNAME = %q;\nwindow.OIDC_CONFIG = %s;\n", s.botUsername, string(oidcJSON))
	if _, err := w.Write([]byte(js)); err != nil {
		slog.Error("write response", "error", err)
	}
}

// serveIndexWithBotUsername serves index.html with cache busting injected
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

	// Inject timestamp for cache busting
	html := strings.ReplaceAll(string(content), "TIMESTAMP_PLACEHOLDER", fmt.Sprintf("%d", time.Now().UnixNano()))

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err := w.Write([]byte(html)); err != nil { // #nosec G203
		slog.Error("write response", "error", err)
	}
}

// serveOIDCSetup serves a helper page with copyable OIDC redirect URIs
func (s *Server) serveOIDCSetup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	f, err := os.Open("./web/static/oidc-setup.html")
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

	appDomain := os.Getenv("APP_DOMAIN")
	if appDomain == "" {
		appDomain = os.Getenv("DOMAIN")
	}
	if appDomain == "" {
		appDomain = strings.Split(r.Host, ":")[0]
	}

	pocketIDDomain := os.Getenv("POCKET_ID_DOMAIN")
	if pocketIDDomain == "" {
		pocketIDDomain = "id.example.com"
	}

	mcpDomain := os.Getenv("MCP_DOMAIN")
	if mcpDomain == "" {
		mcpDomain = "mcp.example.com"
	}

	// MCP server URL: if MCP runs on the same domain as the app (path-prefix routing),
	// append /mcp; otherwise use the dedicated subdomain.
	mcpServerURL := "https://" + mcpDomain
	if mcpDomain == appDomain {
		mcpServerURL = "https://" + appDomain + "/mcp"
	}

	// OIDC client IDs — used to build direct links to Pocket-ID admin pages.
	webClientID := os.Getenv("OIDC_CLIENT_ID")
	mcpClientID := os.Getenv("OIDC_MCP_CLIENT_ID")

	html := string(content)
	html = strings.ReplaceAll(html, "APP_DOMAIN_PLACEHOLDER", appDomain)
	html = strings.ReplaceAll(html, "POCKET_ID_DOMAIN_PLACEHOLDER", pocketIDDomain)
	html = strings.ReplaceAll(html, "MCP_SERVER_URL_PLACEHOLDER", mcpServerURL)
	html = strings.ReplaceAll(html, "WEB_CLIENT_ID_PLACEHOLDER", webClientID)
	html = strings.ReplaceAll(html, "MCP_CLIENT_ID_PLACEHOLDER", mcpClientID)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err := w.Write([]byte(html)); err != nil { // #nosec G203
		slog.Error("write response", "error", err)
	}
}

// handleTelegramCallback handles Telegram Login Widget authentication
func (s *Server) handleTelegramCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit request body size to 1MB to prevent memory exhaustion
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var data TelegramLoginData
	if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
		slog.Error("Invalid JSON from TG-LOGIN", "remoteAddr", r.RemoteAddr, "error", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	slog.Info("TG-LOGIN Attempt", "remoteAddr", r.RemoteAddr, "userID", data.ID, "username", data.Username, "firstName", data.FirstName, "authDate", data.AuthDate)

	valid, user, err := ValidateTelegramLoginWidget(s.botToken, data)
	if !valid || err != nil {
		slog.Error("TG-LOGIN Validation failed", "userID", data.ID, "remoteAddr", r.RemoteAddr, "error", err)
		http.Error(w, "Invalid Telegram login data: "+err.Error(), http.StatusUnauthorized)
		return
	}

	// Check if user is allowed
	if user.ID != s.allowedUserID {
		slog.Warn("TG-LOGIN Unauthorized user", "userID", user.ID, "username", user.Username, "remoteAddr", r.RemoteAddr, "allowedUserID", s.allowedUserID)
		http.Error(w, "Forbidden: User not allowed", http.StatusForbidden)
		return
	}

	// Create session (same as OIDC auth)
	sessionValue := createSessionToken(user.Username, s.sessionSecret)
	http.SetCookie(w, &http.Cookie{
		Name:     "auth_session",
		Value:    sessionValue,
		Expires:  time.Now().Add(24 * time.Hour * 30), // 30 days
		HttpOnly: true,
		Secure:   true,                 // Only send over HTTPS
		SameSite: http.SameSiteLaxMode, // CSRF protection
		Path:     "/",
	})

	slog.Info("TG-LOGIN Success", "userID", user.ID, "username", user.Username, "remoteAddr", r.RemoteAddr)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "ok"}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// -- Web Push Handlers --

func (s *Server) handleGetVAPIDPublicKey(w http.ResponseWriter, r *http.Request) {
	if s.vapidPublicKey == "" {
		http.Error(w, "Web Push not configured", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{
		"public_key": s.vapidPublicKey,
	}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleSubscribePush(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			Auth   string `json:"auth"`
			P256dh string `json:"p256dh"`
		} `json:"keys"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.push.CreatePushSubscription(userID, req.Endpoint, req.Keys.Auth, req.Keys.P256dh); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func (s *Server) handleUnsubscribePush(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.push.DeletePushSubscription(req.Endpoint); err != nil {
		// Log but don't fail hard
		slog.Warn("Error deleting subscription", "error", err)
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleListPushSubscriptions(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	subs, err := s.push.GetPushSubscriptions(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(subs); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func (s *Server) handleConfirmSchedule(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		ScheduledAt   string  `json:"scheduled_at"`
		MedicationIDs []int64 `json:"medication_ids"`
		IntakeIDs     []int64 `json:"intake_ids"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	now := time.Now()

	// 1. Prefer Intake IDs if available
	if len(req.IntakeIDs) > 0 {
		for _, id := range req.IntakeIDs {
			// Verify ownership and status
			intake, err := s.meds.GetIntake(id)
			if err != nil {
				slog.Error("Error getting intake", "intakeID", id, "error", err)
				continue
			}
			if intake == nil || intake.UserID != userID {
				continue // access denied or not found
			}

			if intake.Status == "PENDING" {
				// Delete notification messages
				reminders, _ := s.meds.GetIntakeReminders(id)
				for _, msgID := range reminders {
					s.deleteNotification(r.Context(), msgID)
				}

				// Confirm intake. If it returns sql.ErrNoRows, the intake was already
				// confirmed by another concurrent request - skip inventory decrement to avoid
				// double-decrementing stock.
				if err := s.meds.ConfirmIntake(id, now); err != nil {
					if errors.Is(err, sql.ErrNoRows) {
						slog.Info("Intake already confirmed by another request (race condition)", "intakeID", intake.ID)
					} else {
						slog.Error("Error confirming intake", "intakeID", intake.ID, "error", err)
					}
					continue
				}

				// Decrement inventory only if confirmation succeeded
				if err := s.meds.DecrementInventory(intake.MedicationID, 1); err != nil {
					slog.Error("Error decrementing inventory", "error", err)
				}
			}
		}
		w.WriteHeader(http.StatusOK)
		return
	}

	// 2. Fallback to ScheduledAt + MedicationIDs
	// Parse ScheduledAt
	parsedTime, err := time.Parse(time.RFC3339, req.ScheduledAt)
	if err != nil {
		// Try other formats if needed, or just fail
		slog.Error("Error parsing time", "scheduledAt", req.ScheduledAt, "error", err)
		http.Error(w, "Invalid time format", http.StatusBadRequest)
		return
	}

	for _, medID := range req.MedicationIDs {
		intake, err := s.meds.GetIntakeBySchedule(medID, parsedTime)
		if err != nil {
			slog.Error("Error finding intake for med by schedule", "medID", medID, "scheduledAt", req.ScheduledAt, "error", err)
			continue
		}

		if intake != nil && intake.UserID == userID && intake.Status == "PENDING" {
			// Delete notification messages
			reminders, _ := s.meds.GetIntakeReminders(intake.ID)
			for _, msgID := range reminders {
				s.deleteNotification(r.Context(), msgID)
			}

			// Confirm intake. If it returns sql.ErrNoRows, the intake was already
			// confirmed by another concurrent request - skip inventory decrement to avoid
			// double-decrementing stock.
			if err := s.meds.ConfirmIntake(intake.ID, now); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					slog.Info("Intake already confirmed by another request (race condition)", "intakeID", intake.ID)
				} else {
					slog.Error("Error confirming intake", "intakeID", intake.ID, "error", err)
				}
				continue
			}

			// Decrement inventory only if confirmation succeeded
			if err := s.meds.DecrementInventory(medID, 1); err != nil {
				slog.Error("Error decrementing inventory", "error", err)
			}
		} else if intake == nil {
			slog.Info("Intake not found or not pending for med", "medID", medID, "scheduledAt", req.ScheduledAt)
		}
	}

	// Revert unchecked TAKEN intakes back to PENDING
	medSet := make(map[int64]bool)
	for _, id := range req.MedicationIDs {
		medSet[id] = true
	}

	takenIntakes, err := s.meds.GetTakenIntakesBySchedule(userID, parsedTime)
	if err != nil {
		slog.Error("Error getting taken intakes for schedule", "scheduledAt", req.ScheduledAt, "error", err)
	} else {
		for _, intake := range takenIntakes {
			if !medSet[intake.MedicationID] {
				if err := s.meds.UpdateIntake(intake.ID, time.Time{}, "PENDING"); err != nil {
					slog.Error("Error reverting unchecked taken intake", "intakeID", intake.ID, "error", err)
					continue
				}
				if err := s.meds.IncrementInventory(intake.MedicationID, 1); err != nil {
					slog.Error("Error incrementing inventory on revert", "intakeID", intake.ID, "error", err)
				}
			}
		}
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSendTestMedicationNotification(w http.ResponseWriter, r *http.Request) {
	_ = r.Context().Value(UserCtxKey).(*TelegramUser).ID

	if len(s.notifiers) == 0 {
		http.Error(w, "No notification channels configured", http.StatusBadRequest)
		return
	}

	meds, err := s.meds.ListMedications(false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	now := time.Now()
	var earliestNext time.Time
	var medsAtEarliest []store.Medication

	for _, med := range meds {
		cfg, err := med.ValidSchedule()
		if err != nil || cfg.Type == "as_needed" {
			continue
		}

		// Check next 7 days for the earliest occurrence
		for daysAhead := 0; daysAhead < 8; daysAhead++ {
			checkDay := now.AddDate(0, 0, daysAhead)

			// If "weekly", check day
			if cfg.Type == "weekly" {
				found := false
				dayIdx := int(checkDay.Weekday())
				for _, d := range cfg.Days {
					if d == dayIdx {
						found = true
						break
					}
				}
				if !found {
					continue
				}
			}

			// Iterate over times
			for _, timeStr := range cfg.Times {
				if len(timeStr) != 5 {
					continue
				}
				var hour, minute int
				_, _ = fmt.Sscanf(timeStr, "%d:%d", &hour, &minute)

				target := time.Date(checkDay.Year(), checkDay.Month(), checkDay.Day(), hour, minute, 0, 0, now.Location())

				// Skip if in the past
				if target.Before(now) {
					continue
				}

				// Check Start/End Dates
				if med.StartDate != nil && target.Before(*med.StartDate) {
					continue
				}
				if med.EndDate != nil && target.After(*med.EndDate) {
					continue
				}

				// Is this the earliest we've found?
				if earliestNext.IsZero() || target.Before(earliestNext) {
					earliestNext = target
					medsAtEarliest = []store.Medication{med}
				} else if target.Equal(earliestNext) {
					medsAtEarliest = append(medsAtEarliest, med)
				}
				// Once we found one for this med, we don't need further times for this med *if* it's after earliestNext
			}
			// If we already found a time for this med in this day or previous days, and it's later than current earliestNext, we could optimize,
			// but simple search is fine for small med list.
		}
	}

	if len(medsAtEarliest) == 0 {
		http.Error(w, "No scheduled medications found to test with", http.StatusNotFound)
		return
	}

	// Build notification matching the scheduler's medication notification format
	medNames := make([]string, len(medsAtEarliest))
	medIDs := make([]int64, len(medsAtEarliest))
	for i, m := range medsAtEarliest {
		name := m.Name
		if m.Dosage != "" {
			name += " " + m.Dosage
		}
		medNames[i] = name
		medIDs[i] = m.ID
	}

	n := notifier.Notification{
		Text: fmt.Sprintf("**Time to take medication**\n%s", strings.Join(medNames, ", ")),
		Actions: []notifier.Action{
			{ID: "confirm_all", Label: "Confirm All"},
			{ID: "snooze", Label: "Snooze 10m"},
		},
		Tag: fmt.Sprintf("medication-%s", earliestNext.Format(time.RFC3339)),
		Metadata: map[string]interface{}{
			"type":             "medication",
			"scheduled_at":     earliestNext.Format(time.RFC3339),
			"medication_ids":   medIDs,
			"medication_names": medNames,
		},
	}

	s.notify(r.Context(), n)

	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "Sent simulated notification for %d medication(s) scheduled at %s", len(medsAtEarliest), earliestNext.Format("15:04")) // #nosec G104
}
