package store

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// offAPIProduct matches the minimum structure from OpenFoodFacts required for our macros.
type offAPIProduct struct {
	Code        string `json:"code"`
	ProductName string `json:"product_name"`
	Nutriments  struct {
		Carbohydrates100G float64 `json:"carbohydrates_100g"`
		Proteins100G      float64 `json:"proteins_100g"`
		Fat100G           float64 `json:"fat_100g"`
		EnergyKcal100G    float64 `json:"energy-kcal_100g"`
	} `json:"nutriments"`
}

// SearchOpenFoodFactsAPI performs a live, resilient search against the OpenFoodFacts v0 (Barcode) or cgi (Text) endpoints.
// It maps the response safely to our local FoodProduct struct.
func (s *Store) SearchOpenFoodFactsAPI(ctx context.Context, query string) ([]FoodProduct, error) {
	var targetURL string

	// Determine if query is mostly a barcode (heuristic: all numbers or >= 8 chars numeric)
	isBarcode := len(query) >= 8 && isNumeric(query)

	if isBarcode {
		targetURL = fmt.Sprintf("https://world.openfoodfacts.org/api/v0/product/%s.json", url.PathEscape(query))
	} else {
		targetURL = fmt.Sprintf("https://world.openfoodfacts.org/cgi/search.pl?search_terms=%s&search_simple=1&action=process&json=1&page_size=6", url.QueryEscape(query))
	}

	req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "MedTrackerBot - Go - Version 1.0 - (https://github.com/korjavin/medicationtrackerbot)") // API requires user agent

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openfoodfacts API returned status: %d", resp.StatusCode)
	}

	var results []FoodProduct

	if isBarcode {
		// Parse single product
		var raw struct {
			Status  int           `json:"status"`
			Product offAPIProduct `json:"product"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
			return nil, err
		}
		if raw.Status == 1 && raw.Product.ProductName != "" {
			results = append(results, mapOFFProductToLocal(raw.Product))
		}
	} else {
		// Parse search response
		var raw struct {
			Count    int             `json:"count"`
			Products []offAPIProduct `json:"products"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
			return nil, err
		}
		for _, p := range raw.Products {
			if p.ProductName != "" {
				results = append(results, mapOFFProductToLocal(p))
			}
		}
	}

	return results, nil
}

func mapOFFProductToLocal(p offAPIProduct) FoodProduct {
	var barcode *string
	if p.Code != "" {
		code := p.Code
		barcode = &code
	}

	now := time.Now()

	return FoodProduct{
		ID:             0, // Global/Transient implies 0 ID and 0 UserID in context of cache mapping
		UserID:         0,
		Name:           p.ProductName,
		Barcode:        barcode,
		Carbs100g:      p.Nutriments.Carbohydrates100G,
		Protein100g:    p.Nutriments.Proteins100G,
		Fat100g:        p.Nutriments.Fat100G,
		EnergyKcal100g: p.Nutriments.EnergyKcal100G,
		UsageCount:     0,
		CreatedAt:      now,
		LastUsedAt:     now,
	}
}

func isNumeric(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
