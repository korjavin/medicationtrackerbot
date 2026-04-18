package wizard

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
	"github.com/korjavin/medicationtrackerbot/installer/internal/network"
	"github.com/korjavin/medicationtrackerbot/installer/internal/ui"
)

// dnsModel is the Bubble Tea model for the DNS verification screen.
type dnsModel struct {
	domains  []string
	resolved map[string]bool
	publicIP string
	done     bool
	skipped  bool
	err      error
}

type dnsCheckMsg struct {
	result network.DNSResult
}

type dnsAllResolvedMsg struct{}

func runDNSCheck(state *config.InstallerState) error {
	domains := []string{state.Config.Domain}
	if state.Config.Features.PocketID {
		domains = append(domains, state.Config.PocketID.Domain)
	}
	if state.Config.Features.MCP {
		domains = append(domains, state.Config.MCP.Domain)
	}

	// Detect public IP
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	publicIP, _ := network.DetectPublicIP(ctx)
	cancel()

	m := &dnsModel{
		domains:  domains,
		resolved: make(map[string]bool),
		publicIP: publicIP,
	}

	p := tea.NewProgram(m)
	finalModel, err := p.Run()
	if err != nil {
		return fmt.Errorf("DNS check TUI: %w", err)
	}

	fm := finalModel.(*dnsModel)
	if fm.err != nil {
		return fm.err
	}
	return nil
}

func (m *dnsModel) Init() tea.Cmd {
	return m.checkAll()
}

func (m *dnsModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "s", "S":
			m.skipped = true
			m.done = true
			return m, tea.Quit
		case "enter":
			if m.done {
				return m, tea.Quit
			}
		}

	case dnsCheckMsg:
		m.resolved[msg.result.Domain] = msg.result.Resolved

		allDone := true
		for _, d := range m.domains {
			if !m.resolved[d] {
				allDone = false
				break
			}
		}

		if allDone {
			m.done = true
			return m, tea.Quit
		}

		// Schedule next check in 5 seconds
		return m, tea.Tick(5*time.Second, func(_ time.Time) tea.Msg {
			return dnsAllResolvedMsg{}
		})

	case dnsAllResolvedMsg:
		return m, m.checkAll()
	}

	return m, nil
}

func (m *dnsModel) View() string {
	var b strings.Builder

	b.WriteString(ui.TitleStyle.Render("DNS Verification"))
	b.WriteString("\n\n")

	if m.publicIP != "" {
		b.WriteString(fmt.Sprintf("  Detected public IP: %s\n", ui.SuccessStyle.Render(m.publicIP)))
		b.WriteString("  Create A records pointing to this IP:\n\n")
	} else {
		b.WriteString("  Create A records pointing to your server's public IP:\n\n")
	}

	for _, d := range m.domains {
		var icon string
		if m.resolved[d] {
			icon = ui.CheckMark
		} else {
			icon = lipgloss.NewStyle().Foreground(ui.Warning).Render("⏳")
		}
		b.WriteString(fmt.Sprintf("  %s  %s\n", icon, d))
	}

	b.WriteString("\n")

	if m.done && !m.skipped {
		b.WriteString(ui.SuccessStyle.Render("  All domains resolved!"))
		b.WriteString("\n")
	} else if m.skipped {
		b.WriteString(ui.WarningStyle.Render("  DNS check skipped."))
		b.WriteString("\n")
	} else {
		b.WriteString(ui.SubtitleStyle.Render("  Checking every 5 seconds... Press 's' to skip"))
		b.WriteString("\n")
	}

	return b.String()
}

func (m *dnsModel) checkAll() tea.Cmd {
	cmds := make([]tea.Cmd, 0, len(m.domains))
	for _, d := range m.domains {
		if m.resolved[d] {
			continue
		}
		domain := d
		cmds = append(cmds, func() tea.Msg {
			result := network.CheckDNS(context.Background(), domain)
			return dnsCheckMsg{result: result}
		})
	}
	return tea.Batch(cmds...)
}
