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
	baseURL     string
	apiKey      string
	bearerToken string
	http        *http.Client
}

// NewClient creates a new Pocket-ID API client.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// SetBearerToken sets a JWT bearer token for authentication (takes priority over API key).
func (c *Client) SetBearerToken(token string) {
	c.bearerToken = token
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
// Pocket-ID requires userId in the request body (not just the path param) and
// an optional ttl (Go duration string; empty = server default of 15 minutes).
func (c *Client) CreateOneTimeAccessToken(ctx context.Context, userID string) (*OneTimeAccessToken, error) {
	var token OneTimeAccessToken
	err := c.doJSON(ctx, http.MethodPost, "/api/users/"+userID+"/one-time-access-token",
		OneTimeAccessTokenRequest{UserID: userID, TTL: "24h"}, &token)
	if err != nil {
		return nil, fmt.Errorf("create one-time access token: %w", err)
	}
	return &token, nil
}

// SignupInitialAdmin calls POST /api/signup/setup to create the first admin user.
// It requires no authentication and only works when no users exist yet.
// Returns the created user and a JWT access token for subsequent API calls.
func (c *Client) SignupInitialAdmin(ctx context.Context, req SignupInitialAdminRequest) (*User, string, error) {
	data, err := json.Marshal(req)
	if err != nil {
		return nil, "", fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/signup/setup", bytes.NewReader(data))
	if err != nil {
		return nil, "", fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, "", fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, "", &APIError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	var user User
	if err := json.Unmarshal(respBody, &user); err != nil {
		return nil, "", fmt.Errorf("parse response: %w", err)
	}

	// Extract JWT from Set-Cookie header (name varies by protocol)
	jwt := ""
	for _, cookie := range resp.Cookies() {
		if cookie.Name == "access_token" || cookie.Name == "__Host-access_token" {
			jwt = cookie.Value
			break
		}
	}
	if jwt == "" {
		return nil, "", fmt.Errorf("no access token cookie in setup response")
	}

	return &user, jwt, nil
}

// CreateAPIKey creates a persistent database API key using the current auth (bearer/API key).
// The returned token is shown only once — store it immediately.
func (c *Client) CreateAPIKey(ctx context.Context, name string, expiresAt time.Time) (string, error) {
	var result CreateAPIKeyResponse
	err := c.doJSON(ctx, http.MethodPost, "/api/api-keys", CreateAPIKeyRequest{
		Name:      name,
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
	}, &result)
	if err != nil {
		return "", fmt.Errorf("create API key: %w", err)
	}
	return result.Token, nil
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

	if c.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearerToken)
	} else if c.apiKey != "" {
		req.Header.Set("X-API-KEY", c.apiKey)
	}
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

// IsSetupAlreadyCompleted returns true when /api/signup/setup fails because
// an admin user already exists (HTTP 400 "Setup already completed").
func IsSetupAlreadyCompleted(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.StatusCode == http.StatusBadRequest
	}
	return false
}
