package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
		// 90s covers slow uploads of base64-encoded photos (up to ~8 MB) plus
		// vision-model latency. Text completions return well within this bound.
		httpClient: &http.Client{
			Timeout: 90 * time.Second,
		},
	}
}

// MealItem holds the extracted nutritional information for a single food item.
type MealItem struct {
	Name        string  `json:"name"`
	WeightGrams float64 `json:"weight_grams"`
	Carbs100g   float64 `json:"carbs_100g"`
	Protein100g float64 `json:"protein_100g"`
	Fat100g     float64 `json:"fat_100g"`
}

// ParsedMeal wraps an ordered list of atomic food items parsed from a free-text meal description.
type ParsedMeal struct {
	Items []MealItem `json:"items"`
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

// decodeAPIError builds an error for a non-2xx response. It first tries the
// standard OpenAI error shape ({"error": {"message": ...}}), then the array
// wrapper Gemini's OpenAI-compat layer uses ([{"error": {"message": ...}}]),
// and finally falls back to a body excerpt so the underlying message is never
// silently dropped.
func decodeAPIError(statusCode int, body io.Reader) error {
	raw, _ := io.ReadAll(body)

	var obj chatCompletionResponse
	if err := json.Unmarshal(raw, &obj); err == nil && obj.Error != nil && obj.Error.Message != "" {
		return &apiError{Message: obj.Error.Message}
	}

	var arr []chatCompletionResponse
	if err := json.Unmarshal(raw, &arr); err == nil {
		for _, item := range arr {
			if item.Error != nil && item.Error.Message != "" {
				return &apiError{Message: item.Error.Message}
			}
		}
	}

	excerpt := strings.TrimSpace(string(raw))
	if len(excerpt) > 300 {
		excerpt = excerpt[:300] + "..."
	}
	if excerpt == "" {
		return fmt.Errorf("API returned status code: %d", statusCode)
	}
	return fmt.Errorf("API returned status code %d: %s", statusCode, excerpt)
}

var mealSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"items": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":         map[string]any{"type": "string"},
					"weight_grams": map[string]any{"type": "number"},
					"carbs_100g":   map[string]any{"type": "number"},
					"protein_100g": map[string]any{"type": "number"},
					"fat_100g":     map[string]any{"type": "number"},
				},
				"required":             []string{"name", "weight_grams", "carbs_100g", "protein_100g", "fat_100g"},
				"additionalProperties": false,
			},
		},
	},
	"required":             []string{"items"},
	"additionalProperties": false,
}

// MealSystemPrompt is the system prompt used when parsing free-text meal descriptions.
// It is exported so tests (and observability tooling) can assert on its contents.
const MealSystemPrompt = `You are a nutrition expert. Parse a free-text meal description and split it into an ordered list of atomic food items.

Rules:
- Return every dish name in English, regardless of the input language. Translate non-English names.
- Use common, generic names (e.g. "chicken breast", not "grilled marinated chicken breast with lemon"; "rice", not "steamed jasmine rice").
- Split complex meals into atomic items: one item per distinct food or ingredient listed. Do not combine unrelated foods into a single row.
- Do not over-split composed dishes that the user named as a single unit. A sandwich stays one item ("ham and cheese sandwich"); do not break it into bread + cheese + ham. Soup or stew stays one item.
- For each item return: name, weight_grams (estimated total eaten), and macronutrients PER 100 GRAMS (carbs_100g, protein_100g, fat_100g).
- Preserve the order the user mentioned the items in.
- The "items" array must contain at least one entry.
Respond ONLY with the requested JSON schema.`

// ParseMealFromDescription sends a natural language meal description to the OpenAI API
// and extracts an ordered list of atomic food items with English-normalized names.
func (c *Client) ParseMealFromDescription(ctx context.Context, description string) (*ParsedMeal, error) {
	reqBody := chatCompletionRequest{
		Model: c.model,
		Messages: []chatCompletionMessage{
			{Role: "system", Content: MealSystemPrompt},
			{Role: "user", Content: description},
		},
		Temperature: 0.1,
		ResponseFormat: &responseFormat{
			Type: "json_schema",
			JSONSchema: &jsonSchemaWrap{
				Name:   "parsed_meal",
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
				Content: MealSystemPrompt + `
Return only valid JSON with the shape {"items": [{"name": string, "weight_grams": number, "carbs_100g": number, "protein_100g": number, "fat_100g": number}, ...]}.
Do not wrap the JSON in markdown fences or add explanations.`,
			},
			{Role: "user", Content: description},
		}
		return c.parseMealWithRequest(ctx, fallbackReq)
	}

	return nil, err
}

func (c *Client) parseMealWithRequest(ctx context.Context, reqBody chatCompletionRequest) (*ParsedMeal, error) {
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
		return nil, decodeAPIError(resp.StatusCode, resp.Body)
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

	var parsed ParsedMeal
	if err := json.Unmarshal([]byte(extractJSONContent(content)), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse JSON from API content: %w", err)
	}

	if len(parsed.Items) == 0 {
		return nil, errors.New("AI returned no meal items")
	}

	return &parsed, nil
}

// ActivityExercise holds data for a single parsed exercise.
type ActivityExercise struct {
	Name            string   `json:"name"`
	Sets            *int     `json:"sets"`
	Reps            *int     `json:"reps"`
	WeightKg        *float64 `json:"weight_kg"`
	DurationMinutes *int     `json:"duration_minutes"`
	Notes           string   `json:"notes"`
}

// ActivityData holds the parsed workout activity.
type ActivityData struct {
	Name      string             `json:"name"`
	Exercises []ActivityExercise `json:"exercises"`
}

var activitySchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"name": map[string]any{"type": "string"},
		"exercises": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":             map[string]any{"type": "string"},
					"sets":             map[string]any{"type": []string{"number", "null"}},
					"reps":             map[string]any{"type": []string{"number", "null"}},
					"weight_kg":        map[string]any{"type": []string{"number", "null"}},
					"duration_minutes": map[string]any{"type": []string{"number", "null"}},
					"notes":            map[string]any{"type": "string"},
				},
				"required":             []string{"name", "sets", "reps", "weight_kg", "duration_minutes", "notes"},
				"additionalProperties": false,
			},
		},
	},
	"required":             []string{"name", "exercises"},
	"additionalProperties": false,
}

// ParseActivityFromDescription sends a natural language workout description to the AI and extracts exercise data.
func (c *Client) ParseActivityFromDescription(ctx context.Context, description string) (*ActivityData, error) {
	systemPrompt := `You are a fitness expert. Parse a free-text workout description and extract:
- A short descriptive name for the overall session
- A list of exercises performed

For each exercise include:
- name: exercise name
- sets: number of sets (null if not applicable, e.g. cardio)
- reps: reps per set (null if not applicable)
- weight_kg: weight used in kg (null if bodyweight or not applicable)
- duration_minutes: duration in minutes (null if not applicable, e.g. strength exercises)
- notes: any additional notes (empty string if none)

For cardio/swimming/etc: use duration_minutes, leave sets/reps/weight_kg as null.
For strength: use sets/reps and optionally weight_kg, leave duration_minutes as null.
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
				Name:   "activity_data",
				Strict: true,
				Schema: activitySchema,
			},
		},
	}

	data, err := c.parseActivityWithRequest(ctx, reqBody)
	if err == nil {
		return data, nil
	}

	var apiErr *apiError
	if errors.As(err, &apiErr) && strings.Contains(strings.ToLower(apiErr.Message), "response_format") {
		fallbackReq := reqBody
		fallbackReq.ResponseFormat = nil
		fallbackReq.Messages = []chatCompletionMessage{
			{
				Role: "system",
				Content: systemPrompt + `
Return only valid JSON with keys: name, exercises (array of objects with keys: name, sets, reps, weight_kg, duration_minutes, notes).
Do not wrap the JSON in markdown fences or add explanations.`,
			},
			{Role: "user", Content: description},
		}
		return c.parseActivityWithRequest(ctx, fallbackReq)
	}

	return nil, err
}

func (c *Client) parseActivityWithRequest(ctx context.Context, reqBody chatCompletionRequest) (*ActivityData, error) {
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
		return nil, decodeAPIError(resp.StatusCode, resp.Body)
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

	var activityData ActivityData
	if err := json.Unmarshal([]byte(extractJSONContent(content)), &activityData); err != nil {
		return nil, fmt.Errorf("failed to parse JSON from API content: %w", err)
	}

	if len(activityData.Exercises) == 0 {
		return nil, errors.New("AI returned no exercises")
	}

	return &activityData, nil
}

func extractJSONContent(content string) string {
	content = strings.TrimSpace(content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	return strings.TrimSpace(content)
}

// MealPhotoSystemPrompt extends the meal-parsing rules with image-specific guidance
// for the vision-enabled flow.
const MealPhotoSystemPrompt = MealSystemPrompt + `

You are looking at a single photograph of a meal. Identify each visible food
item, estimate its eaten weight in grams from the apparent portion size, and
report typical macronutrients per 100 grams for that food. If multiple distinct
foods share a plate, list each as its own item. If the photo does not show
food, return an empty items array.`

// ParseMealFromImage sends a food photograph to the OpenAI Vision API and
// returns the same ParsedMeal shape produced by ParseMealFromDescription.
// imageBytes is the raw image; mimeType (e.g. "image/jpeg") gates the data
// URL OpenAI expects. The caller is responsible for any size limits.
func (c *Client) ParseMealFromImage(ctx context.Context, imageBytes []byte, mimeType string) (*ParsedMeal, error) {
	if len(imageBytes) == 0 {
		return nil, errors.New("image bytes are empty")
	}
	if mimeType == "" {
		mimeType = "image/jpeg"
	}

	dataURL := "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(imageBytes)

	reqBody := map[string]any{
		"model": c.model,
		"messages": []map[string]any{
			{"role": "system", "content": MealPhotoSystemPrompt},
			{
				"role": "user",
				"content": []map[string]any{
					{"type": "text", "text": "Identify the foods in this photo and return the JSON described above."},
					{"type": "image_url", "image_url": map[string]any{"url": dataURL}},
				},
			},
		},
		"temperature": 0.1,
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "parsed_meal",
				"strict": true,
				"schema": mealSchema,
			},
		},
	}

	parsed, err := c.parseMealVisionRequest(ctx, reqBody)
	if err == nil {
		return parsed, nil
	}

	// Some OpenAI-compatible providers reject json_schema; fall back to a
	// plain instruction the same way the text path does.
	var apiErr *apiError
	if errors.As(err, &apiErr) && strings.Contains(strings.ToLower(apiErr.Message), "response_format") {
		fallback := map[string]any{
			"model": c.model,
			"messages": []map[string]any{
				{
					"role": "system",
					"content": MealPhotoSystemPrompt + `
Return only valid JSON with the shape {"items": [{"name": string, "weight_grams": number, "carbs_100g": number, "protein_100g": number, "fat_100g": number}, ...]}.
Do not wrap the JSON in markdown fences or add explanations.`,
				},
				{
					"role": "user",
					"content": []map[string]any{
						{"type": "text", "text": "Identify the foods in this photo and return JSON."},
						{"type": "image_url", "image_url": map[string]any{"url": dataURL}},
					},
				},
			},
			"temperature": 0.1,
		}
		return c.parseMealVisionRequest(ctx, fallback)
	}

	return nil, err
}

func (c *Client) parseMealVisionRequest(ctx context.Context, reqBody map[string]any) (*ParsedMeal, error) {
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
		return nil, decodeAPIError(resp.StatusCode, resp.Body)
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

	var parsed ParsedMeal
	if err := json.Unmarshal([]byte(extractJSONContent(content)), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse JSON from API content: %w", err)
	}

	if len(parsed.Items) == 0 {
		return nil, errors.New("AI returned no meal items")
	}

	return &parsed, nil
}
