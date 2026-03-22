package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseMealFromDescription_APIError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error": {"message": "Invalid API key", "type": "invalid_request_error"}}`))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	_, err := client.ParseMealFromDescription(context.Background(), "apple")
	if err == nil {
		t.Fatal("expected API error, got nil")
	}
	if err.Error() != "API error: Invalid API key" {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestParseMealFromDescription_InvalidJSON(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{invalid_json}`))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	_, err := client.ParseMealFromDescription(context.Background(), "apple")
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

func TestParseMealFromDescription_Success(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{
			"choices": [
				{
					"message": {
						"content": "{\"name\": \"Apple\", \"weight_grams\": 150, \"carbs_100g\": 14, \"protein_100g\": 0.3, \"fat_100g\": 0.2}"
					}
				}
			]
		}`))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	meal, err := client.ParseMealFromDescription(context.Background(), "apple")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if meal.Name != "Apple" {
		t.Errorf("expected name Apple, got %s", meal.Name)
	}
	if meal.WeightGrams != 150 {
		t.Errorf("expected weight 150, got %f", meal.WeightGrams)
	}
	if meal.Carbs100g != 14 {
		t.Errorf("expected carbs 14, got %f", meal.Carbs100g)
	}
	if meal.Protein100g != 0.3 {
		t.Errorf("expected protein 0.3, got %f", meal.Protein100g)
	}
	if meal.Fat100g != 0.2 {
		t.Errorf("expected fat 0.2, got %f", meal.Fat100g)
	}
}
