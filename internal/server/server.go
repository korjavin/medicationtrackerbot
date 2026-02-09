package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/bot"
	"github.com/korjavin/medicationtrackerbot/internal/rxnorm"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/webpush"
	"golang.org/x/oauth2"
)

type Server struct {
	store         *store.Store
	bot           *bot.Bot
	rxnorm        *rxnorm.Client
	botToken      string
	allowedUserID int64
	oidcConfig    OIDCConfig
	oauthConfig   *oauth2.Config
	botUsername   string
	vapidConfig   VAPIDConfig
	webPush       *webpush.Service
}

type VAPIDConfig struct {
	PublicKey  string
	PrivateKey string
	Subject    string
}

func New(s *store.Store, b *bot.Bot, botToken string, allowedUserID int64, oidc OIDCConfig, botUsername string, vapidConfig VAPIDConfig) *Server {
	srv := &Server{
		store:         s,
		bot:           b,
		rxnorm:        rxnorm.New(),
		botToken:      botToken,
		allowedUserID: allowedUserID,
		oidcConfig:    oidc,
		botUsername:   botUsername,
		vapidConfig:   vapidConfig,
	}

	if vapidConfig.PublicKey != "" && vapidConfig.PrivateKey != "" {
		srv.webPush = webpush.New(s, vapidConfig.PublicKey, vapidConfig.PrivateKey, vapidConfig.Subject)
	}

	srv.initOAUTH()
	return srv
}

func (s *Server) GetWebPushService() *webpush.Service {
	return s.webPush
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

	// Service Worker with special headers (must be at root scope)
	mux.HandleFunc("/static/sw.js", s.serveServiceWorker)

	// Static Files with no-cache headers
	fs := http.FileServer(http.Dir("./web/static"))
	mux.Handle("/static/", noCacheMiddleware(http.StripPrefix("/static/", fs)))

	// Pitch Deck Presentation
	mux.HandleFunc("/pitch", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "web/static/pitch.html")
	})

	// Main Page with no-cache headers and bot username injection
	mux.HandleFunc("/", s.serveIndexWithBotUsername)

	// Deep link routes - serve SPA, JS handles the path (see web/static/js/app.js)
	mux.HandleFunc("/bp_add", s.serveIndexWithBotUsername)
	mux.HandleFunc("/weight_add", s.serveIndexWithBotUsername)

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
	apiMux.HandleFunc("GET /api/bp/stats", s.handleGetBPStats)

	// BP Reminder endpoints
	apiMux.HandleFunc("GET /api/bp/reminder/status", s.handleGetBPReminderStatus)
	apiMux.HandleFunc("POST /api/bp/reminder/toggle", s.handleToggleBPReminder)
	apiMux.HandleFunc("POST /api/bp/reminder/snooze", s.handleSnoozeBPReminder)
	apiMux.HandleFunc("POST /api/bp/reminder/dontbug", s.handleDontBugMeBPReminder)

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
	apiMux.HandleFunc("GET /api/workout/sessions", s.handleListWorkoutSessions)
	apiMux.HandleFunc("GET /api/workout/sessions/next", s.handleGetNextWorkout)
	apiMux.HandleFunc("GET /api/workout/sessions/details", s.handleGetSessionDetails)
	apiMux.HandleFunc("GET /api/workout/stats", s.handleGetWorkoutStats)
	apiMux.HandleFunc("GET /api/workout/rotation/state", s.handleGetRotationState)
	apiMux.HandleFunc("POST /api/workout/rotation/initialize", s.handleInitializeRotation)
	apiMux.HandleFunc("POST /api/workout/sessions/logs/update", s.handleUpdateExerciseLog)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/snooze", s.handleSnoozeWorkoutSession)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/skip", s.handleSkipWorkoutSession)
	apiMux.HandleFunc("POST /api/workout/sessions/{id}/start", s.handleStartWorkoutSession)
	apiMux.HandleFunc("PUT /api/workout/sessions/status", s.handleUpdateSessionStatus)

	// Web Push endpoints
	apiMux.HandleFunc("GET /api/webpush/vapid-public-key", s.handleGetVAPIDPublicKey)
	apiMux.HandleFunc("POST /api/webpush/subscribe", s.handleSubscribePush)
	apiMux.HandleFunc("POST /api/webpush/unsubscribe", s.handleUnsubscribePush)
	apiMux.HandleFunc("GET /api/webpush/subscriptions", s.handleListPushSubscriptions)
	apiMux.HandleFunc("POST /api/webpush/test-medication", s.handleSendTestMedicationNotification)
	apiMux.HandleFunc("POST /api/medications/confirm-schedule", s.handleConfirmSchedule)

	// Apply Middleware to API
	authMW := AuthMiddleware(s.botToken, s.allowedUserID)
	mux.Handle("/api/", authMW(apiMux))

	return mux
}

// -- Handlers --

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

	logs, err := s.store.GetIntakeHistory(medID, days)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(logs)
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

// serveServiceWorker serves the service worker with correct headers for PWA
func (s *Server) serveServiceWorker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Service-Worker-Allowed", "/")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	http.ServeFile(w, r, "./web/static/sw.js")
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
		Secure:   true,                 // Only send over HTTPS
		SameSite: http.SameSiteLaxMode, // CSRF protection
		Path:     "/",
	})

	log.Printf("[TG-LOGIN] Success for user_id=%d username=%s from %s", user.ID, user.Username, r.RemoteAddr)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// -- Web Push Handlers --

func (s *Server) handleGetVAPIDPublicKey(w http.ResponseWriter, r *http.Request) {
	if s.vapidConfig.PublicKey == "" {
		http.Error(w, "Web Push not configured", http.StatusServiceUnavailable)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"public_key": s.vapidConfig.PublicKey,
	})
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.store.CreatePushSubscription(userID, req.Endpoint, req.Keys.Auth, req.Keys.P256dh); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func (s *Server) handleUnsubscribePush(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if err := s.store.DeletePushSubscription(req.Endpoint); err != nil {
		// Log but don't fail hard
		log.Printf("Error deleting subscription: %v", err)
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleListPushSubscriptions(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	subs, err := s.store.GetPushSubscriptions(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(subs)
}

func (s *Server) handleConfirmSchedule(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	var req struct {
		ScheduledAt   string  `json:"scheduled_at"`
		MedicationIDs []int64 `json:"medication_ids"`
		IntakeIDs     []int64 `json:"intake_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	now := time.Now()

	// 1. Prefer Intake IDs if available
	if len(req.IntakeIDs) > 0 {
		for _, id := range req.IntakeIDs {
			// Verify ownership and status
			intake, err := s.store.GetIntake(id)
			if err != nil {
				log.Printf("Error getting intake %d: %v", id, err)
				continue
			}
			if intake == nil || intake.UserID != userID {
				continue // access denied or not found
			}

			if intake.Status == "PENDING" {
				// Delete Telegram Messages
				reminders, _ := s.store.GetIntakeReminders(id)
				for _, msgID := range reminders {
					if s.bot != nil {
						s.bot.DeleteMessage(msgID)
					}
				}

				if err := s.store.ConfirmIntake(id, now); err != nil {
					log.Printf("Error confirming intake %d: %v", intake.ID, err)
				}

				// Decrement inventory
				if err := s.store.DecrementInventory(intake.MedicationID, 1); err != nil {
					log.Printf("Error decrementing inventory: %v", err)
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
		log.Printf("Error parsing time %s: %v", req.ScheduledAt, err)
		http.Error(w, "Invalid time format", http.StatusBadRequest)
		return
	}

	for _, medID := range req.MedicationIDs {
		intake, err := s.store.GetIntakeBySchedule(medID, parsedTime)
		if err != nil {
			log.Printf("Error finding intake for med %d at %s: %v", medID, req.ScheduledAt, err)
			continue
		}

		if intake != nil && intake.UserID == userID && intake.Status == "PENDING" {
			// Delete Telegram Messages
			reminders, _ := s.store.GetIntakeReminders(intake.ID)
			for _, msgID := range reminders {
				if s.bot != nil {
					s.bot.DeleteMessage(msgID)
				}
			}

			if err := s.store.ConfirmIntake(intake.ID, now); err != nil {
				log.Printf("Error confirming intake %d: %v", intake.ID, err)
			}

			// Decrement inventory
			if err := s.store.DecrementInventory(medID, 1); err != nil {
				log.Printf("Error decrementing inventory: %v", err)
			}
		} else if intake == nil {
			log.Printf("Intake not found or not pending for med %d at %s", medID, req.ScheduledAt)
		}
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleSendTestMedicationNotification(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(UserCtxKey).(*TelegramUser).ID

	if s.webPush == nil {
		http.Error(w, "Web Push not configured", http.StatusBadRequest)
		return
	}

	meds, err := s.store.ListMedications(false)
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
				fmt.Sscanf(timeStr, "%d:%d", &hour, &minute)

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

	// Send simulated Push
	ctx := context.Background()
	if err := s.webPush.SendMedicationNotification(ctx, userID, medsAtEarliest, earliestNext, nil); err != nil {
		http.Error(w, fmt.Sprintf("Failed to send push: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "Sent simulated notification for %d medication(s) scheduled at %s", len(medsAtEarliest), earliestNext.Format("15:04"))
}
