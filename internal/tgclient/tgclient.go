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
	"fmt"
	"net/http"
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
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
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

// Update is the subset of a Telegram update our webhooks read: managed_bot
// (child bot created via the manager) and message (/start linking).
type Update struct {
	UpdateID   int64             `json:"update_id"`
	ManagedBot *ManagedBotUpdate `json:"managed_bot,omitempty"`
	Message    *Message          `json:"message,omitempty"`
}

// ManagedBotUpdate arrives on the manager bot's webhook when a user creates a
// child bot through the manager's newbot deep link.
type ManagedBotUpdate struct {
	BotID       int64  `json:"bot_id"`
	BotUsername string `json:"bot_username"`
}

// Message is the subset of a Telegram message we read for /start linking.
type Message struct {
	MessageID int64  `json:"message_id"`
	Text      string `json:"text"`
	Chat      Chat   `json:"chat"`
	From      *User  `json:"from,omitempty"`
}

// Chat is the subset of a Telegram chat we read (the chat id to link).
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}
