package mcp

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// foodLogPayload is the JSON payload sent to the bot's /api/mcp-food-log endpoint.
type foodLogPayload struct {
	Name     string    `json:"name"`
	EatenAt  time.Time `json:"eaten_at"`
	Calories int       `json:"calories"`
	CarbsG   int       `json:"carbs_g"`
	ProteinG int       `json:"protein_g"`
	FatG     int       `json:"fat_g"`
	WeightG  int       `json:"weight_g"`
}

// FoodWriter sends HMAC-signed food log requests to the main bot's HTTP API.
type FoodWriter struct {
	endpoint string
	secret   string
	client   *http.Client
}

// NewFoodWriter creates a FoodWriter with a 5-second timeout.
func NewFoodWriter(endpoint, secret string) *FoodWriter {
	return &FoodWriter{
		endpoint: endpoint,
		secret:   secret,
		client:   &http.Client{Timeout: 5 * time.Second},
	}
}

// LogFood sends a food log entry to the bot's HTTP API and returns the new entry ID.
func (fw *FoodWriter) LogFood(ctx context.Context, p foodLogPayload) (int64, error) {
	body, err := json.Marshal(p)
	if err != nil {
		return 0, fmt.Errorf("food_writer: marshal payload: %w", err)
	}

	mac := hmac.New(sha256.New, []byte(fw.secret))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fw.endpoint, strings.NewReader(string(body)))
	if err != nil {
		return 0, fmt.Errorf("food_writer: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", sig)

	resp, err := fw.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("food_writer: request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("food_writer: unexpected status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var result struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("food_writer: decode response: %w", err)
	}

	return result.ID, nil
}
