//go:build mobile

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/ai"
	"github.com/korjavin/medicationtrackerbot/internal/config"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	gamificationsvc "github.com/korjavin/medicationtrackerbot/internal/domain/gamification"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
	"github.com/korjavin/medicationtrackerbot/internal/domain/tzupdate"
	"github.com/korjavin/medicationtrackerbot/internal/scheduler"
	"github.com/korjavin/medicationtrackerbot/internal/server"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
	"github.com/korjavin/medicationtrackerbot/web"
)

// main is the mobile-build entry point. It runs the same HTTP server as the
// server build, but skips bot init, MCP audit/bridge, web-push (VAPID), OIDC,
// and Telegram-only wiring. The auth boundary is the Capacitor wrapper; the
// HTTP server listens on localhost and trusts every request as the single
// configured local user.
//
// Configuration comes entirely from the settings table — there are no env vars
// for the mobile build. On a fresh install the bootstrap response sets
// needs_first_run=true and the frontend's web/static/js/features/firstrun/
// overlay walks the user through welcome → permissions → integrations → done;
// completion is recorded via POST /api/firstrun/complete (see
// docs/plans/2026-05-23-mobile-phase2c-firstrun-secrets.md and the "First-run
// Settings flow" subsection of docs/local-mode.md).
//
// On startup the binary prints exactly one line to stdout in the form
// "LISTENING 127.0.0.1:<port>\n" once the TCP listener is bound. The Android
// shell parses this line to discover the OS-assigned port when invoked with
// `-port 0`. All other logging continues to go to stderr via slog.
func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := runMobile(ctx, os.Args[1:], os.Stdout); err != nil {
		slog.Error("mobile run failed", "error", err)
		os.Exit(1)
	}
}

// runMobile is the testable body of main(): it parses argv from a caller-owned
// slice, prints the LISTENING line to the supplied writer, and serves HTTP
// until ctx is cancelled. Splitting it out lets the integration test drive a
// real listener + a real HTTP roundtrip without forking a subprocess.
func runMobile(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("medtracker-mobile", flag.ContinueOnError)
	dbPath := fs.String("db", "meds.db", "path to the SQLite database file")
	userID := fs.Int64("user-id", 1, "local user ID (single-user mobile install)")
	port := fs.String("port", "8080", "HTTP listen port; pass 0 to let the OS assign one")
	// Default to loopback so the LAN can't reach an API that trusts every
	// request as the local user. Override to "0.0.0.0" (or a specific
	// interface) only for on-device Capacitor spike testing where the
	// device WebView talks to a dev machine on the same network.
	host := fs.String("host", "127.0.0.1", "HTTP listen host (loopback by default; override only for spike testing)")
	// Per-install session secret. The local resolver ignores cookies so this
	// is not security-meaningful, but server.New still validates len>=32.
	// Falls back to a fixed constant when not supplied (e.g. from the test
	// suite). The Android shell generates 32 random bytes on first launch
	// and persists them via EncryptedSharedPreferences.
	sessionSecret := fs.String("session-secret", "mobile-build-local-session-secret-32+", "session secret (>=32 chars); the Android shell injects a per-install random value")
	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("parse flags: %w", err)
	}

	// Guard against typos like -user-id 0 or -user-id -1 that would otherwise
	// silently write data with user_id=0, polluting the singleton DB.
	if *userID <= 0 {
		return fmt.Errorf("invalid -user-id %d; must be a positive int64", *userID)
	}

	// Open the DB so migrations run, then load config purely from the
	// settings table. There is no env-var precedence on mobile.
	sharedDB, err := storedb.Open(*dbPath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer sharedDB.Close()

	s, err := store.NewWithDB(sharedDB)
	if err != nil {
		return fmt.Errorf("initialize store: %w", err)
	}
	slog.Info("Database initialized", "path", *dbPath)

	settingsCfg, err := config.LoadFromSettings(context.Background(), s.Settings)
	if err != nil {
		return fmt.Errorf("load settings-table config: %w", err)
	}
	cfg := settingsCfg

	// Shared TZ services. Plan-generation safety net is unchanged; on mobile
	// the notifier-presence gate always reports true because the
	// LocalNotificationSink is the delivery channel (no notifier.Notifier
	// slice is wired here). Plan generation runs unconditionally and the
	// scheduler materializes intakes regardless of any web-push wiring.
	tzPlannerStore := newTZPlannerStore(s)
	tzPlanner := tzreschedule.NewPlannerService(tzPlannerStore)
	tzLifecycle := tzreschedule.NewLifecycleService(s, *userID)
	tzUpdater := tzupdate.NewService(s.TZ, s.TZ, tzPlanner, nil, func() bool { return true })

	if len(*sessionSecret) < 32 {
		return fmt.Errorf("session-secret must be at least 32 chars, got %d", len(*sessionSecret))
	}

	gamSvc := gamificationsvc.New(s.Medication, s.BP, s.Weight, s.Vitals, s.Food, s.Diary, s.Workout, s.Gamification, s.Settings, s.TZ)
	srv := server.New(s, gamSvc, "", *sessionSecret, *userID, server.OIDCConfig{}, "", "")
	// On Android the binary runs from a read-only nativeLibraryDir with no
	// co-located "./web/static" directory, so the disk-relative paths in
	// internal/server would 500 every request to /, /static/*, /favicon.ico,
	// and the service worker. Wire the embedded FS so those handlers read
	// from the binary itself.
	srv.SetStaticFS(web.StaticFS())
	srv.SetTZUpdater(tzUpdater)
	srv.SetTZLifecycle(tzLifecycle)

	// applyIntegrations rewires the food remote config, ElevenLabs config,
	// and AI food client from the supplied config. Called once at startup
	// and again from the integrations-reload callback after the user PATCHes
	// /api/settings/integrations through the firstrun overlay (or Settings
	// UI). Without this hot path the user enters a key, completes firstrun,
	// and hits 503 on the very next AI request until the app is force-stopped
	// and relaunched.
	applyIntegrations := func(c *config.Config) {
		s.Food.SetRemoteConfig(food.RemoteConfig{
			APIKey: c.Food.APIKey,
			URL:    c.Food.URL,
			Domain: c.Food.Domain,
		})
		srv.SetElevenLabsConfig(server.ElevenLabsConfig{
			APIKey:  c.ElevenLabs.APIKey,
			AgentID: c.ElevenLabs.AgentID,
		})
		// AI clients: each Vision* field falls back to its OpenAI* counterpart
		// when unset, so a partial override (e.g. only vision_model) doesn't
		// strand the vision client with an empty API key / URL.
		var foodAI domain.FoodAIService
		if c.OpenAI.APIKey != "" || c.OpenAI.URL != "" || c.OpenAI.Model != "" {
			aiClient := ai.NewClient(c.OpenAI.APIKey, c.OpenAI.URL, c.OpenAI.Model)
			visionClient := aiClient
			visionConfigured := c.OpenAI.VisionAPIKey != "" || c.OpenAI.VisionURL != "" || c.OpenAI.VisionModel != ""
			if visionConfigured {
				visionAPIKey := c.OpenAI.VisionAPIKey
				if visionAPIKey == "" {
					visionAPIKey = c.OpenAI.APIKey
				}
				visionURL := c.OpenAI.VisionURL
				if visionURL == "" {
					visionURL = c.OpenAI.URL
				}
				visionModel := c.OpenAI.VisionModel
				if visionModel == "" {
					visionModel = c.OpenAI.Model
				}
				visionClient = ai.NewClient(visionAPIKey, visionURL, visionModel)
			}
			foodAI = domain.NewFoodAIServiceWithVision(aiClient, visionClient)
		}
		srv.SetFoodAIService(foodAI)
	}

	applyIntegrations(cfg)
	if cfg.OpenAI.APIKey != "" || cfg.OpenAI.URL != "" || cfg.OpenAI.Model != "" {
		slog.Info("AI food logging enabled")
	} else {
		slog.Info("AI food logging disabled (no OpenAI config in settings)")
	}

	// Register the hot-reload callback so the firstrun overlay's integrations
	// PATCH makes the new key live without a restart. Re-reads settings (not
	// env — mobile has no env precedence) and runs the same wiring.
	srv.SetIntegrationsReloader(func(ctx context.Context) error {
		reloaded, err := config.LoadFromSettings(ctx, s.Settings)
		if err != nil {
			return fmt.Errorf("reload settings: %w", err)
		}
		applyIntegrations(reloaded)
		slog.Info("integrations hot-reloaded after settings PATCH")
		return nil
	})

	// Scheduler with the local-notification sink. The Capacitor app polls
	// GET /api/reminders/upcoming and hands each entry to
	// @capacitor/local-notifications for native scheduling.
	sch := scheduler.New(s, *userID, scheduler.NewLocalNotificationSink(*userID))
	sch.Start()
	slog.Info("Scheduler started (mobile build, local-notifications sink)")

	// Wrap the server's mux with a tiny outer mux that adds the unauthenticated
	// /healthz liveness probe. The Android shell polls this endpoint after
	// spawning the binary to decide when to load the WebView URL. /healthz is
	// mobile-only — adding it to the shared server.Routes would force a new
	// entry in mcpCoverageExempt for the server build too.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/", srv.Routes())

	addr := *host + ":" + *port
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}
	actualAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		return fmt.Errorf("unexpected listener address type %T", ln.Addr())
	}
	// Print the LISTENING line to stdout (NOT stderr) on its own line so the
	// Android shell can grep stdout's first line for the actual port without
	// being tripped up by slog records. The hostname is intentionally
	// hardcoded to 127.0.0.1 even when *host differs — the parser only cares
	// about the port, and quoting the dial-target keeps the line stable.
	if _, err := fmt.Fprintf(stdout, "LISTENING 127.0.0.1:%d\n", actualAddr.Port); err != nil {
		_ = ln.Close()
		return fmt.Errorf("write LISTENING line: %w", err)
	}
	slog.Info("Mobile-mode server starting", "addr", ln.Addr().String(), "user_id", *userID)

	httpServer := newHTTPServer(addr, mux)

	listenErr := make(chan error, 1)
	go func() {
		if err := httpServer.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
		}
		close(listenErr)
	}()

	select {
	case err, ok := <-listenErr:
		if ok && err != nil {
			return fmt.Errorf("server serve: %w", err)
		}
		return nil
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
		return nil
	}
}
