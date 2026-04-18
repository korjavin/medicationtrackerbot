package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
						"content": "{\"items\": [{\"name\": \"Apple\", \"weight_grams\": 150, \"carbs_100g\": 14, \"protein_100g\": 0.3, \"fat_100g\": 0.2}]}"
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

	if len(meal.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(meal.Items))
	}
	item := meal.Items[0]
	if item.Name != "Apple" {
		t.Errorf("expected name Apple, got %s", item.Name)
	}
	if item.WeightGrams != 150 {
		t.Errorf("expected weight 150, got %f", item.WeightGrams)
	}
	if item.Carbs100g != 14 {
		t.Errorf("expected carbs 14, got %f", item.Carbs100g)
	}
	if item.Protein100g != 0.3 {
		t.Errorf("expected protein 0.3, got %f", item.Protein100g)
	}
	if item.Fat100g != 0.2 {
		t.Errorf("expected fat 0.2, got %f", item.Fat100g)
	}
}

func TestParseMealFromDescription_MultipleItems(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{
			"choices": [
				{
					"message": {
						"content": "{\"items\": [{\"name\": \"Chicken breast\", \"weight_grams\": 200, \"carbs_100g\": 0, \"protein_100g\": 31, \"fat_100g\": 3.6}, {\"name\": \"Rice\", \"weight_grams\": 150, \"carbs_100g\": 28, \"protein_100g\": 2.7, \"fat_100g\": 0.3}, {\"name\": \"Broccoli\", \"weight_grams\": 80, \"carbs_100g\": 7, \"protein_100g\": 2.8, \"fat_100g\": 0.4}]}"
					}
				}
			]
		}`))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	meal, err := client.ParseMealFromDescription(context.Background(), "chicken breast with rice and broccoli")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(meal.Items) != 3 {
		t.Fatalf("expected 3 items, got %d", len(meal.Items))
	}
	if meal.Items[0].Name != "Chicken breast" {
		t.Errorf("expected first item Chicken breast, got %s", meal.Items[0].Name)
	}
	if meal.Items[1].Name != "Rice" {
		t.Errorf("expected second item Rice, got %s", meal.Items[1].Name)
	}
	if meal.Items[2].Name != "Broccoli" {
		t.Errorf("expected third item Broccoli, got %s", meal.Items[2].Name)
	}
}

func TestParseMealFromDescription_EmptyItemsRejected(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{
			"choices": [
				{"message": {"content": "{\"items\": []}"}}
			]
		}`))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	_, err := client.ParseMealFromDescription(context.Background(), "nothing")
	if err == nil {
		t.Fatal("expected error when AI returns zero items, got nil")
	}
	if !strings.Contains(err.Error(), "no meal items") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestParseMealFromDescription_NonEnglishInputRequestsEnglishOutput(t *testing.T) {
	// Sanity check that the request payload carries the English-normalization instruction
	// regardless of the input language, and that the server returning English names works.
	var capturedSystemPrompt string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatCompletionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if len(req.Messages) == 0 || req.Messages[0].Role != "system" {
			t.Fatalf("expected first message to be system prompt")
		}
		capturedSystemPrompt = req.Messages[0].Content

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{
			"choices": [
				{
					"message": {
						"content": "{\"items\": [{\"name\": \"Buckwheat porridge\", \"weight_grams\": 200, \"carbs_100g\": 20, \"protein_100g\": 4, \"fat_100g\": 1}]}"
					}
				}
			]
		}`))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	meal, err := client.ParseMealFromDescription(context.Background(), "гречневая каша 200 грамм")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(capturedSystemPrompt, "English") {
		t.Errorf("system prompt missing English instruction: %q", capturedSystemPrompt)
	}
	if !strings.Contains(capturedSystemPrompt, "atomic") {
		t.Errorf("system prompt missing atomic-split instruction: %q", capturedSystemPrompt)
	}
	if !strings.Contains(capturedSystemPrompt, "common") {
		t.Errorf("system prompt missing common-name instruction: %q", capturedSystemPrompt)
	}
	if len(meal.Items) != 1 || meal.Items[0].Name != "Buckwheat porridge" {
		t.Fatalf("unexpected meal items: %+v", meal.Items)
	}
}

func TestParseMealFromDescription_FallsBackWhenResponseFormatUnsupported(t *testing.T) {
	requests := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++

		var req chatCompletionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		if requests == 1 {
			if req.ResponseFormat == nil || req.ResponseFormat.Type != "json_schema" {
				t.Fatalf("expected initial request to use json_schema response format")
			}
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error": {"message": "This response_format type is unavailable now", "type": "invalid_request_error"}}`))
			return
		}

		if req.ResponseFormat != nil {
			t.Fatalf("expected fallback request without response format")
		}
		if !strings.Contains(req.Messages[0].Content, "Return only valid JSON") {
			t.Fatalf("expected fallback prompt to request plain JSON")
		}
		if !strings.Contains(req.Messages[0].Content, "items") {
			t.Fatalf("expected fallback prompt to describe the items schema")
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{
			"choices": [
				{
					"message": {
						"content": "{\"items\": [{\"name\": \"Meatballs\", \"weight_grams\": 140, \"carbs_100g\": 6, \"protein_100g\": 18, \"fat_100g\": 15}, {\"name\": \"Fries\", \"weight_grams\": 100, \"carbs_100g\": 41, \"protein_100g\": 3.4, \"fat_100g\": 15}]}"
					}
				}
			]
		}`))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	meal, err := client.ParseMealFromDescription(context.Background(), "meatballs and fries")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if requests != 2 {
		t.Fatalf("expected 2 requests, got %d", requests)
	}
	if len(meal.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(meal.Items))
	}
	if meal.Items[0].Name != "Meatballs" || meal.Items[1].Name != "Fries" {
		t.Fatalf("unexpected meal items: %+v", meal.Items)
	}
}

func TestParseMealFromDescription_ParsesMarkdownWrappedJSON(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("{\n" +
			"  \"choices\": [\n" +
			"    {\n" +
			"      \"message\": {\n" +
			"        \"content\": \"```json\\n{\\\"items\\\": [{\\\"name\\\": \\\"Apple\\\", \\\"weight_grams\\\": 150, \\\"carbs_100g\\\": 14, \\\"protein_100g\\\": 0.3, \\\"fat_100g\\\": 0.2}]}\\n```\"\n" +
			"      }\n" +
			"    }\n" +
			"  ]\n" +
			"}"))
	}))
	defer ts.Close()

	client := NewClient("test-key", ts.URL, "")
	meal, err := client.ParseMealFromDescription(context.Background(), "apple")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(meal.Items) != 1 || meal.Items[0].Name != "Apple" {
		t.Fatalf("unexpected meal items: %+v", meal.Items)
	}
}
