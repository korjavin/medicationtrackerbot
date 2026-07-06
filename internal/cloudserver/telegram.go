package cloudserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/tgclient"
	"golang.org/x/crypto/hkdf"
)

// TelegramAPI owns cmd/cloud's Telegram surface: the manager-bot bootstrap
// (C3a Task 2), managed provisioning + webhooks (Tasks 3–4), and the
// session-authed status/BYO/skip/test endpoints. It is only constructed when
// MANAGER_BOT_TOKEN is set; an absent token leaves Telegram fully disabled and
// no routes are registered.
type TelegramAPI struct {
	store           *cloudstore.Repo
	sessionSecret   string
	baseDomain      string
	apiBaseURL      string // tgclient base URL override; "" → real api.telegram.org
	manager         *tgclient.Client
	managerSecret   string // per-deployment webhook path/secret-token
	managerUsername string // resolved by Bootstrap via getMe
}

// NewTelegramAPI builds the Telegram surface for a manager bot token. apiBaseURL
// overrides the Telegram API root (tests inject an httptest fake); "" uses the
// real api.telegram.org.
func NewTelegramAPI(store *cloudstore.Repo, sessionSecret, managerToken, baseDomain, apiBaseURL string) *TelegramAPI {
	return &TelegramAPI{
		store:         store,
		sessionSecret: sessionSecret,
		baseDomain:    baseDomain,
		apiBaseURL:    apiBaseURL,
		manager:       tgclient.New(managerToken, apiBaseURL),
		managerSecret: deriveWebhookSecret(sessionSecret, "mt/tg-manager-webhook/v1"),
	}
}

// Bootstrap resolves the manager bot's username (no extra env var) and points
// its webhook at /tg/manager/<secret> on the base host. Called once at startup.
func (t *TelegramAPI) Bootstrap(ctx context.Context) error {
	me, err := t.manager.GetMe(ctx)
	if err != nil {
		return err
	}
	t.managerUsername = me.Username

	url := "https://" + t.baseDomain + "/tg/manager/" + t.managerSecret
	if err := t.manager.SetWebhook(ctx, url, t.managerSecret); err != nil {
		return err
	}
	slog.Info("telegram manager bot ready", "username", me.Username, "webhook", url)
	return nil
}

// deriveWebhookSecret produces a stable per-deployment webhook secret from
// SESSION_SECRET via HKDF (hex-encoded 16 bytes). Used both as the URL path
// component and the X-Telegram-Bot-Api-Secret-Token value.
func deriveWebhookSecret(sessionSecret, label string) string {
	buf := make([]byte, 16)
	r := hkdf.New(sha256.New, []byte(sessionSecret), nil, []byte(label))
	if _, err := io.ReadFull(r, buf); err != nil {
		// HKDF over sha256 never fails for 16 bytes; treat as fatal misuse.
		panic("cloudserver: derive webhook secret: " + err.Error())
	}
	return hex.EncodeToString(buf)
}
