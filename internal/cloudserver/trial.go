package cloudserver

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// Trial defaults mirror web/cloud/js/aiclient.js (DEFAULT_URL/DEFAULT_MODEL)
// so a bare TRIAL_OPENAI_API_KEY behaves like a bare BYO key.
const (
	trialDefaultOpenAIURL   = "https://api.openai.com/v1"
	trialDefaultOpenAIModel = "gpt-4o-mini"
	trialDefaultRatePerMin  = 10
)

// TrialConfig holds operator-owned trial provider credentials for the
// server-side proxy routes (docs/cloud-mode.md → Trial provider keys). The
// SECURITY INVARIANT: nothing in this struct may ever appear in an HTTP
// response body, header, injected meta tag, or log line — the client learns
// only booleans (TrialAIConfigured / TrialVoiceConfigured).
type TrialConfig struct {
	// OpenAI(-compatible) text triple.
	OpenAIAPIKey string
	OpenAIURL    string
	OpenAIModel  string
	// Vision triple; each field falls back to its text counterpart when
	// unset (same per-field fallback aiclient.js applies to vault keys).
	VisionAPIKey string
	VisionURL    string
	VisionModel  string
	// ElevenLabs signed-URL minting for the operator's shared agent.
	ElevenLabsAPIKey  string
	ElevenLabsAgentID string
	// Per-account sliding-window limit shared across all trial routes.
	RatePerMinute int
}

// TrialAIConfigured reports whether the OpenAI chat proxy can serve requests.
func (c TrialConfig) TrialAIConfigured() bool { return c.OpenAIAPIKey != "" }

// TrialVoiceConfigured reports whether the ElevenLabs signed-URL mint can
// serve requests (needs both the key and the shared agent).
func (c TrialConfig) TrialVoiceConfigured() bool {
	return c.ElevenLabsAPIKey != "" && c.ElevenLabsAgentID != ""
}

// TrialConfigFromEnv loads TRIAL_* envs (naming mirrors internal/config's
// OPENAI_*/ELEVENLABS_* convention) and applies defaults. With no TRIAL_*
// envs set the zero-ish config is returned and both Configured() checks are
// false — the proxy routes 503 and cloud behavior is unchanged.
func TrialConfigFromEnv() (TrialConfig, error) {
	cfg := TrialConfig{
		OpenAIAPIKey:      os.Getenv("TRIAL_OPENAI_API_KEY"),
		OpenAIURL:         os.Getenv("TRIAL_OPENAI_URL"),
		OpenAIModel:       os.Getenv("TRIAL_OPENAI_MODEL"),
		VisionAPIKey:      os.Getenv("TRIAL_OPENAI_VISION_API_KEY"),
		VisionURL:         os.Getenv("TRIAL_OPENAI_VISION_URL"),
		VisionModel:       os.Getenv("TRIAL_OPENAI_VISION_MODEL"),
		ElevenLabsAPIKey:  os.Getenv("TRIAL_ELEVENLABS_API_KEY"),
		ElevenLabsAgentID: os.Getenv("TRIAL_ELEVENLABS_AGENT_ID"),
		RatePerMinute:     trialDefaultRatePerMin,
	}
	// Trim trailing slashes like internal/ai and aiclient.js do — the proxy
	// concatenates "/chat/completions", and strict routers 404 on "//".
	cfg.OpenAIURL = strings.TrimRight(cfg.OpenAIURL, "/")
	cfg.VisionURL = strings.TrimRight(cfg.VisionURL, "/")
	if cfg.OpenAIURL == "" {
		cfg.OpenAIURL = trialDefaultOpenAIURL
	}
	if cfg.OpenAIModel == "" {
		cfg.OpenAIModel = trialDefaultOpenAIModel
	}
	if cfg.VisionAPIKey == "" {
		cfg.VisionAPIKey = cfg.OpenAIAPIKey
	}
	if cfg.VisionURL == "" {
		cfg.VisionURL = cfg.OpenAIURL
	}
	if cfg.VisionModel == "" {
		cfg.VisionModel = cfg.OpenAIModel
	}
	if rate := os.Getenv("TRIAL_RATE_PER_MIN"); rate != "" {
		n, err := strconv.Atoi(rate)
		if err != nil || n <= 0 {
			return cfg, errors.New("TRIAL_RATE_PER_MIN must be a positive integer")
		}
		cfg.RatePerMinute = n
	}
	return cfg, nil
}
