package ui

import (
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

var (
	// Colors
	Primary   = lipgloss.Color("#DAA520")
	Secondary = lipgloss.Color("#7C7C7C")
	Success   = lipgloss.Color("#04B575")
	Error     = lipgloss.Color("#FF4672")
	Warning   = lipgloss.Color("#FFCC00")

	// Text styles
	TitleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(Primary).
			MarginBottom(1)

	SubtitleStyle = lipgloss.NewStyle().
			Foreground(Secondary).
			MarginBottom(1)

	SuccessStyle = lipgloss.NewStyle().
			Foreground(Success)

	ErrorStyle = lipgloss.NewStyle().
			Foreground(Error)

	WarningStyle = lipgloss.NewStyle().
			Foreground(Warning)

	// Box styles
	BoxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(Primary).
			Padding(1, 2)

	// Status indicators
	CheckMark = SuccessStyle.Render("✓")
	CrossMark = ErrorStyle.Render("✗")
	Spinner   = lipgloss.NewStyle().Foreground(Primary).Render("●")
	Pending   = lipgloss.NewStyle().Foreground(Secondary).Render("○")
)

// InstallerTheme returns a huh theme styled for the installer.
func InstallerTheme() *huh.Theme {
	t := huh.ThemeCatppuccin()
	return t
}
