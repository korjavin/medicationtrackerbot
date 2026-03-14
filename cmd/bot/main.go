package main

import (
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/bot"
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
	if sessionSecret == "" {
		slog.Error("SESSION_SECRET is required. Generate one with: openssl rand -base64 32")
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

	// 3. Bot
	var tgBot *bot.Bot
	if botToken != "" {
		tgBot, err = bot.New(botToken, allowedUserID, s)
		if err != nil {
			slog.Error("Failed to start bot", "error", err)
			os.Exit(1)
		}

		// Start Bot Listener
		go tgBot.Start()
		slog.Info("Bot started")
	}

	// 4. VAPID config for Web Push
	vapidPublicKey := os.Getenv("VAPID_PUBLIC_KEY")
	vapidPrivateKey := os.Getenv("VAPID_PRIVATE_KEY")
	vapidSubject := os.Getenv("VAPID_SUBJECT")
	vapidAdminEmail := os.Getenv("ADMIN_EMAIL")
	vapidDomain := os.Getenv("DOMAIN")
	if vapidDomain == "" {
		vapidDomain = os.Getenv("APP_DOMAIN")
	}

	// Create WebPush service (before server, so we can build notifiers independently)
	var wpService *webpush.Service
	if vapidPublicKey != "" && vapidPrivateKey != "" {
		wpService = webpush.New(s, vapidPublicKey, vapidPrivateKey, vapidSubject, vapidAdminEmail, vapidDomain)
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

	if mcpAuditSecret := os.Getenv("MCP_AUDIT_SECRET"); mcpAuditSecret != "" {
		srv.SetMCPAuditSecret(mcpAuditSecret)
	}

	// Set workout interactor (only if bot is available)
	if tgBot != nil {
		srv.SetWorkoutInteractor(tgBot)
	}

	// Build notifiers slice (shared between server and scheduler)
	var notifiers []notifier.Notifier
	if tgBot != nil {
		notifiers = append(notifiers, notifier.NewTelegram(tgBot))
	}
	if wpService != nil {
		notifiers = append(notifiers, notifier.NewWebPush(wpService))
	}
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

	server := &http.Server{
		Addr:              serverAddr,
		Handler:           srvHandler,
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      45 * time.Second, // Increased to support 30s OpenFoodFacts search
		MaxHeaderBytes:    1 << 20,          // 1MB max header bytes
	}

	if err := server.ListenAndServe(); err != nil {
		slog.Error("Server failed", "error", err)
		os.Exit(1)
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
