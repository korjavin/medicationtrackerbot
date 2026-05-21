//go:build !mobile

package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
	"github.com/korjavin/medicationtrackerbot/internal/bot"
	"github.com/korjavin/medicationtrackerbot/internal/config"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzsuggestion"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzupdate"
	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/scheduler"
	"github.com/korjavin/medicationtrackerbot/internal/server"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
	"github.com/korjavin/medicationtrackerbot/internal/webpush"
)

// isTruthyEnv mirrors the accepted-value set of the server's parseBoolEnv
// (1/true/yes/y, case-insensitive). Duplicated here so the boot-time
// AUTH_TRUST_PROXY warning treats "AUTH_TRUST_PROXY=true" the same way the
// rate-limit middleware does — otherwise an operator who sets the truthy
// string would get a warning that contradicts the actual proxy-trust state.
func isTruthyEnv(key string) bool {
	val := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	return val == "1" || val == "true" || val == "yes" || val == "y"
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	// 1. Config
	cfg, err := config.LoadFromEnv()
	if err != nil {
		slog.Error("Failed to load config", "error", err)
		os.Exit(1)
	}

	dbPath := cfg.DBPath
	if dbPath == "" {
		dbPath = "meds.db"
	}

	botToken := cfg.TelegramBotToken
	if botToken == "" {
		slog.Info("TELEGRAM_BOT_TOKEN not set. Running in web-only mode.")
	}

	sessionSecret := cfg.SessionSecret
	// In demo mode the auth flow never reads a session cookie (DemoUserResolver
	// short-circuits before /auth/* handlers can sign one), so a SESSION_SECRET
	// from the operator is not required. The runbook in docs/demo-mode.md
	// deliberately omits it. Auto-generate a strong random secret so the
	// auth/oidc/telegram handlers (still registered on the mux) won't panic
	// or sign with a known value if a curious visitor pokes them.
	if cfg.DemoMode && sessionSecret == "" {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			slog.Error("DEMO_MODE: failed to generate ephemeral SESSION_SECRET", "error", err)
			os.Exit(1)
		}
		sessionSecret = base64.RawURLEncoding.EncodeToString(buf)
		slog.Warn("DEMO_MODE: SESSION_SECRET not set; generated an ephemeral random secret (session cookies will not survive restarts, which is fine because demo mode resolves every request via DemoUserResolver and ignores cookies)")
	}
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

	if os.Getenv("ALLOWED_USER_ID") == "" {
		slog.Info("ALLOWED_USER_ID is required for notifications.")
	}
	allowedUserID := cfg.AllowedUserID

	port := cfg.Port
	if port == "" {
		port = "8080"
	}

	// 2. Store. We open the shared *db.DB explicitly so it can be passed into
	// per-domain repositories as the internal/store package splits land
	// (docs/plans/2026-05-13-split-store-package.md).
	sharedDB, err := storedb.Open(dbPath)
	if err != nil {
		slog.Error("Failed to open database", "error", err)
		os.Exit(1)
	}
	defer sharedDB.Close()
	s, err := store.NewWithDB(sharedDB)
	if err != nil {
		slog.Error("Failed to initialize store", "error", err)
		os.Exit(1)
	}
	slog.Info("Database initialized", "path", dbPath)

	// Merge the settings-table view of the user-configurable subset (OpenAI,
	// Food, ElevenLabs) into the env-derived config. Env wins per-field; for
	// keys an operator left unset, the settings table value is used. On a
	// fresh DB every settings column defaults to '' so this is a no-op for
	// server installs that already set everything in env.
	settingsCfg, err := config.LoadFromSettings(context.Background(), s.Settings)
	if err != nil {
		slog.Error("Failed to load settings-table config", "error", err)
		os.Exit(1)
	}
	cfg = config.Merge(cfg, settingsCfg)

	// Wire the remote food-DB config into the food repo so SearchRemoteAPI
	// no longer reads os.Getenv at request time.
	s.Food.SetRemoteConfig(food.RemoteConfig{
		APIKey: cfg.Food.APIKey,
		URL:    cfg.Food.URL,
		Domain: cfg.Food.Domain,
	})

	// 2.5 OpenAI Client
	openAIApiKey := cfg.OpenAI.APIKey
	openAIURL := cfg.OpenAI.URL
	openAIModel := cfg.OpenAI.Model

	// Optional split-provider configuration for vision (food photo parsing).
	// When the primary provider is text-only (e.g. DeepSeek), set these to
	// route ParseMealFromImage to a vision-capable model. Each var falls back
	// to its OPENAI_* counterpart when unset.
	visionApiKey := cfg.OpenAI.VisionAPIKey
	visionURL := cfg.OpenAI.VisionURL
	visionModel := cfg.OpenAI.VisionModel
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
	vapidPublicKey := cfg.VAPID.PublicKey
	vapidPrivateKey := cfg.VAPID.PrivateKey
	vapidSubject := cfg.VAPID.Subject
	vapidAdminEmail := cfg.VAPID.AdminEmail
	vapidDomain := cfg.VAPID.Domain

	var wpService *webpush.Service
	if vapidPublicKey != "" && vapidPrivateKey != "" {
		wpService = webpush.New(s.Push, vapidPublicKey, vapidPrivateKey, vapidSubject, vapidAdminEmail, vapidDomain)
	}

	// 4. Bot
	// Construct the shared TZ-update service before the bot and the server so
	// both transports serialize timezone changes through one mutex and apply
	// the same plan-generation safety net. The notifier slice is built below
	// before tgBot.Start() so the closure passed to tzupdate.NewService
	// always observes the finalised set — otherwise a queued /tz + location
	// arriving during startup could race past an empty notifier slice and
	// skip plan generation.
	tzPlannerStore := newTZPlannerStore(s)
	tzPlanner := tzreschedule.NewPlannerService(tzPlannerStore)
	// Lifecycle service: shared by every transport that flips a plan to
	// APPROVED (HTTP /api/tz-plan/{id}/approve, the bot's tz_plan_approve
	// callback, and the scheduler's auto-approve safety nets) so the plan
	// transition and the pre-materialize step inserts always share one
	// transaction. See Track D Task 10 in
	// docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md.
	tzLifecycle := tzreschedule.NewLifecycleService(s, allowedUserID)
	var notifiers []notifier.Notifier
	tzUpdater := tzupdate.NewService(s.TZ, s.TZ, tzPlanner, nil, func() bool { return len(notifiers) > 0 })
	// Construct the TZ-suggestion decision service alongside the tz updater so
	// /api/tz-suggestion/dismiss and the bootstrap dismissal hint share the
	// canonical store + active-plan baseline rather than the placeholder
	// constructed inside server.New. The bot's `/tz` flow is unchanged — it
	// stays an explicit user-initiated path that bypasses the suggester.
	tzSuggester := tzsuggestion.NewService(newTZSuggestionSettings(s), tzPlannerStore)

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
		go tgBot.Start(context.Background())
		slog.Info("Bot started")
	}

	// 5. Server
	if cfg.OIDC.Provider == "oidc" {
		if os.Getenv("OIDC_CLIENT_ID") == "" && os.Getenv("POCKET_ID_CLIENT_ID") != "" {
			slog.Info("Using POCKET_ID credentials for OIDC web login")
		}
		if pocketDomain := os.Getenv("POCKET_ID_DOMAIN"); pocketDomain != "" && cfg.OIDC.IssuerURL == "http://medtracker-pocket-id:1411" {
			slog.Info("Using internal Pocket-ID URL for OIDC discovery", "issuerURL", cfg.OIDC.IssuerURL)
		}
	}
	oidcConfig := server.OIDCConfig{
		Provider:       cfg.OIDC.Provider,
		IssuerURL:      cfg.OIDC.IssuerURL,
		AuthURL:        cfg.OIDC.AuthURL,
		TokenURL:       cfg.OIDC.TokenURL,
		UserInfoURL:    cfg.OIDC.UserInfoURL,
		ClientID:       cfg.OIDC.ClientID,
		ClientSecret:   cfg.OIDC.ClientSecret,
		RedirectURL:    cfg.OIDC.RedirectURL,
		AdminEmail:     cfg.OIDC.AdminEmail,
		AllowedSubject: cfg.OIDC.AllowedSubject,
		ButtonLabel:    cfg.OIDC.ButtonLabel,
		ButtonColor:    cfg.OIDC.ButtonColor,
		ButtonText:     cfg.OIDC.ButtonText,
		Scopes:         cfg.OIDC.Scopes,
	}

	// Get bot username for Telegram Login Widget
	var botUsername string
	if tgBot != nil {
		botUsername = tgBot.Username()
		slog.Info("Bot username", "username", botUsername)
	}

	srv := server.New(s, botToken, sessionSecret, allowedUserID, oidcConfig, botUsername, vapidPublicKey)

	// Flip demo mode before Routes() so AuthMiddleware sees the demo resolver
	// at construction time. Warn loudly — a misconfigured DEMO_MODE on a real
	// deployment would silently disable auth, so the operator should see this
	// as the first thing in the container log.
	if cfg.DemoMode {
		// The demo resolver returns auth.User{ID: allowedUserID, ...} on every
		// request — if ALLOWED_USER_ID is unset the resolver hands handlers
		// user id 0, which no cmd/seeddemo invocation maps to, and the app
		// silently renders empty data. Fail fast so the misconfiguration is
		// obvious at boot, mirroring the strict check in
		// internal/mcp/mcp.LoadConfigFromEnv for the MCP entrypoint.
		if cfg.AllowedUserID == 0 {
			slog.Error("DEMO_MODE=1 requires ALLOWED_USER_ID to be set (must match the user passed to cmd/seeddemo)")
			os.Exit(1)
		}
		// Per-IP rate limiters key on clientIP(r, trustProxy). Behind a
		// reverse proxy without AUTH_TRUST_PROXY=1, every visitor presents
		// the proxy's IP and the limiters become a single shared bucket —
		// one visitor exhausts the daily budget for everyone. Warn loudly
		// so a typical Traefik-fronted deploy doesn't ship in this state.
		// Mirror the same accepted-value set as the server's parseBoolEnv
		// (1/true/yes/y, case-insensitive) so an operator who sets
		// AUTH_TRUST_PROXY=true doesn't get a contradictory warning while
		// the limiter is actually trusting the proxy.
		if !isTruthyEnv("AUTH_TRUST_PROXY") {
			slog.Warn("DEMO_MODE=1 without AUTH_TRUST_PROXY=1: per-IP rate limiters will see the reverse-proxy IP for every visitor and become a single shared bucket. Set AUTH_TRUST_PROXY=1 if you run behind Traefik/Nginx/Caddy.")
		}
		slog.Warn("DEMO_MODE is enabled — auth is disabled and AI endpoints are rate-limited per IP")
		srv.SetDemoMode(true)
		srv.SetDemoConfig(server.DemoConfig{
			AgentCallsPerDay:        cfg.Demo.AgentCallsPerDay,
			AgentUploadsPerDay:      cfg.Demo.AgentUploadsPerDay,
			FoodLogsPerHour:         cfg.Demo.FoodLogsPerHour,
			FoodPhotosPerHour:       cfg.Demo.FoodPhotosPerHour,
			FoodDescriptionsPerHour: cfg.Demo.FoodDescriptionsPerHour,
			MCPExecutePerHour:       cfg.Demo.MCPExecuteCallsPerHour,
		})
	}

	// Inject ElevenLabs creds so the Voice Agent handlers stop calling
	// os.Getenv at request time — they now read the same struct that the
	// mobile build will populate from the settings table.
	srv.SetElevenLabsConfig(server.ElevenLabsConfig{
		APIKey:  cfg.ElevenLabs.APIKey,
		AgentID: cfg.ElevenLabs.AgentID,
	})

	// External-workout webhook key flows through the typed config just like
	// the other integration credentials. server.New() still reads the env var
	// as a backward-compatible default so existing tests and any caller that
	// skips this setter keep working.
	if cfg.ExternalWorkoutAPIKey != "" {
		srv.SetExternalAPIKey(cfg.ExternalWorkoutAPIKey)
	}

	if foodAI != nil {
		srv.SetFoodAIService(foodAI)
	}

	if mcpAuditSecret := cfg.MCP.AuditSecret; mcpAuditSecret != "" {
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

	// Wire the shared TZ-lifecycle service so HTTP, bot, and scheduler approve
	// paths flip plans through one ApproveAndMaterialize tx.
	srv.SetTZLifecycle(tzLifecycle)
	if tgBot != nil {
		tgBot.SetTZLifecycle(tzLifecycle)
	}

	// Wire the TZ-suggestion service so the HTTP server's dismiss endpoint
	// and bootstrap consult the canonical settings + active-plan baseline.
	srv.SetTZSuggester(tzSuggester)

	// Set workout interactor (only if bot is available)
	if tgBot != nil {
		srv.SetWorkoutInteractor(tgBot)
	}

	// `notifiers` is fully built before tgBot.Start() above so the tzupdate
	// service's closure observes the finalised set from the first incoming
	// message; share the same slice with the HTTP server and scheduler.
	srv.SetNotifiers(notifiers)

	// Always start scheduler (works with web push even without bot)
	sch := scheduler.NewWithNotifiers(s, allowedUserID, notifiers)
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
	httpServer := newHTTPServer(serverAddr, srvHandler)

	// Trap SIGINT / SIGTERM so we can close broker subscribers (SSE handlers
	// see ch close and exit cleanly) BEFORE the listener stops accepting. This
	// is what keeps the deploy-time RST_STREAM noise bounded to a single clean
	// onerror per client instead of a hard TCP reset.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	listenErr := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
		}
		close(listenErr)
	}()

	select {
	case err, ok := <-listenErr:
		if ok && err != nil {
			slog.Error("Server failed", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		slog.Info("Shutdown signal received, draining connections")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// Close broker subs first so SSE handlers exit cleanly while the
		// listener is still up to drain non-streaming requests.
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("Server.Shutdown returned error", "error", err)
		}
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Warn("httpServer.Shutdown returned error", "error", err)
		}
	}
}


