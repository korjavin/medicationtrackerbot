package ai

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

// Client is a wrapper for an OpenAI-compatible API.
type Client struct {
	apiKey     string
	apiURL     string
	model      string
	httpClient *http.Client
}

// NewClient creates a new OpenAI API client.
func NewClient(apiKey, apiURL, model string) *Client {
	if apiURL == "" {
		apiURL = "https://api.openai.com/v1"
	}
	if model == "" {
		model = "gpt-4o-mini"
	}

	return &Client{
		apiKey: apiKey,
		apiURL: strings.TrimRight(apiURL, "/"),
		model:  model,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// MealData holds the extracted nutritional information.
type MealData struct {
	Name        string  `json:"name"`
	WeightGrams float64 `json:"weight_grams"`
	Carbs100g   float64 `json:"carbs_100g"`
	Protein100g float64 `json:"protein_100g"`
	Fat100g     float64 `json:"fat_100g"`
}

// chatCompletionRequest represents the payload for the Chat Completions API.
type chatCompletionRequest struct {
	Model          string                  `json:"model"`
	Messages       []chatCompletionMessage `json:"messages"`
	ResponseFormat *responseFormat         `json:"response_format,omitempty"`
	Temperature    float32                 `json:"temperature"`
}

type chatCompletionMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type responseFormat struct {
	Type       string          `json:"type"`
	JSONSchema *jsonSchemaWrap `json:"json_schema,omitempty"`
}

type jsonSchemaWrap struct {
	Name   string `json:"name"`
	Strict bool   `json:"strict"`
	Schema any    `json:"schema"`
}

// chatCompletionResponse represents the API response.
type chatCompletionResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

type apiError struct {
	Message string
}

func (e *apiError) Error() string {
	return "API error: " + e.Message
}

var mealSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"name": map[string]any{
			"type": "string",
		},
		"weight_grams": map[string]any{
			"type": "number",
		},
		"carbs_100g": map[string]any{
			"type": "number",
		},
		"protein_100g": map[string]any{
			"type": "number",
		},
		"fat_100g": map[string]any{
			"type": "number",
		},
	},
	"required":             []string{"name", "weight_grams", "carbs_100g", "protein_100g", "fat_100g"},
	"additionalProperties": false,
}

// ParseMealFromDescription sends a natural language meal description to the OpenAI API and extracts nutritional data.
func (c *Client) ParseMealFromDescription(ctx context.Context, description string) (*MealData, error) {
	systemPrompt := `You are a nutrition expert. Your task is to extract the food name, estimated total weight in grams, and the macronutrients (carbohydrates, protein, and fat) PER 100 GRAMS from a free-text meal description.
If the description mentions multiple items, provide an aggregate name (e.g., "Chicken breast with rice and broccoli") and calculate the average/combined macros per 100g for the entire meal.
Respond ONLY with the requested JSON schema.`

	reqBody := chatCompletionRequest{
		Model: c.model,
		Messages: []chatCompletionMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: description},
		},
		Temperature: 0.1,
		ResponseFormat: &responseFormat{
			Type: "json_schema",
			JSONSchema: &jsonSchemaWrap{
				Name:   "meal_data",
				Strict: true,
				Schema: mealSchema,
			},
		},
	}

	mealData, err := c.parseMealWithRequest(ctx, reqBody)
	if err == nil {
		return mealData, nil
	}

	var apiErr *apiError
	if errors.As(err, &apiErr) && strings.Contains(strings.ToLower(apiErr.Message), "response_format") {
		fallbackReq := reqBody
		fallbackReq.ResponseFormat = nil
		fallbackReq.Messages = []chatCompletionMessage{
			{
				Role: "system",
				Content: systemPrompt + `
Return only valid JSON with keys: name, weight_grams, carbs_100g, protein_100g, fat_100g.
Do not wrap the JSON in markdown fences or add explanations.`,
			},
			{Role: "user", Content: description},
		}
		return c.parseMealWithRequest(ctx, fallbackReq)
	}

	return nil, err
}

func (c *Client) parseMealWithRequest(ctx context.Context, reqBody chatCompletionRequest) (*MealData, error) {
	reqBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL+"/chat/completions", bytes.NewReader(reqBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp chatCompletionResponse
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err == nil && errResp.Error != nil {
			return nil, &apiError{Message: errResp.Error.Message}
		}
		return nil, fmt.Errorf("API returned status code: %d", resp.StatusCode)
	}

	var completion chatCompletionResponse
	if err := json.NewDecoder(resp.Body).Decode(&completion); err != nil {
		return nil, fmt.Errorf("failed to decode API response: %w", err)
	}

	if len(completion.Choices) == 0 {
		return nil, errors.New("API returned no choices")
	}

	content := completion.Choices[0].Message.Content
	if content == "" {
		return nil, errors.New("API returned empty content")
	}

	var mealData MealData
	if err := json.Unmarshal([]byte(extractJSONContent(content)), &mealData); err != nil {
		return nil, fmt.Errorf("failed to parse JSON from API content: %w", err)
	}

	return &mealData, nil
}

func extractJSONContent(content string) string {
	content = strings.TrimSpace(content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	return strings.TrimSpace(content)
}
