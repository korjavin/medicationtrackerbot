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
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/domain/nxk"
	"github.com/korjavin/medicationtrackerbot/internal/tgclient"
	"golang.org/x/crypto/hkdf"
)

// pendingTTL bounds how long a suggested username stays claimable after
// provision — a user who never completes the BotFather dialog frees the row.
const pendingTTL = time.Hour

// Every user-visible string the relay itself composes is a server constant
// here — no message content leaves the account beyond these (the zero-knowledge
// posture the consent screen declares). None reads vault data, so all are
// answerable without the sealed inbound mailbox. The one exception is the
// confirmation text passed to EditReply, which the CLIENT composes and the
// relay forwards verbatim, exactly as it does outbound reminder text.
const (
	welcomeMessage = "✅ Your Med Tracker bot is connected."
	testMessage    = "🔔 Test notification from Med Tracker — your bot works."

	// Plain text: tgclient.SendMessage sends no parse_mode, so markdown would
	// show up literally.
	helpMessage = `Med Tracker — your self-hosted health tracker.

/start — link this chat and connect your bot
/help — show this message

Log by message:
/bp 120 80 — blood pressure (add a third number for pulse)
/weight 81.2 — weight in kg
/food 200g chicken breast — log a meal (needs an AI key in Settings)
/workout legs — log a workout you finished (the name is optional)
/note felt dizzy after lunch — a diary entry
/intake — confirm the medications due now

Reminders arrive in this chat; tap Confirm or Snooze right on the notification.

This server cannot read what you send: your message is sealed the moment it arrives and only your unlocked app can open it. That is why logging replies "Queued" first, then updates itself once your app records it.`

	// queuedMessage answers every sealed command. It is deliberately content-
	// free: the relay sealed the text without parsing it, so it genuinely does
	// not know what it just accepted. An unlocked client edits this message in
	// place once it has applied the command (see EditReply).
	queuedMessage = "⏳ Queued — recorded when you next open the app."

	// setupMessage is sent when the account has no inbox key yet, so the event
	// was dropped rather than stored in the clear.
	setupMessage = "Open the app once to finish setting up, then try again."
)

// inboxEventKindTGCommand seals the RAW message text of a data command. The
// relay never parses arguments; web/domain/tgcommand.js does, at drain time on
// an unlocked client (docs/cloud-mode.md → "Inbound plaintext").
const inboxEventKindTGCommand = "tg_command"

type tgCommandEvent struct {
	Kind string `json:"kind"`
	// Text is the message verbatim, including the leading command token.
	Text   string `json:"text"`
	AtUnix int64  `json:"at_unix"`
	// ReplyMessageID is the "queued" message the client should edit once it has
	// applied this command. 0 when the reply could not be sent.
	ReplyMessageID int64 `json:"reply_message_id"`
}

// inboxEventKindTGPhoto seals only a photo's file_id (+mime/size), never the
// bytes (bd med-vcv.1). The client fetches the image at drain time through the
// account-scoped /api/telegram/photo proxy and AI-parses it with the user's own
// key — the relay never sees pixels or the parse (docs/cloud-mode.md →
// "Inbound plaintext").
const inboxEventKindTGPhoto = "tg_photo"

type tgPhotoEvent struct {
	Kind string `json:"kind"`
	// FileID is Telegram's stable, re-resolvable handle. It is NOT the bytes and
	// not a secret — a getFile with this account's bot token is the only way to
	// turn it into pixels, which is the account-scoping boundary.
	FileID string `json:"file_id"`
	Mime   string `json:"mime"`
	Size   int64  `json:"size"`
	AtUnix int64  `json:"at_unix"`
	// ReplyMessageID is the "queued" message the client edits into a confirmation
	// once the meal is logged. 0 when the reply could not be sent.
	ReplyMessageID int64 `json:"reply_message_id"`
}

// inboxEventKindTGText seals a free-text (non-command) message. Like every
// inbound kind the relay parses NOTHING: at drain time an unlocked client runs
// an OpenAI tool-calling loop over the MCP catalog with the user's own key, so
// the model can log something or answer a question (bd med-vcv.2). The relay
// never calls an AI provider on an inbound message (docs/cloud-mode.md →
// "Inbound plaintext").
const inboxEventKindTGText = "tg_text"

type tgTextEvent struct {
	Kind string `json:"kind"`
	// Text is the message verbatim.
	Text   string `json:"text"`
	AtUnix int64  `json:"at_unix"`
	// ReplyMessageID is the "queued" message the client edits into the agent's
	// answer once the drain runs. 0 when the reply could not be sent.
	ReplyMessageID int64 `json:"reply_message_id"`
}

// childCommands is the autocomplete menu registered on every linked bot. It
// must list exactly what the bot answers — advertising a command that gets
// dropped is the bug this exists to prevent (bd med-26y). /start and /help are
// answered by the relay; the rest are sealed and applied by an unlocked client
// (bd med-eas.29.2), which is still "answered" from the user's point of view.
var childCommands = []tgclient.BotCommand{
	{Command: "start", Description: "Link this chat and connect your bot"},
	{Command: "help", Description: "Show the command list"},
	{Command: "bp", Description: "Log blood pressure: /bp 120 80"},
	{Command: "weight", Description: "Log weight: /weight 81.2"},
	{Command: "food", Description: "Log food: /food 200g chicken breast"},
	{Command: "workout", Description: "Log a workout: /workout legs"},
	{Command: "note", Description: "Add a diary note: /note felt dizzy"},
	{Command: "intake", Description: "Confirm the medications due now"},
}

// setChildCommands registers the autocomplete menu. Called at mint time (so
// commands exist before the user's first /start) and again on /start (so bots
// minted before this backfill on their next /start). Non-fatal: a bot with no
// autocomplete still answers every command.
func setChildCommands(ctx context.Context, client *tgclient.Client, accountID string) {
	if err := client.SetMyCommands(ctx, childCommands); err != nil {
		slog.Warn("telegram: set child commands", "error", err, "account", accountID)
	}
}

// botCommand returns the normalized leading command ("/help") of a message, or
// "" when the text is not a command. Telegram appends "@botname" when several
// bots share a group, so strip that.
func botCommand(text string) string {
	if !strings.HasPrefix(text, "/") {
		return ""
	}
	cmd := strings.Fields(text)[0]
	if i := strings.Index(cmd, "@"); i >= 0 {
		cmd = cmd[:i]
	}
	return strings.ToLower(cmd)
}

// TelegramAPI owns cmd/cloud's Telegram surface: the manager-bot bootstrap
// (C3a Task 2), managed provisioning + webhooks (Tasks 3–4), and the
// session-authed status/BYO/skip/test endpoints. It is only constructed when
// MANAGER_BOT_TOKEN is set; an absent token leaves Telegram fully disabled and
// no routes are registered.
type TelegramAPI struct {
	store         *cloudstore.Repo
	sessionSecret string
	baseDomain    string
	apiBaseURL    string // tgclient base URL override; "" → real api.telegram.org
	// cloudAPIBaseURL is the base for cloud-only calls (the manager bot's
	// getMe/getManagedBotToken/setWebhook/sendMessage, and logOut during proxy
	// migration), which MUST hit api.telegram.org even when apiBaseURL points at
	// the local proxy: the managed-bot token method isn't implemented by the
	// local Bot API server, and file_ids/sessions are server-bound. "" → real
	// cloud. Defaults to apiBaseURL so a test injecting a single fake as apiBaseURL
	// also drives the manager; cmd/cloud splits them via ConfigureProxy when a
	// proxy is on (bd med-eas.46).
	cloudAPIBaseURL string
	// internalWebhookBase, when non-empty, replaces the public https://baseDomain
	// origin for child-bot webhook URLs. In telegram-bot-api --local mode the proxy
	// container delivers webhooks itself and cannot resolve the public host (it
	// hairpins to loopback), so proxy-delivered child bots register an internal
	// docker-network URL (e.g. http://cloud:8080) instead. Only set when a proxy is
	// configured; "" keeps the public URL (bd med-eas.46).
	internalWebhookBase string
	managerToken        string // built into a client per-call against cloudAPIBaseURL
	managerSecret       string // per-deployment webhook path/secret-token
	managerUsername     string // resolved by Bootstrap via getMe
	claimTTL            time.Duration

	// feedbackRecipient is the developer's age X25519 recipient pubkey
	// (FEEDBACK_AGE_RECIPIENT). "" disables the Telegram feedback channel — no
	// button offered, a stale tap does nothing. The manager bot only ever holds
	// the public key: it encrypts feedback blindly and cannot decrypt (med-dni.5).
	feedbackRecipient string
	// feedbackWaiting tracks chats that tapped "Send feedback" and whose next
	// message should be captured as feedback, with a short TTL. In-memory only.
	// ponytail: lost on restart / not shared across replicas — a one-column table
	// if cloud ever runs multi-replica; single-replica just re-taps.
	feedbackWaiting map[int64]time.Time
	feedbackMu      sync.Mutex

	// mintMu serializes the count-then-insert when the managebot mints an
	// invite; without it concurrent updates all read a sub-quota count and all
	// insert. ponytail: one global lock — cmd/cloud is a single process and
	// minting is rare. Same rationale as InviteAPI.mintMu.
	mintMu sync.Mutex
}

// NewTelegramAPI builds the Telegram surface for a manager bot token. apiBaseURL
// overrides the Telegram API root (tests inject an httptest fake); "" uses the
// real api.telegram.org.
func NewTelegramAPI(store *cloudstore.Repo, sessionSecret, managerToken, baseDomain, apiBaseURL, feedbackRecipient string, claimTTL time.Duration) *TelegramAPI {
	return &TelegramAPI{
		store:             store,
		sessionSecret:     sessionSecret,
		baseDomain:        baseDomain,
		apiBaseURL:        apiBaseURL,
		cloudAPIBaseURL:   apiBaseURL, // default; ConfigureProxy points the manager at the real cloud when a proxy is on
		managerToken:      managerToken,
		managerSecret:     deriveWebhookSecret(sessionSecret, "mt/tg-manager-webhook/v1"),
		feedbackRecipient: feedbackRecipient,
		feedbackWaiting:   make(map[int64]time.Time),
		claimTTL:          claimTTL,
	}
}

// ConfigureProxy scopes the Bot API proxy (bd med-eas.46). When cmd/cloud enables
// the local proxy (CLOUD_TG_API_BASE_URL), child bots run on it for file_id
// validity, but the manager bot + migrate logOut must stay on the real cloud
// (cloudBase, "" → api.telegram.org) — the local server doesn't implement the
// managed-bot token method — and proxy-delivered child webhooks must use an
// internal docker-network URL (internalWebhookBase) because the proxy can't reach
// the public host. Called only when a proxy is configured; a no-proxy deployment
// never calls it and behaves exactly as before (manager + children on cloud,
// public webhook URL).
func (t *TelegramAPI) ConfigureProxy(cloudBase, internalWebhookBase string) {
	t.cloudAPIBaseURL = cloudBase
	t.internalWebhookBase = internalWebhookBase
}

// managerClient builds a client for the manager bot bound to the cloud API base
// (not the proxy) — see cloudAPIBaseURL.
func (t *TelegramAPI) managerClient() *tgclient.Client {
	return tgclient.New(t.managerToken, t.cloudAPIBaseURL)
}

// bootstrapGetMeBudget / bootstrapGetMeInterval bound the getMe retry in
// Bootstrap. With the local Bot API proxy (CLOUD_TG_API_BASE_URL, bd med-eas.41)
// the Go app boots in ms while telegram-bot-api --local takes a few seconds to
// bind :8081, so a single getMe loses a pure startup race and Telegram would stay
// disabled until a manual container restart (bd med-eas.42). Retry rides that out;
// a genuinely unreachable URL still gives up after the budget and degrades.
const (
	bootstrapGetMeBudget   = 45 * time.Second
	bootstrapGetMeInterval = 3 * time.Second
)

// Bootstrap resolves the manager bot's username (no extra env var) and points
// its webhook at /tg/manager/<secret> on the base host. Called once at startup.
func (t *TelegramAPI) Bootstrap(ctx context.Context) error {
	me, err := t.getMeWithRetry(ctx, bootstrapGetMeBudget, bootstrapGetMeInterval)
	if err != nil {
		return err
	}
	t.managerUsername = me.Username

	url := "https://" + t.baseDomain + "/tg/manager/" + t.managerSecret
	if err := t.managerClient().SetWebhook(ctx, url, t.managerSecret); err != nil {
		return err
	}
	slog.Info("telegram manager bot ready", "username", me.Username, "webhook", url)
	return nil
}

// getMeWithRetry calls the manager bot's getMe, retrying on failure at a fixed
// interval until it succeeds or budget is exhausted (bd med-eas.42). It rides out
// the startup race where the local Bot API proxy hasn't bound its port yet without
// waiting on compose ordering; the passed-in context still cancels it early, and a
// truly unreachable URL returns the last error after budget so the caller can
// disable Telegram gracefully instead of hanging forever.
func (t *TelegramAPI) getMeWithRetry(ctx context.Context, budget, interval time.Duration) (tgclient.User, error) {
	deadline := time.Now().Add(budget)
	manager := t.managerClient()
	for attempt := 1; ; attempt++ {
		me, err := manager.GetMe(ctx)
		if err == nil {
			return me, nil
		}
		// Give up rather than sleep past the budget on the final attempt.
		if time.Now().Add(interval).After(deadline) {
			return me, err
		}
		slog.Warn("telegram manager bot getMe failed; retrying", "error", err, "attempt", attempt, "retry_in", interval)
		select {
		case <-ctx.Done():
			return me, ctx.Err()
		case <-time.After(interval):
		}
	}
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
	mux.Handle("POST /api/telegram/reply-edit", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.EditReply)))
	mux.Handle("POST /api/telegram/cancel-refire", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.CancelRefire)))
	mux.Handle("GET /api/telegram/photo", RequireSession(t.store, t.sessionSecret, http.HandlerFunc(t.GetPhoto)))
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
	// Lift last_error to the top level so a broken webhook (e.g. the proxy failing
	// to deliver to an unreachable public URL, bd med-eas.46) is visible without
	// digging into webhook_info. Empty when Telegram reports no delivery error.
	writeJSON(w, http.StatusOK, map[string]any{
		"bot_username": bot.BotUsername,
		"bot_id":       bot.BotID,
		"kind":         bot.Kind,
		"chat_linked":  bot.ChatID != nil,
		"expected_url": t.childWebhookURL(sess.AccountID, bot.WebhookSecret),
		"last_error":   info.LastErrorMessage,
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
		switch {
		case upd.CallbackQuery != nil:
			t.handleManagerCallback(r.Context(), upd.CallbackQuery)
		case upd.Message != nil:
			t.handleManagerMessage(r.Context(), upd.Message)
		default:
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

	token, err := t.managerClient().GetManagedBotToken(r.Context(), botID)
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
		// Transient: 5xx, network, or a 429 rate limit. Answer non-2xx so
		// Telegram redelivers — managed_bot_created is never re-sent on demand,
		// so dropping it here would strand the account unbound forever.
		if wait, ok := tgclient.RetryAfter(err); ok {
			slog.Warn("telegram manager webhook: rate limited by telegram", "retry_after", wait, "bot_id", botID)
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

	// Best-effort profile setup
	if err := child.SetMyName(r.Context(), "Med Tracker"); err != nil {
		slog.Warn("telegram manager webhook: set name failed", "error", err, "account", accountID)
	}
	if err := child.SetMyShortDescription(r.Context(), "Your personal medication and health tracker."); err != nil {
		slog.Warn("telegram manager webhook: set short description failed", "error", err, "account", accountID)
	}
	if err := child.SetMyDescription(r.Context(), "Welcome to Med Tracker! I can help you track your medications, log your blood pressure, and keep a journal of your health."); err != nil {
		slog.Warn("telegram manager webhook: set description failed", "error", err, "account", accountID)
	}

	// If logo exists, best-effort set it as well
	if logo, err := os.ReadFile("docs/logo.jpg"); err == nil {
		if err := child.SetMyProfilePhoto(r.Context(), logo); err != nil {
			slog.Warn("telegram manager webhook: set profile photo failed", "error", err, "account", accountID)
		}
	}

	if err := child.SetWebhook(r.Context(), t.childWebhookURL(accountID, botSecret), botSecret); err != nil {
		slog.Error("telegram manager webhook: set child webhook", "error", err, "account", accountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Register autocomplete at mint, not just on /start — otherwise the menu
	// is empty until the user guesses a command first (bd med-26y).
	setChildCommands(r.Context(), child, accountID)
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
	// Webhook was set through the proxy (if one is configured), so this bot is
	// born on the proxy and never needs the cloud→local migration.
	t.markNewBotOnProxy(r.Context(), accountID)
	// Bind fully succeeded — now retire the pending row (single-use). A retry
	// that already deleted it lands on ErrPendingInvalid, which is fine.
	if _, err := t.store.ConsumePendingByUsername(r.Context(), botUsername, now); err != nil && !errors.Is(err, cloudstore.ErrPendingInvalid) {
		slog.Error("telegram manager webhook: delete pending", "error", err, "account", accountID)
	}
	slog.Info("telegram managed bot provisioned", "account", accountID, "bot_username", botUsername)
	w.WriteHeader(http.StatusOK)
}

// Onboarding copy the managebot sends in a private chat. Server constants, like
// welcomeMessage/testMessage.
const (
	onboardingOfferMessage = "👋 I help you set up your own personal health-tracking bot — medications, " +
		"blood pressure, weight, food and vitals, all yours.\n\n" +
		"Want me to create an account for you? Just reply “yes”."
	onboardingClaimedMessage = "You already have a Med Tracker account. Open your subdomain and unlock it with your passkey — " +
		"I can't create a second one for you."
	onboardingMintFailMessage = "Sorry, I couldn't create your account just now. Please try again in a few minutes."
	// onboardingLinkedMessage answers a sender who already runs a child bot: this
	// is the wrong chat, and their own bot is one tap away (bd med-eas.62). %s is
	// the child bot's username.
	onboardingLinkedMessage = "✅ You're set up — chat with your assistant here: @%s\n\n" +
		"This chat only sets new bots up; everything you log goes to your own bot."
)

// onboardingQuotaMessage is built from the cap so the copy can't drift from it.
var onboardingQuotaMessage = fmt.Sprintf(
	"You already have %d setup links waiting — that's my limit per person. "+
		"Open one of them, or wait for them to expire and message me again.",
	managerInviteQuota)

// managerInviteQuota caps how many *live* invites one Telegram user may hold at
// once — unclaimed accounts whose claim has not expired, counted directly (see
// CountLiveInvitesCreatedBy). Not a per-day cap: that would let an abuser stack
// quota × (claimTTL/day) claim links.
// ponytail: hardcoded — env-var knob only if someone asks. Same posture as
// inviteMonthlyQuota.
const managerInviteQuota = 3

// affirmatives are the one-word replies that accept the offer to mint an
// account. Everything else (greetings included) gets the offer itself.
var affirmatives = map[string]bool{"yes": true, "y": true, "yeah": true, "yep": true, "sure": true, "ok": true, "okay": true}

// handleManagerMessage runs the onboarding conversation for an ordinary private
// message to the managebot: explain, offer, and on agreement mint an invite.
// Every failure is logged and swallowed — the caller always answers 200, because
// a non-200 makes Telegram retry the update (and retrying a mint is worse than
// dropping a reply).
func (t *TelegramAPI) handleManagerMessage(ctx context.Context, msg *tgclient.Message) {
	if msg.Chat.Type != "private" || msg.From == nil || msg.From.IsBot {
		return
	}
	// ponytail: accounts.created_by_account_id is overloaded — it is TEXT with no
	// FK, so a "tg:"-prefixed Telegram user id cannot collide with a real account
	// id (never prefixed) nor with admin-CLI mints (NULL). One column then carries
	// provenance, the live-invite cap, and the already-connected check, with no new
	// table. Promote to a tg_invite_mints table if a second non-account minter
	// ever needs provenance.
	creator := "tg:" + strconv.FormatInt(msg.From.ID, 10)

	// A prior "Send feedback" tap arms this chat: capture the next message as
	// feedback (before the onboarding classification below — feedback text is
	// arbitrary and could otherwise be mistaken for a greeting or a "yes").
	if t.takeFeedbackWaiting(msg.Chat.ID) {
		t.captureFeedback(ctx, msg, creator)
		return
	}

	// A sender whose own child bot is already linked landed in the wrong chat:
	// point them at that bot instead of running onboarding (or, worse, saying
	// nothing). Checked before the claimed gate because it covers BYO/web/admin-CLI
	// onboarding too, which "tg:"-attributed claims never see (bd med-eas.62).
	switch bot, err := t.store.BotByChatID(ctx, msg.Chat.ID); {
	case err == nil && bot.BotUsername != "":
		t.replyManagerLinked(ctx, msg.Chat.ID, bot.BotUsername)
		return
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		slog.Error("telegram manager message: linked-bot check", "error", err)
		return
	}

	claimed, err := t.store.HasClaimedAccountCreatedBy(ctx, creator)
	if err != nil {
		slog.Error("telegram manager message: claimed check", "error", err)
		return
	}
	if claimed {
		// A claimed sender is a feedback audience, so this reply carries the
		// "Send feedback" button when the channel is enabled.
		t.replyManagerClaimed(ctx, msg.Chat.ID)
		return
	}

	switch text := strings.TrimSpace(strings.ToLower(msg.Text)); {
	case affirmatives[text]:
		t.mintInvite(ctx, msg.Chat.ID, creator)
	default:
		// Anything else (including the greetings) gets the offer: a sender who
		// reaches here has no linked bot and no claimed account, so silence would
		// just strand them (bd med-eas.62). The users this used to protect — people
		// who already own a bot via BYO/web/admin-CLI onboarding — are now caught by
		// the linked-bot check above.
		t.reply(ctx, msg.Chat.ID, onboardingOfferMessage)
	}
}

// replyManagerLinked points a sender at their own child bot with a one-tap URL
// button. It carries the "Send feedback" button too when the channel is enabled:
// a linked sender is as much the manager bot's feedback audience as a claimed one
// (this reply shadows replyManagerClaimed for anyone who has linked a bot).
func (t *TelegramAPI) replyManagerLinked(ctx context.Context, chatID int64, botUsername string) {
	buttons := []tgclient.InlineKeyboardButton{{Text: "💬 Open @" + botUsername, URL: "https://t.me/" + botUsername}}
	if t.feedbackEnabled() {
		buttons = append(buttons, feedbackButton()...)
	}
	if err := t.managerClient().SendMessageWithButtons(ctx, chatID, fmt.Sprintf(onboardingLinkedMessage, botUsername), buttons); err != nil {
		slog.Error("telegram manager message: send linked reply", "error", err, "chat_id", chatID)
	}
}

// mintInvite provisions a fresh unclaimed account attributed to creator and
// replies with its claim link, refusing once creator holds managerInviteQuota
// live invites.
func (t *TelegramAPI) mintInvite(ctx context.Context, chatID int64, creator string) {
	t.reply(ctx, chatID, t.mintInviteLocked(ctx, creator))
}

// mintInviteLocked does the count-then-insert under mintMu and returns the text
// to reply with. The reply itself is sent by the caller, outside the lock: it is
// an HTTP round-trip to Telegram, and mintMu is global across every user.
func (t *TelegramAPI) mintInviteLocked(ctx context.Context, creator string) string {
	t.mintMu.Lock()
	defer t.mintMu.Unlock()

	// ponytail: no update_id dedupe anywhere in this codebase, so a Telegram
	// retry of a "yes" mints again. The already-connected gate above plus the
	// live-invite cap bound a replay to managerInviteQuota empty accounts; a
	// dedupe table isn't worth it. We also can't re-send a pending invite's link
	// — the token is hash-only at rest — so a user with a live unclaimed invite
	// who asks again just gets a fresh one, up to the cap.
	now := time.Now().UTC()
	// Sweep before counting, same as InviteAPI.CreateInvite: a user sitting at
	// the cap never reaches Provision, so without this their own expired
	// unclaimed invites would occupy slots forever.
	if _, err := t.store.SweepExpiredClaims(ctx, now); err != nil {
		slog.Error("telegram manager message: sweep expired claims", "error", err)
		return onboardingMintFailMessage
	}
	// Count liveness from the rows themselves (unclaimed, expiry in the future)
	// rather than from a created_at window: shortening CLOUD_CLAIM_TTL, or a
	// ResetClaim that moves an expiry without touching created_at, would put a
	// still-claimable link outside any TTL-derived window and hand back quota.
	minted, err := t.store.CountLiveInvitesCreatedBy(ctx, creator, now)
	if err != nil {
		slog.Error("telegram manager message: count mints", "error", err, "creator", creator)
		return onboardingMintFailMessage
	}
	if minted >= managerInviteQuota {
		return onboardingQuotaMessage
	}

	inv, err := Provision(ctx, t.store, t.claimTTL, now, creator)
	if err != nil {
		slog.Error("telegram manager message: provision invite", "error", err, "creator", creator)
		return onboardingMintFailMessage
	}
	return "🎉 Your account is ready. Open this link and set it up with a passkey:\n\n" +
		inv.ClaimURL(t.baseDomain) + "\n\nThe link is personal and expires — open it on the device you'll use."
}

// reply sends a managebot message, logging and swallowing failures.
func (t *TelegramAPI) reply(ctx context.Context, chatID int64, text string) {
	if err := t.managerClient().SendMessage(ctx, chatID, text); err != nil {
		slog.Error("telegram manager message: send reply", "error", err, "chat_id", chatID)
	}
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
	if upd.CallbackQuery != nil {
		t.handleCallbackQuery(w, r, ref, bot, upd.CallbackQuery)
		return
	}

	if upd.Message == nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	// A photo carries no command token in Text (a caption lives in a separate
	// field), so it must be handled BEFORE the botCommand switch — which would
	// otherwise drop it as empty. Only the file_id is sealed; the bytes never
	// touch the relay (bd med-vcv.1).
	if photo := upd.Message.LargestPhoto(); photo != nil {
		t.sealPhoto(w, r, ref, bot, upd.Message, photo)
		return
	}
	// A .nxk document is a Mi Band backup (bd med-nzz): parse it server-side and
	// seal the vitals streams. Like a photo it carries no command token, so it
	// must be handled before the botCommand switch. Any other document has no
	// text and falls through to the empty-message drop below.
	if doc := upd.Message.Document; doc != nil && strings.HasSuffix(strings.ToLower(doc.FileName), ".nxk") {
		t.sealNXKDocument(w, r, ref, bot, upd.Message)
		return
	}
	// The relay reads ONLY the leading token, and only to tell what it answers
	// itself from what it seals. It must not distinguish /bp from /bogus —
	// that would mean inspecting the command surface of a message it is
	// forbidden to understand. Unknown commands are therefore sealed like any
	// other and answered by the client at drain time.
	//
	// Free text (command == "") is sealed like a command and routed to the
	// drain-time AI agent (bd med-vcv.2). The relay still parses nothing and
	// calls no AI; it only seals the raw text, the same exposure the consent
	// screen already declares. A truly empty message (a sticker, a location)
	// carries no text to seal and is dropped.
	switch cmd := botCommand(upd.Message.Text); cmd {
	case "/start":
		// fall through to the linking path below
	case "":
		if strings.TrimSpace(upd.Message.Text) != "" {
			t.sealText(w, r, ref, bot, upd.Message)
			return
		}
		w.WriteHeader(http.StatusOK)
		return
	case "/help":
		client, err := t.botClient(bot)
		if err != nil {
			slog.Error("telegram child webhook: open token", "error", err, "ref", ref)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if err := client.SendMessage(r.Context(), upd.Message.Chat.ID, helpMessage); err != nil {
			slog.Error("telegram child webhook: send help", "error", err, "ref", ref)
		}
		w.WriteHeader(http.StatusOK)
		return
	default:
		t.sealCommand(w, r, ref, bot, upd.Message)
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
	// Backfill autocomplete for bots minted before mint-time registration.
	setChildCommands(r.Context(), client, ref)

	if err := client.SendMessage(r.Context(), upd.Message.Chat.ID, welcomeMessage); err != nil {
		slog.Error("telegram child webhook: send welcome", "error", err, "ref", ref)
		// chat is linked; a failed welcome send is not fatal — reply 200 so
		// Telegram doesn't retry the /start.
	}
	slog.Info("telegram bot linked", "account", ref, "chat_id", upd.Message.Chat.ID)
	w.WriteHeader(http.StatusOK)
}

// sealCommand handles every child-bot command the relay does not answer itself.
// It seals the message VERBATIM — no parsing, no AI, no logging of content —
// and replies with a fixed constant. Order matters: the "queued" reply is sent
// first so its message id can be sealed alongside the text, letting the client
// edit that exact message into a confirmation once it has applied the command.
//
// Always answers 200: a non-2xx makes Telegram redeliver, and a duplicate
// delivery would queue the command twice. Apply is idempotent, but the second
// "queued" message would be visible noise.
func (t *TelegramAPI) sealCommand(w http.ResponseWriter, r *http.Request, ref string, bot *cloudstore.TGBot, msg *tgclient.Message) {
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram child webhook: open token", "error", err, "ref", ref)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	reply := func(text string) {
		if err := client.SendMessage(r.Context(), msg.Chat.ID, text); err != nil {
			slog.Error("telegram child webhook: send reply", "error", err, "ref", ref)
		}
	}

	// No inbox key → the event MUST be dropped, never stored in the clear.
	if pub, err := t.store.AccountInboxPublicKey(r.Context(), ref); err != nil || len(pub) == 0 {
		if err != nil {
			slog.Error("telegram child webhook: read inbox key", "error", err, "ref", ref)
		}
		reply(setupMessage)
		w.WriteHeader(http.StatusOK)
		return
	}

	now := time.Now().UTC()
	// Send the placeholder BEFORE sealing so the client learns which message to
	// edit. If this send fails we still seal (the data matters more than the
	// receipt) — ReplyMessageID stays 0 and the client simply skips the edit.
	replyID, err := client.SendMessageReturningID(r.Context(), msg.Chat.ID, queuedMessage)
	if err != nil {
		slog.Error("telegram child webhook: send queued ack", "error", err, "ref", ref)
	}

	// SECURITY INVARIANT: msg.Text is message content. It is sealed here and
	// never logged, never stored in the clear, never sent anywhere else.
	plaintext, err := json.Marshal(tgCommandEvent{
		Kind:           inboxEventKindTGCommand,
		Text:           msg.Text,
		AtUnix:         now.Unix(),
		ReplyMessageID: replyID,
	})
	if err != nil {
		slog.Error("telegram child webhook: marshal command event", "error", err, "ref", ref)
		w.WriteHeader(http.StatusOK)
		return
	}

	switch err := SealAndQueue(r.Context(), t.store, ref, plaintext, now); {
	case errors.Is(err, ErrNoInboxKey):
		// Raced with a key deletion between the check above and here.
		reply(setupMessage)
	case err != nil:
		slog.Error("telegram child webhook: seal command", "error", err, "ref", ref)
		reply("Sorry — something went wrong. Try again.")
	default:
		slog.Info("telegram child webhook: command queued", "ref", ref, "bytes", len(msg.Text))
	}
	w.WriteHeader(http.StatusOK)
}

// sealPhoto seals a photo message's file_id into the mailbox — never the bytes
// (bd med-vcv.1). Structurally identical to sealCommand (queued ack first, then
// seal, always 200), differing only in the payload: a file_id handle instead of
// text. The client resolves and AI-parses it at drain time.
func (t *TelegramAPI) sealPhoto(w http.ResponseWriter, r *http.Request, ref string, bot *cloudstore.TGBot, msg *tgclient.Message, photo *tgclient.PhotoSize) {
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram child webhook: open token", "error", err, "ref", ref)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	reply := func(text string) {
		if err := client.SendMessage(r.Context(), msg.Chat.ID, text); err != nil {
			slog.Error("telegram child webhook: send reply", "error", err, "ref", ref)
		}
	}

	// No inbox key → the event MUST be dropped, never stored in the clear.
	if pub, err := t.store.AccountInboxPublicKey(r.Context(), ref); err != nil || len(pub) == 0 {
		if err != nil {
			slog.Error("telegram child webhook: read inbox key", "error", err, "ref", ref)
		}
		reply(setupMessage)
		w.WriteHeader(http.StatusOK)
		return
	}

	now := time.Now().UTC()
	replyID, err := client.SendMessageReturningID(r.Context(), msg.Chat.ID, queuedMessage)
	if err != nil {
		slog.Error("telegram child webhook: send queued ack", "error", err, "ref", ref)
	}

	// Telegram photos are always JPEG; there is no per-size mime field. The bytes
	// are never touched here — only this opaque handle is sealed.
	plaintext, err := json.Marshal(tgPhotoEvent{
		Kind:           inboxEventKindTGPhoto,
		FileID:         photo.FileID,
		Mime:           "image/jpeg",
		Size:           photo.FileSize,
		AtUnix:         now.Unix(),
		ReplyMessageID: replyID,
	})
	if err != nil {
		slog.Error("telegram child webhook: marshal photo event", "error", err, "ref", ref)
		w.WriteHeader(http.StatusOK)
		return
	}

	switch err := SealAndQueue(r.Context(), t.store, ref, plaintext, now); {
	case errors.Is(err, ErrNoInboxKey):
		reply(setupMessage)
	case err != nil:
		slog.Error("telegram child webhook: seal photo", "error", err, "ref", ref)
		reply("Sorry — something went wrong. Try again.")
	default:
		slog.Info("telegram child webhook: photo queued", "ref", ref)
	}
	w.WriteHeader(http.StatusOK)
}

// sealText seals a free-text message so the drain-time AI agent can act on it
// (bd med-vcv.2). Structurally identical to sealCommand — the relay parses
// nothing and calls no AI; it only seals the raw text and replies "Queued".
func (t *TelegramAPI) sealText(w http.ResponseWriter, r *http.Request, ref string, bot *cloudstore.TGBot, msg *tgclient.Message) {
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram child webhook: open token", "error", err, "ref", ref)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	reply := func(text string) {
		if err := client.SendMessage(r.Context(), msg.Chat.ID, text); err != nil {
			slog.Error("telegram child webhook: send reply", "error", err, "ref", ref)
		}
	}

	// No inbox key → the event MUST be dropped, never stored in the clear.
	if pub, err := t.store.AccountInboxPublicKey(r.Context(), ref); err != nil || len(pub) == 0 {
		if err != nil {
			slog.Error("telegram child webhook: read inbox key", "error", err, "ref", ref)
		}
		reply(setupMessage)
		w.WriteHeader(http.StatusOK)
		return
	}

	now := time.Now().UTC()
	replyID, err := client.SendMessageReturningID(r.Context(), msg.Chat.ID, queuedMessage)
	if err != nil {
		slog.Error("telegram child webhook: send queued ack", "error", err, "ref", ref)
	}

	// SECURITY INVARIANT: msg.Text is message content — sealed here, never logged,
	// never stored in the clear, never sent to an AI provider by the relay.
	plaintext, err := json.Marshal(tgTextEvent{
		Kind:           inboxEventKindTGText,
		Text:           msg.Text,
		AtUnix:         now.Unix(),
		ReplyMessageID: replyID,
	})
	if err != nil {
		slog.Error("telegram child webhook: marshal text event", "error", err, "ref", ref)
		w.WriteHeader(http.StatusOK)
		return
	}

	switch err := SealAndQueue(r.Context(), t.store, ref, plaintext, now); {
	case errors.Is(err, ErrNoInboxKey):
		reply(setupMessage)
	case err != nil:
		slog.Error("telegram child webhook: seal text", "error", err, "ref", ref)
		reply("Sorry — something went wrong. Try again.")
	default:
		slog.Info("telegram child webhook: text queued", "ref", ref)
	}
	w.WriteHeader(http.StatusOK)
}

// sealNXKDocument parses a Mi Band .nxk backup SERVER-SIDE (transient plaintext,
// same trust model as the Telegram inbound text/photo path) and seals the mapped
// vitals streams into the account's inbox (bd med-nzz). Unlike sealCommand it
// downloads and parses the file here — but still stores no plaintext at rest:
// the parsed streams are sealed to the account's inbox key. GPS is never sealed
// (parseNXKToVitalsEvents discards it). Always answers 200 (a redelivery would
// re-download and re-seal; the import id is deterministic so the client's drain
// converges). The "⏳ Queued" ack is edited into a success/failure summary.
func (t *TelegramAPI) sealNXKDocument(w http.ResponseWriter, r *http.Request, ref string, bot *cloudstore.TGBot, msg *tgclient.Message) {
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram child webhook: open token", "error", err, "ref", ref)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	reply := func(text string) {
		if err := client.SendMessage(r.Context(), msg.Chat.ID, text); err != nil {
			slog.Error("telegram child webhook: send reply", "error", err, "ref", ref)
		}
	}

	// Reject a wrong extension / over-cap file up front — the same guard the
	// bot-mode upload uses. The message is nxk.ValidateImportFile's own text
	// (extension/size), which leaks no internals.
	if err := nxk.ValidateImportFile(msg.Document.FileName, msg.Document.FileSize); err != nil {
		reply("⚠️ " + err.Error())
		w.WriteHeader(http.StatusOK)
		return
	}

	// No inbox key → the event MUST be dropped, never stored in the clear.
	if pub, err := t.store.AccountInboxPublicKey(r.Context(), ref); err != nil || len(pub) == 0 {
		if err != nil {
			slog.Error("telegram child webhook: read inbox key", "error", err, "ref", ref)
		}
		reply(setupMessage)
		w.WriteHeader(http.StatusOK)
		return
	}

	replyID, err := client.SendMessageReturningID(r.Context(), msg.Chat.ID, queuedMessage)
	if err != nil {
		slog.Error("telegram child webhook: send queued ack", "error", err, "ref", ref)
	}
	// edit rewrites the "⏳ Queued" ack into an outcome; when the ack send failed
	// (replyID 0) it sends a fresh message instead.
	edit := func(text string) {
		if replyID == 0 {
			reply(text)
			return
		}
		if err := client.EditMessageText(r.Context(), msg.Chat.ID, replyID, text); err != nil && !tgclient.IsMessageNotModified(err) {
			slog.Warn("telegram child webhook: edit nxk ack", "error", err, "ref", ref)
		}
	}

	tmpPath, err := t.downloadDocument(r.Context(), client, msg.Document)
	if err != nil {
		if tgclient.IsFileTooBig(err) {
			// Telegram's public Bot API refuses getFile for files >20 MB. Most
			// Mi Band backups exceed that; the fix is the operator running the
			// local Bot API proxy (CLOUD_TG_API_BASE_URL), not a retry.
			slog.Warn("telegram child webhook: nxk over 20MB bot limit", "ref", ref)
			edit("❌ That file is larger than Telegram's 20 MB bot limit. Ask the operator to enable the local Bot API proxy so large Mi Band backups can be imported.")
			w.WriteHeader(http.StatusOK)
			return
		}
		if tgclient.IsInvalidFileID(err) && t.apiBaseURL != "" {
			// file_ids are server-bound: this bot's webhook still lives on the
			// cloud (pre-proxy), so it delivers cloud-issued file_ids that the local
			// proxy rejects. The fix is the one-time cloud→local bot migration, not
			// a retry (bd med-eas.43).
			slog.Warn("telegram child webhook: invalid file_id under proxy — bot likely needs proxy migration; run `cloud admin migrate-bots-to-proxy` or re-link the bot", "ref", ref)
			edit("❌ This bot needs a one-time migration to the local Bot API proxy before it can import large files. Ask the operator to run the bot migration (or re-link the bot).")
			w.WriteHeader(http.StatusOK)
			return
		}
		slog.Error("telegram child webhook: download nxk", "error", err, "ref", ref)
		edit("❌ Couldn't download the file — try sending it again.")
		w.WriteHeader(http.StatusOK)
		return
	}
	defer os.Remove(tmpPath)

	events, err := parseNXKToVitalsEvents(tmpPath)
	if err != nil {
		// A bad file is the user's fault — never leak internals.
		slog.Warn("telegram child webhook: parse nxk", "error", err, "ref", ref)
		edit("❌ Couldn't read that Mi Band backup.")
		w.WriteHeader(http.StatusOK)
		return
	}

	now := time.Now().UTC()
	for _, ev := range events {
		ev.AtUnix = now.Unix()
		plaintext, err := json.Marshal(ev)
		if err != nil {
			slog.Error("telegram child webhook: marshal nxk event", "error", err, "ref", ref)
			edit("Sorry — something went wrong. Try again.")
			w.WriteHeader(http.StatusOK)
			return
		}
		switch err := SealAndQueue(r.Context(), t.store, ref, plaintext, now); {
		case errors.Is(err, ErrNoInboxKey):
			// Raced with a key deletion between the check above and here.
			edit(setupMessage)
			w.WriteHeader(http.StatusOK)
			return
		case err != nil:
			slog.Error("telegram child webhook: seal nxk", "error", err, "ref", ref)
			edit("Sorry — something went wrong. Try again.")
			w.WriteHeader(http.StatusOK)
			return
		}
	}
	slog.Info("telegram child webhook: nxk import queued", "ref", ref, "events", len(events))
	edit("✅ Backup queued — your Mi Band vitals appear when you next open the app.")
	w.WriteHeader(http.StatusOK)
}

// downloadDocument resolves a document's file_id and writes its bytes to a temp
// file, mirroring internal/bot/sleep_import.go's local-vs-remote fetch: a local
// Bot API server hands back an absolute path on a shared volume, otherwise the
// bytes stream over HTTP. Caller removes the returned path. The extension is
// preserved so nxk.ValidateImportFile (in parseNXKToVitalsEvents) sees .nxk.
func (t *TelegramAPI) downloadDocument(ctx context.Context, client *tgclient.Client, doc *tgclient.Document) (string, error) {
	file, err := client.GetFile(ctx, doc.FileID)
	if err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp("", "nxk-tg-*"+extForUpload(doc.FileName))
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	fail := func(err error) (string, error) {
		tmp.Close()
		os.Remove(tmpPath)
		return "", err
	}

	var src io.ReadCloser
	if strings.HasPrefix(file.FilePath, "/") {
		// Local Bot API mode: the file already lives on a shared volume.
		src, err = os.Open(file.FilePath) // #nosec G304 -- path is from Telegram getFile, not user input
	} else {
		src, _, err = client.DownloadFile(ctx, file.FilePath)
	}
	if err != nil {
		return fail(err)
	}
	defer src.Close()

	if _, err := io.Copy(tmp, src); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return "", err
	}
	return tmpPath, nil
}

// editReplyRequest is what an unlocked client posts after it has applied a
// sealed command and confirmed the write flushed.
type editReplyRequest struct {
	MessageID int64  `json:"message_id"`
	Text      string `json:"text"`
}

// maxEditTextRunes bounds the client-composed confirmation. Telegram's own cap
// is 4096; reject earlier so a bug can't turn the relay into a message cannon.
const maxEditTextRunes = 1000

// EditReply rewrites a "queued" placeholder into a confirmation the CLIENT
// composed. This adds no trust: the relay forwards a string it never derived,
// exactly as it already does for outbound reminder text (SendReminder), and it
// still cannot read the vault. The chat is taken from the stored bot row, never
// from the request — a session may only edit messages in its own bot's chat.
func (t *TelegramAPI) EditReply(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req editReplyRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<14)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	if req.MessageID <= 0 || req.Text == "" || len([]rune(req.Text)) > maxEditTextRunes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}

	bot, err := t.store.BotByAccount(r.Context(), sess.AccountID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && bot.ChatID == nil) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no_linked_chat"})
		return
	}
	if err != nil {
		slog.Error("telegram edit reply: load bot", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram edit reply: open token", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Never log req.Text — it is a confirmation derived from vault data.
	err = client.EditMessageText(r.Context(), *bot.ChatID, req.MessageID, req.Text)
	if err != nil && !tgclient.IsMessageNotModified(err) {
		slog.Warn("telegram edit reply: edit failed", "account", sess.AccountID, "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "edit_failed"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// cancelRefireRequest is the app-confirm cancel body: a med slot stem
// "s:<slotUnix>". The client sends it when a dose is confirmed/snoozed in the
// PWA (no Telegram tap), so the relay-owned re-fire chain stops for that slot.
type cancelRefireRequest struct {
	Callback string `json:"callback"`
}

// CancelRefire drops the relay-owned re-fire chain for a med slot the client
// confirmed/snoozed in the app. The prefix guard means a session can only cancel
// its own med "s:<slot>" re-fires, never an arbitrary callback. Best-effort from
// the client's side; here it validates, cancels, and returns 204.
func (t *TelegramAPI) CancelRefire(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req cancelRefireRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<12)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	if !strings.HasPrefix(req.Callback, tgclient.CallbackSlotPrefix) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_callback"})
		return
	}
	if _, err := t.store.CancelRelayRefire(r.Context(), sess.AccountID, req.Callback); err != nil {
		slog.Error("telegram cancel refire", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// maxPhotoProxyBytes caps what the photo proxy streams, matching the client's
// 8 MB image ceiling (web/cloud/js/aiclient.js). Telegram photos are far smaller;
// this only bounds a misbehaving upstream.
const maxPhotoProxyBytes = 8 << 20

// GetPhoto streams the bytes of a sealed photo's file_id to the unlocked client
// so it can AI-parse the meal locally (bd med-vcv.1). The relay resolves and
// forwards bytes but never inspects, stores, or logs them — the same
// forward-verbatim contract as EditReply, in the other direction.
//
// SECURITY: the file_id is resolved through THIS account's own bot token
// (getFile), which only Telegram can turn into pixels and only for files sent to
// this bot. That token — bound to the session's account via BotByAccount — is
// the whole access boundary; the relay cannot cross-check the file_id against
// the sealed mailbox because it is zero-knowledge ciphertext. A getFile failure
// (e.g. an expired handle) is a normal error the client acks rather than retries
// forever.
func (t *TelegramAPI) GetPhoto(w http.ResponseWriter, r *http.Request) {
	sess, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	fileID := r.URL.Query().Get("file_id")
	if fileID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing_file_id"})
		return
	}

	bot, err := t.store.BotByAccount(r.Context(), sess.AccountID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && bot.ChatID == nil) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no_linked_chat"})
		return
	}
	if err != nil {
		slog.Error("telegram photo: load bot", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram photo: open token", "error", err, "account", sess.AccountID)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	file, err := client.GetFile(r.Context(), fileID)
	if err != nil {
		// Expired/invalid handle or upstream hiccup — surface as a plain 502 the
		// client acks (never log the file_id: it is message-derived).
		slog.Warn("telegram photo: getFile failed", "account", sess.AccountID, "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "getfile_failed"})
		return
	}
	// Reject an over-cap file up front rather than streaming a silently-truncated
	// (corrupt) image the client would AI-parse into a wrong meal. getFile reports
	// the size before we download a byte.
	if file.FileSize > maxPhotoProxyBytes {
		slog.Warn("telegram photo: file over cap", "account", sess.AccountID, "size", file.FileSize)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "too_large"})
		return
	}
	body, contentType, err := client.DownloadFile(r.Context(), file.FilePath)
	if err != nil {
		slog.Warn("telegram photo: download failed", "account", sess.AccountID, "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "download_failed"})
		return
	}
	defer body.Close()

	if contentType == "" {
		contentType = "image/jpeg"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	// nosniff: the client consumes this via fetch()/blob() (never a top-level
	// navigation) and re-checks the type, but this is cheap defense-in-depth
	// against a future direct-navigation consumer.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Stream straight through — nothing buffered to disk, nothing logged but the
	// byte count on error. LimitReader is a backstop; the size gate above is the
	// real bound.
	if _, err := io.Copy(w, io.LimitReader(body, maxPhotoProxyBytes)); err != nil {
		slog.Warn("telegram photo: stream failed", "account", sess.AccountID, "error", err)
	}
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<14)
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
	setChildCommands(r.Context(), client, sess.AccountID)
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
	// Webhook was set through the proxy (if one is configured), so this bot is
	// born on the proxy and never needs the cloud→local migration.
	t.markNewBotOnProxy(r.Context(), sess.AccountID)
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

// inboxEventKindIntakeSlot is the sealed-event kind a Confirm/Snooze tap
// produces. The client's drain switches on it. AtUnix is the SERVER's timestamp
// for the tap, not the drain's — a Confirm tapped at 09:00 records taken-at
// 09:00 even if the app first opens at noon.
const inboxEventKindIntakeSlot = "intake_slot_action"

type intakeSlotEvent struct {
	Kind      string `json:"kind"`
	SlotUnix  int64  `json:"slot_unix"`
	Action    string `json:"action"`
	AtUnix    int64  `json:"at_unix"`
	MessageID int64  `json:"message_id"`
}

// inboxEventKindWorkoutSession is the sealed-event kind a workout Snooze/Skip tap
// produces (med-eas.70). The client's drain resolves the deterministic
// session-<groupId>-<date> record and applies the snooze/skip. Like the intake
// slot event, AtUnix is the SERVER's tap timestamp, not the drain's.
const inboxEventKindWorkoutSession = "workout_session_action"

type workoutSessionEvent struct {
	Kind      string `json:"kind"`
	GroupID   int64  `json:"group_id"`
	Date      string `json:"date"`
	Action    string `json:"action"`
	AtUnix    int64  `json:"at_unix"`
	MessageID int64  `json:"message_id"`
}

// inboxEventKindMeasureReminder is the sealed-event kind a BP/weight reminder
// Snooze/Skip tap produces (med-eas.76). BP and weight share ONE event kind; the
// client's drain routes on the event's Kind ("bp"|"weight") to the matching
// reminders-domain setter. Like the other tap events, AtUnix is the SERVER's tap
// timestamp so the mute window is pinned to when the button was pressed.
const inboxEventKindMeasureReminder = "measure_reminder_action"

type measureReminderEvent struct {
	Kind      string `json:"kind"`    // event kind, always inboxEventKindMeasureReminder
	Measure   string `json:"measure"` // "bp" | "weight"
	Action    string `json:"action"`  // "snooze" | "skip"
	AtUnix    int64  `json:"at_unix"`
	MessageID int64  `json:"message_id"`
}

// Replies to a button tap. Telegram spins the button until answerCallbackQuery
// lands, so every path answers — including the ones that discard the tap.
const (
	callbackAckConfirm = "✅ Saved — it will be recorded when you next open the app."
	callbackAckSnooze  = "⏰ Snoozed — it will apply when you next open the app."
	callbackAckSkipped = "⏭️ Skipped — it will apply when you next open the app."
	callbackAckDropped = "Open the app once to finish setting up, then try again."
	callbackAckUnknown = "Sorry — this button is no longer valid."
)

// handleCallbackQuery turns an inline Confirm/Snooze tap into a sealed mailbox
// event. The server cannot apply the tap itself (it cannot write ciphertext it
// cannot produce), so it seals the intent to the account's inbox key and lets an
// unlocked client apply it through the domain layer at drain time.
//
// It always replies 200: a tap is not worth re-driving. Telegram redelivers a
// non-2xx webhook, which for an already-sealed event would queue a duplicate —
// harmless (the apply is idempotent) but pointless. The one thing we never do is
// store the tap in the clear when no inbox key exists: that plaintext is exactly
// what this design withholds.
func (t *TelegramAPI) handleCallbackQuery(w http.ResponseWriter, r *http.Request, ref string, bot *cloudstore.TGBot, cq *tgclient.CallbackQuery) {
	// Best-effort ack helper: a failure to answer only leaves a spinner.
	answer := func(text string) {
		if cq.ID == "" {
			return
		}
		client, err := t.botClient(bot)
		if err != nil {
			slog.Error("telegram callback: open token", "error", err, "ref", ref)
			return
		}
		if err := client.AnswerCallbackQuery(r.Context(), cq.ID, text); err != nil {
			slog.Warn("telegram callback: answer failed", "error", err, "ref", ref)
		}
	}

	// A callback from a chat other than the linked one is not this account's
	// user. Telegram omits Message for old messages, so this can only be
	// enforced when it is present.
	if cq.Message != nil && bot.ChatID != nil && cq.Message.Chat.ID != *bot.ChatID {
		slog.Warn("telegram callback: chat mismatch, ignoring", "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	// cq.Message is optional — Telegram omits it for old messages, leaving the id
	// 0. A 0 message_id makes the drain-time edit a safe no-op (the confirm still
	// records); the data fix is independent of the cosmetic message edit.
	var messageID int64
	if cq.Message != nil {
		messageID = cq.Message.MessageID
	}

	// Workout taps live in their own callback namespace ("w:") and drive the
	// snooze/skip + relay re-fire path (med-eas.70). Route them before the med
	// (s:) parser so the two namespaces never cross-parse.
	if tgclient.IsWorkoutCallback(cq.Data) {
		t.handleWorkoutCallback(w, r, ref, bot, cq, messageID, answer)
		return
	}

	// BP/weight taps live in the "bp:"/"wt:" namespaces (med-eas.76) and drive the
	// same snooze/skip + relay re-fire path. Route them before the med (s:) parser
	// so the namespaces never cross-parse.
	if tgclient.IsMeasureCallback(cq.Data) {
		t.handleMeasureCallback(w, r, ref, bot, cq, messageID, answer)
		return
	}

	slotUnix, action, ok := tgclient.ParseCallbackData(cq.Data)
	if !ok {
		slog.Warn("telegram callback: unparseable callback_data", "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	now := time.Now().UTC()
	plaintext, err := json.Marshal(intakeSlotEvent{
		Kind:      inboxEventKindIntakeSlot,
		SlotUnix:  slotUnix,
		Action:    action,
		AtUnix:    now.Unix(),
		MessageID: messageID,
	})
	if err != nil {
		slog.Error("telegram callback: marshal event", "error", err, "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	// ref IS the account id (see BotByWebhookRef).
	switch err := SealAndQueue(r.Context(), t.store, ref, plaintext, now); {
	case errors.Is(err, ErrNoInboxKey):
		// The account has never unlocked a client, so there is no key to seal
		// to. Drop the tap rather than store it readable.
		slog.Warn("telegram callback: no inbox key, dropping tap", "ref", ref)
		answer(callbackAckDropped)
	case err != nil:
		slog.Error("telegram callback: seal and queue", "error", err, "ref", ref)
		answer(callbackAckUnknown)
	case action == tgclient.CallbackActionSnooze:
		// Schedule a relay-owned Telegram re-fire ~1h out so the reminder re-arrives
		// even if the PWA never reopens (mirrors the workout snooze path). The stem
		// "s:<slotUnix>" is the tapped callback minus its ":<action>" suffix; the
		// re-fire only COPIES already-cleartext fields, never reading `ct`. Cancel +
		// insert supersede any pending re-fire so a re-snooze reschedules instead of
		// stacking. Log-and-swallow: a failed reschedule never fails the 200.
		stem := strings.TrimSuffix(cq.Data, ":"+action)
		refireText := medRefireText
		if cq.Message != nil && cq.Message.Text != "" {
			refireText = cq.Message.Text
		}
		if err := t.store.RescheduleRelayRefire(r.Context(), ref, now.Add(time.Hour), refireText, stem, messageID); err != nil {
			slog.Error("telegram callback: reschedule med relay refire", "error", err, "ref", ref)
		}
		t.editCallbackMessage(r.Context(), bot, ref, messageID, medSnoozeEditText)
		answer(callbackAckSnooze)
	default:
		// A Confirm stops the relay-owned re-fire chain for this slot (mirrors the
		// workout Skip path). The stem "s:<slotUnix>" is the tapped callback minus
		// its ":confirm" suffix. Log-and-swallow: a failed cancel never fails the 200.
		stem := strings.TrimSuffix(cq.Data, ":"+action)
		if _, err := t.store.CancelRelayRefire(r.Context(), ref, stem); err != nil {
			slog.Error("telegram callback: cancel med relay refire", "error", err, "ref", ref)
		}
		t.editCallbackMessage(r.Context(), bot, ref, messageID, medConfirmEditText)
		answer(callbackAckConfirm)
	}
	w.WriteHeader(http.StatusOK)
}

// editCallbackMessage rewrites a tapped reminder (med, workout, or measure) into
// static text and drops its buttons the instant the tap lands, so the user can't
// re-tap while
// the client's drain-time EditReply is still pending. Best-effort: a 0
// messageID (Telegram omitted an old cq.Message) or a failed edit only logs; the
// seal + toast already acked the tap and the client drain still finalizes the
// real receipt. ZERO-KNOWLEDGE: text is a caller-supplied static const only.
func (t *TelegramAPI) editCallbackMessage(ctx context.Context, bot *cloudstore.TGBot, ref string, messageID int64, text string) {
	if messageID == 0 || bot.ChatID == nil {
		return
	}
	client, err := t.botClient(bot)
	if err != nil {
		slog.Error("telegram callback: open token for edit", "error", err, "ref", ref)
		return
	}
	if err := client.EditMessageTextClearMarkup(ctx, *bot.ChatID, messageID, text); err != nil && !tgclient.IsMessageNotModified(err) {
		slog.Warn("telegram callback: edit message failed", "error", err, "ref", ref)
	}
}

// workoutRefireText is the generic re-fire body used when Telegram omits the
// original message (too old to edit), so the copy path never has to read vault
// data to reconstruct it.
const workoutRefireText = "Workout reminder"

// medRefireText is the generic re-fire body used when Telegram omits the
// original message (too old to edit/copy), so the relay never reads vault data
// to reconstruct a med reminder body.
const medRefireText = "Medication reminder"

// Static, server-composed message bodies written the instant a med Confirm/
// Snooze button is tapped. They replace the original message text and clear its
// buttons so the user can't re-tap while the client's drain-time EditReply is
// still pending. ZERO-KNOWLEDGE: templated only — never a medication name or any
// vault value.
const (
	medConfirmEditText = "✅ Confirmed — waiting for your device to come online to record it."
	medSnoozeEditText  = "⏰ Snoozed 1h — I'll remind you again."

	// Static edit-text for workout + measure (BP/weight) taps. Same ZK contract:
	// server-composed templates only, never a vault value. Workout snooze omits
	// the duration (1h vs 2h) so one const covers both; measure snooze is always
	// 1h. The skip text is shared by workout and measure.
	workoutSnoozeEditText = "⏰ Snoozed — I'll remind you again."
	measureSnoozeEditText = "⏰ Snoozed 1h — I'll remind you again."
	reminderSkipEditText  = "⏭️ Skipped — waiting for your device to record it."
)

// handleWorkoutCallback applies a workout Snooze/Skip tap ("w:" namespace,
// med-eas.70). Like the med path it seals a session-reconciliation event to the
// account's inbox key (the relay can't write vault ciphertext), then — the new
// relay capability — on a snooze it schedules a relay-owned Telegram re-fire so
// the reminder re-arrives even if the PWA never reopens, and on a skip it
// cancels any pending re-fire. The re-fire only COPIES already-cleartext fields
// (message text + the same "w:" stem at a new fire_at); it never reads `ct`, so
// the zero-knowledge posture is unchanged. Always answers 200.
func (t *TelegramAPI) handleWorkoutCallback(w http.ResponseWriter, r *http.Request, ref string, bot *cloudstore.TGBot, cq *tgclient.CallbackQuery, messageID int64, answer func(string)) {
	groupID, date, action, ok := tgclient.ParseWorkoutCallback(cq.Data)
	if !ok {
		slog.Warn("telegram callback: unparseable workout callback_data", "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	now := time.Now().UTC()
	plaintext, err := json.Marshal(workoutSessionEvent{
		Kind:      inboxEventKindWorkoutSession,
		GroupID:   groupID,
		Date:      date,
		Action:    action,
		AtUnix:    now.Unix(),
		MessageID: messageID,
	})
	if err != nil {
		slog.Error("telegram callback: marshal workout event", "error", err, "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	// ref IS the account id (see BotByWebhookRef).
	switch err := SealAndQueue(r.Context(), t.store, ref, plaintext, now); {
	case errors.Is(err, ErrNoInboxKey):
		// No key to seal to (and no client that could ever reconcile the session),
		// so drop the tap AND schedule no re-fire.
		slog.Warn("telegram callback: no inbox key, dropping workout tap", "ref", ref)
		answer(callbackAckDropped)
		w.WriteHeader(http.StatusOK)
		return
	case err != nil:
		slog.Error("telegram callback: seal and queue workout", "error", err, "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	// The re-fire re-uses the tapped session's stem "w:<groupId>:<YYYYMMDD>" so the
	// user can snooze again from the re-delivered message. The stem is the tapped
	// callback minus its validated ":<action>" suffix.
	stem := strings.TrimSuffix(cq.Data, ":"+action)
	switch action {
	case tgclient.CallbackActionSnooze1h, tgclient.CallbackActionSnooze2h:
		delay := time.Hour
		if action == tgclient.CallbackActionSnooze2h {
			delay = 2 * time.Hour
		}
		refireText := workoutRefireText
		if cq.Message != nil && cq.Message.Text != "" {
			refireText = cq.Message.Text
		}
		// Supersede any pending re-fire for this session so a re-snooze (or an
		// accidental double-tap — the buttons stay live) reschedules instead of
		// stacking a second delivery. Snooze1h and Snooze2h share the same stem.
		// Cancel + insert are one transaction so two concurrent snooze taps can't
		// both delete-then-insert and leave duplicate pending re-fires.
		if err := t.store.RescheduleRelayRefire(r.Context(), ref, now.Add(delay), refireText, stem, messageID); err != nil {
			slog.Error("telegram callback: reschedule relay refire", "error", err, "ref", ref)
		}
		t.editCallbackMessage(r.Context(), bot, ref, messageID, workoutSnoozeEditText)
		answer(callbackAckSnooze)
	case tgclient.CallbackActionSkip:
		if _, err := t.store.CancelRelayRefire(r.Context(), ref, stem); err != nil {
			slog.Error("telegram callback: cancel relay refire", "error", err, "ref", ref)
		}
		t.editCallbackMessage(r.Context(), bot, ref, messageID, reminderSkipEditText)
		answer(callbackAckSkipped)
	}
	w.WriteHeader(http.StatusOK)
}

// measureRefireText is the generic re-fire body used when Telegram omits the
// original message (too old to edit), so the relay never reads vault data to
// reconstruct a BP/weight reminder body.
const measureRefireText = "Measurement reminder"

// handleMeasureCallback applies a BP/weight reminder Snooze/Skip tap
// ("bp:"/"wt:" namespaces, med-eas.76). It mirrors handleWorkoutCallback: seal a
// measure-reconciliation event to the account's inbox key (the relay can't write
// vault ciphertext), then on Snooze schedule a relay-owned Telegram re-fire ~1h
// out and on Skip cancel any pending re-fire. The re-fire only COPIES
// already-cleartext fields (message text + the same stem at a new fire_at); it
// never reads `ct`, so the zero-knowledge posture is unchanged. Always answers
// 200.
func (t *TelegramAPI) handleMeasureCallback(w http.ResponseWriter, r *http.Request, ref string, bot *cloudstore.TGBot, cq *tgclient.CallbackQuery, messageID int64, answer func(string)) {
	kind, _, action, ok := tgclient.ParseMeasureCallback(cq.Data)
	if !ok {
		slog.Warn("telegram callback: unparseable measure callback_data", "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	// The callback action is snooze1h/skip; the sealed event carries the coarse
	// snooze/skip the client's drain switches on.
	eventAction := "snooze"
	if action == tgclient.CallbackActionSkip {
		eventAction = "skip"
	}

	now := time.Now().UTC()
	plaintext, err := json.Marshal(measureReminderEvent{
		Kind:      inboxEventKindMeasureReminder,
		Measure:   kind,
		Action:    eventAction,
		AtUnix:    now.Unix(),
		MessageID: messageID,
	})
	if err != nil {
		slog.Error("telegram callback: marshal measure event", "error", err, "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	// ref IS the account id (see BotByWebhookRef).
	switch err := SealAndQueue(r.Context(), t.store, ref, plaintext, now); {
	case errors.Is(err, ErrNoInboxKey):
		slog.Warn("telegram callback: no inbox key, dropping measure tap", "ref", ref)
		answer(callbackAckDropped)
		w.WriteHeader(http.StatusOK)
		return
	case err != nil:
		slog.Error("telegram callback: seal and queue measure", "error", err, "ref", ref)
		answer(callbackAckUnknown)
		w.WriteHeader(http.StatusOK)
		return
	}

	// The re-fire re-uses the tapped stem "<bp:|wt:><slotUnix>" so the user can
	// snooze again from the re-delivered message; it's the tapped callback minus
	// its validated ":<action>" suffix.
	stem := strings.TrimSuffix(cq.Data, ":"+action)
	switch action {
	case tgclient.CallbackActionSnooze1h:
		refireText := measureRefireText
		if cq.Message != nil && cq.Message.Text != "" {
			refireText = cq.Message.Text
		}
		if err := t.store.RescheduleRelayRefire(r.Context(), ref, now.Add(time.Hour), refireText, stem, messageID); err != nil {
			slog.Error("telegram callback: reschedule measure relay refire", "error", err, "ref", ref)
		}
		t.editCallbackMessage(r.Context(), bot, ref, messageID, measureSnoozeEditText)
		answer(callbackAckSnooze)
	case tgclient.CallbackActionSkip:
		if _, err := t.store.CancelRelayRefire(r.Context(), ref, stem); err != nil {
			slog.Error("telegram callback: cancel measure relay refire", "error", err, "ref", ref)
		}
		t.editCallbackMessage(r.Context(), bot, ref, messageID, reminderSkipEditText)
		answer(callbackAckSkipped)
	}
	w.WriteHeader(http.StatusOK)
}

// ErrNoLinkedChat means the account has a bot row but the user never tapped
// /start, so there is no chat to deliver to. The relay treats this as terminal
// for that entry rather than retrying it forever.
var ErrNoLinkedChat = errors.New("telegram: bot has no linked chat")

// reminderDeepLink composes the account's deep-link URL for a bottom-nav section
// (workouts/bp/weight): https://<subdomain>.<baseDomain>/?tab=<section>. The
// only account-specific part is the subdomain (a public routing label, not vault
// data), so this leaks nothing the relay doesn't already route by. Returns "" if
// the subdomain can't be resolved; the caller drops the empty-URL button.
func (t *TelegramAPI) reminderDeepLink(ctx context.Context, accountID, section string) string {
	subdomain, err := t.store.SubdomainByAccount(ctx, accountID)
	if err != nil || subdomain == "" {
		slog.Warn("telegram send reminder: subdomain lookup failed, dropping deep-link button", "error", err, "accountID", accountID)
		return ""
	}
	return "https://" + subdomain + "." + t.baseDomain + "/?tab=" + section
}

// dropEmptyURLButtons removes any URL button whose URL failed to resolve — an
// empty url is rejected by Telegram, so we degrade to a smaller keyboard rather
// than a rejected send. Callback buttons (empty URL, populated CallbackData) are
// kept.
func dropEmptyURLButtons(buttons []tgclient.InlineKeyboardButton) []tgclient.InlineKeyboardButton {
	out := buttons[:0]
	for _, b := range buttons {
		if b.CallbackData == "" && b.URL == "" {
			continue
		}
		out = append(out, b)
	}
	return out
}

// SendReminder forwards a client-composed reminder to the account's linked bot
// (the relay's TelegramSender). text arrives as plaintext because the relay
// cannot decrypt the vault — the client chose this exact string at its chosen
// verbosity and handed it over knowing the relay reads it. Nothing here derives
// text from account data.
//
// callbackStem is "s:<slotUnix>" for a medication dose reminder and "" for
// everything else. When set, Confirm/Snooze buttons ride along; a tap comes back
// to ChildWebhook, is sealed to the account's inbox key, and is applied by an
// unlocked client at drain time.
func (t *TelegramAPI) SendReminder(ctx context.Context, accountID, text, callbackStem string) (int64, error) {
	bot, err := t.store.BotByAccount(ctx, accountID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNoLinkedChat
	}
	if err != nil {
		return 0, err
	}
	if bot.ChatID == nil {
		return 0, ErrNoLinkedChat
	}
	client, err := t.botClient(bot)
	if err != nil {
		return 0, err
	}
	// A stem the client never should have sent (or a tampered row) would become
	// callback_data we cannot parse back. Drop the buttons, keep the reminder.
	if callbackStem != "" && !tgclient.ValidCallbackStem(callbackStem) {
		slog.Warn("telegram send reminder: invalid callback stem, sending without buttons", "accountID", accountID)
		callbackStem = ""
	}
	if callbackStem == "" {
		return client.SendMessageReturningID(ctx, *bot.ChatID, text)
	}
	// The button set is chosen by the stem's namespace: workout ("w:") reminders
	// get ▶️ Start (deep link) + Snooze 1h / Snooze 2h / Skip; measure ("bp:"/"wt:")
	// reminders get 🌐 Open (deep link) + Snooze 1h / Skip; medication ("s:")
	// reminders keep the original Confirm / Snooze pair (med-eas.70/.75/.76).
	var buttons []tgclient.InlineKeyboardButton
	switch {
	case tgclient.IsWorkoutCallback(callbackStem):
		buttons = []tgclient.InlineKeyboardButton{
			{Text: "▶️ Start", URL: t.reminderDeepLink(ctx, accountID, "workouts")},
			{Text: "⏰ Snooze 1h", CallbackData: callbackStem + ":" + tgclient.CallbackActionSnooze1h},
			{Text: "⏰ Snooze 2h", CallbackData: callbackStem + ":" + tgclient.CallbackActionSnooze2h},
			{Text: "⏭️ Skip", CallbackData: callbackStem + ":" + tgclient.CallbackActionSkip},
		}
	case tgclient.IsMeasureCallback(callbackStem):
		section := "bp"
		if strings.HasPrefix(callbackStem, tgclient.CallbackWeightPrefix) {
			section = "weight"
		}
		buttons = []tgclient.InlineKeyboardButton{
			{Text: "🌐 Open", URL: t.reminderDeepLink(ctx, accountID, section)},
			{Text: "⏰ Snooze 1h", CallbackData: callbackStem + ":" + tgclient.CallbackActionSnooze1h},
			{Text: "⏭️ Skip", CallbackData: callbackStem + ":" + tgclient.CallbackActionSkip},
		}
	default:
		buttons = []tgclient.InlineKeyboardButton{
			{Text: "✅ Confirm", CallbackData: callbackStem + ":" + tgclient.CallbackActionConfirm},
			{Text: "⏰ Snooze", CallbackData: callbackStem + ":" + tgclient.CallbackActionSnooze},
		}
	}
	// Drop any button whose deep link could not be resolved (empty URL is invalid
	// to Telegram) so a subdomain-lookup miss degrades to a smaller keyboard
	// rather than a rejected send.
	buttons = dropEmptyURLButtons(buttons)
	return client.SendMessageWithButtonsReturningID(ctx, *bot.ChatID, text, buttons)
}

// DeleteReminder removes a previously-sent reminder message from the account's
// linked bot chat. It is account-scoped and best-effort: it resolves the chat by
// account internally (so the relay never touches a chat_id) and swallows every
// Telegram error — a message the user already deleted, one older than Telegram's
// 48h bot-delete limit, or a revoked token must never abort the re-fire chain.
// messageID <= 0 means "nothing to delete" and is a no-op. The messageID is a TG
// artifact the relay already holds; no vault data is read here.
func (t *TelegramAPI) DeleteReminder(ctx context.Context, accountID string, messageID int64) error {
	if messageID <= 0 {
		return nil
	}
	bot, err := t.store.BotByAccount(ctx, accountID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && bot.ChatID == nil) {
		return nil
	}
	if err != nil {
		slog.Warn("telegram delete reminder: load bot", "error", err, "account", accountID)
		return nil
	}
	client, err := t.botClient(bot)
	if err != nil {
		slog.Warn("telegram delete reminder: bot client", "error", err, "account", accountID)
		return nil
	}
	if derr := client.DeleteMessage(ctx, *bot.ChatID, messageID); derr != nil {
		slog.Warn("telegram delete reminder: best-effort delete failed", "error", derr, "account", accountID, "messageID", messageID)
	}
	return nil
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

// TeardownForAccount deletes the account's Telegram webhook and bot binding,
// best-effort, for the self-service account-delete path (med-d5t.8). The DB row
// is also removed by the account delete's transaction, but the webhook lives on
// Telegram's side and must be torn down here, using the token before it is gone.
// Every step is logged and swallowed: a friend must be able to leave even when
// Telegram is unreachable.
func (t *TelegramAPI) TeardownForAccount(ctx context.Context, accountID string) {
	bot, err := t.store.BotByAccount(ctx, accountID)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Warn("account teardown: load telegram bot", "error", err, "account", accountID)
		}
		return
	}
	if client, cerr := t.botClient(bot); cerr == nil {
		if werr := client.DeleteWebhook(ctx); werr != nil {
			slog.Warn("account teardown: delete telegram webhook", "error", werr, "account", accountID)
		}
	}
	if derr := t.store.DeleteBot(ctx, accountID); derr != nil {
		slog.Warn("account teardown: delete telegram bot row", "error", derr, "account", accountID)
	}
}

// markNewBotOnProxy stamps a freshly-linked bot as proxy-migrated when a proxy
// is configured: its webhook was just set through the proxy, so it was born on
// the local server and never needs the cloud→local migration. A no-op (and a
// harmless best-effort stamp) when no proxy is configured — those bots stay NULL
// so a later `migrate-bots-to-proxy` run picks them up if the proxy is enabled.
func (t *TelegramAPI) markNewBotOnProxy(ctx context.Context, accountID string) {
	if t.apiBaseURL == "" {
		return
	}
	if err := t.store.MarkProxyMigrated(ctx, accountID, time.Now().UTC()); err != nil {
		slog.Warn("telegram: mark new bot proxy-migrated", "error", err, "account", accountID)
	}
}

// MigrateBotsToProxy moves every not-yet-migrated linked bot from the cloud Bot
// API to the local proxy: logOut on api.telegram.org (releasing the bot from
// Telegram's DC), then re-setWebhook THROUGH the proxy so subsequent updates
// carry proxy-issued file_ids. file_ids are server-bound, so this is the only
// way a pre-proxy bot's getFile can succeed against the local server. logOut is
// effectively one-way for ~10 minutes, so this is an explicit operator action
// (`cloud admin migrate-bots-to-proxy`), never a silent per-startup sweep.
// Returns how many bots were migrated and how many failed (left un-stamped so a
// re-run retries them). Errors only on a proxy misconfiguration or a DB read.
func (t *TelegramAPI) MigrateBotsToProxy(ctx context.Context) (migrated, failed int, err error) {
	if t.apiBaseURL == "" {
		return 0, 0, errors.New("no Bot API proxy configured (CLOUD_TG_API_BASE_URL is empty); nothing to migrate")
	}
	bots, err := t.store.BotsNeedingProxyMigration(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("list bots needing migration: %w", err)
	}
	for i := range bots {
		bot := &bots[i]
		token, oerr := openTGToken(t.sessionSecret, bot.TokenCT, bot.TokenNonce)
		if oerr != nil {
			slog.Error("migrate bots: open token", "error", oerr, "account", bot.AccountID)
			failed++
			continue
		}
		// logOut against the CLOUD server (api.telegram.org), regardless of the
		// proxy the migrated client will use.
		cloud := tgclient.New(token, t.cloudAPIBaseURL)
		if lerr := cloud.LogOut(ctx); lerr != nil {
			// "already logged out" style responses are fine — the bot is already
			// free of the cloud DC, so proceed to setWebhook via the proxy.
			if tgclient.IsClientError(lerr) {
				slog.Warn("migrate bots: cloud logOut rejected (treating as already logged out)", "error", lerr, "account", bot.AccountID)
			} else {
				slog.Error("migrate bots: cloud logOut", "error", lerr, "account", bot.AccountID)
				failed++
				continue
			}
		}
		// Re-point the webhook through the proxy. This is the first proxy request,
		// which auto-logs the bot into the local server (shared TELEGRAM_API_ID/HASH).
		proxy := tgclient.New(token, t.apiBaseURL)
		if werr := proxy.SetWebhook(ctx, t.childWebhookURL(bot.AccountID, bot.WebhookSecret), bot.WebhookSecret); werr != nil {
			slog.Error("migrate bots: setWebhook via proxy", "error", werr, "account", bot.AccountID)
			failed++
			continue
		}
		setChildCommands(ctx, proxy, bot.AccountID)
		if merr := t.store.MarkProxyMigrated(ctx, bot.AccountID, time.Now().UTC()); merr != nil {
			slog.Error("migrate bots: mark migrated", "error", merr, "account", bot.AccountID)
			failed++
			continue
		}
		slog.Info("migrate bots: migrated to proxy", "account", bot.AccountID, "bot_username", bot.BotUsername)
		migrated++
	}
	return migrated, failed, nil
}

// childWebhookURL builds the child-webhook URL for a bot secret. With the local
// Bot API proxy on, the proxy delivers webhooks itself and can't resolve the
// public host, so proxy-delivered bots get an internal docker-network URL
// (internalWebhookBase); otherwise the public https origin (bd med-eas.46).
func (t *TelegramAPI) childWebhookURL(accountID, botSecret string) string {
	origin := "https://" + t.baseDomain
	if t.internalWebhookBase != "" {
		origin = t.internalWebhookBase
	}
	return origin + "/tg/bot/" + accountID + "/" + botSecret
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
