//go:build mobile

package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
	"github.com/korjavin/medicationtrackerbot/internal/config"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzupdate"
	"github.com/korjavin/medicationtrackerbot/internal/scheduler"
	"github.com/korjavin/medicationtrackerbot/internal/server"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
)

// main is the mobile-build entry point. It runs the same HTTP server as the
// server build, but skips bot init, MCP audit/bridge, web-push (VAPID), OIDC,
// and Telegram-only wiring. The auth boundary is the Capacitor wrapper; the
// HTTP server listens on localhost and trusts every request as the single
// configured local user.
//
// Configuration comes entirely from the settings table — there are no env vars
// for the mobile build. The first-run experience (settings populated via the
// Settings UI) is Phase 2 work; Phase 1 expects the DB to be pre-seeded or for
// the user to walk through the in-app Settings screen after first launch.
func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	var (
		dbPath = flag.String("db", "meds.db", "path to the SQLite database file")
		userID = flag.Int64("user-id", 1, "local user ID (single-user mobile install)")
		port   = flag.String("port", "8080", "HTTP listen port")
	)
	flag.Parse()

	// Guard against typos like -user-id 0 or -user-id -1 that would otherwise
	// silently write data with user_id=0, polluting the singleton DB.
	if *userID <= 0 {
		slog.Error("invalid -user-id; must be a positive int64", "user-id", *userID)
		os.Exit(1)
	}

	// Open the DB so migrations run, then load config purely from the
	// settings table. There is no env-var precedence on mobile.
	sharedDB, err := storedb.Open(*dbPath)
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
	slog.Info("Database initialized", "path", *dbPath)

	settingsCfg, err := config.LoadFromSettings(context.Background(), s.Settings)
	if err != nil {
		slog.Error("Failed to load settings-table config", "error", err)
		os.Exit(1)
	}
	cfg := settingsCfg

	// Food repo: wire the OpenFoodFacts remote credentials in case the user
	// configured them via the Settings UI.
	s.Food.SetRemoteConfig(food.RemoteConfig{
		APIKey: cfg.Food.APIKey,
		URL:    cfg.Food.URL,
		Domain: cfg.Food.Domain,
	})

	// AI clients: same wiring as server build but driven by settings rows.
	var foodAI domain.FoodAIService
	if cfg.OpenAI.APIKey != "" || cfg.OpenAI.URL != "" || cfg.OpenAI.Model != "" {
		aiClient := ai.NewClient(cfg.OpenAI.APIKey, cfg.OpenAI.URL, cfg.OpenAI.Model)
		visionClient := aiClient
		if cfg.OpenAI.VisionAPIKey != "" || cfg.OpenAI.VisionURL != "" || cfg.OpenAI.VisionModel != "" {
			visionClient = ai.NewClient(cfg.OpenAI.VisionAPIKey, cfg.OpenAI.VisionURL, cfg.OpenAI.VisionModel)
		}
		foodAI = domain.NewFoodAIServiceWithVision(aiClient, visionClient)
		slog.Info("AI food logging enabled")
	} else {
		slog.Info("AI food logging disabled (no OpenAI config in settings)")
	}

	// Shared TZ services. Plan-generation safety net is unchanged; on mobile
	// the notifier-presence gate always reports true because the
	// LocalNotificationSink is the delivery channel (no notifier.Notifier
	// slice is wired here). Plan generation runs unconditionally and the
	// scheduler materializes intakes regardless of any web-push wiring.
	tzPlannerStore := newTZPlannerStore(s)
	tzPlanner := tzreschedule.NewPlannerService(tzPlannerStore)
	tzLifecycle := tzreschedule.NewLifecycleService(s, *userID)
	tzUpdater := tzupdate.NewService(s.TZ, s.TZ, tzPlanner, nil, func() bool { return true })

	// Session secret: not security-meaningful on mobile (the local resolver
	// ignores cookies), but server.New validates len>=32. Use a deterministic
	// per-install token derived from the DB path; not used for any verification.
	const mobileSessionSecret = "mobile-build-local-session-secret-32+"

	srv := server.New(s, "", mobileSessionSecret, *userID, server.OIDCConfig{}, "", "")
	if foodAI != nil {
		srv.SetFoodAIService(foodAI)
	}
	srv.SetTZUpdater(tzUpdater)
	srv.SetTZLifecycle(tzLifecycle)
	srv.SetElevenLabsConfig(server.ElevenLabsConfig{
		APIKey:  cfg.ElevenLabs.APIKey,
		AgentID: cfg.ElevenLabs.AgentID,
	})

	// Scheduler with the local-notification sink. The Capacitor app polls
	// GET /api/reminders/upcoming and hands each entry to
	// @capacitor/local-notifications for native scheduling.
	sch := scheduler.New(s, *userID, scheduler.NewLocalNotificationSink(*userID))
	sch.Start()
	slog.Info("Scheduler started (mobile build, local-notifications sink)")

	addr := ":" + *port
	slog.Info("Mobile-mode server starting", "addr", addr, "user_id", *userID)
	httpServer := newHTTPServer(addr, srv.Routes())

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
		slog.Info("Shutdown signal received")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("Server.Shutdown returned error", "error", err)
		}
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Warn("httpServer.Shutdown returned error", "error", err)
		}
	}
}
