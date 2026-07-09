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
	return c.call(ctx, "sendMessage", map[string]any{
		"chat_id": chatID,
		"text":    text,
	}, nil)
}

// InlineKeyboardButton is one tappable button. Only callback buttons are used —
// a tap posts CallbackData back to the bot's webhook.
type InlineKeyboardButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data"`
}

// SendMessageWithButtons sends text plus a single row of inline buttons.
// Separate from SendMessage because the vast majority of what this bot sends
// (welcome, test, BP/weight reminders) has nothing to answer.
func (c *Client) SendMessageWithButtons(ctx context.Context, chatID int64, text string, buttons []InlineKeyboardButton) error {
	if len(buttons) == 0 {
		return c.SendMessage(ctx, chatID, text)
	}
	return c.call(ctx, "sendMessage", map[string]any{
		"chat_id":      chatID,
		"text":         text,
		"reply_markup": map[string]any{"inline_keyboard": [][]InlineKeyboardButton{buttons}},
	}, nil)
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

// Callback actions carried in the third field of callback_data.
const (
	CallbackActionConfirm = "confirm"
	CallbackActionSnooze  = "snooze"
)

// ValidCallbackStem reports whether s is a well-formed "s:<slotUnix>" stem — the
// only callback_data the client may put on a queue entry. Guards the relay
// against a client (or a tampered row) injecting arbitrary bytes into
// callback_data, and keeps stem+":confirm" inside Telegram's 64-byte limit.
// A stem must accept exactly what ParseCallbackData can read back: anything
// else would let the relay render a button whose tap it then refuses. So the
// slot is required to parse as a positive int64, not merely to look numeric.
func ValidCallbackStem(s string) bool {
	if s == "" {
		return true // no buttons; the common case
	}
	if len(s) > 32 {
		return false
	}
	rest, found := strings.CutPrefix(s, CallbackSlotPrefix)
	if !found {
		return false
	}
	slot, err := strconv.ParseInt(rest, 10, 64)
	return err == nil && slot > 0
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
// and managed_bot_created for the manager-webhook bind.
type Message struct {
	MessageID         int64              `json:"message_id"`
	Text              string             `json:"text"`
	Chat              Chat               `json:"chat"`
	From              *User              `json:"from,omitempty"`
	ManagedBotCreated *ManagedBotCreated `json:"managed_bot_created,omitempty"`
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
