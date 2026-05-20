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
// the client can submit a partial update. A field set to the secretMask
// sentinel ("***") leaves the existing value untouched; an empty string
// clears the stored value; any other string overwrites it.
type integrationsPatchRequest struct {
	OpenAI     *openAIIntegrationDTO     `json:"openai,omitempty"`
	Food       *foodIntegrationDTO       `json:"food,omitempty"`
	ElevenLabs *elevenLabsIntegrationDTO `json:"elevenlabs,omitempty"`
}

// handleGetIntegrations returns the OpenAI / Food / ElevenLabs integration
// configuration that the user has saved via the Settings UI. Secret-bearing
// fields are masked when set so a screenshot or browser-DevTools network log
// never leaks the underlying API keys.
func (s *Server) handleGetIntegrations(w http.ResponseWriter, r *http.Request) {
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
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req integrationsPatchRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// Resolve each requested group against its existing row first so the
	// secret-mask sentinel is replaced by the previously-stored value before
	// the write fans out. The reads are outside the transaction (no harm: any
	// concurrent writer would race the optimistic UI anyway), the writes are
	// inside.
	var (
		openAINext *settings.IntegrationOpenAI
		foodNext   *settings.IntegrationFood
		elNext     *settings.IntegrationElevenLabs
	)

	if req.OpenAI != nil {
		existing, err := s.settings.GetIntegrationOpenAI(ctx)
		if err != nil {
			slog.Error("get integration openai for patch failed", "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		openAINext = &settings.IntegrationOpenAI{
			APIKey:       mergeSecretField(req.OpenAI.APIKey, existing.APIKey),
			URL:          req.OpenAI.URL,
			Model:        req.OpenAI.Model,
			VisionAPIKey: mergeSecretField(req.OpenAI.VisionAPIKey, existing.VisionAPIKey),
			VisionURL:    req.OpenAI.VisionURL,
			VisionModel:  req.OpenAI.VisionModel,
		}
	}

	if req.Food != nil {
		existing, err := s.settings.GetIntegrationFood(ctx)
		if err != nil {
			slog.Error("get integration food for patch failed", "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		foodNext = &settings.IntegrationFood{
			APIKey: mergeSecretField(req.Food.APIKey, existing.APIKey),
			URL:    req.Food.URL,
			Domain: req.Food.Domain,
		}
	}

	if req.ElevenLabs != nil {
		existing, err := s.settings.GetIntegrationElevenLabs(ctx)
		if err != nil {
			slog.Error("get integration elevenlabs for patch failed", "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		elNext = &settings.IntegrationElevenLabs{
			APIKey:  mergeSecretField(req.ElevenLabs.APIKey, existing.APIKey),
			AgentID: req.ElevenLabs.AgentID,
		}
	}

	if openAINext == nil && foodNext == nil && elNext == nil {
		w.WriteHeader(http.StatusOK)
		return
	}

	if err := s.settings.SetIntegrations(ctx, openAINext, foodNext, elNext); err != nil {
		slog.Error("set integrations atomic failed", "error", err)
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

// mergeSecretField is the inverse of maskSecret on the PATCH side: when the
// incoming string is the mask sentinel, the existing value is retained
// (the client did not re-enter the secret). Empty strings explicitly clear
// the stored secret; any other value overwrites it.
func mergeSecretField(incoming, existing string) string {
	if incoming == secretMask {
		return existing
	}
	return incoming
}

