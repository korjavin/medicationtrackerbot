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

	// Food repo: wire the OpenFoodFacts remote credentials in case the user
	// configured them via the Settings UI.
	s.Food.SetRemoteConfig(food.RemoteConfig{
		APIKey: cfg.Food.APIKey,
		URL:    cfg.Food.URL,
		Domain: cfg.Food.Domain,
	})

	// AI clients: same wiring as server build but driven by settings rows.
	// Each Vision* field falls back to its OpenAI* counterpart when unset, so
	// a partial override (e.g. only vision_model) doesn't strand the vision
	// client with an empty API key / URL.
	var foodAI domain.FoodAIService
	if cfg.OpenAI.APIKey != "" || cfg.OpenAI.URL != "" || cfg.OpenAI.Model != "" {
		aiClient := ai.NewClient(cfg.OpenAI.APIKey, cfg.OpenAI.URL, cfg.OpenAI.Model)
		visionClient := aiClient
		visionConfigured := cfg.OpenAI.VisionAPIKey != "" || cfg.OpenAI.VisionURL != "" || cfg.OpenAI.VisionModel != ""
		if visionConfigured {
			visionAPIKey := cfg.OpenAI.VisionAPIKey
			if visionAPIKey == "" {
				visionAPIKey = cfg.OpenAI.APIKey
			}
			visionURL := cfg.OpenAI.VisionURL
			if visionURL == "" {
				visionURL = cfg.OpenAI.URL
			}
			visionModel := cfg.OpenAI.VisionModel
			if visionModel == "" {
				visionModel = cfg.OpenAI.Model
			}
			visionClient = ai.NewClient(visionAPIKey, visionURL, visionModel)
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
