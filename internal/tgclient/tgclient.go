// Package tgclient is a minimal raw-HTTP Telegram Bot API client for cmd/cloud.
// It covers only the surface C3a needs (manager-bot bootstrap, managed-bot
// provisioning, child-bot webhooks + welcome messages). No third-party bot
// library — the JSON contract is small and stable, and the base URL is
// injectable so tests run against an httptest fake of api.telegram.org.
package tgclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the real Telegram Bot API root. Tests override it.
const DefaultBaseURL = "https://api.telegram.org"

// Client calls the Bot API for a single bot token. Construct one per token.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// New builds a client for token. baseURL empty → DefaultBaseURL.
func New(token, baseURL string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

// BaseURL returns the API root the client is bound to (real cloud or a proxy),
// so callers/tests can tell which server a client will hit.
func (c *Client) BaseURL() string { return c.baseURL }

// apiError carries Telegram's {ok:false, description} envelope so callers get
// the server's own message instead of a bare HTTP status. RetryAfter carries
// parameters.retry_after (seconds), which Telegram sets on 429.
type apiError struct {
	Code        int
	Description string
	RetryAfter  int
}

func (e *apiError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("telegram api error %d: %s (retry after %ds)", e.Code, e.Description, e.RetryAfter)
	}
	return fmt.Sprintf("telegram api error %d: %s", e.Code, e.Description)
}

// call posts params as JSON to /bot<token>/<method> and unwraps the response
// envelope into result (which may be nil to discard the payload).
func (c *Client) call(ctx context.Context, method string, params any, result any) error {
	var body bytes.Buffer
	if params != nil {
		if err := json.NewEncoder(&body).Encode(params); err != nil {
			return err
		}
	}
	return c.doRequest(ctx, method, "application/json", &body, result)
}

func (c *Client) doRequest(ctx context.Context, method string, contentType string, body *bytes.Buffer, result any) error {
	url := fmt.Sprintf("%s/bot%s/%s", c.baseURL, c.token, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return c.redact(err)
	}
	req.Header.Set("Content-Type", contentType)

	resp, err := c.http.Do(req)
	if err != nil {
		// *url.Error.Error() prints the full request URL, which embeds the bot
		// token as a path segment — strip it so a routine transport failure
		// (DNS, timeout, refused) doesn't leak the token into caller logs.
		return c.redact(err)
	}
	defer resp.Body.Close()

	var env struct {
		OK          bool            `json:"ok"`
		Description string          `json:"description"`
		Result      json.RawMessage `json:"result"`
		Parameters  struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("decode telegram response: %w", err)
	}
	if !env.OK {
		return &apiError{Code: resp.StatusCode, Description: env.Description, RetryAfter: env.Parameters.RetryAfter}
	}
	if result != nil {
		if err := json.Unmarshal(env.Result, result); err != nil {
			return fmt.Errorf("decode telegram result: %w", err)
		}
	}
	return nil
}

// redact returns err with any occurrence of the bot token replaced. The token
// only ever appears verbatim in *url.Error (URL path segment); replacing the
// raw substring covers it without depending on the error's concrete type.
func (c *Client) redact(err error) error {
	if err == nil || c.token == "" {
		return err
	}
	if s := err.Error(); strings.Contains(s, c.token) {
		return errors.New(strings.ReplaceAll(s, c.token, "bot<redacted>"))
	}
	return err
}

// User is the subset of Telegram's User we use.
type User struct {
	ID            int64  `json:"id"`
	IsBot         bool   `json:"is_bot"`
	FirstName     string `json:"first_name"`
	Username      string `json:"username"`
	CanManageBots bool   `json:"can_manage_bots"`
}

// GetMe resolves the bot's own identity (used to learn the manager username
// without an extra env var).
func (c *Client) GetMe(ctx context.Context) (User, error) {
	var u User
	err := c.call(ctx, "getMe", nil, &u)
	return u, err
}

// File is the subset of Telegram's File we use. FilePath is a short-lived
// (~1h) path under the file endpoint; FileID is stable and re-resolvable, so we
// call GetFile again on each drain rather than persisting FilePath.
type File struct {
	FileID   string `json:"file_id"`
	FilePath string `json:"file_path"`
	FileSize int64  `json:"file_size"`
}

// GetFile resolves a file_id to a File (with a fresh, expiring file_path). A bot
// token can only resolve files sent to THAT bot, which is the account-scoping
// boundary the cloud photo-proxy relies on (bd med-vcv.1).
func (c *Client) GetFile(ctx context.Context, fileID string) (File, error) {
	var f File
	err := c.call(ctx, "getFile", map[string]any{"file_id": fileID}, &f)
	return f, err
}

// DownloadFile streams the bytes at filePath (from GetFile). The file endpoint
// lives under a DIFFERENT path prefix than the API methods
// (/file/bot<token>/<path>, not /bot<token>/<method>), and returns raw bytes,
// not the {ok,result} envelope. The caller MUST close the returned body. The
// content type is whatever Telegram serves (image/jpeg for photos).
func (c *Client) DownloadFile(ctx context.Context, filePath string) (io.ReadCloser, string, error) {
	url := fmt.Sprintf("%s/file/bot%s/%s", c.baseURL, c.token, filePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", c.redact(err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", c.redact(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, "", c.redact(fmt.Errorf("telegram file download: status %d", resp.StatusCode))
	}
	return resp.Body, resp.Header.Get("Content-Type"), nil
}

// GetManagedBotToken fetches a child bot's token after a managed_bot update.
// Bot API 9.6. The bot is identified by user_id — bots ARE users, so this is the
// child bot's own id, NOT the human creator's (the live API returns "400: user
// is not a bot" if a human id is passed, and "400: invalid user_id specified"
// if it's omitted). The result is the token as a bare JSON string (result:
// "123:ABC"), not an object — verified against the live API.
func (c *Client) GetManagedBotToken(ctx context.Context, botID int64) (string, error) {
	var token string
	err := c.call(ctx, "getManagedBotToken", map[string]any{"user_id": botID}, &token)
	return token, err
}

// IsClientError reports whether err is a Telegram API error with a 4xx status —
// a permanent rejection (bad/deleted/deactivated bot, invalid params) that
// retrying won't fix, as opposed to a transient 5xx/network failure.
//
// 429 is the one 4xx that is NOT permanent: it means "too fast, come back in
// retry_after seconds". Callers use this predicate to decide whether to drop an
// event or let it be redelivered, so classifying a rate limit as permanent
// would silently discard work that would have succeeded moments later.
func IsClientError(err error) bool {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Code >= 400 && ae.Code < 500 && ae.Code != http.StatusTooManyRequests
	}
	return false
}

// RetryAfter reports the cooldown Telegram asked for on a 429, if err is such
// an error. ok is false for every other error.
func RetryAfter(err error) (time.Duration, bool) {
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == http.StatusTooManyRequests {
		return time.Duration(ae.RetryAfter) * time.Second, true
	}
	return 0, false
}

// SetWebhook registers url as the bot's webhook with the given secret_token
// (echoed back in the X-Telegram-Bot-Api-Secret-Token header on each update).
func (c *Client) SetWebhook(ctx context.Context, url, secretToken string) error {
	return c.call(ctx, "setWebhook", map[string]any{
		"url":          url,
		"secret_token": secretToken,
	}, nil)
}

// BotCommand represents a bot command.
type BotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// SetMyCommands changes the list of the bot's commands.
func (c *Client) SetMyCommands(ctx context.Context, commands []BotCommand) error {
	return c.call(ctx, "setMyCommands", map[string]any{
		"commands": commands,
	}, nil)
}

// DeleteWebhook removes the bot's webhook.
func (c *Client) DeleteWebhook(ctx context.Context) error {
	return c.call(ctx, "deleteWebhook", nil, nil)
}

// LogOut logs the bot out of the Bot API server this client points at. To move
// a bot from the cloud (api.telegram.org) to a self-hosted --local server, call
// LogOut against a CLOUD-based client first: it releases the bot from Telegram's
// datacenter so the local server can claim it (auto-login via the shared
// TELEGRAM_API_ID/HASH on the first request). After a successful logOut the bot
// can log in on the local server immediately, but cannot rejoin the cloud for
// ~10 minutes — so this is effectively one-way and must be operator-driven.
// file_ids are server-bound, so without this migration a bot whose webhook still
// lives on the cloud delivers cloud-issued file_ids that the local proxy rejects.
func (c *Client) LogOut(ctx context.Context) error {
	return c.call(ctx, "logOut", nil, nil)
}

// SetMyName changes the bot's name.
func (c *Client) SetMyName(ctx context.Context, name string) error {
	return c.call(ctx, "setMyName", map[string]any{
		"name": name,
	}, nil)
}

// SetMyDescription changes the bot's description, which is shown in the chat with the bot if the chat is empty.
func (c *Client) SetMyDescription(ctx context.Context, description string) error {
	return c.call(ctx, "setMyDescription", map[string]any{
		"description": description,
	}, nil)
}

// SetMyShortDescription changes the bot's short description, which is shown on the bot's profile page and is sent together with the link when users share the bot.
func (c *Client) SetMyShortDescription(ctx context.Context, shortDescription string) error {
	return c.call(ctx, "setMyShortDescription", map[string]any{
		"short_description": shortDescription,
	}, nil)
}

// SetMyProfilePhoto changes the profile photo of the bot.
func (c *Client) SetMyProfilePhoto(ctx context.Context, photo []byte) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	if err := writer.WriteField("photo", `{"type":"static","photo":"attach://profile_photo"}`); err != nil {
		return err
	}

	part, err := writer.CreateFormFile("profile_photo", "photo.jpg")
	if err != nil {
		return err
	}
	_, err = part.Write(photo)
	if err != nil {
		return err
	}

	err = writer.Close()
	if err != nil {
		return err
	}

	return c.doRequest(ctx, "setMyProfilePhoto", writer.FormDataContentType(), &body, nil)
}

// WebhookInfo is the subset of getWebhookInfo we surface for diagnosing why a
// bot isn't receiving updates: whether Telegram has our URL at all, how many
// updates are stuck, and the last delivery error (a 401/403 here means our
// webhook handler is rejecting Telegram's requests).
type WebhookInfo struct {
	URL                  string   `json:"url"`
	HasCustomCertificate bool     `json:"has_custom_certificate"`
	PendingUpdateCount   int      `json:"pending_update_count"`
	IPAddress            string   `json:"ip_address"`
	LastErrorDate        int64    `json:"last_error_date"`
	LastErrorMessage     string   `json:"last_error_message"`
	AllowedUpdates       []string `json:"allowed_updates"`
}

// GetWebhookInfo returns Telegram's view of the bot's webhook registration.
func (c *Client) GetWebhookInfo(ctx context.Context) (WebhookInfo, error) {
	var info WebhookInfo
	err := c.call(ctx, "getWebhookInfo", nil, &info)
	return info, err
}

// SendMessage sends a plain-text message to chatID.
func (c *Client) SendMessage(ctx context.Context, chatID int64, text string) error {
	_, err := c.SendMessageReturningID(ctx, chatID, text)
	return err
}

// SendMessageReturningID sends a plain-text message and returns the sent
// message's id, so the caller can later EditMessageText it. Used by the
// child-bot command path: the relay replies "queued", then an unlocked client
// that has actually applied the command asks the relay to edit that same
// message into a confirmation (docs/cloud-mode.md → Inbound plaintext).
func (c *Client) SendMessageReturningID(ctx context.Context, chatID int64, text string) (int64, error) {
	var sent Message
	if err := c.call(ctx, "sendMessage", map[string]any{
		"chat_id": chatID,
		"text":    text,
	}, &sent); err != nil {
		return 0, err
	}
	return sent.MessageID, nil
}

// CopyMessage re-sends the content of an existing message (text, or media by
// file_id — no download/re-upload) into chatID as a fresh message from this bot.
// Unlike forwardMessage it carries no "forwarded from" header, so the original
// sender stays anonymous — what the feedback relay wants (feedback is
// deliberately unattributed; the encrypted queue item still carries the account
// id for cmd/feedbackpull).
func (c *Client) CopyMessage(ctx context.Context, chatID, fromChatID, messageID int64) error {
	return c.call(ctx, "copyMessage", map[string]any{
		"chat_id":      chatID,
		"from_chat_id": fromChatID,
		"message_id":   messageID,
	}, nil)
}

// EditMessageText rewrites a message this bot previously sent. Editing a bot's
// own message has no time limit, so a command queued on Monday and drained on
// Friday still updates in place. Telegram answers 400
// "message is not modified" when the text is unchanged — a re-drain after a
// crash, which callers treat as success.
func (c *Client) EditMessageText(ctx context.Context, chatID, messageID int64, text string) error {
	return c.call(ctx, "editMessageText", map[string]any{
		"chat_id":    chatID,
		"message_id": messageID,
		"text":       text,
	}, nil)
}

// EditMessageTextClearMarkup rewrites a message's text AND drops its inline
// keyboard in one editMessageText call (an empty inline_keyboard removes the
// buttons). Used the instant a Confirm/Snooze button is tapped so the message
// can't be re-tapped before the client's drain-time EditReply finalizes it.
// Separate from EditMessageText, which omits reply_markup and so LEAVES existing
// buttons in place (EditReply relies on that).
func (c *Client) EditMessageTextClearMarkup(ctx context.Context, chatID, messageID int64, text string) error {
	return c.call(ctx, "editMessageText", map[string]any{
		"chat_id":      chatID,
		"message_id":   messageID,
		"text":         text,
		"reply_markup": map[string]any{"inline_keyboard": [][]InlineKeyboardButton{}},
	}, nil)
}

// DeleteMessage removes a message this bot previously sent. Telegram lets a bot
// delete its own messages only within 48h; older ones (and already-deleted ones)
// return a 4xx that the caller (DeleteReminder) swallows best-effort.
func (c *Client) DeleteMessage(ctx context.Context, chatID, messageID int64) error {
	return c.call(ctx, "deleteMessage", map[string]any{
		"chat_id":    chatID,
		"message_id": messageID,
	}, nil)
}

// IsMessageNotModified reports whether err is Telegram's benign "you asked me
// to edit a message into exactly what it already says" response.
func IsMessageNotModified(err error) bool {
	var apiErr *apiError
	return errors.As(err, &apiErr) && strings.Contains(strings.ToLower(apiErr.Description), "message is not modified")
}

// IsFileTooBig reports whether err is Telegram's getFile rejection for a file
// over the 20 MB Bot API download limit ("Bad Request: file is too big"). This
// cap only applies to the public api.telegram.org; a self-hosted --local Bot API
// server raises it to ~2 GB, so callers use this to tell the user the file needs
// the local Bot API proxy rather than a retry.
func IsFileTooBig(err error) bool {
	var apiErr *apiError
	return errors.As(err, &apiErr) && strings.Contains(strings.ToLower(apiErr.Description), "file is too big")
}

// IsInvalidFileID reports whether err is Telegram's getFile rejection of a
// file_id that this Bot API server did not issue ("Bad Request: invalid
// file_id"). file_ids are only valid on the exact server that minted them, so
// when the cloud proxy is enabled but a bot's webhook still lives on
// api.telegram.org, updates carry cloud-issued file_ids that the local proxy
// rejects here. Callers use this to point the operator at the one-time bot
// migration (logOut on cloud → re-setWebhook via the proxy) instead of a retry.
func IsInvalidFileID(err error) bool {
	var apiErr *apiError
	return errors.As(err, &apiErr) && strings.Contains(strings.ToLower(apiErr.Description), "invalid file_id")
}

// InlineKeyboardButton is one tappable button. A button is EXACTLY one of a
// callback button (tap posts CallbackData back to the webhook) or a URL button
// (tap opens URL) — Telegram rejects a button that sets both, hence omitempty on
// each so only the populated field serializes.
type InlineKeyboardButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
	URL          string `json:"url,omitempty"`
}

// SendMessageWithButtons sends text plus a single row of inline buttons.
// Separate from SendMessage because the vast majority of what this bot sends
// (welcome, test, BP/weight reminders) has nothing to answer.
func (c *Client) SendMessageWithButtons(ctx context.Context, chatID int64, text string, buttons []InlineKeyboardButton) error {
	_, err := c.SendMessageWithButtonsReturningID(ctx, chatID, text, buttons)
	return err
}

// SendMessageWithButtonsReturningID mirrors SendMessageWithButtons but returns
// the sent message's id, so the relay can later delete it when re-firing a
// repeated reminder (med-eas.79). No buttons → delegates to
// SendMessageReturningID, exactly as SendMessageWithButtons delegates to
// SendMessage.
func (c *Client) SendMessageWithButtonsReturningID(ctx context.Context, chatID int64, text string, buttons []InlineKeyboardButton) (int64, error) {
	if len(buttons) == 0 {
		return c.SendMessageReturningID(ctx, chatID, text)
	}
	var sent Message
	if err := c.call(ctx, "sendMessage", map[string]any{
		"chat_id":      chatID,
		"text":         text,
		"reply_markup": map[string]any{"inline_keyboard": [][]InlineKeyboardButton{buttons}},
	}, &sent); err != nil {
		return 0, err
	}
	return sent.MessageID, nil
}

// AnswerCallbackQuery acknowledges a button tap. Telegram spins the button's
// progress indicator until this lands, so it must be sent on EVERY callback —
// including ones we decline to act on.
func (c *Client) AnswerCallbackQuery(ctx context.Context, callbackQueryID, text string) error {
	params := map[string]any{"callback_query_id": callbackQueryID}
	if text != "" {
		params["text"] = text
	}
	return c.call(ctx, "answerCallbackQuery", params, nil)
}

// CallbackSlotPrefix namespaces the callback_data carried by the inline
// Confirm/Snooze buttons on a medication reminder. The full shape is
// "s:<slotUnix>:<action>", where slotUnix is the dose slot's instant.
//
// Slot-scoped, not intake-scoped, because a cloud dose reminder bundles every
// medication due at the same instant into one message (web/domain/reminders.js
// groups targets bySlot) — so one tap means "I took the meds due at 08:00", and
// the client expands the slot to its intakes at drain time.
//
// The relay learns nothing new from it: the slot instant is already this row's
// fire_at_unix, in the clear. It is deterministic, so re-applying a re-delivered
// tap converges instead of duplicating.
const CallbackSlotPrefix = "s:"

// CallbackWorkoutPrefix namespaces the callback_data carried by the inline
// Snooze/Skip buttons on a cloud workout-session reminder. The full shape is
// "w:<groupId>:<YYYYMMDD>:<action>". Group + date already identify the
// schedule-materialized session deterministically (workout.sessionRecordId), so
// the relay learns nothing new — the date is already this row's fire_at_unix in
// the clear.
const CallbackWorkoutPrefix = "w:"

// CallbackBPPrefix / CallbackWeightPrefix namespace the Snooze/Skip buttons on a
// cloud BP or weight reminder. The full shape is "<bp:|wt:><slotUnix>:<action>",
// where slotUnix is the reminder's fire instant — already this row's
// fire_at_unix in the clear, so the relay learns nothing new. Unlike meds and
// workouts these reminders have no per-instance id (BP/weight are ad-hoc
// measurements), so the slot instant alone keys the deterministic action.
const (
	CallbackBPPrefix     = "bp:"
	CallbackWeightPrefix = "wt:"
)

// Callback actions carried in the third field of callback_data. Confirm/Snooze
// are meds (s:); Snooze1h/Snooze2h/Skip are workouts (w:); Snooze1h/Skip are
// measures (bp:/wt:).
const (
	CallbackActionConfirm  = "confirm"
	CallbackActionSnooze   = "snooze"
	CallbackActionSnooze1h = "snooze1h"
	CallbackActionSnooze2h = "snooze2h"
	CallbackActionSkip     = "skip"
)

// ValidCallbackStem reports whether s is a well-formed button stem — either a
// med "s:<slotUnix>" or a workout "w:<groupId>:<YYYYMMDD>" — the only
// callback_data the client may put on a queue entry. Guards the relay against a
// client (or a tampered row) injecting arbitrary bytes into callback_data, and
// keeps stem+":<action>" inside Telegram's 64-byte limit. A stem must accept
// exactly what the matching parser can read back: anything else would let the
// relay render a button whose tap it then refuses.
func ValidCallbackStem(s string) bool {
	if s == "" {
		return true // no buttons; the common case
	}
	// Cap comfortably above the longest stem — a workout stem is
	// "w:<int64>:<8>" ≤ 30 bytes, and stem+":snooze1h" stays well under
	// Telegram's 64-byte callback_data limit.
	if len(s) > 40 {
		return false
	}
	if rest, found := strings.CutPrefix(s, CallbackWorkoutPrefix); found {
		return validWorkoutStemRest(rest)
	}
	if rest, found := strings.CutPrefix(s, CallbackBPPrefix); found {
		return validSlotRest(rest)
	}
	if rest, found := strings.CutPrefix(s, CallbackWeightPrefix); found {
		return validSlotRest(rest)
	}
	rest, found := strings.CutPrefix(s, CallbackSlotPrefix)
	if !found {
		return false
	}
	return validSlotRest(rest)
}

// validSlotRest reports whether rest is a positive int64 slot instant — the
// stem body shared by med (s:) and measure (bp:/wt:) callbacks.
func validSlotRest(rest string) bool {
	slot, err := strconv.ParseInt(rest, 10, 64)
	return err == nil && slot > 0
}

// validWorkoutStemRest validates "<groupId>:<YYYYMMDD>" — a positive int64 group
// and an exactly-8-digit date.
func validWorkoutStemRest(rest string) bool {
	groupStr, dateStr, found := strings.Cut(rest, ":")
	if !found {
		return false
	}
	group, err := strconv.ParseInt(groupStr, 10, 64)
	if err != nil || group <= 0 {
		return false
	}
	return validWorkoutDate(dateStr)
}

// validWorkoutDate reports whether s is exactly 8 ASCII digits (YYYYMMDD).
func validWorkoutDate(s string) bool {
	if len(s) != 8 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// IsWorkoutCallback reports whether data is in the workout ("w:") namespace, so
// the handler can route namespaces without double-parsing.
func IsWorkoutCallback(data string) bool {
	return strings.HasPrefix(data, CallbackWorkoutPrefix)
}

// ParseWorkoutCallback splits "w:<groupId>:<YYYYMMDD>:<action>" into its parts.
// date is returned as "YYYY-MM-DD" (dashes re-inserted). ok is false for an
// unknown namespace, a bad action, a non-numeric/non-positive group, or a
// malformed date.
func ParseWorkoutCallback(data string) (groupID int64, date string, action string, ok bool) {
	rest, found := strings.CutPrefix(data, CallbackWorkoutPrefix)
	if !found {
		return 0, "", "", false
	}
	groupStr, rest, found := strings.Cut(rest, ":")
	if !found {
		return 0, "", "", false
	}
	dateStr, action, found := strings.Cut(rest, ":")
	if !found {
		return 0, "", "", false
	}
	if action != CallbackActionSnooze1h && action != CallbackActionSnooze2h && action != CallbackActionSkip {
		return 0, "", "", false
	}
	groupID, err := strconv.ParseInt(groupStr, 10, 64)
	if err != nil || groupID <= 0 {
		return 0, "", "", false
	}
	if !validWorkoutDate(dateStr) {
		return 0, "", "", false
	}
	date = dateStr[0:4] + "-" + dateStr[4:6] + "-" + dateStr[6:8]
	return groupID, date, action, true
}

// ParseCallbackData splits "s:<slotUnix>:<action>" into its parts. ok is false
// for anything else — an unknown namespace, a bad action, a non-numeric slot.
func ParseCallbackData(data string) (slotUnix int64, action string, ok bool) {
	rest, found := strings.CutPrefix(data, CallbackSlotPrefix)
	if !found {
		return 0, "", false
	}
	slotStr, action, found := strings.Cut(rest, ":")
	if !found {
		return 0, "", false
	}
	if action != CallbackActionConfirm && action != CallbackActionSnooze {
		return 0, "", false
	}
	slotUnix, err := strconv.ParseInt(slotStr, 10, 64)
	if err != nil || slotUnix <= 0 {
		return 0, "", false
	}
	return slotUnix, action, true
}

// IsMeasureCallback reports whether data is in the BP ("bp:") or weight ("wt:")
// namespace, so the handler can route it without cross-parsing s:/w:.
func IsMeasureCallback(data string) bool {
	return strings.HasPrefix(data, CallbackBPPrefix) || strings.HasPrefix(data, CallbackWeightPrefix)
}

// ParseMeasureCallback splits "<bp:|wt:><slotUnix>:<action>" into its parts.
// kind is "bp" or "weight". ok is false for anything else — an unknown or
// cross namespace (s:/w:), a bad action (only snooze1h/skip), a
// non-numeric/non-positive slot. Does NOT read the s:/w: namespaces.
func ParseMeasureCallback(data string) (kind string, slotUnix int64, action string, ok bool) {
	var prefix string
	switch {
	case strings.HasPrefix(data, CallbackBPPrefix):
		kind, prefix = "bp", CallbackBPPrefix
	case strings.HasPrefix(data, CallbackWeightPrefix):
		kind, prefix = "weight", CallbackWeightPrefix
	default:
		return "", 0, "", false
	}
	rest := strings.TrimPrefix(data, prefix)
	slotStr, action, found := strings.Cut(rest, ":")
	if !found {
		return "", 0, "", false
	}
	if action != CallbackActionSnooze1h && action != CallbackActionSkip {
		return "", 0, "", false
	}
	slotUnix, err := strconv.ParseInt(slotStr, 10, 64)
	if err != nil || slotUnix <= 0 {
		return "", 0, "", false
	}
	return kind, slotUnix, action, true
}

// CallbackQuery is an inline-button tap. Message is optional — Telegram omits it
// for messages too old to edit — so nothing may depend on it.
type CallbackQuery struct {
	ID      string   `json:"id"`
	Data    string   `json:"data"`
	From    *User    `json:"from,omitempty"`
	Message *Message `json:"message,omitempty"`
}

// Update is the subset of a Telegram update our webhooks read. A managed-bot
// creation arrives in TWO shapes (both observed live, Bot API 9.6, 2026-04):
// a top-level managed_bot update ({user, bot}) and a service message
// (message.managed_bot_created.bot). We accept either; whichever binds first
// consumes the pending row and the other no-ops.
type Update struct {
	UpdateID      int64             `json:"update_id"`
	ManagedBot    *ManagedBotUpdate `json:"managed_bot,omitempty"`
	Message       *Message          `json:"message,omitempty"`
	CallbackQuery *CallbackQuery    `json:"callback_query,omitempty"`
}

// ManagedBotUpdate is the top-level managed_bot update: the creator user and
// the created child bot.
type ManagedBotUpdate struct {
	User *User `json:"user"`
	Bot  *User `json:"bot"`
}

// ManagedBotCreatedInfo returns the created child bot's id + username and the
// creator's user id when this update is a managed-bot creation (either shape).
// The user id is required: getManagedBotToken rejects the call without it.
// ok=false for any other update.
func (u *Update) ManagedBotCreatedInfo() (botID int64, username string, userID int64, ok bool) {
	switch {
	case u.ManagedBot != nil && u.ManagedBot.Bot != nil:
		var uid int64
		if u.ManagedBot.User != nil {
			uid = u.ManagedBot.User.ID
		}
		b := u.ManagedBot.Bot
		return b.ID, b.Username, uid, b.ID != 0 && uid != 0
	case u.Message != nil && u.Message.ManagedBotCreated != nil && u.Message.ManagedBotCreated.Bot != nil:
		var uid int64
		if u.Message.From != nil {
			uid = u.Message.From.ID
		}
		b := u.Message.ManagedBotCreated.Bot
		return b.ID, b.Username, uid, b.ID != 0 && uid != 0
	}
	return 0, "", 0, false
}

// Message is the subset of a Telegram message we read: text for /start linking,
// managed_bot_created for the manager-webhook bind, and photo for cloud photo
// food logging (bd med-vcv.1 — only the file_id is sealed, never the bytes).
type Message struct {
	MessageID         int64              `json:"message_id"`
	Text              string             `json:"text"`
	Chat              Chat               `json:"chat"`
	From              *User              `json:"from,omitempty"`
	ManagedBotCreated *ManagedBotCreated `json:"managed_bot_created,omitempty"`
	Photo             []PhotoSize        `json:"photo,omitempty"`
	Document          *Document          `json:"document,omitempty"`
	Voice             *Voice             `json:"voice,omitempty"`
	Caption           string             `json:"caption,omitempty"`
}

// Voice is the subset of a Telegram voice message we read: the file_id to
// resolve+download plus mime/duration/size for typing and bounding. Used by the
// cloud manager bot's feedback channel (bd med-dni.5).
type Voice struct {
	FileID   string `json:"file_id"`
	MimeType string `json:"mime_type"`
	Duration int    `json:"duration"`
	FileSize int64  `json:"file_size"`
}

// Document is the subset of a Telegram file attachment we read: the file_id to
// resolve+download and the filename+size to type-check (.nxk) and bound. Used by
// the cloud relay's Mi Band NXK ingestion path (bd med-nzz).
type Document struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name"`
	FileSize int64  `json:"file_size"`
	MimeType string `json:"mime_type"`
}

// PhotoSize is one rendition of a photo. Telegram sends an ascending-size array;
// the last element is the largest. We read only file_id (stable, re-resolvable)
// and file_size (to skip an over-cap fetch).
type PhotoSize struct {
	FileID   string `json:"file_id"`
	FileSize int64  `json:"file_size"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

// LargestPhoto returns the highest-resolution rendition (the last entry), or nil
// when the message carries no photo.
func (m *Message) LargestPhoto() *PhotoSize {
	if len(m.Photo) == 0 {
		return nil
	}
	return &m.Photo[len(m.Photo)-1]
}

// ManagedBotCreated is the service field on the message Telegram posts to the
// manager bot when a user creates a child bot via the newbot deep link.
type ManagedBotCreated struct {
	Bot *User `json:"bot"`
}

// Chat is the subset of a Telegram chat we read (the chat id to link).
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}
