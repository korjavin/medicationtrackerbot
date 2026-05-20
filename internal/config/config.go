// Package config holds the typed configuration struct that the bot main wires
// from process environment variables. It exists so the upcoming mobile build
// (//go:build mobile) and the existing server build share one shape and so the
// growing set of os.Getenv reads scattered across the codebase can be replaced
// with explicit dependency injection.
//
// LoadFromEnv preserves the exact semantics that cmd/bot/main.go used before
// this extraction — including OIDC fallback to POCKET_ID_*, DOMAIN/APP_DOMAIN
// ordering for VAPID, and OPENAI_VISION_* falling back to OPENAI_* — so the
// server build is byte-for-byte equivalent.
//
// LoadFromSettings reads the user-configurable subset (OpenAI / Food /
// ElevenLabs) from the singleton settings table. Merge combines an env-derived
// Config with a settings-derived Config using the precedence:
//
//  1. Env var (the server-mode operator's source of truth)
//  2. Settings table (user-edited via the Settings UI; the mobile build's only
//     source because the mobile binary's environment is the OS launcher's env,
//     not a docker-compose file)
//  3. Built-in default (e.g. https://api.openai.com/v1 for OpenAI URL — defaults
//     are still applied by individual call sites, not here)
//
// Field-level precedence means a partially-set env still wins per-field: e.g.
// setting only OPENAI_API_KEY in env and the rest in settings produces a
// Config where APIKey is from env and URL/Model are from settings.
package config

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"strings"

	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
)

// Config is the typed view of process-level configuration. Each sub-struct
// groups related settings so call sites can take just the slice they need.
type Config struct {
	DBPath                string
	Port                  string
	SessionSecret         string
	TelegramBotToken      string
	AllowedUserID         int64
	OpenAI                OpenAIConfig
	Food                  FoodConfig
	ElevenLabs            ElevenLabsConfig
	VAPID                 VAPIDConfig
	OIDC                  OIDCConfig
	MCP                   MCPConfig
	ExternalWorkoutAPIKey string
	AppDomain             string
}

// OpenAIConfig groups the OpenAI-compatible client settings, including the
// optional split-provider fields used when food photos are routed to a
// vision-capable model distinct from the primary text completion endpoint.
type OpenAIConfig struct {
	APIKey       string
	URL          string
	Model        string
	VisionAPIKey string
	VisionURL    string
	VisionModel  string
}

// FoodConfig groups the remote food-DB lookup settings used by
// internal/store/food's SearchRemoteAPI call. Either URL or Domain must be set
// at the call site for remote search to work.
type FoodConfig struct {
	APIKey string
	URL    string
	Domain string
}

// ElevenLabsConfig groups the Voice Agent proxy credentials. Both APIKey and
// AgentID must be set for the conversational endpoint to function; APIKey
// alone is enough for the per-conversation file upload proxy.
type ElevenLabsConfig struct {
	APIKey  string
	AgentID string
}

// VAPIDConfig groups Web Push signing material plus the subject/domain fields
// that pad the JWT.
type VAPIDConfig struct {
	PublicKey  string
	PrivateKey string
	Subject    string
	AdminEmail string
	Domain     string
}

// OIDCConfig groups the OIDC/OAuth login settings. The Provider field is set
// to "oidc" or "google" depending on which env vars triggered the load; an
// empty Provider means no OIDC was configured.
type OIDCConfig struct {
	Provider       string
	IssuerURL      string
	AuthURL        string
	TokenURL       string
	UserInfoURL    string
	ClientID       string
	ClientSecret   string
	RedirectURL    string
	AdminEmail     string
	AllowedSubject string
	ButtonLabel    string
	ButtonColor    string
	ButtonText     string
	Scopes         []string
}

// MCPConfig groups MCP-related secrets read at startup.
type MCPConfig struct {
	AuditSecret string
}

// LoadFromEnv reads the process environment and returns a populated Config.
// It performs exactly the env reads that lived in cmd/bot/main.go before this
// package existed: AppDomain falls back from APP_DOMAIN to DOMAIN, the OIDC
// loader uses POCKET_ID_* as a secondary source when OIDC_CLIENT_ID is unset,
// and OIDC discovery is rewritten to the internal Pocket-ID container URL
// when POCKET_ID_DOMAIN matches the issuer.
func LoadFromEnv() (*Config, error) {
	cfg := &Config{
		DBPath:           os.Getenv("DB_PATH"),
		Port:             os.Getenv("PORT"),
		SessionSecret:    os.Getenv("SESSION_SECRET"),
		TelegramBotToken: os.Getenv("TELEGRAM_BOT_TOKEN"),
		OpenAI: OpenAIConfig{
			APIKey:       os.Getenv("OPENAI_API_KEY"),
			URL:          os.Getenv("OPENAI_URL"),
			Model:        os.Getenv("OPENAI_MODEL"),
			VisionAPIKey: os.Getenv("OPENAI_VISION_API_KEY"),
			VisionURL:    os.Getenv("OPENAI_VISION_URL"),
			VisionModel:  os.Getenv("OPENAI_VISION_MODEL"),
		},
		Food: FoodConfig{
			APIKey: os.Getenv("FOOD_API_KEY"),
			URL:    os.Getenv("FOOD_API_URL"),
			Domain: os.Getenv("FOOD_DOMAIN"),
		},
		ElevenLabs: ElevenLabsConfig{
			APIKey:  os.Getenv("ELEVENLABS_API_KEY"),
			AgentID: os.Getenv("ELEVENLABS_AGENT_ID"),
		},
		VAPID: VAPIDConfig{
			PublicKey:  os.Getenv("VAPID_PUBLIC_KEY"),
			PrivateKey: os.Getenv("VAPID_PRIVATE_KEY"),
			Subject:    os.Getenv("VAPID_SUBJECT"),
			AdminEmail: os.Getenv("ADMIN_EMAIL"),
			Domain:     resolveVAPIDDomain(),
		},
		MCP: MCPConfig{
			AuditSecret: os.Getenv("MCP_AUDIT_SECRET"),
		},
		OIDC:                  loadOIDCFromEnv(),
		ExternalWorkoutAPIKey: os.Getenv("EXTERNAL_WORKOUT_API_KEY"),
		AppDomain:             resolveAppDomain(),
	}
	if userIDStr := os.Getenv("ALLOWED_USER_ID"); userIDStr != "" {
		parsed, err := strconv.ParseInt(userIDStr, 10, 64)
		if err != nil {
			// Don't return an error — server-mode tests construct a Config
			// without ALLOWED_USER_ID set and rely on this returning a usable
			// Config. But surface the malformed value so an operator typo
			// isn't undiagnosable.
			slog.Warn("ALLOWED_USER_ID is set but not a valid int64; treating as zero", "value", userIDStr, "error", err)
		} else {
			cfg.AllowedUserID = parsed
		}
	}
	return cfg, nil
}

// resolveVAPIDDomain mirrors the DOMAIN-then-APP_DOMAIN ordering the bot main
// used to assemble the Web Push subject claim. The order is *not* the same as
// AppDomain (which prefers APP_DOMAIN) — keep them distinct.
func resolveVAPIDDomain() string {
	if v := os.Getenv("DOMAIN"); v != "" {
		return v
	}
	return os.Getenv("APP_DOMAIN")
}

// resolveAppDomain mirrors the APP_DOMAIN-then-DOMAIN ordering the HTTP server
// uses for cookie/redirect base resolution.
func resolveAppDomain() string {
	if v := os.Getenv("APP_DOMAIN"); v != "" {
		return v
	}
	return os.Getenv("DOMAIN")
}

func loadOIDCFromEnv() OIDCConfig {
	if os.Getenv("OIDC_ISSUER_URL") != "" || os.Getenv("OIDC_CLIENT_ID") != "" {
		clientID := os.Getenv("OIDC_CLIENT_ID")
		clientSecret := os.Getenv("OIDC_CLIENT_SECRET")
		if clientID == "" && os.Getenv("POCKET_ID_CLIENT_ID") != "" {
			clientID = os.Getenv("POCKET_ID_CLIENT_ID")
			clientSecret = os.Getenv("POCKET_ID_CLIENT_SECRET")
		}
		issuerURL := os.Getenv("OIDC_ISSUER_URL")
		if pocketDomain := os.Getenv("POCKET_ID_DOMAIN"); pocketDomain != "" && strings.Contains(issuerURL, pocketDomain) {
			issuerURL = "http://medtracker-pocket-id:1411"
		}
		return OIDCConfig{
			Provider:       "oidc",
			IssuerURL:      issuerURL,
			AuthURL:        os.Getenv("OIDC_AUTH_URL"),
			TokenURL:       os.Getenv("OIDC_TOKEN_URL"),
			UserInfoURL:    os.Getenv("OIDC_USERINFO_URL"),
			ClientID:       clientID,
			ClientSecret:   clientSecret,
			RedirectURL:    os.Getenv("OIDC_REDIRECT_URL"),
			AdminEmail:     os.Getenv("OIDC_ADMIN_EMAIL"),
			AllowedSubject: os.Getenv("OIDC_ALLOWED_SUBJECT"),
			ButtonLabel:    os.Getenv("OIDC_BUTTON_LABEL"),
			ButtonColor:    os.Getenv("OIDC_BUTTON_COLOR"),
			ButtonText:     os.Getenv("OIDC_BUTTON_TEXT_COLOR"),
			Scopes:         parseOIDCScopes(os.Getenv("OIDC_SCOPES")),
		}
	}
	if os.Getenv("GOOGLE_CLIENT_ID") != "" {
		return OIDCConfig{
			Provider:     "google",
			ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
			ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
			RedirectURL:  os.Getenv("GOOGLE_REDIRECT_URL"),
			AdminEmail:   os.Getenv("ADMIN_EMAIL"),
		}
	}
	return OIDCConfig{}
}

// SettingsReader is the narrow interface LoadFromSettings depends on. It is
// satisfied by *settings.Repo; defining it here keeps tests from having to
// stand up a full SQLite DB to exercise the load path.
type SettingsReader interface {
	GetIntegrationOpenAI(ctx context.Context) (settings.IntegrationOpenAI, error)
	GetIntegrationFood(ctx context.Context) (settings.IntegrationFood, error)
	GetIntegrationElevenLabs(ctx context.Context) (settings.IntegrationElevenLabs, error)
}

// LoadFromSettings reads the user-configurable subset (OpenAI, Food,
// ElevenLabs) from the settings table and returns a Config with just those
// fields populated. Fields not represented in the settings table (DBPath,
// SessionSecret, VAPID, OIDC, MCP, TelegramBotToken, etc.) are left zero —
// those still come from env in server mode and from build-time defaults in
// mobile mode.
func LoadFromSettings(ctx context.Context, r SettingsReader) (*Config, error) {
	openAI, err := r.GetIntegrationOpenAI(ctx)
	if err != nil {
		return nil, err
	}
	food, err := r.GetIntegrationFood(ctx)
	if err != nil {
		return nil, err
	}
	el, err := r.GetIntegrationElevenLabs(ctx)
	if err != nil {
		return nil, err
	}
	return &Config{
		OpenAI: OpenAIConfig{
			APIKey:       openAI.APIKey,
			URL:          openAI.URL,
			Model:        openAI.Model,
			VisionAPIKey: openAI.VisionAPIKey,
			VisionURL:    openAI.VisionURL,
			VisionModel:  openAI.VisionModel,
		},
		Food: FoodConfig{
			APIKey: food.APIKey,
			URL:    food.URL,
			Domain: food.Domain,
		},
		ElevenLabs: ElevenLabsConfig{
			APIKey:  el.APIKey,
			AgentID: el.AgentID,
		},
	}, nil
}

// Merge returns a new *Config that takes each user-configurable field from env
// when set, else from settings, else zero. Server-mode fields (DBPath, Port,
// SessionSecret, TelegramBotToken, AllowedUserID, VAPID, OIDC, MCP,
// ExternalWorkoutAPIKey, AppDomain) are passed through from env unchanged —
// they do not have a settings-table counterpart.
//
// Passing a nil settingsCfg returns envCfg unchanged. Passing a nil envCfg
// returns settingsCfg unchanged. Both nil returns nil.
func Merge(envCfg, settingsCfg *Config) *Config {
	if envCfg == nil && settingsCfg == nil {
		return nil
	}
	if envCfg == nil {
		out := *settingsCfg
		return &out
	}
	if settingsCfg == nil {
		out := *envCfg
		return &out
	}
	out := *envCfg
	out.OpenAI = OpenAIConfig{
		APIKey:       firstNonEmpty(envCfg.OpenAI.APIKey, settingsCfg.OpenAI.APIKey),
		URL:          firstNonEmpty(envCfg.OpenAI.URL, settingsCfg.OpenAI.URL),
		Model:        firstNonEmpty(envCfg.OpenAI.Model, settingsCfg.OpenAI.Model),
		VisionAPIKey: firstNonEmpty(envCfg.OpenAI.VisionAPIKey, settingsCfg.OpenAI.VisionAPIKey),
		VisionURL:    firstNonEmpty(envCfg.OpenAI.VisionURL, settingsCfg.OpenAI.VisionURL),
		VisionModel:  firstNonEmpty(envCfg.OpenAI.VisionModel, settingsCfg.OpenAI.VisionModel),
	}
	out.Food = FoodConfig{
		APIKey: firstNonEmpty(envCfg.Food.APIKey, settingsCfg.Food.APIKey),
		URL:    firstNonEmpty(envCfg.Food.URL, settingsCfg.Food.URL),
		Domain: firstNonEmpty(envCfg.Food.Domain, settingsCfg.Food.Domain),
	}
	out.ElevenLabs = ElevenLabsConfig{
		APIKey:  firstNonEmpty(envCfg.ElevenLabs.APIKey, settingsCfg.ElevenLabs.APIKey),
		AgentID: firstNonEmpty(envCfg.ElevenLabs.AgentID, settingsCfg.ElevenLabs.AgentID),
	}
	return &out
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// parseOIDCScopes splits OIDC_SCOPES on any of comma / space / newline / tab.
// Kept as a package-level helper so tests can call it directly.
func parseOIDCScopes(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	var scopes []string
	for _, s := range fields {
		if s != "" {
			scopes = append(scopes, s)
		}
	}
	return scopes
}
