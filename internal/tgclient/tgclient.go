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
// Bot API 9.6. Returns the raw token string.
func (c *Client) GetManagedBotToken(ctx context.Context, botID int64) (string, error) {
	var res struct {
		Token string `json:"token"`
	}
	err := c.call(ctx, "getManagedBotToken", map[string]any{"bot_id": botID}, &res)
	return res.Token, err
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

// SendMessage sends a plain-text message to chatID.
func (c *Client) SendMessage(ctx context.Context, chatID int64, text string) error {
	return c.call(ctx, "sendMessage", map[string]any{
		"chat_id": chatID,
		"text":    text,
	}, nil)
}

// Update is the subset of a Telegram update our webhooks read: a message
// carrying managed_bot_created (child bot created via the manager) and plain
// message (/start linking).
type Update struct {
	UpdateID int64    `json:"update_id"`
	Message  *Message `json:"message,omitempty"`
}

// ManagedBotCreatedInfo returns the created child bot's id + username when this
// update is the managed_bot_created service message Telegram posts to the
// manager bot after a user creates a bot via the newbot deep link. ok=false for
// any other update. Verified against the real Bot API 9.6 payload (2026-04):
// update.message.managed_bot_created.bot.{id,username} — NOT a top-level
// managed_bot field (the original C3a struct guessed wrong).
func (u *Update) ManagedBotCreatedInfo() (botID int64, username string, ok bool) {
	if u.Message == nil || u.Message.ManagedBotCreated == nil {
		return 0, "", false
	}
	b := u.Message.ManagedBotCreated.Bot
	return b.ID, b.Username, b.ID != 0 && b.Username != ""
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
	Bot ManagedBot `json:"bot"`
}

// ManagedBot is the created child bot (the subset of the User object we need).
type ManagedBot struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

// Chat is the subset of a Telegram chat we read (the chat id to link).
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}
