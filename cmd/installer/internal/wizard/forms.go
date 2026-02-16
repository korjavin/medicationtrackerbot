package wizard

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/huh"

	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
	"github.com/korjavin/medicationtrackerbot/installer/internal/ui"
)

// buildCoreForm creates the form for Step 2: core configuration.
func buildCoreForm(cfg *config.Config) *huh.Form {
	// Auto-detect timezone
	if cfg.Timezone == "" {
		cfg.Timezone = detectTimezone()
	}
	if cfg.InstallDir == "" {
		cfg.InstallDir = "/opt/medtracker"
	}

	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Install directory").
				Description("Where to store configuration and data").
				Value(&cfg.InstallDir).
				Validate(func(s string) error { return config.ValidateInstallDir(s) }),

			huh.NewInput().
				Title("Primary domain").
				Description("The domain your MedTracker will be accessible at").
				Placeholder("meds.example.com").
				Value(&cfg.Domain).
				Validate(func(s string) error { return config.ValidateDomain(s) }),

			huh.NewInput().
				Title("Timezone").
				Description("Used for medication schedules and reminders").
				Value(&cfg.Timezone).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),

			huh.NewInput().
				Title("Telegram bot token").
				Description("Get one from @BotFather on Telegram").
				Placeholder("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11").
				Value(&cfg.BotToken).
				Validate(func(s string) error { return config.ValidateBotToken(s) }),

			huh.NewInput().
				Title("Telegram user ID").
				Description("Your numeric Telegram user ID (get from @userinfobot)").
				Placeholder("123456789").
				Value(&cfg.UserID).
				Validate(func(s string) error { return config.ValidateUserID(s) }),
		).Title("Core Configuration"),
	).WithTheme(ui.InstallerTheme())
}

// featureOption is used for tracking multi-select feature choices.
type featureOption struct {
	Key   string
	Label string
	Desc  string
}

var allFeatures = []featureOption{
	{Key: "traefik", Label: "HTTPS via Traefik + Let's Encrypt", Desc: "Automatic TLS certificates"},
	{Key: "pocketid", Label: "Browser login via Pocket-ID", Desc: "Access web UI from any browser"},
	{Key: "webpush", Label: "Web push notifications", Desc: "Browser push for medication reminders"},
	{Key: "mcp", Label: "Claude MCP connector", Desc: "AI integration for health data queries"},
	{Key: "telegramapi", Label: "Local Telegram Bot API server", Desc: "Remove 20MB file download limit"},
	{Key: "litestream", Label: "Litestream backup to S3/R2", Desc: "Continuous SQLite replication"},
}

// buildFeatureForm creates the form for Step 3: feature selection.
func buildFeatureForm(cfg *config.Config) (*huh.Form, *[]string) {
	// Build options
	options := make([]huh.Option[string], len(allFeatures))
	for i, f := range allFeatures {
		options[i] = huh.NewOption(fmt.Sprintf("%s — %s", f.Label, f.Desc), f.Key)
	}

	// Pre-select recommended features
	selected := []string{}
	if cfg.Features.Traefik {
		selected = append(selected, "traefik")
	}
	if cfg.Features.PocketID {
		selected = append(selected, "pocketid")
	}
	if cfg.Features.WebPush {
		selected = append(selected, "webpush")
	}
	if cfg.Features.MCP {
		selected = append(selected, "mcp")
	}
	if cfg.Features.TelegramAPI {
		selected = append(selected, "telegramapi")
	}
	if cfg.Features.Litestream {
		selected = append(selected, "litestream")
	}

	// Default selection for fresh installs
	if len(selected) == 0 {
		selected = []string{"traefik", "pocketid", "webpush"}
	}

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title("Optional features").
				Description("Select features to enable (space to toggle, enter to confirm)").
				Options(options...).
				Value(&selected),
		).Title("Feature Selection"),
	).WithTheme(ui.InstallerTheme())

	return form, &selected
}

// applyFeatureSelection maps selected feature keys back to the config.
func applyFeatureSelection(cfg *config.Config, selected []string) {
	set := make(map[string]bool)
	for _, s := range selected {
		set[s] = true
	}
	cfg.Features.Traefik = set["traefik"]
	cfg.Features.PocketID = set["pocketid"]
	cfg.Features.WebPush = set["webpush"]
	cfg.Features.MCP = set["mcp"]
	cfg.Features.TelegramAPI = set["telegramapi"]
	cfg.Features.Litestream = set["litestream"]
}

// buildConditionalForms creates forms for Step 4 based on selected features.
func buildConditionalForms(cfg *config.Config) []*huh.Form {
	var forms []*huh.Form

	if cfg.Features.Traefik {
		forms = append(forms, buildTraefikForm(cfg))
	} else {
		forms = append(forms, buildExternalProxyForm(cfg))
	}

	if cfg.Features.PocketID {
		forms = append(forms, buildPocketIDForm(cfg))
	}

	if cfg.Features.MCP {
		forms = append(forms, buildMCPForm(cfg))
	}

	if cfg.Features.WebPush {
		forms = append(forms, buildWebPushForm(cfg))
	}

	if cfg.Features.TelegramAPI {
		forms = append(forms, buildTelegramAPIForm(cfg))
	}

	if cfg.Features.Litestream {
		forms = append(forms, buildLitestreamForm(cfg))
	}

	return forms
}

func buildTraefikForm(cfg *config.Config) *huh.Form {
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Let's Encrypt email").
				Description("Used for TLS certificate notifications").
				Placeholder("you@example.com").
				Value(&cfg.Traefik.LetsEncryptEmail).
				Validate(func(s string) error { return config.ValidateEmail(s) }),
		).Title("Traefik / HTTPS"),
	).WithTheme(ui.InstallerTheme())
}

func buildExternalProxyForm(cfg *config.Config) *huh.Form {
	if cfg.Traefik.ExternalNetwork == "" {
		cfg.Traefik.ExternalNetwork = "traefik_proxy"
	}
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("External proxy Docker network name").
				Description("The Docker network your reverse proxy uses").
				Value(&cfg.Traefik.ExternalNetwork).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),
		).Title("External Proxy"),
	).WithTheme(ui.InstallerTheme())
}

func buildPocketIDForm(cfg *config.Config) *huh.Form {
	// Default subdomain
	if cfg.PocketID.Domain == "" && cfg.Domain != "" {
		parts := strings.SplitN(cfg.Domain, ".", 2)
		if len(parts) == 2 {
			cfg.PocketID.Domain = "id." + parts[1]
		}
	}

	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Pocket-ID domain").
				Description("Domain for the authentication service. MUST be a separate subdomain (e.g., id.example.com)").
				Value(&cfg.PocketID.Domain).
				Validate(func(s string) error { return config.ValidateDomain(s) }),

			huh.NewInput().
				Title("Admin email").
				Description("Your email for the admin account").
				Placeholder("you@example.com").
				Value(&cfg.PocketID.AdminEmail).
				Validate(func(s string) error { return config.ValidateEmail(s) }),
		).Title("Pocket-ID Authentication"),
	).WithTheme(ui.InstallerTheme())
}

func buildMCPForm(cfg *config.Config) *huh.Form {
	if cfg.MCP.Domain == "" && cfg.Domain != "" {
		cfg.MCP.Domain = cfg.Domain
	}

	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("MCP server domain").
				Description("Domain for the Claude AI integration endpoint").
				Value(&cfg.MCP.Domain).
				Validate(func(s string) error { return config.ValidateDomain(s) }),
		).Title("MCP Server"),
	).WithTheme(ui.InstallerTheme())
}

func buildWebPushForm(cfg *config.Config) *huh.Form {
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("VAPID contact email").
				Description("Required by web push spec, rarely used").
				Placeholder("you@example.com").
				Value(&cfg.WebPush.ContactEmail).
				Validate(func(s string) error { return config.ValidateEmail(s) }),
		).Title("Web Push Notifications"),
	).WithTheme(ui.InstallerTheme())
}

func buildTelegramAPIForm(cfg *config.Config) *huh.Form {
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Telegram API ID").
				Description("From https://my.telegram.org/apps").
				Value(&cfg.TelegramAPI.APIID).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),

			huh.NewInput().
				Title("Telegram API Hash").
				Description("From https://my.telegram.org/apps").
				Value(&cfg.TelegramAPI.APIHash).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),
		).Title("Local Telegram Bot API"),
	).WithTheme(ui.InstallerTheme())
}

func buildLitestreamForm(cfg *config.Config) *huh.Form {
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("S3/R2 Access Key ID").
				Value(&cfg.Litestream.AccessKeyID).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),

			huh.NewInput().
				Title("S3/R2 Secret Access Key").
				EchoMode(huh.EchoModePassword).
				Value(&cfg.Litestream.SecretAccessKey).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),

			huh.NewInput().
				Title("S3/R2 Endpoint").
				Description("e.g., https://<account-id>.r2.cloudflarestorage.com").
				Value(&cfg.Litestream.Endpoint).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),

			huh.NewInput().
				Title("Bucket name").
				Value(&cfg.Litestream.Bucket).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),
		).Title("Litestream Backup"),
	).WithTheme(ui.InstallerTheme())
}

func detectTimezone() string {
	tz := time.Now().Location().String()
	if tz == "Local" {
		return "Europe/Berlin"
	}
	return tz
}
