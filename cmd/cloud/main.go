// Command cloud is the zero-knowledge cloud service: accounts, WebAuthn
// passkey auth, DEK envelopes, and static shell hosting on per-user wildcard
// subdomains. See docs/cloud-mode.md for the design and
// docs/plans/2026-07-03-cloud-c0a-foundation-passkey-signup.md for the
// implementation plan this binary is being built against.
package main

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudserver"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	cloudweb "github.com/korjavin/medicationtrackerbot/web/cloud"
	domainweb "github.com/korjavin/medicationtrackerbot/web/domain"
	webstatic "github.com/korjavin/medicationtrackerbot/web/static"
)

// config is the env-driven configuration for cmd/cloud — no flags, per the
// bot binary's convention (cmd/bot/main_server.go).
type config struct {
	dbPath            string
	port              string
	baseDomain        string
	sessionSecret     string
	claimTTL          time.Duration
	accountQuotaBytes int64
	vapidSubject      string
	dryQueueWarnHours time.Duration
	foodDBURL         string
	foodDBAPIKey      string
	managerBotToken   string
	tgAPIBaseURL      string
	trial             cloudserver.TrialConfig
}

func loadConfig() (config, error) {
	cfg := config{
		dbPath:            os.Getenv("CLOUD_DB_PATH"),
		port:              os.Getenv("PORT"),
		baseDomain:        os.Getenv("CLOUD_BASE_DOMAIN"),
		claimTTL:          14 * 24 * time.Hour,
		accountQuotaBytes: 50 << 20, // 50MB
		vapidSubject:      os.Getenv("VAPID_SUBJECT"),
		dryQueueWarnHours: 120 * time.Hour,
		foodDBURL:         os.Getenv("CLOUD_FOOD_DB_URL"),
		foodDBAPIKey:      os.Getenv("CLOUD_FOOD_DB_API_KEY"),
		managerBotToken:   os.Getenv("MANAGER_BOT_TOKEN"),
		tgAPIBaseURL:      os.Getenv("CLOUD_TG_API_BASE_URL"),
	}
	if cfg.dbPath == "" {
		cfg.dbPath = "cloud.db"
	}
	if cfg.port == "" {
		cfg.port = "8080"
	}
	if cfg.baseDomain == "" {
		return cfg, errors.New("CLOUD_BASE_DOMAIN is required (e.g. app.example.com; use 'localhost' for local dev)")
	}
	if cfg.vapidSubject == "" {
		cfg.vapidSubject = "mailto:noreply@" + cfg.baseDomain
	}

	// Read but don't validate SESSION_SECRET here: the admin subcommands
	// (list/revoke/delete) never mint sessions, so main() validates it only on
	// the server path — after the admin dispatch — to keep ad-hoc operator use
	// from needing a real secret in env.
	cfg.sessionSecret = os.Getenv("SESSION_SECRET")

	if ttlDays := os.Getenv("CLOUD_CLAIM_TTL"); ttlDays != "" {
		days, err := strconv.Atoi(ttlDays)
		if err != nil || days <= 0 {
			return cfg, errors.New("CLOUD_CLAIM_TTL must be a positive integer number of days")
		}
		cfg.claimTTL = time.Duration(days) * 24 * time.Hour
	}

	if quota := os.Getenv("CLOUD_ACCOUNT_QUOTA_BYTES"); quota != "" {
		bytes, err := strconv.ParseInt(quota, 10, 64)
		if err != nil || bytes < 0 {
			return cfg, errors.New("CLOUD_ACCOUNT_QUOTA_BYTES must be a non-negative integer (0 disables the quota)")
		}
		cfg.accountQuotaBytes = bytes
	}

	trial, err := cloudserver.TrialConfigFromEnv()
	if err != nil {
		return cfg, err
	}
	cfg.trial = trial

	if warnHours := os.Getenv("CLOUD_DRY_QUEUE_WARN_HOURS"); warnHours != "" {
		hours, err := strconv.Atoi(warnHours)
		if err != nil || hours <= 0 {
			return cfg, errors.New("CLOUD_DRY_QUEUE_WARN_HOURS must be a positive integer number of hours")
		}
		cfg.dryQueueWarnHours = time.Duration(hours) * time.Hour
	}

	return cfg, nil
}

// validateSessionSecret mirrors the length + Shannon-entropy check in
// cmd/bot/main_server.go so operators get the same guardrail against a weak
// or accidentally-empty SESSION_SECRET.
func validateSessionSecret(secret string) error {
	if secret == "" || len(secret) < 32 {
		return errors.New("SESSION_SECRET is required and must be at least 32 characters long. Generate one with: openssl rand -base64 32")
	}

	var entropy float64
	charCounts := make(map[rune]int)
	for _, char := range secret {
		charCounts[char]++
	}
	length := float64(len(secret))
	for _, count := range charCounts {
		p := float64(count) / length
		entropy -= p * math.Log2(p)
	}
	if entropy < 3.5 {
		return errors.New("SESSION_SECRET has insufficient entropy (is too predictable). Generate a secure one with: openssl rand -base64 32")
	}
	return nil
}

// newHTTPServer mirrors cmd/bot/http_server.go's helper.
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadTimeout:       15 * time.Second, // comfortable for a ~2-3 MB gzip-compressed vault snapshot upload
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      45 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	cfg, err := loadConfig()
	if err != nil {
		slog.Error("Failed to load config", "error", err)
		os.Exit(1)
	}

	if len(os.Args) > 1 && os.Args[1] == "admin" {
		os.Exit(runAdmin(cfg, os.Args[2:]))
	}

	if err := validateSessionSecret(cfg.sessionSecret); err != nil {
		slog.Error("Failed to load config", "error", err)
		os.Exit(1)
	}

	sharedDB, err := storedb.Open(cfg.dbPath)
	if err != nil {
		slog.Error("Failed to open database", "error", err)
		os.Exit(1)
	}
	defer sharedDB.Close()

	store, err := cloudstore.New(sharedDB)
	if err != nil {
		slog.Error("Failed to initialize cloudstore", "error", err)
		os.Exit(1)
	}
	// Log the effective quota: "is the quota on?" was previously unanswerable
	// without reading the source, and a deployment with it off looks identical
	// to one with it on until a single account fills the disk (med-d5t.4).
	quotaDesc := "disabled"
	if cfg.accountQuotaBytes > 0 {
		quotaDesc = strconv.FormatInt(cfg.accountQuotaBytes, 10) + " bytes"
	}
	slog.Info("Database initialized", "path", cfg.dbPath, "baseDomain", cfg.baseDomain, "claimTTL", cfg.claimTTL, "accountQuota", quotaDesc)

	backfilled, err := cloudserver.BackfillVAPIDKeys(context.Background(), store)
	if err != nil {
		slog.Error("Failed to backfill VAPID keys", "error", err)
		os.Exit(1)
	}
	slog.Info("VAPID key backfill complete", "accountsBackfilled", backfilled)

	webauthnAPI := cloudserver.NewWebAuthnAPI(store, cfg.sessionSecret)
	envelopeAPI := cloudserver.NewEnvelopeAPI(store, cfg.sessionSecret)
	transferAPI := cloudserver.NewTransferAPI(store, cfg.sessionSecret)
	deviceAPI := cloudserver.NewDeviceAPI(store, cfg.sessionSecret)
	recoveryAPI := cloudserver.NewRecoveryAPI(store)
	inviteAPI := cloudserver.NewInviteAPI(store, cfg.sessionSecret, cfg.baseDomain, cfg.claimTTL)
	syncAPI := cloudserver.NewSyncAPI(store, cfg.sessionSecret, cfg.accountQuotaBytes)
	webPushSender := &cloudserver.WebPushSender{
		Subject:    cfg.vapidSubject,
		BaseDomain: cfg.baseDomain,
	}
	pushAPI := cloudserver.NewPushAPI(store, webPushSender, cfg.sessionSecret)
	mcpRelayAPI := cloudserver.NewMCPRelayAPI(store, cfg.sessionSecret)
	mcpRemoteAPI := cloudserver.NewMCPRemoteAPI(store, mcpRelayAPI, cfg.sessionSecret)
	mcpRemoteAPI.Restore(context.Background())
	trialProxyAPI := cloudserver.NewTrialProxyAPI(store, cfg.sessionSecret, cfg.trial)
	foodProxyAPI := cloudserver.NewFoodProxyAPI(store, cfg.sessionSecret, cfg.foodDBURL, cfg.foodDBAPIKey)
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	envelopeAPI.RegisterRoutes(apiMux)
	transferAPI.RegisterRoutes(apiMux)
	deviceAPI.RegisterRoutes(apiMux)
	recoveryAPI.RegisterRoutes(apiMux)
	inviteAPI.RegisterRoutes(apiMux)
	syncAPI.RegisterRoutes(apiMux)
	pushAPI.RegisterRoutes(apiMux)
	cloudserver.NewInboxAPI(store, cfg.sessionSecret).RegisterRoutes(apiMux)
	cloudserver.NewVitalsImportAPI(store, cfg.sessionSecret).RegisterRoutes(apiMux)
	mcpRelayAPI.RegisterRoutes(apiMux)
	mcpRemoteAPI.RegisterRoutes(apiMux)
	trialProxyAPI.RegisterRoutes(apiMux)
	foodProxyAPI.RegisterRoutes(apiMux)
	cloudserver.NewEgressAPI(store, cfg.sessionSecret).RegisterRoutes(apiMux)

	// Telegram is fully disabled unless a manager bot token is configured; the
	// wizard step simply doesn't render and no webhook routes are wired.
	var tgAPI *cloudserver.TelegramAPI
	if cfg.managerBotToken == "" {
		slog.Info("telegram disabled", "reason", "MANAGER_BOT_TOKEN unset")
	} else {
		tgAPI = cloudserver.NewTelegramAPI(store, cfg.sessionSecret, cfg.managerBotToken, cfg.baseDomain, cfg.tgAPIBaseURL, cfg.claimTTL)
		if err := tgAPI.Bootstrap(context.Background()); err != nil {
			// Bootstrap hits api.telegram.org (getMe + setWebhook). Telegram is
			// an optional, additive feature — a transient third-party outage at
			// startup must not brick unlock/sync/push for every account. Log and
			// leave Telegram disabled (no routes) instead of exiting.
			slog.Error("telegram manager bot bootstrap failed; disabling telegram", "error", err)
			tgAPI = nil
		} else {
			tgAPI.RegisterAPIRoutes(apiMux)
		}
	}

	// Self-service account deletion (med-d5t.8). Registered after tgAPI is
	// finalized so its teardown can tear down Telegram too. teardown composes the
	// external + in-memory cleanup a pure DB delete can't: closing MCP relay legs
	// (tier 1), disabling the hosted MCP client (tier 2), and deleting the
	// Telegram webhook. All best-effort — the DB delete is the source of truth.
	accountTeardown := func(ctx context.Context, accountID string) {
		mcpRelayAPI.RevokePairing(accountID)
		mcpRemoteAPI.TeardownForAccount(ctx, accountID)
		if tgAPI != nil {
			tgAPI.TeardownForAccount(ctx, accountID)
		}
	}
	cloudserver.NewAccountAPI(store, cfg.sessionSecret, webauthnAPI, accountTeardown).RegisterRoutes(apiMux)

	router := cloudserver.New(cfg.baseDomain, store, cloudweb.FS, webstatic.FS, domainweb.FS, apiMux, cfg.foodDBURL, cfg.trial.TrialAIConfigured(), cfg.trial.TrialVoiceConfigured())
	router.SetMCPHandler(mcpRemoteAPI.Endpoint())

	// A nil *TelegramAPI stored in a TelegramSender interface is NOT a nil
	// interface, so assign only when Telegram actually came up — otherwise the
	// relay would call SendReminder on a nil receiver.
	var tgSender cloudserver.TelegramSender
	if tgAPI != nil {
		tgSender = tgAPI
	}
	relay := cloudserver.NewRelay(store, webPushSender, tgSender, cfg.dryQueueWarnHours)

	mux := http.NewServeMux()
	// Liveness: "the process is running". Unconditional on purpose — the
	// orchestrator restarts on failure, and restarting will not fix a full disk.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	// Readiness: "this instance can actually serve". Reads the database, so a
	// locked, corrupt, or disk-full cloud.db stops reporting healthy (med-d5t.7).
	mux.HandleFunc("GET /readyz", cloudserver.ReadyzHandler(sharedDB, router.BuildID()))
	if tgAPI != nil {
		tgAPI.RegisterWebhookRoutes(mux)
	}
	mux.Handle("/", router)

	serverAddr := ":" + cfg.port
	slog.Info("Server starting", "addr", serverAddr)
	httpServer := newHTTPServer(serverAddr, mux)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go relay.Run(ctx)

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
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Warn("httpServer.Shutdown returned error", "error", err)
		}
	}
}
