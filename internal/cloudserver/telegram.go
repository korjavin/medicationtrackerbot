package cloudserver

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/tgclient"
	"golang.org/x/crypto/hkdf"
)

// pendingTTL bounds how long a suggested username stays claimable after
// provision — a user who never completes the BotFather dialog frees the row.
const pendingTTL = time.Hour

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

// RegisterAPIRoutes wires the session-authed /api/telegram/* endpoints onto
// the subdomain apiMux. Only called when Telegram is enabled.
func (t *TelegramAPI) RegisterAPIRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/telegram/provision", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Provision)))
	mux.Handle("GET /api/telegram/status", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Status)))
}

// RegisterWebhookRoutes wires the base-host Telegram server-to-server webhook
// onto the top-level mux (coexists with the "/" landing-page catch-all —
// ServeMux prefers the more specific pattern). Only called when enabled.
func (t *TelegramAPI) RegisterWebhookRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /tg/manager/{secret}", t.ManagerWebhook)
}

// Provision starts a managed-bot creation flow: it mints a random suggested
// username (whose suffix is the pairing key), records a short-lived pending
// row, and returns the BotFather deep link the client opens.
func (t *TelegramAPI) Provision(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	suggested := suggestedUsername()
	now := time.Now()
	if err := t.store.CreatePending(r.Context(), suggested, sess.AccountID, now, now.Add(pendingTTL)); err != nil {
		slog.Error("telegram provision: create pending", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	deepLink := "https://t.me/newbot/" + t.managerUsername + "/" + suggested + "?" + url.Values{"name": {"Med Tracker"}}.Encode()
	writeJSON(w, http.StatusOK, map[string]string{
		"deep_link":          deepLink,
		"suggested_username": suggested,
	})
}

// Status reports where the account sits in the Telegram-setup state machine so
// the wizard/settings polling UI can render the right step.
func (t *TelegramAPI) Status(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	account, _ := AccountFromContext(r.Context())

	resp := map[string]any{"enabled": true, "state": "none"}
	bot, err := t.store.BotByAccount(r.Context(), sess.AccountID)
	switch {
	case err == nil:
		resp["bot_username"] = bot.BotUsername
		if bot.LinkedAt != nil {
			resp["state"] = "linked"
		} else {
			resp["state"] = "bot_created"
		}
	case errors.Is(err, sql.ErrNoRows):
		pending, perr := t.store.HasPendingByAccount(r.Context(), sess.AccountID, time.Now())
		if perr != nil {
			slog.Error("telegram status: pending check", "error", perr, "account", sess.AccountID)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		switch {
		case pending:
			resp["state"] = "pending"
		case account != nil && account.TGSkippedAt != nil:
			resp["state"] = "skipped"
		}
	default:
		slog.Error("telegram status: load bot", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ManagerWebhook receives the manager bot's updates. It authenticates the
// secret (path component + X-Telegram-Bot-Api-Secret-Token header, both HKDF
// values), then on a managed_bot update matches the suggested username to a
// pending row, fetches + seals the child token, and points a webhook at the
// child bot. Unmatched updates (edited username, replay) are logged and
// dropped with 200 so Telegram doesn't retry.
func (t *TelegramAPI) ManagerWebhook(w http.ResponseWriter, r *http.Request) {
	if !t.authWebhook(r, t.managerSecret) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var upd tgclient.Update
	if err := json.NewDecoder(r.Body).Decode(&upd); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if upd.ManagedBot == nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	mb := upd.ManagedBot
	now := time.Now()
	accountID, err := t.store.ConsumePendingByUsername(r.Context(), mb.BotUsername, now)
	if errors.Is(err, cloudstore.ErrPendingInvalid) {
		// Edited username or replay — no fast-path binding. v1 ceiling; the
		// wizard copy asks the user to keep the suggested name (BYO fallback
		// otherwise). ponytail: revisit if ManagedBotUpdated carries the link.
		slog.Info("telegram manager webhook: no pending match", "bot_username", mb.BotUsername)
		w.WriteHeader(http.StatusOK)
		return
	}
	if err != nil {
		slog.Error("telegram manager webhook: consume pending", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	token, err := t.manager.GetManagedBotToken(r.Context(), mb.BotID)
	if err != nil {
		slog.Error("telegram manager webhook: get managed token", "error", err, "bot_id", mb.BotID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	ct, nonce, err := sealTGToken(t.sessionSecret, token)
	if err != nil {
		slog.Error("telegram manager webhook: seal token", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	botSecret := randomSecret()
	if err := t.store.UpsertBot(r.Context(), cloudstore.TGBot{
		AccountID:     accountID,
		BotID:         mb.BotID,
		BotUsername:   mb.BotUsername,
		TokenCT:       ct,
		TokenNonce:    nonce,
		Kind:          "managed",
		WebhookSecret: botSecret,
		CreatedAt:     now,
	}); err != nil {
		slog.Error("telegram manager webhook: upsert bot", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	child := tgclient.New(token, t.apiBaseURL)
	childURL := "https://" + t.baseDomain + "/tg/bot/" + accountID + "/" + botSecret
	if err := child.SetWebhook(r.Context(), childURL, botSecret); err != nil {
		slog.Error("telegram manager webhook: set child webhook", "error", err, "account", accountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	slog.Info("telegram managed bot provisioned", "account", accountID, "bot_username", mb.BotUsername)
	w.WriteHeader(http.StatusOK)
}

// authWebhook checks both the secret path component and the
// X-Telegram-Bot-Api-Secret-Token header against want (constant-time).
func (t *TelegramAPI) authWebhook(r *http.Request, want string) bool {
	pathSecret := r.PathValue("secret")
	header := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
	return subtle.ConstantTimeCompare([]byte(pathSecret), []byte(want)) == 1 &&
		subtle.ConstantTimeCompare([]byte(header), []byte(want)) == 1
}

// suggestedUsername mints "mt_<8 lowercase base32>_bot" — a Telegram-valid
// username whose random middle is the managed-provisioning pairing key.
func suggestedUsername() string {
	buf := make([]byte, 5) // 5 bytes → 8 base32 chars
	if _, err := rand.Read(buf); err != nil {
		panic("cloudserver: read random for suggested username: " + err.Error())
	}
	suffix := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf))
	return "mt_" + suffix + "_bot"
}

// randomSecret returns 16 random bytes hex-encoded — a per-child-bot webhook
// secret (distinct from the deployment-wide manager secret).
func randomSecret() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic("cloudserver: read random for webhook secret: " + err.Error())
	}
	return hex.EncodeToString(buf)
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
