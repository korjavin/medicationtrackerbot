package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
)

func TestHandleGetIntegrations_MasksSecretsAndReportsPlainFields(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()
	if err := db.Settings.SetIntegrationOpenAI(ctx, settings.IntegrationOpenAI{
		APIKey: "sk-xyz", URL: "https://api.openai.com/v1", Model: "gpt-5",
		VisionAPIKey: "", VisionURL: "https://vision.example.com", VisionModel: "gpt-4o-vision",
	}); err != nil {
		t.Fatalf("seed openai: %v", err)
	}
	if err := db.Settings.SetIntegrationFood(ctx, settings.IntegrationFood{
		APIKey: "food-key", URL: "", Domain: "fastfood.example.com",
	}); err != nil {
		t.Fatalf("seed food: %v", err)
	}
	if err := db.Settings.SetIntegrationElevenLabs(ctx, settings.IntegrationElevenLabs{
		APIKey: "el-key", AgentID: "agent_abc",
	}); err != nil {
		t.Fatalf("seed elevenlabs: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/settings/integrations", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetIntegrations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var resp integrationsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if resp.OpenAI.APIKey != secretMask {
		t.Errorf("OpenAI.APIKey not masked: %q", resp.OpenAI.APIKey)
	}
	if resp.OpenAI.URL != "https://api.openai.com/v1" {
		t.Errorf("OpenAI.URL passthrough mismatch: %q", resp.OpenAI.URL)
	}
	if resp.OpenAI.Model != "gpt-5" {
		t.Errorf("OpenAI.Model passthrough mismatch: %q", resp.OpenAI.Model)
	}
	if resp.OpenAI.VisionAPIKey != "" {
		t.Errorf("OpenAI.VisionAPIKey should be empty when unset: %q", resp.OpenAI.VisionAPIKey)
	}
	if resp.OpenAI.VisionModel != "gpt-4o-vision" {
		t.Errorf("OpenAI.VisionModel mismatch: %q", resp.OpenAI.VisionModel)
	}

	if resp.Food.APIKey != secretMask {
		t.Errorf("Food.APIKey not masked: %q", resp.Food.APIKey)
	}
	if resp.Food.URL != "" {
		t.Errorf("Food.URL should be empty: %q", resp.Food.URL)
	}
	if resp.Food.Domain != "fastfood.example.com" {
		t.Errorf("Food.Domain mismatch: %q", resp.Food.Domain)
	}

	if resp.ElevenLabs.APIKey != secretMask {
		t.Errorf("ElevenLabs.APIKey not masked: %q", resp.ElevenLabs.APIKey)
	}
	if resp.ElevenLabs.AgentID != "agent_abc" {
		t.Errorf("ElevenLabs.AgentID mismatch: %q", resp.ElevenLabs.AgentID)
	}
}

func TestHandlePatchIntegrations_PartialUpdateAndSecretPreservation(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()
	if err := db.Settings.SetIntegrationOpenAI(ctx, settings.IntegrationOpenAI{
		APIKey: "sk-existing", URL: "https://api.openai.com/v1", Model: "gpt-5",
	}); err != nil {
		t.Fatalf("seed openai: %v", err)
	}
	if err := db.Settings.SetIntegrationElevenLabs(ctx, settings.IntegrationElevenLabs{
		APIKey: "el-existing", AgentID: "agent_old",
	}); err != nil {
		t.Fatalf("seed elevenlabs: %v", err)
	}

	body := []byte(`{
		"openai": {
			"api_key": "***",
			"url": "https://proxy.example.com/v1",
			"model": "gpt-5",
			"vision_api_key": "",
			"vision_url": "",
			"vision_model": ""
		},
		"elevenlabs": {
			"api_key": "el-new",
			"agent_id": "agent_old"
		}
	}`)

	req := httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateIntegrations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	openAI, err := db.Settings.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("read openai: %v", err)
	}
	if openAI.APIKey != "sk-existing" {
		t.Errorf("OpenAI.APIKey should be preserved by *** mask, got %q", openAI.APIKey)
	}
	if openAI.URL != "https://proxy.example.com/v1" {
		t.Errorf("OpenAI.URL not updated: %q", openAI.URL)
	}

	el, err := db.Settings.GetIntegrationElevenLabs(ctx)
	if err != nil {
		t.Fatalf("read elevenlabs: %v", err)
	}
	if el.APIKey != "el-new" {
		t.Errorf("ElevenLabs.APIKey should be overwritten by new value, got %q", el.APIKey)
	}
	if el.AgentID != "agent_old" {
		t.Errorf("ElevenLabs.AgentID mismatch: %q", el.AgentID)
	}

	food, err := db.Settings.GetIntegrationFood(ctx)
	if err != nil {
		t.Fatalf("read food: %v", err)
	}
	if food.APIKey != "" || food.URL != "" || food.Domain != "" {
		t.Errorf("Food group should be untouched (omitted from patch); got %+v", food)
	}
}

func TestHandlePatchIntegrations_EmptyStringClearsSecret(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()
	if err := db.Settings.SetIntegrationOpenAI(ctx, settings.IntegrationOpenAI{
		APIKey: "sk-existing",
	}); err != nil {
		t.Fatalf("seed openai: %v", err)
	}

	body := []byte(`{"openai": {"api_key": "", "url": "", "model": "", "vision_api_key": "", "vision_url": "", "vision_model": ""}}`)
	req := httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateIntegrations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	openAI, err := db.Settings.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("read openai: %v", err)
	}
	if openAI.APIKey != "" {
		t.Errorf("OpenAI.APIKey should be cleared by empty string, got %q", openAI.APIKey)
	}
}

func TestHandlePatchIntegrations_InvalidBodyReturns400(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	cases := []struct {
		name string
		body string
	}{
		{"malformed json", "{not json"},
		{"unknown field", `{"openai": {"hacker_key": "x"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("PATCH", "/api/settings/integrations", strings.NewReader(tc.body))
			req = withUser(req, 123456)
			w := httptest.NewRecorder()
			srv.handleUpdateIntegrations(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", w.Code)
			}
		})
	}
}

// TestHandlePatchIntegrations_OmittedFieldsPreserveExistingValues asserts the
// PATCH semantic: fields absent from the JSON body are left untouched, even
// when the enclosing group is present. A field set to "" still clears the
// stored value (per TestHandlePatchIntegrations_EmptyStringClearsSecret);
// only field-absent means "leave as-is."
func TestHandlePatchIntegrations_OmittedFieldsPreserveExistingValues(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()
	if err := db.Settings.SetIntegrationOpenAI(ctx, settings.IntegrationOpenAI{
		APIKey: "sk-existing", URL: "https://api.openai.com/v1", Model: "gpt-5",
		VisionAPIKey: "vk-existing", VisionURL: "https://vision.example.com", VisionModel: "gpt-4o-vision",
	}); err != nil {
		t.Fatalf("seed openai: %v", err)
	}

	// Submit only the model — all other fields are absent. The handler must
	// leave URL, both vision fields, and the masked API key untouched rather
	// than treating "missing" as "empty".
	body := []byte(`{"openai": {"model": "gpt-5-new"}}`)
	req := httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateIntegrations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	openAI, err := db.Settings.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("read openai: %v", err)
	}
	if openAI.APIKey != "sk-existing" {
		t.Errorf("APIKey should be preserved when omitted, got %q", openAI.APIKey)
	}
	if openAI.URL != "https://api.openai.com/v1" {
		t.Errorf("URL should be preserved when omitted, got %q", openAI.URL)
	}
	if openAI.Model != "gpt-5-new" {
		t.Errorf("Model should be updated to new value, got %q", openAI.Model)
	}
	if openAI.VisionAPIKey != "vk-existing" {
		t.Errorf("VisionAPIKey should be preserved when omitted, got %q", openAI.VisionAPIKey)
	}
	if openAI.VisionURL != "https://vision.example.com" {
		t.Errorf("VisionURL should be preserved when omitted, got %q", openAI.VisionURL)
	}
	if openAI.VisionModel != "gpt-4o-vision" {
		t.Errorf("VisionModel should be preserved when omitted, got %q", openAI.VisionModel)
	}
}

func TestHandleGetIntegrations_EmptySettingsReturnsAllEmpty(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	req := httptest.NewRequest("GET", "/api/settings/integrations", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetIntegrations(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp integrationsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.OpenAI.APIKey != "" || resp.Food.APIKey != "" || resp.ElevenLabs.APIKey != "" {
		t.Errorf("expected all secrets unset on fresh DB, got %+v", resp)
	}
}
