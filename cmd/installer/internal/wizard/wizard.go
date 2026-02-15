package wizard

import (
	"context"
	"fmt"
	"os"

	"github.com/charmbracelet/huh"

	"github.com/korjavin/medicationtrackerbot/installer/internal/compose"
	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
	"github.com/korjavin/medicationtrackerbot/installer/internal/crypto"
	"github.com/korjavin/medicationtrackerbot/installer/internal/docker"
	"github.com/korjavin/medicationtrackerbot/installer/internal/ui"
)

// Wizard orchestrates the installation flow.
type Wizard struct {
	state   *config.InstallerState
	runtime *docker.Runtime
}

// Run is the main entry point for the wizard.
func Run() error {
	printWelcome()

	// Step 1: Detect prerequisites
	rt, err := docker.Detect()
	if err != nil {
		fmt.Println(ui.ErrorStyle.Render("Prerequisite check failed:"))
		fmt.Println(ui.ErrorStyle.Render(err.Error()))
		fmt.Println()

		if err := offerDockerInstall(); err != nil {
			return err
		}

		// Re-detect after install
		rt, err = docker.Detect()
		if err != nil {
			return err
		}
	}
	fmt.Printf("%s  %s %s (compose %s)\n\n",
		ui.CheckMark, rt.Command, rt.Version, rt.ComposeVersion)

	w := &Wizard{
		state:   config.NewInstallerState(),
		runtime: rt,
	}
	w.state.Config.ContainerTool = rt.Command

	// Check for existing installation
	resumeStep, err := w.checkExisting()
	if err != nil {
		return err
	}

	if resumeStep != "" {
		return w.runFrom(resumeStep)
	}

	return w.runFrom(StepCore)
}

func printWelcome() {
	title := ui.TitleStyle.Render("MedTracker Installation Wizard")
	fmt.Println(title)
	fmt.Println(ui.SubtitleStyle.Render("Self-hosted health tracking with Telegram integration"))
	fmt.Println()
}

// checkExisting looks for an existing state file and offers resume options.
func (w *Wizard) checkExisting() (Step, error) {
	// Ask for install dir first to know where to look for state
	installDir := "/opt/medtracker"

	existing, err := config.LoadState(installDir)
	if err != nil {
		return "", fmt.Errorf("load state: %w", err)
	}

	if existing == nil {
		return "", nil
	}

	w.state = existing
	fmt.Printf("%s  Found existing installation (last step: %s)\n\n",
		ui.WarningStyle.Render("!"), existing.LastStep)

	var choice string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Existing installation detected").
				Options(
					huh.NewOption("Resume from last step", "resume"),
					huh.NewOption("Reconfigure (keep secrets)", "reconfigure"),
					huh.NewOption("Fresh install (start over)", "fresh"),
				).
				Value(&choice),
		),
	).WithTheme(ui.InstallerTheme())

	if err := form.Run(); err != nil {
		return "", err
	}

	switch choice {
	case "resume":
		return Step(existing.LastStep), nil
	case "reconfigure":
		return StepCore, nil
	case "fresh":
		w.state = config.NewInstallerState()
		w.state.Config.ContainerTool = w.runtime.Command
		return "", nil
	}
	return "", nil
}

// runFrom executes the wizard starting from the given step.
func (w *Wizard) runFrom(startStep Step) error {
	steps := AllSteps()
	startIdx := StepIndex(startStep)
	if startIdx < 0 {
		startIdx = 0
	}

	for i := startIdx; i < len(steps); i++ {
		step := steps[i]
		w.state.LastStep = string(step)

		if err := w.runStep(step); err != nil {
			// Save state before exiting so we can resume
			if saveErr := config.SaveState(w.state.Config.InstallDir, w.state); saveErr != nil {
				fmt.Printf("Warning: could not save state: %v\n", saveErr)
			}
			return err
		}

		// Save progress after each step
		if w.state.Config.InstallDir != "" {
			if err := config.SaveState(w.state.Config.InstallDir, w.state); err != nil {
				fmt.Printf("Warning: could not save state: %v\n", err)
			}
		}
	}

	return nil
}

func (w *Wizard) runStep(step Step) error {
	switch step {
	case StepWelcome:
		return nil // already handled
	case StepCore:
		return w.stepCore()
	case StepFeatures:
		return w.stepFeatures()
	case StepConditional:
		return w.stepConditional()
	case StepSummary:
		return w.stepSummary()
	case StepDNS:
		return w.stepDNS()
	case StepDeploy:
		return w.stepDeploy()
	case StepPasskey:
		return w.stepPasskey()
	case StepVerify:
		return w.stepVerify()
	case StepDone:
		return nil
	default:
		return fmt.Errorf("unknown step: %s", step)
	}
}

func (w *Wizard) stepCore() error {
	form := buildCoreForm(&w.state.Config)
	return form.Run()
}

func (w *Wizard) stepFeatures() error {
	form, selected := buildFeatureForm(&w.state.Config)
	if err := form.Run(); err != nil {
		return err
	}
	applyFeatureSelection(&w.state.Config, *selected)
	return nil
}

func (w *Wizard) stepConditional() error {
	forms := buildConditionalForms(&w.state.Config)
	for _, f := range forms {
		if err := f.Run(); err != nil {
			return err
		}
	}
	return nil
}

func (w *Wizard) stepSummary() error {
	// Generate secrets if not already done
	if err := w.ensureSecrets(); err != nil {
		return fmt.Errorf("generate secrets: %w", err)
	}

	// Display summary
	printSummary(&w.state.Config, &w.state.Secrets)

	var action string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Ready to proceed?").
				Options(
					huh.NewOption("Deploy now", "deploy"),
					huh.NewOption("Save config and exit", "save"),
				).
				Value(&action),
		),
	).WithTheme(ui.InstallerTheme())

	if err := form.Run(); err != nil {
		return err
	}

	// Generate files
	if err := w.generateFiles(true); err != nil {
		return fmt.Errorf("generate files: %w", err)
	}

	fmt.Printf("\n%s  Configuration saved to %s\n", ui.CheckMark, w.state.Config.InstallDir)

	if action == "save" {
		fmt.Println("\nRun the installer again to deploy when ready.")
		os.Exit(0)
	}

	return nil
}

func (w *Wizard) stepDNS() error {
	return runDNSCheck(w.state)
}

func (w *Wizard) stepDeploy() error {
	return runDeploy(w.state, w.runtime)
}

func (w *Wizard) stepPasskey() error {
	if !w.state.Config.Features.PocketID {
		return nil
	}
	return runPasskeyEnrollment(w.state, w.runtime)
}

func (w *Wizard) stepVerify() error {
	printFinalSummary(w.state)
	return nil
}

// ensureSecrets generates any secrets that haven't been created yet.
func (w *Wizard) ensureSecrets() error {
	s := &w.state.Secrets

	if s.SessionSecret == "" {
		key, err := crypto.RandomKey(32)
		if err != nil {
			return err
		}
		s.SessionSecret = key
	}

	if w.state.Config.Features.PocketID {
		if s.PocketIDAPIKey == "" {
			key, err := crypto.RandomKey(32)
			if err != nil {
				return err
			}
			s.PocketIDAPIKey = key
		}
		if s.PocketIDEncryptKey == "" {
			key, err := crypto.RandomKey(32)
			if err != nil {
				return err
			}
			s.PocketIDEncryptKey = key
		}
	}

	if w.state.Config.Features.WebPush {
		if s.VAPIDPublicKey == "" || s.VAPIDPrivateKey == "" {
			vapid, err := crypto.GenerateVAPIDKeys()
			if err != nil {
				return err
			}
			s.VAPIDPublicKey = vapid.PublicKey
			s.VAPIDPrivateKey = vapid.PrivateKey
		}
	}

	return nil
}

// generateFiles creates .env, .env.mcp, and docker-compose.yml in the install directory.
func (w *Wizard) generateFiles(includeAPIKey bool) error {
	dir := w.state.Config.InstallDir

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create install dir: %w", err)
	}

	// .env
	envContent := config.GenerateEnv(&w.state.Config, &w.state.Secrets, &w.state.PocketID)
	if err := config.WriteEnvFile(dir, envContent); err != nil {
		return err
	}

	// .env.mcp
	if w.state.Config.Features.MCP {
		mcpContent := config.GenerateMCPEnv(&w.state.Config, &w.state.PocketID)
		if err := config.WriteMCPEnvFile(dir, mcpContent); err != nil {
			return err
		}
	}

	// docker-compose.yml
	tmplData := compose.NewTemplateData(&w.state.Config, &w.state.Secrets, includeAPIKey)
	composeContent, err := compose.Render(tmplData)
	if err != nil {
		return err
	}
	if err := compose.WriteComposeFile(dir, composeContent); err != nil {
		return err
	}

	return nil
}

// regenerateWithoutAPIKey re-generates compose file without the Pocket-ID API key.
func (w *Wizard) regenerateWithoutAPIKey() error {
	return w.generateFiles(false)
}

// printSummary displays all configuration in a readable format.
func printSummary(cfg *config.Config, secrets *config.Secrets) {
	fmt.Println()
	fmt.Println(ui.TitleStyle.Render("Configuration Summary"))
	fmt.Println()

	printKV("Install directory", cfg.InstallDir)
	printKV("Domain", cfg.Domain)
	printKV("Timezone", cfg.Timezone)
	printKV("Bot token", maskToken(cfg.BotToken))
	printKV("User ID", cfg.UserID)
	printKV("Container runtime", cfg.ContainerTool)
	fmt.Println()

	fmt.Println(ui.SubtitleStyle.Render("Features:"))
	printFeature("HTTPS (Traefik)", cfg.Features.Traefik)
	printFeature("Browser login (Pocket-ID)", cfg.Features.PocketID)
	printFeature("Web push notifications", cfg.Features.WebPush)
	printFeature("Claude MCP connector", cfg.Features.MCP)
	printFeature("Local Telegram API", cfg.Features.TelegramAPI)
	printFeature("Litestream backup", cfg.Features.Litestream)
	fmt.Println()

	if cfg.Features.Traefik {
		printKV("Let's Encrypt email", cfg.Traefik.LetsEncryptEmail)
	}
	if cfg.Features.PocketID {
		printKV("Pocket-ID domain", cfg.PocketID.Domain)
		printKV("Admin email", cfg.PocketID.AdminEmail)
	}
	if cfg.Features.MCP {
		printKV("MCP domain", cfg.MCP.Domain)
	}
}

func printKV(key, value string) {
	fmt.Printf("  %-24s %s\n", ui.SubtitleStyle.Render(key+":"), value)
}

func printFeature(name string, enabled bool) {
	if enabled {
		fmt.Printf("  %s  %s\n", ui.CheckMark, name)
	} else {
		fmt.Printf("  %s  %s\n", ui.Pending, name)
	}
}

func maskToken(token string) string {
	if len(token) <= 10 {
		return "***"
	}
	return token[:5] + "..." + token[len(token)-4:]
}

// printFinalSummary displays the final post-install information.
func printFinalSummary(state *config.InstallerState) {
	ctx := context.Background()
	_ = ctx

	fmt.Println()
	fmt.Println(ui.TitleStyle.Render("Installation Complete!"))
	fmt.Println()

	fmt.Println(ui.SubtitleStyle.Render("Access URLs:"))
	fmt.Printf("  Web app:       https://%s\n", state.Config.Domain)
	if state.Config.Features.PocketID {
		fmt.Printf("  Pocket-ID:     https://%s\n", state.Config.PocketID.Domain)
	}
	if state.Config.Features.MCP {
		fmt.Printf("  MCP server:    https://%s\n", state.Config.MCP.Domain)
	}
	fmt.Println()

	fmt.Println(ui.SubtitleStyle.Render("Management commands:"))
	fmt.Printf("  cd %s\n", state.Config.InstallDir)
	fmt.Printf("  %s logs -f medtracker\n", composeCmdStr(state.Config.ContainerTool))
	fmt.Printf("  %s restart\n", composeCmdStr(state.Config.ContainerTool))
	fmt.Printf("  %s down\n", composeCmdStr(state.Config.ContainerTool))
	fmt.Println()

	fmt.Println(ui.SubtitleStyle.Render("Next steps:"))
	fmt.Printf("  1. Set up your bot's domain in @BotFather:\n")
	fmt.Printf("     /mybots → your bot → Bot Settings → Menu Button → Set domain: %s\n", state.Config.Domain)
	fmt.Printf("  2. Send /start to your bot on Telegram\n")
	fmt.Println()
}

func composeCmdStr(tool string) string {
	if tool == "podman" {
		return "podman compose"
	}
	return "docker compose"
}

func offerDockerInstall() error {
	distro, err := docker.GetDistroInfo()
	if err != nil {
		return fmt.Errorf("could not detect OS distribution: %w", err)
	}

	_, cmd := distro.InstallCommand()

	var confirm bool
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(fmt.Sprintf("Would you like to install Docker on %s?", distro.Name)).
				Description(fmt.Sprintf("This will run: %s\n(requires sudo/root access)", cmd)).
				Value(&confirm),
		),
	).WithTheme(ui.InstallerTheme())

	if err := form.Run(); err != nil {
		return err
	}

	if !confirm {
		return fmt.Errorf("installation aborted: Docker is required")
	}

	fmt.Printf("\nInstalling Docker...\n")
	if err := docker.RunInstallCommand(cmd); err != nil {
		return fmt.Errorf("docker installation failed: %w", err)
	}

	fmt.Printf("\n%s  Docker installed successfully!\n\n", ui.CheckMark)
	return nil
}
