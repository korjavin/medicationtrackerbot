package config

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
)

func TestLoadFromEnv_AllFieldsPopulated(t *testing.T) {
	clearEnv(t)

	t.Setenv("DB_PATH", "/tmp/meds.db")
	t.Setenv("PORT", "9090")
	t.Setenv("SESSION_SECRET", "32-char-secret-aaaaaaaaaaaaaaaaaaaa")
	t.Setenv("TELEGRAM_BOT_TOKEN", "bot-token")
	t.Setenv("ALLOWED_USER_ID", "424242")

	t.Setenv("OPENAI_API_KEY", "sk-text")
	t.Setenv("OPENAI_URL", "https://api.example.test/v1")
	t.Setenv("OPENAI_MODEL", "model-x")
	t.Setenv("OPENAI_VISION_API_KEY", "sk-vision")
	t.Setenv("OPENAI_VISION_URL", "https://vision.example.test/v1")
	t.Setenv("OPENAI_VISION_MODEL", "model-vision")

	t.Setenv("FOOD_API_KEY", "food-key")
	t.Setenv("FOOD_API_URL", "https://food.example.test/v1")
	t.Setenv("FOOD_DOMAIN", "food.example.test")

	t.Setenv("ELEVENLABS_API_KEY", "el-key")
	t.Setenv("ELEVENLABS_AGENT_ID", "el-agent")

	t.Setenv("VAPID_PUBLIC_KEY", "vapid-pub")
	t.Setenv("VAPID_PRIVATE_KEY", "vapid-priv")
	t.Setenv("VAPID_SUBJECT", "mailto:ops@example.test")
	t.Setenv("ADMIN_EMAIL", "ops@example.test")
	t.Setenv("DOMAIN", "meds.example.test")
	t.Setenv("APP_DOMAIN", "app.example.test")

	t.Setenv("OIDC_ISSUER_URL", "https://idp.example.test")
	t.Setenv("OIDC_CLIENT_ID", "client-id")
	t.Setenv("OIDC_CLIENT_SECRET", "client-secret")
	t.Setenv("OIDC_REDIRECT_URL", "https://app.example.test/cb")
	t.Setenv("OIDC_BUTTON_LABEL", "Login")
	t.Setenv("OIDC_SCOPES", "openid email,profile")

	t.Setenv("MCP_AUDIT_SECRET", "mcp-secret")
	t.Setenv("EXTERNAL_WORKOUT_API_KEY", "ext-workout")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv: %v", err)
	}

	if cfg.DBPath != "/tmp/meds.db" {
		t.Errorf("DBPath = %q", cfg.DBPath)
	}
	if cfg.Port != "9090" {
		t.Errorf("Port = %q", cfg.Port)
	}
	if cfg.SessionSecret == "" {
		t.Errorf("SessionSecret should be set")
	}
	if cfg.TelegramBotToken != "bot-token" {
		t.Errorf("TelegramBotToken = %q", cfg.TelegramBotToken)
	}
	if cfg.AllowedUserID != 424242 {
		t.Errorf("AllowedUserID = %d", cfg.AllowedUserID)
	}

	wantOpenAI := OpenAIConfig{
		APIKey:       "sk-text",
		URL:          "https://api.example.test/v1",
		Model:        "model-x",
		VisionAPIKey: "sk-vision",
		VisionURL:    "https://vision.example.test/v1",
		VisionModel:  "model-vision",
	}
	if cfg.OpenAI != wantOpenAI {
		t.Errorf("OpenAI = %+v want %+v", cfg.OpenAI, wantOpenAI)
	}

	wantFood := FoodConfig{
		APIKey: "food-key",
		URL:    "https://food.example.test/v1",
		Domain: "food.example.test",
	}
	if cfg.Food != wantFood {
		t.Errorf("Food = %+v want %+v", cfg.Food, wantFood)
	}

	wantEL := ElevenLabsConfig{APIKey: "el-key", AgentID: "el-agent"}
	if cfg.ElevenLabs != wantEL {
		t.Errorf("ElevenLabs = %+v want %+v", cfg.ElevenLabs, wantEL)
	}

	// VAPID Domain prefers DOMAIN over APP_DOMAIN, distinct from AppDomain.
	wantVAPID := VAPIDConfig{
		PublicKey:  "vapid-pub",
		PrivateKey: "vapid-priv",
		Subject:    "mailto:ops@example.test",
		AdminEmail: "ops@example.test",
		Domain:     "meds.example.test",
	}
	if cfg.VAPID != wantVAPID {
		t.Errorf("VAPID = %+v want %+v", cfg.VAPID, wantVAPID)
	}

	// AppDomain prefers APP_DOMAIN over DOMAIN.
	if cfg.AppDomain != "app.example.test" {
		t.Errorf("AppDomain = %q want app.example.test", cfg.AppDomain)
	}

	if cfg.MCP.AuditSecret != "mcp-secret" {
		t.Errorf("MCP.AuditSecret = %q", cfg.MCP.AuditSecret)
	}
	if cfg.ExternalWorkoutAPIKey != "ext-workout" {
		t.Errorf("ExternalWorkoutAPIKey = %q", cfg.ExternalWorkoutAPIKey)
	}

	if cfg.OIDC.Provider != "oidc" {
		t.Errorf("OIDC.Provider = %q want oidc", cfg.OIDC.Provider)
	}
	if cfg.OIDC.ClientID != "client-id" || cfg.OIDC.ClientSecret != "client-secret" {
		t.Errorf("OIDC client creds wrong: %+v", cfg.OIDC)
	}
	wantScopes := []string{"openid", "email", "profile"}
	if !reflect.DeepEqual(cfg.OIDC.Scopes, wantScopes) {
		t.Errorf("OIDC.Scopes = %v want %v", cfg.OIDC.Scopes, wantScopes)
	}
}

func TestLoadFromEnv_AppDomainFallsBackToDOMAIN(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOMAIN", "meds.example.test")
	// APP_DOMAIN not set.

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv: %v", err)
	}
	if cfg.AppDomain != "meds.example.test" {
		t.Errorf("AppDomain = %q want meds.example.test (fallback to DOMAIN)", cfg.AppDomain)
	}
	if cfg.VAPID.Domain != "meds.example.test" {
		t.Errorf("VAPID.Domain = %q want meds.example.test", cfg.VAPID.Domain)
	}
}

func TestLoadFromEnv_VAPIDDomainFallsBackToAPPDOMAIN(t *testing.T) {
	clearEnv(t)
	// DOMAIN not set; APP_DOMAIN is the only one set.
	t.Setenv("APP_DOMAIN", "app.example.test")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv: %v", err)
	}
	if cfg.VAPID.Domain != "app.example.test" {
		t.Errorf("VAPID.Domain = %q want app.example.test (fallback to APP_DOMAIN)", cfg.VAPID.Domain)
	}
	if cfg.AppDomain != "app.example.test" {
		t.Errorf("AppDomain = %q want app.example.test", cfg.AppDomain)
	}
}

func TestLoadFromEnv_OIDCFallsBackToPocketID(t *testing.T) {
	clearEnv(t)
	t.Setenv("OIDC_ISSUER_URL", "https://pocket.example.test")
	// OIDC_CLIENT_ID intentionally blank — POCKET_ID_* should supply creds.
	t.Setenv("POCKET_ID_CLIENT_ID", "pocket-client")
	t.Setenv("POCKET_ID_CLIENT_SECRET", "pocket-secret")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv: %v", err)
	}
	if cfg.OIDC.ClientID != "pocket-client" {
		t.Errorf("OIDC.ClientID = %q want pocket-client", cfg.OIDC.ClientID)
	}
	if cfg.OIDC.ClientSecret != "pocket-secret" {
		t.Errorf("OIDC.ClientSecret = %q want pocket-secret", cfg.OIDC.ClientSecret)
	}
}

func TestLoadFromEnv_OIDCRewritesIssuerForInternalPocketID(t *testing.T) {
	clearEnv(t)
	t.Setenv("OIDC_ISSUER_URL", "https://pocket.example.test")
	t.Setenv("OIDC_CLIENT_ID", "client")
	t.Setenv("POCKET_ID_DOMAIN", "pocket.example.test")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv: %v", err)
	}
	if cfg.OIDC.IssuerURL != "http://medtracker-pocket-id:1411" {
		t.Errorf("OIDC.IssuerURL = %q want internal container URL", cfg.OIDC.IssuerURL)
	}
}

func TestLoadFromEnv_GoogleProviderWhenOIDCMissingButGoogleSet(t *testing.T) {
	clearEnv(t)
	t.Setenv("GOOGLE_CLIENT_ID", "google-id")
	t.Setenv("GOOGLE_CLIENT_SECRET", "google-secret")
	t.Setenv("GOOGLE_REDIRECT_URL", "https://app.example.test/cb")
	t.Setenv("ADMIN_EMAIL", "admin@example.test")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv: %v", err)
	}
	if cfg.OIDC.Provider != "google" {
		t.Errorf("OIDC.Provider = %q want google", cfg.OIDC.Provider)
	}
	if cfg.OIDC.ClientID != "google-id" {
		t.Errorf("OIDC.ClientID = %q", cfg.OIDC.ClientID)
	}
}

func TestLoadFromEnv_EmptyEnv(t *testing.T) {
	clearEnv(t)
	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv: %v", err)
	}
	if cfg.DBPath != "" || cfg.Port != "" || cfg.AllowedUserID != 0 {
		t.Errorf("expected zero-value Config; got %+v", cfg)
	}
	if cfg.OIDC.Provider != "" {
		t.Errorf("OIDC.Provider = %q want empty", cfg.OIDC.Provider)
	}
}

func TestParseOIDCScopes(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"whitespace only", "   \t\n ", nil},
		{"space separated", "openid email profile", []string{"openid", "email", "profile"}},
		{"comma separated", "openid,email,profile", []string{"openid", "email", "profile"}},
		{"mixed separators", "openid email,profile\tgroups\nphone", []string{"openid", "email", "profile", "groups", "phone"}},
		{"trims and drops empties", "  openid,, ,email  ", []string{"openid", "email"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseOIDCScopes(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseOIDCScopes(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// fakeSettingsReader is a hand-rolled SettingsReader for the Merge /
// LoadFromSettings tests. Avoiding a real *settings.Repo keeps the config
// package's tests dependency-free of SQLite migration setup.
type fakeSettingsReader struct {
	openAI    settings.IntegrationOpenAI
	food      settings.IntegrationFood
	el        settings.IntegrationElevenLabs
	openAIErr error
	foodErr   error
	elErr     error
}

func (f *fakeSettingsReader) GetIntegrationOpenAI(_ context.Context) (settings.IntegrationOpenAI, error) {
	return f.openAI, f.openAIErr
}
func (f *fakeSettingsReader) GetIntegrationFood(_ context.Context) (settings.IntegrationFood, error) {
	return f.food, f.foodErr
}
func (f *fakeSettingsReader) GetIntegrationElevenLabs(_ context.Context) (settings.IntegrationElevenLabs, error) {
	return f.el, f.elErr
}

func TestLoadFromSettings_AllFieldsPopulated(t *testing.T) {
	r := &fakeSettingsReader{
		openAI: settings.IntegrationOpenAI{
			APIKey: "sk-from-db", URL: "https://db.example/v1", Model: "db-model",
			VisionAPIKey: "sk-vision-db", VisionURL: "https://v.db/v1", VisionModel: "v-db",
		},
		food: settings.IntegrationFood{APIKey: "food-db", URL: "https://food.db/v1", Domain: "food.db"},
		el:   settings.IntegrationElevenLabs{APIKey: "el-db", AgentID: "el-agent-db"},
	}
	cfg, err := LoadFromSettings(context.Background(), r)
	if err != nil {
		t.Fatalf("LoadFromSettings: %v", err)
	}
	want := OpenAIConfig{
		APIKey: "sk-from-db", URL: "https://db.example/v1", Model: "db-model",
		VisionAPIKey: "sk-vision-db", VisionURL: "https://v.db/v1", VisionModel: "v-db",
	}
	if cfg.OpenAI != want {
		t.Errorf("OpenAI = %+v want %+v", cfg.OpenAI, want)
	}
	if cfg.Food != (FoodConfig{APIKey: "food-db", URL: "https://food.db/v1", Domain: "food.db"}) {
		t.Errorf("Food = %+v", cfg.Food)
	}
	if cfg.ElevenLabs != (ElevenLabsConfig{APIKey: "el-db", AgentID: "el-agent-db"}) {
		t.Errorf("ElevenLabs = %+v", cfg.ElevenLabs)
	}
	// Non-settings fields stay zero.
	if cfg.DBPath != "" || cfg.SessionSecret != "" || cfg.TelegramBotToken != "" {
		t.Errorf("expected non-settings fields zero; got %+v", cfg)
	}
}

func TestLoadFromSettings_PropagatesErrors(t *testing.T) {
	wantErr := errors.New("db blew up")
	r := &fakeSettingsReader{openAIErr: wantErr}
	if _, err := LoadFromSettings(context.Background(), r); !errors.Is(err, wantErr) {
		t.Errorf("expected wrapped %v, got %v", wantErr, err)
	}
	r = &fakeSettingsReader{foodErr: wantErr}
	if _, err := LoadFromSettings(context.Background(), r); !errors.Is(err, wantErr) {
		t.Errorf("expected wrapped %v, got %v", wantErr, err)
	}
	r = &fakeSettingsReader{elErr: wantErr}
	if _, err := LoadFromSettings(context.Background(), r); !errors.Is(err, wantErr) {
		t.Errorf("expected wrapped %v, got %v", wantErr, err)
	}
}

func TestMerge(t *testing.T) {
	envFull := &Config{
		DBPath:           "/env/meds.db",
		Port:             "9000",
		SessionSecret:    "env-session-secret-very-long-aaaaa",
		TelegramBotToken: "env-bot",
		OpenAI: OpenAIConfig{
			APIKey: "sk-env", URL: "https://env.example/v1", Model: "env-model",
			VisionAPIKey: "sk-vision-env", VisionURL: "https://v.env/v1", VisionModel: "v-env",
		},
		Food:       FoodConfig{APIKey: "food-env", URL: "https://food.env/v1", Domain: "food.env"},
		ElevenLabs: ElevenLabsConfig{APIKey: "el-env", AgentID: "el-env-agent"},
	}
	settingsFull := &Config{
		OpenAI: OpenAIConfig{
			APIKey: "sk-db", URL: "https://db.example/v1", Model: "db-model",
			VisionAPIKey: "sk-vision-db", VisionURL: "https://v.db/v1", VisionModel: "v-db",
		},
		Food:       FoodConfig{APIKey: "food-db", URL: "https://food.db/v1", Domain: "food.db"},
		ElevenLabs: ElevenLabsConfig{APIKey: "el-db", AgentID: "el-db-agent"},
	}

	tests := []struct {
		name        string
		env         *Config
		fromDB      *Config
		wantOpenAI  OpenAIConfig
		wantFood    FoodConfig
		wantEL      ElevenLabsConfig
		wantNilResp bool
		wantDBPath  string
	}{
		{
			name:       "env_only",
			env:        envFull,
			fromDB:     nil,
			wantOpenAI: envFull.OpenAI,
			wantFood:   envFull.Food,
			wantEL:     envFull.ElevenLabs,
			wantDBPath: "/env/meds.db",
		},
		{
			name:       "settings_only",
			env:        nil,
			fromDB:     settingsFull,
			wantOpenAI: settingsFull.OpenAI,
			wantFood:   settingsFull.Food,
			wantEL:     settingsFull.ElevenLabs,
			wantDBPath: "",
		},
		{
			name:       "env_wins_when_both_present",
			env:        envFull,
			fromDB:     settingsFull,
			wantOpenAI: envFull.OpenAI,
			wantFood:   envFull.Food,
			wantEL:     envFull.ElevenLabs,
			wantDBPath: "/env/meds.db",
		},
		{
			name: "per_field_fallback",
			env: &Config{
				DBPath: "/env/meds.db",
				OpenAI: OpenAIConfig{APIKey: "sk-env"}, // URL/Model unset in env
			},
			fromDB: &Config{
				OpenAI: OpenAIConfig{
					APIKey: "sk-db-shadowed", URL: "https://db.example/v1", Model: "db-model",
				},
				Food: FoodConfig{APIKey: "food-db"},
			},
			wantOpenAI: OpenAIConfig{
				APIKey: "sk-env",                 // env wins
				URL:    "https://db.example/v1", // settings fills gap
				Model:  "db-model",              // settings fills gap
			},
			wantFood:   FoodConfig{APIKey: "food-db"},
			wantEL:     ElevenLabsConfig{},
			wantDBPath: "/env/meds.db",
		},
		{
			name:        "both_nil",
			env:         nil,
			fromDB:      nil,
			wantNilResp: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Merge(tc.env, tc.fromDB)
			if tc.wantNilResp {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("expected non-nil")
			}
			if got.OpenAI != tc.wantOpenAI {
				t.Errorf("OpenAI = %+v\nwant %+v", got.OpenAI, tc.wantOpenAI)
			}
			if got.Food != tc.wantFood {
				t.Errorf("Food = %+v\nwant %+v", got.Food, tc.wantFood)
			}
			if got.ElevenLabs != tc.wantEL {
				t.Errorf("ElevenLabs = %+v\nwant %+v", got.ElevenLabs, tc.wantEL)
			}
			if got.DBPath != tc.wantDBPath {
				t.Errorf("DBPath = %q want %q", got.DBPath, tc.wantDBPath)
			}
		})
	}
}

func TestMerge_DoesNotMutateInputs(t *testing.T) {
	env := &Config{OpenAI: OpenAIConfig{APIKey: "sk-env"}}
	fromDB := &Config{OpenAI: OpenAIConfig{URL: "https://db/v1"}}
	_ = Merge(env, fromDB)
	if env.OpenAI.URL != "" {
		t.Errorf("Merge mutated env.OpenAI.URL: %q", env.OpenAI.URL)
	}
	if fromDB.OpenAI.APIKey != "" {
		t.Errorf("Merge mutated fromDB.OpenAI.APIKey: %q", fromDB.OpenAI.APIKey)
	}
}

// clearEnv unsets every variable LoadFromEnv reads so that one test's setup
// can't bleed into another's expectation. t.Setenv automatically restores the
// prior value at test end, which is what we want — but a value left set by
// the caller's shell would otherwise be visible to tests that intentionally
// don't set it.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"DB_PATH", "PORT", "SESSION_SECRET", "TELEGRAM_BOT_TOKEN", "ALLOWED_USER_ID",
		"OPENAI_API_KEY", "OPENAI_URL", "OPENAI_MODEL",
		"OPENAI_VISION_API_KEY", "OPENAI_VISION_URL", "OPENAI_VISION_MODEL",
		"FOOD_API_KEY", "FOOD_API_URL", "FOOD_DOMAIN",
		"ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID",
		"VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
		"ADMIN_EMAIL", "DOMAIN", "APP_DOMAIN",
		"OIDC_ISSUER_URL", "OIDC_AUTH_URL", "OIDC_TOKEN_URL", "OIDC_USERINFO_URL",
		"OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URL",
		"OIDC_ADMIN_EMAIL", "OIDC_ALLOWED_SUBJECT",
		"OIDC_BUTTON_LABEL", "OIDC_BUTTON_COLOR", "OIDC_BUTTON_TEXT_COLOR",
		"OIDC_SCOPES",
		"POCKET_ID_CLIENT_ID", "POCKET_ID_CLIENT_SECRET", "POCKET_ID_DOMAIN",
		"GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URL",
		"MCP_AUDIT_SECRET", "EXTERNAL_WORKOUT_API_KEY",
		"DEMO_MODE", "DEMO_AGENT_CALLS_PER_DAY", "DEMO_FOOD_LOGS_PER_HOUR",
		"DEMO_FOOD_PHOTOS_PER_HOUR", "DEMO_FOOD_DESCRIPTIONS_PER_HOUR",
	} {
		t.Setenv(k, "")
	}
}

func TestLoadFromEnv_DemoMode(t *testing.T) {
	defaults := DemoConfig{
		AgentCallsPerDay:        1,
		FoodLogsPerHour:         1,
		FoodPhotosPerHour:       1,
		FoodDescriptionsPerHour: 1,
	}

	tests := []struct {
		name     string
		envVars  map[string]string
		wantOn   bool
		wantDemo DemoConfig
	}{
		{
			name:     "demo_mode_unset",
			envVars:  map[string]string{},
			wantOn:   false,
			wantDemo: DemoConfig{},
		},
		{
			name:     "demo_mode_zero",
			envVars:  map[string]string{"DEMO_MODE": "0"},
			wantOn:   false,
			wantDemo: DemoConfig{},
		},
		{
			name:     "demo_mode_one_defaults",
			envVars:  map[string]string{"DEMO_MODE": "1"},
			wantOn:   true,
			wantDemo: defaults,
		},
		{
			name:     "demo_mode_true_defaults",
			envVars:  map[string]string{"DEMO_MODE": "true"},
			wantOn:   true,
			wantDemo: defaults,
		},
		{
			name: "all_overrides_set",
			envVars: map[string]string{
				"DEMO_MODE":                       "1",
				"DEMO_AGENT_CALLS_PER_DAY":        "5",
				"DEMO_FOOD_LOGS_PER_HOUR":         "10",
				"DEMO_FOOD_PHOTOS_PER_HOUR":       "3",
				"DEMO_FOOD_DESCRIPTIONS_PER_HOUR": "7",
			},
			wantOn: true,
			wantDemo: DemoConfig{
				AgentCallsPerDay:        5,
				FoodLogsPerHour:         10,
				FoodPhotosPerHour:       3,
				FoodDescriptionsPerHour: 7,
			},
		},
		{
			name: "partial_overrides_fall_back_to_defaults",
			envVars: map[string]string{
				"DEMO_MODE":                "1",
				"DEMO_AGENT_CALLS_PER_DAY": "12",
			},
			wantOn: true,
			wantDemo: DemoConfig{
				AgentCallsPerDay:        12,
				FoodLogsPerHour:         1,
				FoodPhotosPerHour:       1,
				FoodDescriptionsPerHour: 1,
			},
		},
		{
			name: "malformed_integers_fall_back_to_defaults",
			envVars: map[string]string{
				"DEMO_MODE":                       "1",
				"DEMO_AGENT_CALLS_PER_DAY":        "not-a-number",
				"DEMO_FOOD_LOGS_PER_HOUR":         "",
				"DEMO_FOOD_PHOTOS_PER_HOUR":       "0",
				"DEMO_FOOD_DESCRIPTIONS_PER_HOUR": "-5",
			},
			wantOn:   true,
			wantDemo: defaults,
		},
		{
			name: "overrides_ignored_when_demo_off",
			envVars: map[string]string{
				"DEMO_AGENT_CALLS_PER_DAY": "99",
				"DEMO_FOOD_LOGS_PER_HOUR":  "99",
			},
			wantOn:   false,
			wantDemo: DemoConfig{},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clearEnv(t)
			for k, v := range tc.envVars {
				t.Setenv(k, v)
			}
			cfg, err := LoadFromEnv()
			if err != nil {
				t.Fatalf("LoadFromEnv: %v", err)
			}
			if cfg.DemoMode != tc.wantOn {
				t.Errorf("DemoMode = %v want %v", cfg.DemoMode, tc.wantOn)
			}
			if cfg.Demo != tc.wantDemo {
				t.Errorf("Demo = %+v\nwant %+v", cfg.Demo, tc.wantDemo)
			}
		})
	}
}
