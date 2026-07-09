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
	"fmt"
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

// welcomeMessage / testMessage are the only user-visible strings C3a sends —
// server constants, no message content leaves the account beyond these (the
// zero-knowledge posture the consent screen declares).
const (
	welcomeMessage = "✅ Your Med Tracker bot is connected."
	testMessage    = "🔔 Test notification from Med Tracker — your bot works."
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

// RegisterAPIRoutes wires the session-authed /api/telegram/* endpoints onto
// the subdomain apiMux. Only called when Telegram is enabled.
func (t *TelegramAPI) RegisterAPIRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/telegram/provision", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Provision)))
	mux.Handle("GET /api/telegram/status", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Status)))
	mux.Handle("GET /api/telegram/diag", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Diag)))
	mux.Handle("POST /api/telegram/byo", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.BYO)))
	mux.Handle("POST /api/telegram/skip", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Skip)))
	mux.Handle("POST /api/telegram/reset", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Reset)))
	mux.Handle("POST /api/telegram/test", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Test)))
	mux.Handle("DELETE /api/telegram", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.Delete)))
}

// RegisterWebhookRoutes wires the base-host Telegram server-to-server webhook
// onto the top-level mux (coexists with the "/" landing-page catch-all —
// ServeMux prefers the more specific pattern). Only called when enabled.
func (t *TelegramAPI) RegisterWebhookRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /tg/manager/{secret}", t.ManagerWebhook)
	mux.HandleFunc("POST /tg/bot/{ref}/{secret}", t.ChildWebhook)
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
	writeJSON(w, http.StatusOK, map[string]string{
		"deep_link":          t.deepLink(suggested),
		"suggested_username": suggested,
	})
}

// deepLink builds the BotFather "new managed bot" link for a suggested username.
// Provision and Status both return it so the client's pending page keeps showing
// the same "Open Telegram to create the bot" button, including after a reload.
func (t *TelegramAPI) deepLink(suggested string) string {
	return "https://t.me/newbot/" + t.managerUsername + "/" + suggested + "?" + url.Values{"name": {"Med Tracker"}}.Encode()
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
		suggested, perr := t.store.PendingUsernameByAccount(r.Context(), sess.AccountID, time.Now())
		if perr != nil {
			slog.Error("telegram status: pending check", "error", perr, "account", sess.AccountID)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		switch {
		case suggested != "":
			resp["state"] = "pending"
			// Carry the deep link so the pending page can (re)render the
			// create-bot button without a fresh provision POST.
			resp["suggested_username"] = suggested
			resp["deep_link"] = t.deepLink(suggested)
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

// Diag returns Telegram's getWebhookInfo for the account's linked child bot so
// we can tell, when /start produces no ChildWebhook activity, whether Telegram
// even has our webhook URL (managed bots may not honor an independent
// setWebhook) or is delivering to it and getting rejected (last_error 401/403).
// Also echoes the URL we *expect* Telegram to hold, for a direct compare. The
// caller owns this account, so exposing its own webhook secret is fine.
func (t *TelegramAPI) Diag(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	bot, err := t.store.BotByAccount(r.Context(), sess.AccountID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{"linked": false, "note": "no bot provisioned for this account"})
		return
	}
	if err != nil {
		slog.Error("telegram diag: load bot", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram diag: open token", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	info, err := client.GetWebhookInfo(r.Context())
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"bot_username":         bot.BotUsername,
			"kind":                 bot.Kind,
			"getWebhookInfo_error": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"bot_username": bot.BotUsername,
		"bot_id":       bot.BotID,
		"kind":         bot.Kind,
		"chat_linked":  bot.ChatID != nil,
		"expected_url": t.childWebhookURL(sess.AccountID, bot.WebhookSecret),
		"webhook_info": info,
	})
}

// ManagerWebhook receives the manager bot's updates. It authenticates the
// secret (path component + X-Telegram-Bot-Api-Secret-Token header, both HKDF
// values), then on a managed_bot update matches the suggested username to a
// pending row, fetches + seals the child token, and points a webhook at the
// child bot. Unmatched updates (edited username, replay) are logged and
// dropped with 200 so Telegram doesn't retry.
func (t *TelegramAPI) ManagerWebhook(w http.ResponseWriter, r *http.Request) {
	if !t.authWebhook(r, t.managerSecret) {
		slog.Warn("telegram manager webhook: auth rejected")
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// Read the request body once for JSON decoding. Logs must only include
	// non-sensitive diagnostics such as update_id or decode error. Do not
	// log the raw payload, as it can contain PII.
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		slog.Error("telegram manager webhook: read body", "error", err)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var upd tgclient.Update
	if err := json.Unmarshal(body, &upd); err != nil {
		slog.Warn("telegram manager webhook: decode failed", "error", err)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	botID, botUsername, userID, ok := upd.ManagedBotCreatedInfo()
	if !ok {
		if upd.Message != nil && upd.Message.Chat.Type == "private" {
			switch text := strings.TrimSpace(strings.ToLower(upd.Message.Text)); text {
			case "yes", "sure", "y", "yeah", "ok", "okay", "yep", "absolutely", "please", "i do":
				now := time.Now()
				inv, err := Provision(r.Context(), t.store, 14*24*time.Hour, now)
				if err != nil {
					slog.Error("telegram manager webhook: provision invite failed", "error", err)
					t.manager.SendMessage(r.Context(), upd.Message.Chat.ID, "Sorry, I encountered an error while creating your invite. Please try again later.")
				} else {
					link := inv.ClaimURL(t.baseDomain)
					msg := fmt.Sprintf("Great! Here is your invite link to claim your new Med Tracker account:\n\n%s\n\nOnce you claim it, you can follow the instructions to set up your own bot.", link)
					t.manager.SendMessage(r.Context(), upd.Message.Chat.ID, msg)
				}
			case "/start", "hi", "hello", "help":
				msg := "Hi! I am the manager bot for Med Tracker. I help people set up their own personal health tracking bot (meds, vitals, food intake, weight, blood pressure).\n\nWould you like to try it out? If so, just reply with 'yes' and I will generate an invite link for you."
				t.manager.SendMessage(r.Context(), upd.Message.Chat.ID, msg)
			default:
				msg := "I am a manager bot for Med Tracker. If you would like an invite to try it out, just reply with 'yes'."
				t.manager.SendMessage(r.Context(), upd.Message.Chat.ID, msg)
			}
		} else {
			slog.Info("telegram manager webhook: update without managed_bot_created", "update_id", upd.UpdateID)
		}
		w.WriteHeader(http.StatusOK)
		return
	}
	slog.Info("telegram manager webhook: managed_bot_created", "bot_id", botID, "bot_username", botUsername, "user_id", userID)
	now := time.Now()
	// Peek (don't consume) the pending row: the pending row is the only retry
	// anchor, so we delete it only after every fallible Telegram/DB step below
	// succeeds. A 500 before that leaves the row intact and Telegram re-drives
	// the whole bind — otherwise a transient token/webhook failure would strand
	// the flow with no way to re-fire the managed_bot update.
	accountID, err := t.store.PendingAccountByUsername(r.Context(), botUsername, now)
	if errors.Is(err, cloudstore.ErrPendingInvalid) {
		// Edited username or replay — no fast-path binding. v1 ceiling; the
		// wizard copy asks the user to keep the suggested name (BYO fallback
		// otherwise). ponytail: revisit if ManagedBotUpdated carries the link.
		slog.Info("telegram manager webhook: no pending match", "bot_username", botUsername)
		w.WriteHeader(http.StatusOK)
		return
	}
	if err != nil {
		slog.Error("telegram manager webhook: consume pending", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	token, err := t.manager.GetManagedBotToken(r.Context(), botID)
	if err != nil {
		if tgclient.IsClientError(err) {
			// Permanent (bot deleted/deactivated, invalid) — drop with 200 so
			// Telegram stops re-driving a dead event. Common for stale retries
			// of bots the user deleted mid-setup. The pending row is left intact
			// so a fresh create can still bind.
			slog.Warn("telegram manager webhook: get managed token permanently failed, dropping", "error", err, "bot_id", botID)
			w.WriteHeader(http.StatusOK)
			return
		}
		slog.Error("telegram manager webhook: get managed token", "error", err, "bot_id", botID)
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
	// Set the child webhook BEFORE writing the bot row so the bot row is the
	// bind's commit point — it exists only after every fallible Telegram step has
	// succeeded. A SetWebhook failure here 500s with nothing written and the
	// pending row still intact, so Telegram re-drives the whole bind. Writing the
	// bot row first would let a "start over" (reset) delete the pending retry
	// anchor in the window before a SetWebhook failure, stranding a bot_created
	// row whose webhook was never set with no pending row left to retry against.
	child := tgclient.New(token, t.apiBaseURL)
	if err := child.SetWebhook(r.Context(), t.childWebhookURL(accountID, botSecret), botSecret); err != nil {
		slog.Error("telegram manager webhook: set child webhook", "error", err, "account", accountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Webhook is live — commit the bot row, gated on the pending row still
	// existing: "start over" (reset) deletes it, and this atomic check makes a
	// reset that lands mid-bind resolve cleanly. written=false means reset won the
	// race — drop with 200 (the webhook we just set is harmlessly orphaned; a
	// fresh provision rotates the secret and replaces it).
	written, err := t.store.UpsertManagedBotIfPending(r.Context(), cloudstore.TGBot{
		AccountID:     accountID,
		BotID:         botID,
		BotUsername:   botUsername,
		TokenCT:       ct,
		TokenNonce:    nonce,
		Kind:          "managed",
		WebhookSecret: botSecret,
		CreatedAt:     now,
	}, botUsername, now)
	if err != nil {
		slog.Error("telegram manager webhook: upsert bot", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !written {
		slog.Info("telegram manager webhook: pending gone before bind (reset), dropping", "bot_username", botUsername)
		w.WriteHeader(http.StatusOK)
		return
	}
	// Bind fully succeeded — now retire the pending row (single-use). A retry
	// that already deleted it lands on ErrPendingInvalid, which is fine.
	if _, err := t.store.ConsumePendingByUsername(r.Context(), botUsername, now); err != nil && !errors.Is(err, cloudstore.ErrPendingInvalid) {
		slog.Error("telegram manager webhook: delete pending", "error", err, "account", accountID)
	}
	slog.Info("telegram managed bot provisioned", "account", accountID, "bot_username", botUsername)
	w.WriteHeader(http.StatusOK)
}

// ChildWebhook receives a linked bot's updates. It loads the bot addressed by
// the URL ref, checks the secret (path + header, constant-time) against that
// bot's per-bot secret, then on a /start message links the chat and sends the
// welcome message — the end-to-end proof the bot works. Non-/start content is
// ignored in C3a (no command surface until C3b).
func (t *TelegramAPI) ChildWebhook(w http.ResponseWriter, r *http.Request) {
	ref := r.PathValue("ref")
	bot, err := t.store.BotByWebhookRef(r.Context(), ref)
	if errors.Is(err, sql.ErrNoRows) {
		// A managed bot's webhook is set *before* the bot row is written so a
		// SetWebhook failure 500s cleanly without stranding the row. This opens
		// a tiny race: if Telegram immediately buffers a deep-link /start, it can
		// deliver it here before the UpsertBot transaction commits. If we 403,
		// Telegram drops the update and the user's /start is lost. Wait and retry.
		for i := 0; i < 5; i++ {
			time.Sleep(100 * time.Millisecond)
			bot, err = t.store.BotByWebhookRef(r.Context(), ref)
			if err == nil {
				break
			}
		}
	}
	if errors.Is(err, sql.ErrNoRows) {
		slog.Warn("telegram child webhook: unknown ref", "ref", ref)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if err != nil {
		slog.Error("telegram child webhook: load bot", "error", err, "ref", ref)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !t.authWebhook(r, bot.WebhookSecret) {
		slog.Warn("telegram child webhook: auth rejected", "ref", ref)
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// Read the request body once for JSON decoding. Logs must only include
	// non-sensitive diagnostics such as ref, update_id, and decode error.
	// Do not log the raw Telegram payload, as it can contain PII.
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		slog.Error("telegram child webhook: read body", "error", err, "ref", ref)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	slog.Info("telegram child webhook: update", "ref", ref)
	var upd tgclient.Update
	if err := json.Unmarshal(body, &upd); err != nil {
		slog.Warn("telegram child webhook: decode failed", "error", err, "ref", ref)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if upd.Message == nil || !strings.HasPrefix(upd.Message.Text, "/start") {
		w.WriteHeader(http.StatusOK)
		return
	}

	now := time.Now()
	if err := t.store.LinkChat(r.Context(), ref, upd.Message.Chat.ID, now); err != nil {
		slog.Error("telegram child webhook: link chat", "error", err, "ref", ref)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram child webhook: open token", "error", err, "ref", ref)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := client.SendMessage(r.Context(), upd.Message.Chat.ID, welcomeMessage); err != nil {
		slog.Error("telegram child webhook: send welcome", "error", err, "ref", ref)
		// chat is linked; a failed welcome send is not fatal — reply 200 so
		// Telegram doesn't retry the /start.
	}
	slog.Info("telegram bot linked", "account", ref, "chat_id", upd.Message.Chat.ID)
	w.WriteHeader(http.StatusOK)
}

// BYO validates an operator-supplied bot token via getMe, seals it, stores it
// (kind=byo), and points a webhook at the child route. Linking then follows the
// same /start path as a managed bot.
func (t *TelegramAPI) BYO(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Token) == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	token := strings.TrimSpace(body.Token)

	client := tgclient.New(token, t.apiBaseURL)
	me, err := client.GetMe(r.Context())
	if err != nil {
		// Bad token — Telegram rejects getMe. Surface as a 400, not a 500.
		slog.Info("telegram byo: getMe rejected", "account", sess.AccountID, "error", err)
		http.Error(w, "invalid bot token", http.StatusBadRequest)
		return
	}

	ct, nonce, err := sealTGToken(t.sessionSecret, token)
	if err != nil {
		slog.Error("telegram byo: seal token", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// BYO is reachable from the pending page, so a managed provision may still be
	// in flight. Claim (delete) the pending row BEFORE writing the bot row: the
	// pending row is the manager webhook's write gate (UpsertManagedBotIfPending
	// only overwrites while it exists), so deleting it first makes the BYO choice
	// win — a delayed managed_bot_created update then finds no pending row and
	// drops instead of clobbering this bot with a mismatched secret. Deleting
	// after the write left a window where that late update could overwrite the
	// just-written BYO row, 403ing the user's /start. Fatal on error: proceeding
	// past a failed delete would reopen exactly that race.
	if err := t.store.DeletePendingByAccount(r.Context(), sess.AccountID); err != nil {
		slog.Error("telegram byo: delete pending", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	botSecret := randomSecret()
	// Set the webhook BEFORE writing the bot row so the bot row is the commit
	// point (same invariant as the managed path): it exists only after every
	// fallible Telegram step has succeeded. Writing the bot row first would leave
	// a bot_created row whose webhook was never set if SetWebhook 500s — Status
	// then reports bot_created and the pending anchor is already gone, so /start
	// never reaches the server. Pending is already deleted above, so a SetWebhook
	// failure here cleanly falls back to none and the user can retry BYO.
	if err := client.SetWebhook(r.Context(), t.childWebhookURL(sess.AccountID, botSecret), botSecret); err != nil {
		slog.Error("telegram byo: set webhook", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := t.store.UpsertBot(r.Context(), cloudstore.TGBot{
		AccountID:     sess.AccountID,
		BotID:         me.ID,
		BotUsername:   me.Username,
		TokenCT:       ct,
		TokenNonce:    nonce,
		Kind:          "byo",
		WebhookSecret: botSecret,
		CreatedAt:     time.Now(),
	}); err != nil {
		slog.Error("telegram byo: upsert bot", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"bot_username": me.Username})
}

// Skip records that the user declined Telegram setup (tg_skipped_unix) so the
// stateless wizard's derived-state rule never re-nags. Idempotent.
func (t *TelegramAPI) Skip(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := t.store.SetTGSkipped(r.Context(), sess.AccountID, time.Now()); err != nil {
		slog.Error("telegram skip: set skipped", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"skipped": true})
}

// Reset abandons a stuck managed-bot provisioning: it clears the account's
// pending row (idempotent) so Status falls back to none and the user can start
// over without waiting out the pending TTL. Bot and skipped rows are untouched.
func (t *TelegramAPI) Reset(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := t.store.DeletePendingByAccount(r.Context(), sess.AccountID); err != nil {
		slog.Error("telegram reset: delete pending", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
}

// Test sends a test notification through a linked bot — the wizard/settings
// "it works" button. Requires a bot that has been /start'ed (chat linked).
func (t *TelegramAPI) Test(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	bot, err := t.store.BotByAccount(r.Context(), sess.AccountID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && bot.ChatID == nil) {
		http.Error(w, "bot not linked", http.StatusConflict)
		return
	}
	if err != nil {
		slog.Error("telegram test: load bot", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram test: open token", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := client.SendMessage(r.Context(), *bot.ChatID, testMessage); err != nil {
		slog.Error("telegram test: send", "error", err, "account", sess.AccountID)
		http.Error(w, "send failed", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"sent": true})
}

// Delete unlinks the account's bot: it deletes the Telegram webhook (best
// effort) and removes the row. A *managed* bot itself stays owned by the user
// (deletable via BotFather) — the response copy says so.
func (t *TelegramAPI) Delete(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	bot, err := t.store.BotByAccount(r.Context(), sess.AccountID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		slog.Error("telegram delete: load bot", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err == nil {
		if client, cerr := t.botClient(bot); cerr == nil {
			if werr := client.DeleteWebhook(r.Context()); werr != nil {
				slog.Warn("telegram delete: delete webhook", "error", werr, "account", sess.AccountID)
			}
		}
		if derr := t.store.DeleteBot(r.Context(), sess.AccountID); derr != nil {
			slog.Error("telegram delete: delete row", "error", derr, "account", sess.AccountID)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"note": "Bot unlinked. A managed bot remains yours — delete it in BotFather if you no longer want it.",
	})
}

// childWebhookURL builds the base-host child-webhook URL for a bot secret.
func (t *TelegramAPI) childWebhookURL(accountID, botSecret string) string {
	return "https://" + t.baseDomain + "/tg/bot/" + accountID + "/" + botSecret
}

// botClient opens a bot's sealed token and returns a tgclient bound to it.
func (t *TelegramAPI) botClient(bot *cloudstore.TGBot) (*tgclient.Client, error) {
	token, err := openTGToken(t.sessionSecret, bot.TokenCT, bot.TokenNonce)
	if err != nil {
		return nil, err
	}
	return tgclient.New(token, t.apiBaseURL), nil
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
