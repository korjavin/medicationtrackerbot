package mcp

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// foodLogPayload is the JSON body sent to the bot's /api/mcp-food-log endpoint.
type foodLogPayload struct {
	Name     string    `json:"name"`
	EatenAt  time.Time `json:"eaten_at"`
	Calories int       `json:"calories"`
	CarbsG   int       `json:"carbs_g"`
	ProteinG int       `json:"protein_g"`
	FatG     int       `json:"fat_g"`
	WeightG  int       `json:"weight_g"`
}

// foodLogResult is the JSON response from the bot's /api/mcp-food-log endpoint.
type foodLogResult struct {
	ID int64 `json:"id"`
}

// FoodWriter posts food intake entries to the main bot container via HMAC-signed HTTP.
type FoodWriter struct {
	endpoint string // e.g. "http://medtracker:8080/api/mcp-food-log"
	secret   string
	client   *http.Client
}

// NewFoodWriter creates a FoodWriter targeting the given endpoint with the given secret.
func NewFoodWriter(endpoint, secret string) *FoodWriter {
	return &FoodWriter{
		endpoint: endpoint,
		secret:   secret,
		client:   &http.Client{Timeout: 15 * time.Second},
	}
}

// LogFood sends a food intake entry to the bot and returns the created entry ID.
func (fw *FoodWriter) LogFood(ctx context.Context, payload foodLogPayload) (int64, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("marshal food log: %w", err)
	}

	mac := hmac.New(sha256.New, []byte(fw.secret))
	mac.Write(body)
	signature := hex.EncodeToString(mac.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fw.endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Signature", signature)

	resp, err := fw.client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("post food log: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("bot returned HTTP %d for food log", resp.StatusCode)
	}

	var result foodLogResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("decode food log response: %w", err)
	}

	return result.ID, nil
}
