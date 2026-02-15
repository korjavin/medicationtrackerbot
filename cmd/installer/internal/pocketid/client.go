package pocketid

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client is an HTTP client for the Pocket-ID API.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// NewClient creates a new Pocket-ID API client.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// WaitForReady polls the OIDC discovery endpoint until Pocket-ID is ready.
func (c *Client) WaitForReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	backoff := 2 * time.Second

	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/.well-known/openid-configuration", nil)
		if err != nil {
			return err
		}

		resp, err := c.http.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
			if backoff < 10*time.Second {
				backoff = backoff * 3 / 2
			}
		}
	}
	return fmt.Errorf("pocket-id not ready after %v", timeout)
}

// CreateUser creates a new user in Pocket-ID.
func (c *Client) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
	var user User
	err := c.doJSON(ctx, http.MethodPost, "/api/users", req, &user)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return &user, nil
}

// ListUsers returns all users.
func (c *Client) ListUsers(ctx context.Context) ([]User, error) {
	var users []User
	err := c.doJSON(ctx, http.MethodGet, "/api/users", nil, &users)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	return users, nil
}

// FindUserByEmail searches for a user by email address.
func (c *Client) FindUserByEmail(ctx context.Context, email string) (*User, error) {
	users, err := c.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	for _, u := range users {
		if u.Email == email {
			return &u, nil
		}
	}
	return nil, fmt.Errorf("user with email %s not found", email)
}

// CreateOIDCClient creates a new OIDC client.
func (c *Client) CreateOIDCClient(ctx context.Context, req CreateOIDCClientRequest) (*OIDCClient, error) {
	var client OIDCClient
	err := c.doJSON(ctx, http.MethodPost, "/api/oidc/clients", req, &client)
	if err != nil {
		return nil, fmt.Errorf("create OIDC client: %w", err)
	}
	return &client, nil
}

// ListOIDCClients returns all OIDC clients.
func (c *Client) ListOIDCClients(ctx context.Context) ([]OIDCClient, error) {
	var clients []OIDCClient
	err := c.doJSON(ctx, http.MethodGet, "/api/oidc/clients", nil, &clients)
	if err != nil {
		return nil, fmt.Errorf("list OIDC clients: %w", err)
	}
	return clients, nil
}

// FindOIDCClientByName searches for an OIDC client by name.
func (c *Client) FindOIDCClientByName(ctx context.Context, name string) (*OIDCClient, error) {
	clients, err := c.ListOIDCClients(ctx)
	if err != nil {
		return nil, err
	}
	for _, cl := range clients {
		if cl.Name == name {
			return &cl, nil
		}
	}
	return nil, fmt.Errorf("OIDC client %q not found", name)
}

// CreateOneTimeAccessToken generates a one-time passkey enrollment token for a user.
func (c *Client) CreateOneTimeAccessToken(ctx context.Context, userID string) (*OneTimeAccessToken, error) {
	var token OneTimeAccessToken
	err := c.doJSON(ctx, http.MethodPost, "/api/users/"+userID+"/one-time-access-token", nil, &token)
	if err != nil {
		return nil, fmt.Errorf("create one-time access token: %w", err)
	}
	return &token, nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, body any, result any) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("X-API-KEY", c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return &APIError{
			StatusCode: resp.StatusCode,
			Body:       string(respBody),
		}
	}

	if result != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, result); err != nil {
			return fmt.Errorf("parse response: %w", err)
		}
	}
	return nil
}

// APIError represents an error response from the Pocket-ID API.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("pocket-id API error %d: %s", e.StatusCode, e.Body)
}

// IsConflict returns true if the error is a 409 Conflict.
func IsConflict(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.StatusCode == http.StatusConflict
	}
	return false
}
