package store

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// fastFoodProduct matches the OpenAPI schema for FastFoodDB.
type fastFoodProduct struct {
	Barcode  string   `json:"barcode"`
	Name     string   `json:"name"`
	Kcal100g *float64 `json:"kcal100g"`
	Protein  *float64 `json:"protein"`
	Fat      *float64 `json:"fat"`
	Carbs    *float64 `json:"carbs"`
}

// SearchRemoteFoodAPI performs a live, resilient search against the FastFoodDB API.
// It maps the response safely to our local FoodProduct struct.
func (s *Store) SearchRemoteFoodAPI(ctx context.Context, query string) ([]FoodProduct, error) {
	baseURL := os.Getenv("FOOD_API_URL")
	if baseURL == "" {
		domain := os.Getenv("FOOD_DOMAIN")
		if domain == "" {
			return nil, fmt.Errorf("FOOD_DOMAIN or FOOD_API_URL environment variable is required")
		}
		if strings.HasPrefix(domain, "http://") || strings.HasPrefix(domain, "https://") {
			baseURL = domain
		} else {
			baseURL = "https://" + domain
		}
	}
	baseURL = strings.TrimRight(baseURL, "/")

	apiKey := os.Getenv("FOOD_API_KEY")

	var targetURL string

	// Determine if query is mostly a barcode (heuristic: all numbers or >= 8 chars numeric)
	isBarcode := len(query) >= 8 && isNumeric(query)

	if isBarcode {
		targetURL = fmt.Sprintf("%s/api/v1/food/barcode/%s", baseURL, url.PathEscape(query))
	} else {
		targetURL = fmt.Sprintf("%s/api/v1/food/search?q=%s&limit=20", baseURL, url.QueryEscape(query))
	}

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		return nil, err
	}

	if apiKey != "" {
		req.Header.Set("X-API-Key", apiKey)
	}

	clientCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req = req.WithContext(clientCtx)

	client := &http.Client{
		Timeout: 30 * time.Second,
	}
	resp, err := client.Do(req) // #nosec G107
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote food API returned status: %d", resp.StatusCode)
	}

	var results []FoodProduct

	if isBarcode {
		// Parse single product
		var p fastFoodProduct
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&p); err != nil {
			return nil, err
		}
		if p.Name != "" {
			results = append(results, mapFastFoodProductToLocal(p))
		}
	} else {
		// Parse search response
		var raw struct {
			Results []fastFoodProduct `json:"results"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 5*1024*1024)).Decode(&raw); err != nil {
			return nil, err
		}
		for _, p := range raw.Results {
			// FastFoodDB returns accurate matches; map them.
			if p.Name != "" {
				results = append(results, mapFastFoodProductToLocal(p))
			}
		}
	}

	return results, nil
}

func mapFastFoodProductToLocal(p fastFoodProduct) FoodProduct {
	var barcode *string
	if p.Barcode != "" {
		b := p.Barcode
		barcode = &b
	}

	now := time.Now()

	var carbs, protein, fat, kcal float64
	if p.Carbs != nil {
		carbs = *p.Carbs
	}
	if p.Protein != nil {
		protein = *p.Protein
	}
	if p.Fat != nil {
		fat = *p.Fat
	}
	if p.Kcal100g != nil {
		kcal = *p.Kcal100g
	}

	return FoodProduct{
		ID:             0, // Global/Transient implies 0 ID and 0 UserID in context of cache mapping
		UserID:         0,
		Name:           normalizeFoodProductName(p.Name),
		Barcode:        barcode,
		Carbs100g:      carbs,
		Protein100g:    protein,
		Fat100g:        fat,
		EnergyKcal100g: kcal,
		UsageCount:     0,
		CreatedAt:      now,
		LastUsedAt:     now,
	}
}

func normalizeFoodProductName(name string) string {
	decoded := strings.TrimSpace(html.UnescapeString(name))
	if decoded == "" {
		return ""
	}

	if strings.Contains(decoded, "%") {
		if unescaped, err := url.QueryUnescape(decoded); err == nil {
			decoded = strings.TrimSpace(unescaped)
		}
	}
	return decoded
}

func isNumeric(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
