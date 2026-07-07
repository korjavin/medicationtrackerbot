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
	"net/http"
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
// the server's own message instead of a bare HTTP status.
type apiError struct {
	Code        int
	Description string
}

func (e *apiError) Error() string {
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
	url := fmt.Sprintf("%s/bot%s/%s", c.baseURL, c.token, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &body)
	if err != nil {
		return c.redact(err)
	}
	req.Header.Set("Content-Type", "application/json")

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
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("decode telegram response: %w", err)
	}
	if !env.OK {
		return &apiError{Code: resp.StatusCode, Description: env.Description}
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
func IsClientError(err error) bool {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Code >= 400 && ae.Code < 500
	}
	return false
}

// SetWebhook registers url as the bot's webhook with the given secret_token
// (echoed back in the X-Telegram-Bot-Api-Secret-Token header on each update).
func (c *Client) SetWebhook(ctx context.Context, url, secretToken string) error {
	return c.call(ctx, "setWebhook", map[string]any{
		"url":          url,
		"secret_token": secretToken,
	}, nil)
}

// DeleteWebhook removes the bot's webhook.
func (c *Client) DeleteWebhook(ctx context.Context) error {
	return c.call(ctx, "deleteWebhook", nil, nil)
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

// Update is the subset of a Telegram update our webhooks read. A managed-bot
// creation arrives in TWO shapes (both observed live, Bot API 9.6, 2026-04):
// a top-level managed_bot update ({user, bot}) and a service message
// (message.managed_bot_created.bot). We accept either; whichever binds first
// consumes the pending row and the other no-ops.
type Update struct {
	UpdateID   int64             `json:"update_id"`
	ManagedBot *ManagedBotUpdate `json:"managed_bot,omitempty"`
	Message    *Message          `json:"message,omitempty"`
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
