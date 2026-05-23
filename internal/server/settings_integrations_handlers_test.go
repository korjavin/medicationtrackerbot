package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
)

var errReloaderTest = errors.New("reloader failed")

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

// TestHandlePatchIntegrations_InvokesReloaderAfterSuccess asserts the hot
// reload contract the mobile build depends on: after a successful PATCH the
// registered reloader runs so the freshly-saved OpenAI / Food / ElevenLabs
// values become live without a process restart. Without this hook the
// firstrun overlay's "enter key, unlock AI features" promise would fall
// over — s.foodAI / s.elevenLabs / food.RemoteConfig stay at startup values
// until restart. A reloader error is logged (best-effort) but does not fail
// the PATCH response since the row is already persisted.
func TestHandlePatchIntegrations_InvokesReloaderAfterSuccess(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	var called int
	var seenAPIKey string
	srv.SetIntegrationsReloader(func(ctx context.Context) error {
		called++
		openAI, err := db.Settings.GetIntegrationOpenAI(ctx)
		if err != nil {
			return err
		}
		seenAPIKey = openAI.APIKey
		return nil
	})

	body := []byte(`{"openai":{"api_key":"sk-fresh","url":"https://api.openai.com/v1","model":"gpt-4o-mini"}}`)
	req := httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateIntegrations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	if called != 1 {
		t.Errorf("expected reloader to fire once, got %d", called)
	}
	if seenAPIKey != "sk-fresh" {
		t.Errorf("reloader should observe the newly-persisted key, got %q", seenAPIKey)
	}
}

// TestHandlePatchIntegrations_ReloaderErrorDoesNotFailRequest asserts the
// best-effort contract: a reloader failure (e.g. transient settings re-read
// error) is logged but the PATCH response stays 200 because the row is
// already written. The user can restart to recover; failing the PATCH would
// leave them with the values persisted but no signal they were.
func TestHandlePatchIntegrations_ReloaderErrorDoesNotFailRequest(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	srv.SetIntegrationsReloader(func(ctx context.Context) error {
		return errReloaderTest
	})

	body := []byte(`{"openai":{"api_key":"sk-fresh"}}`)
	req := httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleUpdateIntegrations(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 despite reloader error, got %d (%s)", w.Code, w.Body.String())
	}
	openAI, err := db.Settings.GetIntegrationOpenAI(context.Background())
	if err != nil {
		t.Fatalf("read openai: %v", err)
	}
	if openAI.APIKey != "sk-fresh" {
		t.Errorf("row should be persisted even when reloader fails, got %q", openAI.APIKey)
	}
}

// TestHandlePatchIntegrations_HotReloadRaceFree asserts the hot-reload path
// can safely run concurrently with HTTP handlers that read foodAI and
// elevenLabs. Before the integrationsMu was introduced, a reloader firing
// while handleElevenLabsSignedURL / handleCreateFoodLogFromPhoto were
// in-flight would race on the struct + interface writes; this test would
// trip the -race detector. Now those reads / writes are guarded by the
// mutex, so a tight write/read loop in parallel goroutines stays clean.
func TestHandlePatchIntegrations_HotReloadRaceFree(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	srv.SetIntegrationsReloader(func(ctx context.Context) error {
		srv.SetElevenLabsConfig(ElevenLabsConfig{APIKey: "el-fresh", AgentID: "agent_fresh"})
		srv.SetFoodAIService(&stubFoodAI{})
		return nil
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			body := []byte(`{"elevenlabs":{"api_key":"el-x","agent_id":"agent_x"}}`)
			req := httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
			req = withUser(req, 123456)
			w := httptest.NewRecorder()
			srv.handleUpdateIntegrations(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("patch iter %d: expected 200, got %d", i, w.Code)
				return
			}
		}
	}()

	// Concurrent reader: tight loop pulling the same fields the live
	// handlers would read. Snapshot accessors must give a consistent view.
	for i := 0; i < 200; i++ {
		cfg := srv.elevenLabsConfig()
		_ = cfg.APIKey
		_ = cfg.AgentID
		_ = srv.foodAIService()
	}
	<-done
}

// TestHandlePatchIntegrations_ReloaderSerializedAcrossConcurrentPatches asserts
// the full reloader callback (read settings → rebuild clients → apply) runs
// under a single mutex so two concurrent PATCH handlers cannot interleave an
// older snapshot's apply after a newer snapshot's apply. Without the reload
// mutex, the in-memory providers could lag the DB indefinitely until the next
// PATCH or restart. The reloader here pauses while holding the "active" flag
// so an unsynchronized implementation would observe overlap; the assertion
// fires only on overlap, not on serial scheduling that happens to look the
// same.
func TestHandlePatchIntegrations_ReloaderSerializedAcrossConcurrentPatches(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	var active int32
	var overlap int32
	srv.SetIntegrationsReloader(func(ctx context.Context) error {
		if atomic.AddInt32(&active, 1) != 1 {
			atomic.StoreInt32(&overlap, 1)
		}
		// Hold the reload window long enough for a concurrent reloader to
		// race in if the handler doesn't serialize.
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&active, -1)
		return nil
	})

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := []byte(`{"openai":{"api_key":"sk-iter","model":"gpt-4o-mini"}}`)
			req := httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
			req = withUser(req, 123456)
			w := httptest.NewRecorder()
			srv.handleUpdateIntegrations(w, req)
			if w.Code != http.StatusOK {
				t.Errorf("expected 200, got %d (%s)", w.Code, w.Body.String())
			}
		}()
	}
	wg.Wait()
	if atomic.LoadInt32(&overlap) != 0 {
		t.Fatal("reloader callbacks ran concurrently; reloadMu did not serialize them")
	}
}

func TestHandleIntegrations_DemoModeBlocksReadsAndWrites(t *testing.T) {
	srv, db := createFoodTestServer(t)
	defer db.Close()

	ctx := context.Background()
	if err := db.Settings.SetIntegrationOpenAI(ctx, settings.IntegrationOpenAI{
		APIKey: "sk-original", URL: "https://api.openai.com/v1", Model: "gpt-5",
	}); err != nil {
		t.Fatalf("seed openai: %v", err)
	}
	srv.SetDemoMode(true)

	// GET must 403.
	req := httptest.NewRequest("GET", "/api/settings/integrations", nil)
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleGetIntegrations(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("GET expected 403 in demo mode, got %d (%s)", w.Code, w.Body.String())
	}

	// PATCH must 403 and must NOT mutate the stored credentials.
	body := []byte(`{"openai":{"api_key":"sk-attacker","url":"https://attacker.example/v1"}}`)
	req = httptest.NewRequest("PATCH", "/api/settings/integrations", bytes.NewReader(body))
	req = withUser(req, 123456)
	w = httptest.NewRecorder()
	srv.handleUpdateIntegrations(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("PATCH expected 403 in demo mode, got %d (%s)", w.Code, w.Body.String())
	}
	openAI, err := db.Settings.GetIntegrationOpenAI(ctx)
	if err != nil {
		t.Fatalf("read openai: %v", err)
	}
	if openAI.APIKey != "sk-original" {
		t.Errorf("PATCH must not mutate in demo mode, got APIKey=%q", openAI.APIKey)
	}
	if openAI.URL != "https://api.openai.com/v1" {
		t.Errorf("PATCH must not mutate in demo mode, got URL=%q", openAI.URL)
	}
}
