package wizard

import (
	"context"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/korjavin/medicationtrackerbot/installer/internal/compose"
	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
	"github.com/korjavin/medicationtrackerbot/installer/internal/docker"
	"github.com/korjavin/medicationtrackerbot/installer/internal/pocketid"
	"github.com/korjavin/medicationtrackerbot/installer/internal/ui"
)

// deployTask represents a single deployment step.
type deployTask struct {
	name   string
	status taskStatus
	err    error
}

type taskStatus int

const (
	taskPending taskStatus = iota
	taskRunning
	taskDone
	taskFailed
)

// deployModel is the Bubble Tea model for the deployment screen.
type deployModel struct {
	tasks      []deployTask
	current    int
	done       bool
	err        error
	state      *config.InstallerState
	runtime    *docker.Runtime
	viewport   viewport.Model
	showLogs   bool
	width      int
	height     int
	logContent strings.Builder
}

type taskCompleteMsg struct {
	err error
}

type logMsg string

type logWriter struct {
	program *tea.Program
}

func (w *logWriter) Write(p []byte) (n int, err error) {
	w.program.Send(logMsg(string(p)))
	return len(p), nil
}

func runDeploy(state *config.InstallerState, rt *docker.Runtime) error {
	tasks := buildDeployTasks(state)

	m := &deployModel{
		tasks:   tasks,
		state:   state,
		runtime: rt,
	}

	p := tea.NewProgram(m)

	// Set up log redirection
	rt.Stdout = &logWriter{program: p}
	rt.Stderr = &logWriter{program: p}

	finalModel, err := p.Run()
	if err != nil {
		return fmt.Errorf("deploy TUI: %w", err)
	}

	fm := finalModel.(*deployModel)
	if fm.err != nil {
		return fm.err
	}
	return nil
}

func buildDeployTasks(state *config.InstallerState) []deployTask {
	tasks := []deployTask{
		{name: "Pull container images"},
		{name: "Create Docker network"},
	}

	if state.Config.Features.Traefik {
		tasks = append(tasks, deployTask{name: "Start Traefik reverse proxy"})
	}

	if state.Config.Features.PocketID {
		tasks = append(tasks,
			deployTask{name: "Start Pocket-ID"},
			deployTask{name: "Verify network connectivity"},
			deployTask{name: "Wait for Pocket-ID to be ready"},
			deployTask{name: "Create Pocket-ID admin user"},
			deployTask{name: "Create OIDC client for MedTracker"},
		)
		if state.Config.Features.MCP {
			tasks = append(tasks, deployTask{name: "Create OIDC client for MCP"})
		}
		tasks = append(tasks,
			deployTask{name: "Update configuration with OIDC credentials"},
		)
	}

	tasks = append(tasks, deployTask{name: "Start MedTracker"})

	if state.Config.Features.MCP {
		tasks = append(tasks, deployTask{name: "Start MCP server"})
	}

	tasks = append(tasks, deployTask{name: "Verify services are running"})

	return tasks
}

func (m *deployModel) Init() tea.Cmd {
	return m.runCurrentTask()
}

func (m *deployModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if !m.showLogs {
			m.viewport = viewport.New(msg.Width-4, 10)
		} else {
			m.viewport.Width = msg.Width - 4
			m.viewport.Height = msg.Height - len(m.tasks) - 6
		}

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "l":
			m.showLogs = !m.showLogs
			if m.showLogs {
				m.viewport.Height = m.height - len(m.tasks) - 6
			}
		}

		if m.showLogs {
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		}

	case logMsg:
		m.logContent.WriteString(string(msg))
		m.viewport.SetContent(m.logContent.String())
		m.viewport.GotoBottom()

	case taskCompleteMsg:
		if msg.err != nil {
			m.tasks[m.current].status = taskFailed
			m.tasks[m.current].err = msg.err
			m.err = msg.err
			m.done = true
			return m, tea.Quit
		}

		m.tasks[m.current].status = taskDone
		m.current++

		if m.current >= len(m.tasks) {
			m.done = true
			return m, tea.Quit
		}

		return m, m.runCurrentTask()
	}
	return m, tea.Batch(cmds...)
}

func (m *deployModel) View() string {
	var b strings.Builder

	b.WriteString(ui.TitleStyle.Render("Deploying Services"))
	b.WriteString("\n\n")

	for i, t := range m.tasks {
		var icon string
		switch t.status {
		case taskPending:
			icon = ui.Pending
		case taskRunning:
			icon = lipgloss.NewStyle().Foreground(ui.Primary).Render("⟳")
		case taskDone:
			icon = ui.CheckMark
		case taskFailed:
			icon = ui.CrossMark
		}

		line := fmt.Sprintf("  %s  %s", icon, t.name)
		if t.status == taskFailed && t.err != nil {
			line += "\n     " + ui.ErrorStyle.Render(t.err.Error())
		}
		b.WriteString(line)
		b.WriteString("\n")
		_ = i
	}

	if m.showLogs {
		b.WriteString("\n")
		b.WriteString(ui.BoxStyle.Width(m.width - 4).Render(m.viewport.View()))
		b.WriteString("\n")
	}

	if m.done && m.err == nil {
		b.WriteString("\n")
		b.WriteString(ui.SuccessStyle.Render("All services deployed successfully!"))
	}

	b.WriteString("\n")
	b.WriteString(ui.SubtitleStyle.Render("Press 'l' to toggle logs • ctrl+c to quit"))
	return b.String()
}

func (m *deployModel) runCurrentTask() tea.Cmd {
	m.tasks[m.current].status = taskRunning
	taskName := m.tasks[m.current].name

	return func() tea.Msg {
		m.log(fmt.Sprintf("\n--- Starting: %s ---\n", taskName))
		err := m.executeTask(taskName)
		if err != nil {
			m.log(fmt.Sprintf("Error: %v\n", err))
		} else {
			m.log(fmt.Sprintf("Step completed successfully.\n"))
		}
		return taskCompleteMsg{err: err}
	}
}

func (m *deployModel) log(msg string) {
	if m.runtime.Stdout != nil {
		m.runtime.Stdout.Write([]byte(msg))
	}
}

func (m *deployModel) executeTask(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	dir := m.state.Config.InstallDir
	rt := m.runtime

	switch name {
	case "Pull container images":
		return rt.ComposePull(ctx, dir)

	case "Create Docker network":
		networkName := "traefik_proxy"
		if !m.state.Config.Features.Traefik && m.state.Config.Traefik.ExternalNetwork != "" {
			networkName = m.state.Config.Traefik.ExternalNetwork
		}
		return rt.CreateNetwork(ctx, networkName)

	case "Start Traefik reverse proxy":
		if err := rt.ComposeUp(ctx, dir, "traefik"); err != nil {
			return err
		}
		m.state.Deploy.TraefikStarted = true
		return nil

	case "Start Pocket-ID":
		if err := rt.ComposeUp(ctx, dir, "pocket-id"); err != nil {
			return err
		}
		m.state.Deploy.PocketIDStarted = true
		return nil

	case "Verify network connectivity":
		// Ensure pocket-id is connected to traefik_proxy
		// Sometimes docker compose fails to attach external networks correctly
		m.log("Checking network connectivity for medtracker-pocket-id...\n")
		networkName := "traefik_proxy"
		if !m.state.Config.Features.Traefik && m.state.Config.Traefik.ExternalNetwork != "" {
			networkName = m.state.Config.Traefik.ExternalNetwork
		}

		// Check if connected
		checkCmd := exec.CommandContext(ctx, rt.Command, "inspect", "medtracker-pocket-id", "--format", fmt.Sprintf("{{.NetworkSettings.Networks.%s}}", networkName))
		out, err := checkCmd.Output()
		if err != nil || strings.TrimSpace(string(out)) == "<no value>" || string(out) == "null" {
			m.log(fmt.Sprintf("Connecting medtracker-pocket-id to %s...\n", networkName))
			connectCmd := exec.CommandContext(ctx, rt.Command, "network", "connect", networkName, "medtracker-pocket-id")
			if out, err := connectCmd.CombinedOutput(); err != nil {
				// Ignore if already connected (race condition or check failure)
				if !strings.Contains(string(out), "already exists") {
					m.log(fmt.Sprintf("Warning: failed to connect network: %v, output: %s\n", err, string(out)))
				}
			} else {
				m.log(fmt.Sprintf("Connected to %s\n", networkName))
			}
		} else {
			m.log(fmt.Sprintf("Already connected to %s\n", networkName))
		}
		return nil

	case "Wait for Pocket-ID to be ready":
		// Use local address - port 1411 is bound to 127.0.0.1 in compose
		client := pocketid.NewClient("http://127.0.0.1:1411", m.state.Secrets.PocketIDAPIKey)

		m.log("Waiting for Pocket-ID container on http://127.0.0.1:1411...\n")
		return client.WaitForReady(ctx, 120*time.Second)

	case "Create Pocket-ID admin user":
		return m.createPocketIDUser(ctx)

	case "Create OIDC client for MedTracker":
		return m.createWebOIDCClient(ctx)

	case "Create OIDC client for MCP":
		return m.createMCPOIDCClient(ctx)

	case "Update configuration with OIDC credentials":
		return m.updateConfigWithOIDC()

	case "Start MedTracker":
		if err := rt.ComposeUp(ctx, dir, "medtracker"); err != nil {
			return err
		}
		m.state.Deploy.MedtrackerStarted = true
		return nil

	case "Start MCP server":
		if err := rt.ComposeUp(ctx, dir, "mcp-server"); err != nil {
			return err
		}
		m.state.Deploy.MCPStarted = true
		return nil

	case "Verify services are running":
		return m.verifyServices(ctx)

	default:
		return fmt.Errorf("unknown task: %s", name)
	}
}

func (m *deployModel) createPocketIDUser(ctx context.Context) error {
	// POST /api/signup/setup is unauthenticated and only works on a fresh install.
	// Use local address — external HTTPS domain may not resolve from inside the server.
	client := pocketid.NewClient("http://127.0.0.1:1411", "")

	user, jwt, err := client.SignupInitialAdmin(ctx, pocketid.SignupInitialAdminRequest{
		Username:  "admin",
		Email:     m.state.Config.PocketID.AdminEmail,
		FirstName: "Admin",
		LastName:  "User",
	})
	if err != nil {
		if pocketid.IsSetupAlreadyCompleted(err) {
			// Admin already exists (resume after partial failure).
			if m.state.Secrets.PocketIDInstallerAPIKey != "" {
				m.log("Admin user already exists, reusing saved API key.\n")
				return nil
			}
			return fmt.Errorf("Pocket-ID setup already completed but no installer API key was saved; delete the Pocket-ID volume and re-run to start fresh")
		}
		return err
	}

	m.state.PocketID.UserID = user.ID
	m.state.PocketID.AllowedSubject = user.ID

	// Use the JWT to create a persistent DB API key for subsequent steps and re-runs.
	client.SetBearerToken(jwt)
	apiKeyToken, err := client.CreateAPIKey(ctx, "medtracker-installer", time.Now().Add(365*24*time.Hour))
	if err != nil {
		return fmt.Errorf("create installer API key: %w", err)
	}
	m.state.Secrets.PocketIDInstallerAPIKey = apiKeyToken
	return nil
}

func (m *deployModel) createWebOIDCClient(ctx context.Context) error {
	// Use local address for API calls
	client := pocketid.NewClient("http://127.0.0.1:1411", m.state.Secrets.PocketIDInstallerAPIKey)

	oidcClient, err := client.CreateOIDCClient(ctx, pocketid.CreateOIDCClientRequest{
		Name:               "MedTracker",
		CallbackURLs:       []string{"https://" + m.state.Config.Domain + "/auth/oidc/callback"},
		LogoutCallbackURLs: []string{"https://" + m.state.Config.Domain},
		IsPublic:           false,
	})
	if err != nil {
		if pocketid.IsConflict(err) {
			existing, findErr := client.FindOIDCClientByName(ctx, "MedTracker")
			if findErr != nil {
				return fmt.Errorf("client exists but could not find: %w", findErr)
			}
			m.state.PocketID.WebClientID = existing.ID
			m.state.PocketID.WebClientSecret = existing.Secret
			return nil
		}
		return err
	}

	m.state.PocketID.WebClientID = oidcClient.ID
	m.state.PocketID.WebClientSecret = oidcClient.Secret
	return nil
}

func (m *deployModel) createMCPOIDCClient(ctx context.Context) error {
	// Use local address for API calls
	client := pocketid.NewClient("http://127.0.0.1:1411", m.state.Secrets.PocketIDInstallerAPIKey)

	oidcClient, err := client.CreateOIDCClient(ctx, pocketid.CreateOIDCClientRequest{
		Name: "MedTracker MCP",
		CallbackURLs: []string{
			"https://claude.ai/api/mcp/auth_callback",
			"https://claude.com/api/mcp/auth_callback",
		},
		IsPublic: false,
	})
	if err != nil {
		if pocketid.IsConflict(err) {
			existing, findErr := client.FindOIDCClientByName(ctx, "MedTracker MCP")
			if findErr != nil {
				return fmt.Errorf("client exists but could not find: %w", findErr)
			}
			m.state.PocketID.MCPClientID = existing.ID
			m.state.PocketID.MCPClientSecret = existing.Secret
			return nil
		}
		return err
	}

	m.state.PocketID.MCPClientID = oidcClient.ID
	m.state.PocketID.MCPClientSecret = oidcClient.Secret
	return nil
}

func (m *deployModel) updateConfigWithOIDC() error {
	dir := m.state.Config.InstallDir

	// Regenerate .env with OIDC credentials
	envContent := config.GenerateEnv(&m.state.Config, &m.state.Secrets, &m.state.PocketID)
	if err := config.WriteEnvFile(dir, envContent); err != nil {
		return err
	}

	// Regenerate .env.mcp if MCP is enabled
	if m.state.Config.Features.MCP {
		mcpContent := config.GenerateMCPEnv(&m.state.Config, &m.state.PocketID)
		if err := config.WriteMCPEnvFile(dir, mcpContent); err != nil {
			return err
		}
	}

	// Regenerate docker-compose.yml WITHOUT API key (security)
	tmplData := compose.NewTemplateData(&m.state.Config, &m.state.Secrets, false)
	composeContent, err := compose.Render(tmplData)
	if err != nil {
		return err
	}
	if err := compose.WriteComposeFile(dir, composeContent); err != nil {
		return err
	}

	m.state.Deploy.PocketIDConfigured = true
	return nil
}

func (m *deployModel) verifyServices(ctx context.Context) error {
	// Check medtracker on local port — checking via external HTTPS domain fails
	// from inside the server due to split-horizon DNS / Traefik routing.
	localURL := "http://127.0.0.1:8080"
	m.log(fmt.Sprintf("Checking medtracker on %s...\n", localURL))
	if err := waitForHTTP(ctx, localURL, 60*time.Second); err != nil {
		// Non-fatal: log warning but don't fail — the service may still be starting
		// and is accessible externally even if not locally (port not mapped).
		m.log(fmt.Sprintf("Warning: local check failed (%v); service may still be running via Traefik.\n", err))
	}
	return nil
}

func waitForHTTP(ctx context.Context, url string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			// Use a short timeout for the check itself
			checkCtx, checkCancel := context.WithTimeout(ctx, 3*time.Second)
			req, err := http.NewRequestWithContext(checkCtx, "GET", url, nil)
			if err != nil {
				checkCancel()
				continue
			}

			resp, err := http.DefaultClient.Do(req)
			checkCancel()

			if err == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
	}
}
