package main

import (
	"log/slog"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
	"github.com/korjavin/medicationtrackerbot/internal/bot"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzupdate"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/scheduler"
	"github.com/korjavin/medicationtrackerbot/internal/server"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/webpush"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	// 1. Config
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "meds.db"
	}

	botToken := os.Getenv("TELEGRAM_BOT_TOKEN")
	if botToken == "" {
		slog.Info("TELEGRAM_BOT_TOKEN not set. Running in web-only mode.")
	}

	sessionSecret := os.Getenv("SESSION_SECRET")
	if sessionSecret == "" || len(sessionSecret) < 32 {
		slog.Error("SESSION_SECRET is required and must be at least 32 characters long. Generate one with: openssl rand -base64 32")
		os.Exit(1)
	}

	// Calculate Shannon entropy to ensure the secret is not predictable
	var entropy float64
	charCounts := make(map[rune]int)
	for _, char := range sessionSecret {
		charCounts[char]++
	}
	length := float64(len(sessionSecret))
	for _, count := range charCounts {
		p := float64(count) / length
		entropy -= p * (math.Log2(p))
	}
	// A cryptographically secure 32-character base64 string should easily have an entropy > 4.0
	// Even a weak standard password usually exceeds 3.0.
	if entropy < 3.5 {
		slog.Error("SESSION_SECRET has insufficient entropy (is too predictable). Generate a secure one with: openssl rand -base64 32")
		os.Exit(1)
	}

	userIDStr := os.Getenv("ALLOWED_USER_ID")
	if userIDStr == "" {
		slog.Info("ALLOWED_USER_ID is required for notifications.")
	}
	allowedUserID, _ := strconv.ParseInt(userIDStr, 10, 64)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// 2. Store
	s, err := store.New(dbPath)
	if err != nil {
		slog.Error("Failed to initialize store", "error", err)
		os.Exit(1)
	}
	defer s.Close()
	slog.Info("Database initialized", "path", dbPath)

	// 2.5 OpenAI Client
	openAIApiKey := os.Getenv("OPENAI_API_KEY")
	openAIURL := os.Getenv("OPENAI_URL")
	openAIModel := os.Getenv("OPENAI_MODEL")

	// Optional split-provider configuration for vision (food photo parsing).
	// When the primary provider is text-only (e.g. DeepSeek), set these to
	// route ParseMealFromImage to a vision-capable model. Each var falls back
	// to its OPENAI_* counterpart when unset.
	visionApiKey := os.Getenv("OPENAI_VISION_API_KEY")
	visionURL := os.Getenv("OPENAI_VISION_URL")
	visionModel := os.Getenv("OPENAI_VISION_MODEL")
	visionConfigured := visionApiKey != "" || visionURL != "" || visionModel != ""
	if visionApiKey == "" {
		visionApiKey = openAIApiKey
	}
	if visionURL == "" {
		visionURL = openAIURL
	}
	if visionModel == "" {
		visionModel = openAIModel
	}

	var foodAI domain.FoodAIService
	var activityAI domain.ActivityAIService
	// Enable AI features if API Key, URL, OR Model are explicitly set
	if openAIApiKey != "" || openAIURL != "" || openAIModel != "" {
		aiClient := ai.NewClient(openAIApiKey, openAIURL, openAIModel)
		visionClient := aiClient
		if visionConfigured {
			visionClient = ai.NewClient(visionApiKey, visionURL, visionModel)
			slog.Info("AI vision client configured separately for food photos", "url", visionURL, "model", visionModel)
		}
		foodAI = domain.NewFoodAIServiceWithVision(aiClient, visionClient)
		activityAI = domain.NewActivityAIService(aiClient)
		slog.Info("AI food and activity logging enabled")
	} else {
		slog.Info("AI food and activity logging disabled (no OPENAI variables set)")
	}

	// 3. VAPID config for Web Push (built before the bot so the notifier set
	// is finalised before the Telegram listener starts processing messages —
	// see the notifier-presence gate in tzupdate.Service.)
	vapidPublicKey := os.Getenv("VAPID_PUBLIC_KEY")
	vapidPrivateKey := os.Getenv("VAPID_PRIVATE_KEY")
	vapidSubject := os.Getenv("VAPID_SUBJECT")
	vapidAdminEmail := os.Getenv("ADMIN_EMAIL")
	vapidDomain := os.Getenv("DOMAIN")
	if vapidDomain == "" {
		vapidDomain = os.Getenv("APP_DOMAIN")
	}

	var wpService *webpush.Service
	if vapidPublicKey != "" && vapidPrivateKey != "" {
		wpService = webpush.New(s, vapidPublicKey, vapidPrivateKey, vapidSubject, vapidAdminEmail, vapidDomain)
	}

	// 4. Bot
	// Construct the shared TZ-update service before the bot and the server so
	// both transports serialize timezone changes through one mutex and apply
	// the same plan-generation safety net. The notifier slice is built below
	// before tgBot.Start() so the closure passed to tzupdate.NewService
	// always observes the finalised set — otherwise a queued /tz + location
	// arriving during startup could race past an empty notifier slice and
	// skip plan generation.
	tzPlanner := tzreschedule.NewPlannerService(s)
	var notifiers []notifier.Notifier
	tzUpdater := tzupdate.NewService(s, s, tzPlanner, nil, func() bool { return len(notifiers) > 0 })

	var tgBot *bot.Bot
	if botToken != "" {
		tgBot, err = bot.New(botToken, allowedUserID, s, foodAI, activityAI, tzUpdater)
		if err != nil {
			slog.Error("Failed to start bot", "error", err)
			os.Exit(1)
		}
	}

	// Build the notifier set BEFORE starting the bot listener so the
	// tzupdate.Service notifier-presence gate observes the populated slice
	// from the first incoming message onward.
	if tgBot != nil {
		notifiers = append(notifiers, notifier.NewTelegram(tgBot))
	}
	if wpService != nil {
		notifiers = append(notifiers, notifier.NewWebPush(wpService))
	}

	if tgBot != nil {
		go tgBot.Start()
		slog.Info("Bot started")
	}

	// 5. Server
	oidcConfig := server.OIDCConfig{}
	if os.Getenv("OIDC_ISSUER_URL") != "" || os.Getenv("OIDC_CLIENT_ID") != "" {
		// Use POCKET_ID credentials as fallback if OIDC credentials not set
		clientID := os.Getenv("OIDC_CLIENT_ID")
		clientSecret := os.Getenv("OIDC_CLIENT_SECRET")
		if clientID == "" && os.Getenv("POCKET_ID_CLIENT_ID") != "" {
			clientID = os.Getenv("POCKET_ID_CLIENT_ID")
			clientSecret = os.Getenv("POCKET_ID_CLIENT_SECRET")
			slog.Info("Using POCKET_ID credentials for OIDC web login")
		}

		issuerURL := os.Getenv("OIDC_ISSUER_URL")
		// If POCKET_ID_DOMAIN is set and issuer matches, use internal container URL for discovery
		if pocketDomain := os.Getenv("POCKET_ID_DOMAIN"); pocketDomain != "" && strings.Contains(issuerURL, pocketDomain) {
			// Use internal container URL for OIDC discovery to avoid Traefik/DNS issues
			issuerURL = "http://medtracker-pocket-id:1411"
			slog.Info("Using internal Pocket-ID URL for OIDC discovery", "issuerURL", issuerURL)
		}

		oidcConfig = server.OIDCConfig{
			Provider:       "oidc",
			IssuerURL:      issuerURL,
			AuthURL:        os.Getenv("OIDC_AUTH_URL"),
			TokenURL:       os.Getenv("OIDC_TOKEN_URL"),
			UserInfoURL:    os.Getenv("OIDC_USERINFO_URL"),
			ClientID:       clientID,
			ClientSecret:   clientSecret,
			RedirectURL:    os.Getenv("OIDC_REDIRECT_URL"),
			AdminEmail:     os.Getenv("OIDC_ADMIN_EMAIL"),
			AllowedSubject: os.Getenv("OIDC_ALLOWED_SUBJECT"),
			ButtonLabel:    os.Getenv("OIDC_BUTTON_LABEL"),
			ButtonColor:    os.Getenv("OIDC_BUTTON_COLOR"),
			ButtonText:     os.Getenv("OIDC_BUTTON_TEXT_COLOR"),
			Scopes:         parseOIDCScopes(os.Getenv("OIDC_SCOPES")),
		}
	} else if os.Getenv("GOOGLE_CLIENT_ID") != "" {
		// Only configure Google OAuth if credentials are actually provided
		oidcConfig = server.OIDCConfig{
			Provider:     "google",
			ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
			ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("GOOGLE_REDIRECT_URL"),
			AdminEmail:   os.Getenv("ADMIN_EMAIL"),
		}
	}

	// Get bot username for Telegram Login Widget
	var botUsername string
	if tgBot != nil {
		botUsername = tgBot.Username()
		slog.Info("Bot username", "username", botUsername)
	}

	srv := server.New(s, botToken, sessionSecret, allowedUserID, oidcConfig, botUsername, vapidPublicKey)

	if foodAI != nil {
		srv.SetFoodAIService(foodAI)
	}

	if mcpAuditSecret := os.Getenv("MCP_AUDIT_SECRET"); mcpAuditSecret != "" {
		srv.SetMCPAuditSecret(mcpAuditSecret)

		// The /internal/mcp/bridge endpoint that the Python executor proxies
		// through requires an operation registry; without it every bridge call
		// 503s. Register the same default catalog the MCP server exposes.
		reg := registry.New()
		if err := reg.Register(registry.DefaultOperations()...); err != nil {
			slog.Error("Failed to build MCP operation registry", "error", err)
			os.Exit(1)
		}
		srv.SetMCPRegistry(server.NewRegistryAdapter(reg))
	}

	// Wire the shared TZ-update service so both web and bot transports share
	// one mutex and one plan-generation path.
	srv.SetTZUpdater(tzUpdater)

	// Set workout interactor (only if bot is available)
	if tgBot != nil {
		srv.SetWorkoutInteractor(tgBot)
	}

	// `notifiers` is fully built before tgBot.Start() above so the tzupdate
	// service's closure observes the finalised set from the first incoming
	// message; share the same slice with the HTTP server and scheduler.
	srv.SetNotifiers(notifiers)

	// Always start scheduler (works with web push even without bot)
	sch := scheduler.New(s, allowedUserID, notifiers)
	sch.Start()
	if tgBot != nil {
		slog.Info("Scheduler started")
	} else {
		slog.Info("Scheduler started (web push only, no Telegram notifications)")
	}

	// Start Server
	serverAddr := ":" + port
	slog.Info("Server starting", "addr", serverAddr)
	srvHandler := srv.Routes()
	server := newHTTPServer(serverAddr, srvHandler)

	if err := server.ListenAndServe(); err != nil {
		slog.Error("Server failed", "error", err)
		os.Exit(1)
	}
}

func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      45 * time.Second, // Increased to support 30s OpenFoodFacts search
		MaxHeaderBytes:    1 << 20,          // 1MB max header bytes
	}
}

func parseOIDCScopes(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	var scopes []string
	for _, s := range fields {
		if s != "" {
			scopes = append(scopes, s)
		}
	}
	return scopes
}
