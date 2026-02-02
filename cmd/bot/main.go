package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/bot"
	"github.com/korjavin/medicationtrackerbot/internal/notification"
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

	// 3. Create action handler (needed by both bot and server)
	actionHandler := notification.NewActionHandler(s)

	// 4. Bot
	var tgBot *bot.Bot
	if botToken != "" {
		tgBot, err = bot.New(botToken, allowedUserID, s, actionHandler)
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
	oidcConfig := server.OIDCConfig{
		ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		RedirectURL:  os.Getenv("GOOGLE_REDIRECT_URL"),
		AdminEmail:   os.Getenv("ADMIN_EMAIL"),
	}

	// Get bot username for Telegram Login Widget
	var botUsername string
	if tgBot != nil {
		botUsername = tgBot.Username()
		log.Println("Bot username:", botUsername)
	}

	srv := server.New(s, tgBot, botToken, allowedUserID, oidcConfig, botUsername, vapidConfig, actionHandler)

	// Create notification service and register providers
	notifService := notification.NewService(s)

	if tgBot != nil {
		telegramProvider := notification.NewTelegramProvider(tgBot)
		notifService.RegisterProvider(telegramProvider)
		log.Println("Registered Telegram notification provider")
	}

	webPushService := srv.GetWebPushService()
	if webPushService != nil {
		webPushProvider := notification.NewWebPushProvider(webPushService)
		notifService.RegisterProvider(webPushProvider)
		log.Println("Registered Web Push notification provider")
	}

	// Initialize default notification settings for the allowed user
	// This ensures the user has settings even if they haven't been through migration yet
	if allowedUserID > 0 {
		for _, notifType := range []string{"medication", "workout", "low_stock"} {
			if tgBot != nil {
				s.UpdateNotificationSetting(allowedUserID, "telegram", notifType, true)
			}
			if webPushService != nil {
				s.UpdateNotificationSetting(allowedUserID, "web_push", notifType, true)
			}
		}
		log.Println("Initialized notification settings for user", allowedUserID)
	}

	if tgBot != nil || webPushService != nil {
		// Start scheduler with notification service
		sch := scheduler.New(s, notifService, allowedUserID)
		sch.Start()
		log.Println("Scheduler started with notification service")
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
