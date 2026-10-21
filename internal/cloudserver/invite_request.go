package cloudserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/tgclient"
)

// Request an invite (bd med-ta2n.14). Someone without an invite asks for one —
// by email from the in-app sheet (POST /api/invite-requests, base host, no
// session) or by saying "yes" to the manager bot — and the admin decides with
// Approve / Decline buttons in the admin chat (FEEDBACK_ADMIN_CHAT_ID). Approve
// mints the invite and delivers it: by email over SMTP, or as a DM from the
// manager bot. The callback mints accounts, so it is honoured only from the
// admin's own Telegram user, only on the message that carries the request, and
// only once (the row's status moves out of pending exactly once).

const inviteRequestsPath = "/api/invite-requests"

const (
	inviteRequestIPMax      = 5
	inviteRequestIPWindow   = time.Hour
	inviteRequestDailyCap   = 50
	inviteRequestDedupe     = 7 * 24 * time.Hour
	inviteRequestNoteMax    = 500
	inviteRequestEmailMax   = 254
	inviteRequestWorkBudget = 60 * time.Second // mint + SMTP + edit, off the webhook
	// inviteRequestStaleAfter: an 'approved' row older than this has outlived
	// its run (budget + the settle's own timeout + slack) and Approve re-runs it.
	inviteRequestStaleAfter = 2 * inviteRequestWorkBudget
	inviteCallbackPrefix    = "ir:"
)

// Copy for the Telegram channel and the admin chat (server constants).
const (
	inviteTGAskedMessage   = "Thanks — I've asked the admin. You'll get your link here once it's approved."
	inviteTGAlreadyMessage = "You've already asked recently. Please wait a few days before asking again."
	inviteTGClosedMessage  = "Invites are closed right now."
	inviteTGDeclineMessage = "Sorry, invites are closed for now."
	inviteTGFailMessage    = "Sorry, I couldn't pass that on just now. Please try again in a few minutes."
)

// InviteRequestAPI serves POST /api/invite-requests. It is always mounted; it
// answers 404 until Enable hands it a Telegram surface that has a mailer and an
// admin chat (the sheet then falls back to the landing page's mailto).
type InviteRequestAPI struct {
	store   *cloudstore.Repo
	limiter *rateLimiter // per IP, in memory only: no IP is ever stored
	tg      *TelegramAPI
	mu      sync.Mutex // serializes daily-cap + dedupe + insert across requests
}

// NewInviteRequestAPI builds the handler.
func NewInviteRequestAPI(store *cloudstore.Repo) *InviteRequestAPI {
	return &InviteRequestAPI{
		store:   store,
		limiter: newRateLimiter(inviteRequestIPMax, inviteRequestIPWindow),
	}
}

// Enable turns the email endpoint on, and reports whether it did: it needs the
// manager bot's admin chat (who approves) and a mailer (who delivers). Without
// either, POST answers 404 and the app keeps the landing page's mailto.
func (a *InviteRequestAPI) Enable(tg *TelegramAPI) bool {
	if tg == nil || tg.feedbackAdminChatID == 0 || tg.mailer == nil {
		return false
	}
	a.tg = tg
	return true
}

// RegisterRoutes mounts the POST and its CORS preflight (the local-mode app
// posts cross-origin from its bundled origin). router.go forwards the path from
// the base host only.
func (a *InviteRequestAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("OPTIONS "+inviteRequestsPath, a.ServeHTTP)
	mux.HandleFunc("POST "+inviteRequestsPath, a.ServeHTTP)
}

type inviteRequestBody struct {
	Email string `json:"email"`
	Note  string `json:"note"`
}

func (a *InviteRequestAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	if origin := r.Header.Get("Origin"); origin == localAppOrigin || origin == androidLocalOrigin {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Add("Vary", "Origin")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "POST")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			h.Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if a.tg == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_enabled"})
		return
	}
	ip := clientIP(r)
	if !a.limiter.Allow(ip) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"})
		return
	}
	var body inviteRequestBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request"})
		return
	}
	email, ok := normalizeRequestEmail(body.Email)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_email"})
		return
	}
	note := strings.TrimSpace(body.Note)
	if !utf8.ValidString(note) || utf8.RuneCountInString(note) > inviteRequestNoteMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_note"})
		return
	}
	a.mu.Lock()
	id, created, err := a.store.CreateEmailInviteRequest(r.Context(), email, note, time.Now().UTC(), inviteRequestDedupe, inviteRequestDailyCap)
	a.mu.Unlock()
	switch {
	case errors.Is(err, cloudstore.ErrInviteRequestsFull):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "busy"})
		return
	case err != nil:
		slog.Error("invite request: store", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		return
	}
	if created {
		text := "📨 Invite request (email)\n" + email
		if note != "" {
			text += "\n\n" + note
		}
		a.tg.inviteWork.Add(1)
		go func() {
			defer a.tg.inviteWork.Done()
			ctx, cancel := context.WithTimeout(context.Background(), feedbackPingTimeout)
			defer cancel()
			a.tg.pingInviteRequest(ctx, id, text)
		}()
	}
	// The same answer for a new request and a duplicate: never reveal state.
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "sent"})
}

// normalizeRequestEmail accepts one bare address (no display name, no angle
// brackets, no CR/LF or other control characters) and lowercases it. This value
// is the only thing that ever reaches RCPT TO and the To header.
func normalizeRequestEmail(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > inviteRequestEmailMax || strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return "", false
	}
	a, err := mail.ParseAddress(s)
	if err != nil || a.Name != "" || a.Address != s || !strings.Contains(s[strings.LastIndex(s, "@")+1:], ".") {
		return "", false
	}
	return strings.ToLower(s), true
}

// inviteRequestsEnabled: the Telegram channel needs only the admin chat.
func (t *TelegramAPI) inviteRequestsEnabled() bool { return t.feedbackAdminChatID != 0 }

// WaitInviteWork waits for in-flight admin pings and approval work (mint +
// email/DM), or until ctx ends; false means some was cut off. For shutdown:
// the webhook has already recorded the decision and returned.
func (t *TelegramAPI) WaitInviteWork(ctx context.Context) bool {
	done := make(chan struct{})
	go func() { t.inviteWork.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}

// SetSMTP gives the Approve path its SMTP transport.
func (t *TelegramAPI) SetSMTP(cfg SMTPConfig) { t.mailer = newSMTPMailer(cfg) }

func inviteButtons(id int64) []tgclient.InlineKeyboardButton {
	n := strconv.FormatInt(id, 10)
	return []tgclient.InlineKeyboardButton{
		{Text: "✅ Approve", CallbackData: inviteCallbackPrefix + n + ":a"},
		{Text: "✖️ Decline", CallbackData: inviteCallbackPrefix + n + ":d"},
	}
}

// pingInviteRequest posts the request with its two buttons to the admin chat
// and records the message id. A failed ping deletes the row (no buttons ever
// reached the admin), so the requester's next attempt files a fresh one
// instead of hitting the dedupe.
func (t *TelegramAPI) pingInviteRequest(ctx context.Context, id int64, text string) bool {
	msgID, err := t.managerClient().SendMessageWithButtonsReturningID(ctx, t.feedbackAdminChatID, text, inviteButtons(id))
	if err != nil {
		slog.Warn("invite request: admin ping failed", "error", err, "request", id)
		if err := t.store.DeleteUnpingedInviteRequest(context.WithoutCancel(ctx), id); err != nil {
			slog.Warn("invite request: drop unpinged row", "error", err, "request", id)
		}
		return false
	}
	if err := t.store.SetInviteRequestAdminMessage(ctx, id, msgID); err != nil {
		slog.Warn("invite request: store admin message id", "error", err, "request", id)
	}
	return true
}

// requestTGInvite is the manager bot's "yes": a pending request and an admin
// ping, never a mint (the owner's approval gate).
func (t *TelegramAPI) requestTGInvite(ctx context.Context, msg *tgclient.Message) {
	if !t.inviteRequestsEnabled() {
		t.reply(ctx, msg.Chat.ID, inviteTGClosedMessage)
		return
	}
	t.mintMu.Lock() // the pending check + insert, against concurrent retries
	id, created, err := t.store.CreateTGInviteRequest(ctx, msg.Chat.ID, msg.From.ID, time.Now().UTC(), inviteRequestDedupe)
	t.mintMu.Unlock()
	if err != nil {
		slog.Error("invite request: store tg", "error", err)
		t.reply(ctx, msg.Chat.ID, inviteTGFailMessage)
		return
	}
	if !created {
		t.reply(ctx, msg.Chat.ID, inviteTGAlreadyMessage)
		return
	}
	who := strings.TrimSpace(msg.From.FirstName)
	if msg.From.Username != "" {
		who += " @" + msg.From.Username
	}
	text := fmt.Sprintf("📨 Invite request (Telegram) from %s (%d)", strings.TrimSpace(who), msg.From.ID)
	if !t.pingInviteRequest(ctx, id, text) {
		t.reply(ctx, msg.Chat.ID, inviteTGFailMessage)
		return
	}
	t.reply(ctx, msg.Chat.ID, inviteTGAskedMessage)
}

// parseInviteCallback splits "ir:<id>:a|d".
func parseInviteCallback(data string) (id int64, approve, ok bool) {
	rest, found := strings.CutPrefix(data, inviteCallbackPrefix)
	if !found {
		return 0, false, false
	}
	num, verb, found := strings.Cut(rest, ":")
	if !found || (verb != "a" && verb != "d") {
		return 0, false, false
	}
	id, err := strconv.ParseInt(num, 10, 64)
	if err != nil || id <= 0 {
		return 0, false, false
	}
	return id, verb == "a", true
}

// handleInviteCallback answers an Approve/Decline tap. It runs only for the
// admin (cq.From is set by Telegram, and callback data alone is forgeable for
// any message id), only from the request's own message, and the status move
// out of pending is the dedupe: a second tap, a Telegram redelivery or a
// concurrent tap is answered "Already decided" and changes nothing. The mint,
// the email and the message edit run off the webhook goroutine.
func (t *TelegramAPI) handleInviteCallback(ctx context.Context, cq *tgclient.CallbackQuery) {
	answer := func(text string) {
		if cq.ID == "" {
			return
		}
		if err := t.managerClient().AnswerCallbackQuery(ctx, cq.ID, text); err != nil {
			slog.Warn("invite request: answer callback", "error", err)
		}
	}
	id, approve, ok := parseInviteCallback(cq.Data)
	if !ok || !t.inviteRequestsEnabled() || cq.From == nil || cq.From.ID != t.feedbackAdminChatID {
		if cq.From != nil && cq.From.ID != t.feedbackAdminChatID {
			slog.Warn("invite request: callback from a non-admin user ignored", "user_id", cq.From.ID)
		}
		answer("")
		return
	}
	req, err := t.store.InviteRequestByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		answer("Already decided or expired.")
		return
	}
	if err != nil {
		slog.Error("invite request: load", "error", err, "request", id)
		answer("Something went wrong — try again.")
		return
	}
	if req.AdminMessageID != 0 && (cq.Message == nil || cq.Message.MessageID != req.AdminMessageID || cq.Message.Chat.ID != t.feedbackAdminChatID) {
		slog.Warn("invite request: callback from another message ignored", "request", id)
		answer("")
		return
	}
	// A row filed while SMTP was set can outlive it (a restart with SMTP
	// removed or invalid): refuse before anything is minted and keep the row
	// pending, so Approve works again once mail is back.
	if approve && req.Channel == cloudstore.InviteRequestEmail && t.mailer == nil {
		slog.Warn("invite request: email approve without SMTP", "request", id)
		answer("Email isn't set up on the server — fix SMTP, then tap Approve again.")
		return
	}
	to := cloudstore.InviteRequestDeclined
	if approve {
		to = cloudstore.InviteRequestApproved
	}
	now := time.Now().UTC()
	moved, err := t.store.MoveInviteRequest(ctx, id, cloudstore.InviteRequestPending, to, now)
	if err == nil && !moved && approve && req.Status == cloudstore.InviteRequestApproved {
		// An approval whose run never finished (crash, shutdown past the grace,
		// failed rollback): once well past its work budget, Approve re-runs it
		// under a new stamp, so the old run can no longer settle the row. A
		// re-run may mint a second invite; the unclaimed one just expires.
		if moved, err = t.store.ReclaimStaleInviteRequest(ctx, id, now, now.Add(-inviteRequestStaleAfter)); moved {
			slog.Warn("invite request: re-running a stale approval", "request", id)
		}
	}
	if err != nil {
		slog.Error("invite request: decide", "error", err, "request", id)
		answer("Something went wrong — try again.")
		return
	}
	if !moved {
		if req.Status == cloudstore.InviteRequestApproved {
			answer("Already being sent — if nothing arrives, tap Approve again in a few minutes.")
		} else {
			answer("Already decided.")
		}
		return
	}
	if approve {
		answer("Approved — sending the invite…")
	} else {
		answer("Declined.")
	}
	header := ""
	if cq.Message != nil {
		header = cq.Message.Text
		if req.AdminMessageID == 0 {
			// The ping landed but its id was never saved: the tapped message is
			// the one to rewrite (and to carry a fallback link).
			req.AdminMessageID = cq.Message.MessageID
		}
	}
	t.inviteWork.Add(1)
	go func() {
		defer t.inviteWork.Done()
		wctx, cancel := context.WithTimeout(context.Background(), inviteRequestWorkBudget)
		defer cancel()
		t.carryOutInviteDecision(wctx, req, approve, header, now)
	}()
}

// carryOutInviteDecision delivers an Approve (mint + email or DM) or a Decline
// and rewrites the admin message to the outcome, dropping its buttons. runAt
// is the approval's stamp: only this run may settle the row.
func (t *TelegramAPI) carryOutInviteDecision(ctx context.Context, req *cloudstore.InviteRequest, approve bool, header string, runAt time.Time) {
	edit := func(outcome string, keepButtons bool) bool {
		if req.AdminMessageID == 0 {
			return false // no message to carry the outcome (or a fallback link)
		}
		text := outcome
		if header != "" {
			text = header + "\n\n" + outcome
		}
		var buttons []tgclient.InlineKeyboardButton
		if keepButtons {
			buttons = inviteButtons(req.ID)
		}
		if err := t.managerClient().EditMessageTextWithButtons(ctx, t.feedbackAdminChatID, req.AdminMessageID, text, buttons); err != nil {
			slog.Warn("invite request: edit admin message", "error", err, "request", req.ID)
			return false
		}
		return true
	}
	if !approve {
		if req.Channel == cloudstore.InviteRequestTG {
			// A reply to someone who asked in this chat — not unsolicited mail.
			t.reply(ctx, req.TGChatID, inviteTGDeclineMessage)
		}
		edit("✖️ Declined", false)
		return
	}

	// settle moves the row out of 'approved' if this run still owns it. The
	// context may be spent by now, so it gets a fresh one. An unsettled row
	// stays 'approved', which Approve re-runs once stale — so wherever the
	// requester has nothing yet, a failed settle keeps the buttons.
	settle := func(to string) bool {
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		moved, err := t.store.SettleInviteRequest(sctx, req.ID, runAt, to, time.Now().UTC())
		if err != nil || !moved {
			slog.Error("invite request: settle", "error", err, "moved", moved, "to", to, "request", req.ID)
			return false
		}
		return true
	}
	// handedOff: the link is in the admin message (to pass on by hand) or the
	// requester has it; only then is the row done. If the fallback edit failed,
	// nobody holds the link (only its hash is stored), so the row stays
	// 'approved' with its buttons for a stale re-run.
	handedOff := func(outcome string, delivered bool) {
		if !delivered && !edit(outcome, false) {
			return
		}
		settle(cloudstore.InviteRequestDone)
		if delivered {
			edit(outcome, false)
		}
	}

	inv, refusal := t.mintForRequest(ctx, req)
	if inv == nil {
		if refusal == onboardingQuotaMessage {
			settled := settle(cloudstore.InviteRequestDeclined)
			t.reply(ctx, req.TGChatID, onboardingQuotaMessage)
			edit(fmt.Sprintf("✖️ Declined: at the %d live-invite cap", managerInviteQuota), !settled)
			return
		}
		// Nothing was minted: reopen so the admin can tap Approve again (if the
		// reopen fails, the stale-approval re-run serves the same tap).
		settle(cloudstore.InviteRequestPending)
		edit("⚠️ Couldn't create the account — tap Approve to retry.", true)
		return
	}
	link := inv.ClaimURL(t.baseDomain)

	if req.Channel == cloudstore.InviteRequestTG {
		if err := t.managerClient().SendMessage(ctx, req.TGChatID, inviteReadyMessage(link)); err != nil {
			slog.Warn("invite request: DM invite failed", "error", err, "request", req.ID)
			handedOff("⚠️ Approved, but the Telegram DM FAILED — link for them: "+link, false)
			return
		}
		handedOff("✅ Approved · link sent in Telegram", true)
		return
	}

	if err := t.mailer.send(ctx, req.EmailLC, "Your invite to "+t.baseDomain, t.inviteEmailBody(link)); err != nil {
		class := mailErrorClass(err)
		slog.Warn("invite request: email failed", "class", class, "request", req.ID)
		handedOff(fmt.Sprintf("⚠️ Approved, but the email FAILED (%s) — link for %s: %s", class, req.EmailLC, link), false)
		return
	}
	handedOff("✅ Approved · invite emailed to "+req.EmailLC, true)
}

// mintForRequest provisions the invite. Telegram rows keep the manager bot's
// provenance ("tg:<user>") and its live-invite cap, checked now, under mintMu;
// email rows have no creator identity to count against (the per-IP and daily
// limits bound them) and are recorded as "req:<row id>". nil + the reply copy
// when nothing was minted.
func (t *TelegramAPI) mintForRequest(ctx context.Context, req *cloudstore.InviteRequest) (*Invite, string) {
	if req.Channel == cloudstore.InviteRequestTG {
		return t.mintTGInviteLocked(ctx, "tg:"+strconv.FormatInt(req.TGUserID, 10))
	}
	inv, err := Provision(ctx, t.store, t.claimTTL, time.Now().UTC(), "req:"+strconv.FormatInt(req.ID, 10))
	if err != nil {
		slog.Error("invite request: provision", "error", err, "request", req.ID)
		return nil, onboardingMintFailMessage
	}
	return inv, ""
}

func inviteReadyMessage(link string) string {
	return "🎉 Your account is ready. Open this link to set it up:\n\n" + link + "\n\nThe link is personal, works once and expires."
}

func (t *TelegramAPI) inviteEmailBody(link string) string {
	days := int(t.claimTTL / (24 * time.Hour))
	return "Your invite to " + t.baseDomain + " was approved. Open this link to set up your account:\n\n" +
		link + "\n\n" +
		fmt.Sprintf("The link is personal, single-use and expires in %d days — open it on the device you'll use.\n", days) +
		"Setting up takes a minute: you create a passkey (Face ID, a fingerprint or your device PIN), no password.\n\n" +
		"Didn't ask for this? Ignore this email — nothing happens unless the link is opened.\n"
}
