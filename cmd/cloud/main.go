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
	vapidPublicKey    string
	vapidPrivateKey   string
	vapidSubject      string
}

func loadConfig() (config, error) {
	cfg := config{
		dbPath:            os.Getenv("CLOUD_DB_PATH"),
		port:              os.Getenv("PORT"),
		baseDomain:        os.Getenv("CLOUD_BASE_DOMAIN"),
		claimTTL:          14 * 24 * time.Hour,
		accountQuotaBytes: 50 << 20, // 50MB
		vapidPublicKey:    os.Getenv("VAPID_PUBLIC_KEY"),
		vapidPrivateKey:   os.Getenv("VAPID_PRIVATE_KEY"),
		vapidSubject:      os.Getenv("VAPID_SUBJECT"),
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
		ReadTimeout:       15 * time.Second,
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
	slog.Info("Database initialized", "path", cfg.dbPath, "baseDomain", cfg.baseDomain, "claimTTL", cfg.claimTTL)

	webauthnAPI := cloudserver.NewWebAuthnAPI(store, cfg.sessionSecret)
	envelopeAPI := cloudserver.NewEnvelopeAPI(store, cfg.sessionSecret)
	transferAPI := cloudserver.NewTransferAPI(store, cfg.sessionSecret)
	deviceAPI := cloudserver.NewDeviceAPI(store, cfg.sessionSecret)
	recoveryAPI := cloudserver.NewRecoveryAPI(store)
	syncAPI := cloudserver.NewSyncAPI(store, cfg.sessionSecret, cfg.accountQuotaBytes)
	pushAPI := cloudserver.NewPushAPI(store, cfg.sessionSecret, cfg.vapidPublicKey)
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	envelopeAPI.RegisterRoutes(apiMux)
	transferAPI.RegisterRoutes(apiMux)
	deviceAPI.RegisterRoutes(apiMux)
	recoveryAPI.RegisterRoutes(apiMux)
	syncAPI.RegisterRoutes(apiMux)
	pushAPI.RegisterRoutes(apiMux)
	router := cloudserver.New(cfg.baseDomain, store, cloudweb.FS, apiMux)

	var relay *cloudserver.Relay
	if cfg.vapidPublicKey != "" && cfg.vapidPrivateKey != "" {
		relay = cloudserver.NewRelay(store, &cloudserver.WebPushSender{
			VAPIDPublicKey:  cfg.vapidPublicKey,
			VAPIDPrivateKey: cfg.vapidPrivateKey,
			VAPIDSubject:    cfg.vapidSubject,
		})
	} else {
		slog.Info("Push relay disabled: VAPID keys not configured")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.Handle("/", router)

	serverAddr := ":" + cfg.port
	slog.Info("Server starting", "addr", serverAddr)
	httpServer := newHTTPServer(serverAddr, mux)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if relay != nil {
		go relay.Run(ctx)
	}

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
