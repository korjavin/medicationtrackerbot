package wizard

import (
	"time"

	"github.com/charmbracelet/huh"

	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
	"github.com/korjavin/medicationtrackerbot/installer/internal/ui"
)

// buildMainDomainForm asks for the primary app domain.
func buildMainDomainForm(cfg *config.Config) *huh.Form {
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Primary domain").
				Description("The domain your MedTracker web UI will be accessible at (e.g. meds.example.com)").
				Placeholder("meds.example.com").
				Value(&cfg.Domain).
				Validate(func(s string) error { return config.ValidateDomain(s) }),
		).Title("Domain Configuration — App"),
	).WithTheme(ui.InstallerTheme())
}

// buildPocketIDDomainForm asks for the Pocket-ID auth server domain.
// Call this after buildMainDomainForm so the default can be pre-derived.
func buildPocketIDDomainForm(cfg *config.Config) *huh.Form {
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Pocket-ID domain (auth server)").
				Description("Separate subdomain for the identity server that secures AI access to your data.\nMUST differ from the primary domain (e.g. id.example.com).").
				Value(&cfg.PocketID.Domain).
				Validate(func(s string) error { return config.ValidateDomain(s) }),
		).Title("Domain Configuration — Auth"),
	).WithTheme(ui.InstallerTheme())
}

// buildTelegramForm creates the form for the Telegram bot step.
func buildTelegramForm(cfg *config.Config) *huh.Form {
	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Telegram bot token").
				Description("The token from @BotFather (e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11)").
				Placeholder("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11").
				Value(&cfg.BotToken).
				Validate(func(s string) error { return config.ValidateBotToken(s) }),

			huh.NewInput().
				Title("Your Telegram user ID").
				Description("Your numeric ID from @userinfobot — only this account can control the bot").
				Placeholder("123456789").
				Value(&cfg.UserID).
				Validate(func(s string) error { return config.ValidateUserID(s) }),
		).Title("Telegram Bot"),
	).WithTheme(ui.InstallerTheme())
}

// buildCoreForm creates the form for Step 3: core configuration.
func buildCoreForm(cfg *config.Config) *huh.Form {
	// Auto-detect timezone
	if cfg.Timezone == "" {
		cfg.Timezone = detectTimezone()
	}
	// Use default install directory without prompting
	if cfg.InstallDir == "" {
		cfg.InstallDir = "/opt/medtracker"
	}

	return huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Timezone").
				Description("Used for medication schedules and reminders (e.g. Europe/Berlin)").
				Value(&cfg.Timezone).
				Validate(func(s string) error { return config.ValidateNonEmpty(s) }),
		).Title("Core Configuration"),
	).WithTheme(ui.InstallerTheme())
}

// buildConditionalForms creates forms for Step 4 based on selected features.
func buildConditionalForms(cfg *config.Config) []*huh.Form {
	var forms []*huh.Form

	if cfg.Features.Traefik {
		forms = append(forms, buildTraefikForm(cfg))
	} else {
		forms = append(forms, buildExternalProxyForm(cfg))
	}

	if cfg.Features.MCP {
		// MCP is served under the main domain at /mcp (no separate subdomain needed).
		cfg.MCP.Domain = cfg.Domain
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

func detectTimezone() string {
	tz := time.Now().Location().String()
	if tz == "Local" {
		return "Europe/Berlin"
	}
	return tz
}
