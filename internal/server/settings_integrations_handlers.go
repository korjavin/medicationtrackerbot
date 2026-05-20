package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
)

// secretMask is the placeholder returned in GET responses for fields that
// hold a non-empty secret. The frontend renders this as "configured" without
// ever revealing the stored value; on PATCH the same string is treated as
// "leave the existing value as-is" so the user can edit non-secret fields
// without re-entering keys.
const secretMask = "***"

// integrationsResponse is the wire shape returned by GET
// /api/settings/integrations. Secret fields are masked when set, empty when
// unset, so the UI can tell "configured" apart from "not configured" without
// ever receiving the underlying key.
type integrationsResponse struct {
	OpenAI     openAIIntegrationDTO     `json:"openai"`
	Food       foodIntegrationDTO       `json:"food"`
	ElevenLabs elevenLabsIntegrationDTO `json:"elevenlabs"`
}

type openAIIntegrationDTO struct {
	APIKey       string `json:"api_key"`
	URL          string `json:"url"`
	Model        string `json:"model"`
	VisionAPIKey string `json:"vision_api_key"`
	VisionURL    string `json:"vision_url"`
	VisionModel  string `json:"vision_model"`
}

type foodIntegrationDTO struct {
	APIKey string `json:"api_key"`
	URL    string `json:"url"`
	Domain string `json:"domain"`
}

type elevenLabsIntegrationDTO struct {
	APIKey  string `json:"api_key"`
	AgentID string `json:"agent_id"`
}

// integrationsPatchRequest mirrors the GET shape with all fields optional so
// the client can submit a partial update. Group pointers are nil when omitted
// from the request body; within a provided group, each field is itself a
// pointer so the handler can distinguish "field absent (leave as-is)" from
// "field present and empty (clear it)". A field set to the secretMask
// sentinel ("***") also leaves the existing value untouched — that path is
// kept so the frontend can round-trip a GET response (masked secrets) back
// into a PATCH without re-prompting the user for their API keys.
type integrationsPatchRequest struct {
	OpenAI     *openAIIntegrationPatch     `json:"openai,omitempty"`
	Food       *foodIntegrationPatch       `json:"food,omitempty"`
	ElevenLabs *elevenLabsIntegrationPatch `json:"elevenlabs,omitempty"`
}

type openAIIntegrationPatch struct {
	APIKey       *string `json:"api_key,omitempty"`
	URL          *string `json:"url,omitempty"`
	Model        *string `json:"model,omitempty"`
	VisionAPIKey *string `json:"vision_api_key,omitempty"`
	VisionURL    *string `json:"vision_url,omitempty"`
	VisionModel  *string `json:"vision_model,omitempty"`
}

type foodIntegrationPatch struct {
	APIKey *string `json:"api_key,omitempty"`
	URL    *string `json:"url,omitempty"`
	Domain *string `json:"domain,omitempty"`
}

type elevenLabsIntegrationPatch struct {
	APIKey  *string `json:"api_key,omitempty"`
	AgentID *string `json:"agent_id,omitempty"`
}

// handleGetIntegrations returns the OpenAI / Food / ElevenLabs integration
// configuration that the user has saved via the Settings UI. Secret-bearing
// fields are masked when set so a screenshot or browser-DevTools network log
// never leaks the underlying API keys.
func (s *Server) handleGetIntegrations(w http.ResponseWriter, r *http.Request) {
	// In demo mode every visitor resolves to the same demo user, so exposing
	// operator-specific URLs / agent IDs (and giving anonymous visitors a
	// surface to discover what's configured) is not appropriate. Both reads
	// and writes are blocked here; the frontend hides the section based on
	// bootstrap.demo.enabled but we enforce server-side too.
	if s.demoMode {
		http.Error(w, "integrations management is disabled in demo mode", http.StatusForbidden)
		return
	}

	ctx := r.Context()

	openAI, err := s.settings.GetIntegrationOpenAI(ctx)
	if err != nil {
		slog.Error("get integration openai failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	food, err := s.settings.GetIntegrationFood(ctx)
	if err != nil {
		slog.Error("get integration food failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	el, err := s.settings.GetIntegrationElevenLabs(ctx)
	if err != nil {
		slog.Error("get integration elevenlabs failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	resp := integrationsResponse{
		OpenAI: openAIIntegrationDTO{
			APIKey:       maskSecret(openAI.APIKey),
			URL:          openAI.URL,
			Model:        openAI.Model,
			VisionAPIKey: maskSecret(openAI.VisionAPIKey),
			VisionURL:    openAI.VisionURL,
			VisionModel:  openAI.VisionModel,
		},
		Food: foodIntegrationDTO{
			APIKey: maskSecret(food.APIKey),
			URL:    food.URL,
			Domain: food.Domain,
		},
		ElevenLabs: elevenLabsIntegrationDTO{
			APIKey:  maskSecret(el.APIKey),
			AgentID: el.AgentID,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("encode integrations response", "error", err)
	}
}

// handleUpdateIntegrations applies a partial update to the OpenAI / Food /
// ElevenLabs settings columns. Fields submitted with the secretMask sentinel
// are preserved (the user did not re-enter the secret), empty strings clear
// the stored value, and any other string overwrites it. Groups omitted from
// the request body are left untouched.
//
// The new values take effect at next process restart — the in-memory copies
// held by the Server (ElevenLabsConfig), the food repo (RemoteConfig), and
// the AI client are wired at startup and are not hot-reloaded.
func (s *Server) handleUpdateIntegrations(w http.ResponseWriter, r *http.Request) {
	// Demo mode resolves every request to the same fixed user, so an
	// anonymous visitor could otherwise PATCH the shared OpenAI / Food /
	// ElevenLabs credentials — wiping the operator's keys or pointing them
	// at an attacker-controlled URL. Block writes outright.
	if s.demoMode {
		http.Error(w, "integrations management is disabled in demo mode", http.StatusForbidden)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req integrationsPatchRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Translate each provided group into a settings.*Patch with pointer-typed
	// fields: nil = column unchanged, non-nil = overwrite with *value. The
	// secretMask sentinel ("***") collapses to nil here so the repo never needs
	// to read existing values to "preserve" a masked secret — which avoids the
	// read-modify-write race where two concurrent patches could resurrect a
	// secret another patch just cleared.
	var (
		openAINext *settings.IntegrationOpenAIPatch
		foodNext   *settings.IntegrationFoodPatch
		elNext     *settings.IntegrationElevenLabsPatch
	)

	if req.OpenAI != nil {
		openAINext = &settings.IntegrationOpenAIPatch{
			APIKey:       resolveSecretPatch(req.OpenAI.APIKey),
			URL:          req.OpenAI.URL,
			Model:        req.OpenAI.Model,
			VisionAPIKey: resolveSecretPatch(req.OpenAI.VisionAPIKey),
			VisionURL:    req.OpenAI.VisionURL,
			VisionModel:  req.OpenAI.VisionModel,
		}
	}

	if req.Food != nil {
		foodNext = &settings.IntegrationFoodPatch{
			APIKey: resolveSecretPatch(req.Food.APIKey),
			URL:    req.Food.URL,
			Domain: req.Food.Domain,
		}
	}

	if req.ElevenLabs != nil {
		elNext = &settings.IntegrationElevenLabsPatch{
			APIKey:  resolveSecretPatch(req.ElevenLabs.APIKey),
			AgentID: req.ElevenLabs.AgentID,
		}
	}

	if openAINext == nil && foodNext == nil && elNext == nil {
		w.WriteHeader(http.StatusOK)
		return
	}

	if err := s.settings.PatchIntegrations(ctx, openAINext, foodNext, elNext); err != nil {
		slog.Error("patch integrations failed", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// maskSecret returns the secretMask sentinel when value is non-empty, so a
// GET response can signal "configured" without echoing the raw secret. Empty
// values pass through unchanged so the UI knows the field is unset.
func maskSecret(value string) string {
	if value == "" {
		return ""
	}
	return secretMask
}

// resolveSecretPatch collapses the secretMask sentinel ("***") to nil so the
// repo treats a masked secret the same as an absent field — i.e. "leave the
// stored column untouched." Absence (nil) passes through as nil; an explicit
// empty string passes through as a non-nil pointer to "" (explicit clear); any
// other string passes through unchanged.
func resolveSecretPatch(incoming *string) *string {
	if incoming == nil {
		return nil
	}
	if *incoming == secretMask {
		return nil
	}
	return incoming
}

