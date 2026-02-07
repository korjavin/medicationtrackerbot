package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/bot"
	"github.com/korjavin/medicationtrackerbot/internal/scheduler"
	"github.com/korjavin/medicationtrackerbot/internal/server"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func main() {
	// 1. Config
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "meds.db"
	}

	botToken := os.Getenv("TELEGRAM_BOT_TOKEN")
	if botToken == "" {
		log.Println("TELEGRAM_BOT_TOKEN is required. Bot functionality will fail.")
		// In local dev sometimes we might want to skip if only testing web
	}

	sessionSecret := os.Getenv("SESSION_SECRET")
	if sessionSecret == "" {
		log.Fatal("SESSION_SECRET is required. Generate one with: openssl rand -base64 32")
	}

	userIDStr := os.Getenv("ALLOWED_USER_ID")
	if userIDStr == "" {
		log.Println("ALLOWED_USER_ID is required for notifications.")
	}
	allowedUserID, _ := strconv.ParseInt(userIDStr, 10, 64)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// 2. Store
	s, err := store.New(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize store: %v", err)
	}
	defer s.Close()
	log.Println("Database initialized at", dbPath)

	// 3. Bot
	var tgBot *bot.Bot
	if botToken != "" {
		tgBot, err = bot.New(botToken, allowedUserID, s)
		if err != nil {
			log.Fatalf("Failed to start bot: %v", err)
		}

		// Start Bot Listener
		go tgBot.Start()
		log.Println("Bot started")
	}

	// 4. Scheduler
	// 4. Scheduler
	// Only start scheduler if bot is active (required for notifications)
	// But we now have Web Push which *could* work without bot, but
	// scheduler currently depends heavily on bot.
	// We'll pass server's WebPush service to scheduler later or
	// we initialize WebPush service independently?
	// The plan was: Server initializes WebPush. Scheduler uses Server's instance?
	// Or we initialize WebPush here and pass to both.

	// Better: Initialize WebPush here if config present.
	// But Server.New initializes it inside.

	// Let's grab the config first.
	vapidConfig := server.VAPIDConfig{
		PublicKey:  os.Getenv("VAPID_PUBLIC_KEY"),
		PrivateKey: os.Getenv("VAPID_PRIVATE_KEY"),
		Subject:    os.Getenv("VAPID_SUBJECT"),
	}

	// 5. Server (Initialize first to get WebPush service)
	oidcConfig := server.OIDCConfig{}
	if os.Getenv("OIDC_ISSUER_URL") != "" || os.Getenv("OIDC_CLIENT_ID") != "" {
		// Use POCKET_ID credentials as fallback if OIDC credentials not set
		clientID := os.Getenv("OIDC_CLIENT_ID")
		clientSecret := os.Getenv("OIDC_CLIENT_SECRET")
		if clientID == "" && os.Getenv("POCKET_ID_CLIENT_ID") != "" {
			clientID = os.Getenv("POCKET_ID_CLIENT_ID")
			clientSecret = os.Getenv("POCKET_ID_CLIENT_SECRET")
			log.Println("Using POCKET_ID credentials for OIDC web login")
		}

		issuerURL := os.Getenv("OIDC_ISSUER_URL")
		// If POCKET_ID_DOMAIN is set and issuer matches, use internal container URL for discovery
		if pocketDomain := os.Getenv("POCKET_ID_DOMAIN"); pocketDomain != "" && strings.Contains(issuerURL, pocketDomain) {
			// Use internal container URL for OIDC discovery to avoid Traefik/DNS issues
			issuerURL = "http://medtracker-pocket-id:1411"
			log.Printf("Using internal Pocket-ID URL for OIDC discovery: %s", issuerURL)
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
		log.Println("Bot username:", botUsername)
	}

	srv := server.New(s, tgBot, botToken, sessionSecret, allowedUserID, oidcConfig, botUsername, vapidConfig)

	if tgBot != nil {
		// Scheduler needs WebPush service from server
		sch := scheduler.New(s, tgBot, allowedUserID, srv.GetWebPushService())
		sch.Start()
		log.Println("Scheduler started")
	}

	// Start Server
	serverAddr := ":" + port
	log.Printf("Server starting on %s", serverAddr)
	srvHandler := srv.Routes()

	server := &http.Server{
		Addr:         serverAddr,
		Handler:      srvHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
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
