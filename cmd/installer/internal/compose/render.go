package compose

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"text/template"

	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
)

// TemplateData holds the data passed to the docker-compose template.
type TemplateData struct {
	Traefik            bool
	PocketID           bool
	MCP                bool
	TelegramAPI        bool
	Litestream         bool
	NetworkName        string
	SocketPath         string
	PocketIDAPIKey     string
	PocketIDEncryptKey string
	Config             config.Config
}

// NewTemplateData creates template data from a config and secrets.
func NewTemplateData(cfg *config.Config, secrets *config.Secrets, includeAPIKey bool) TemplateData {
	networkName := "traefik_proxy"
	if !cfg.Features.Traefik && cfg.Traefik.ExternalNetwork != "" {
		networkName = cfg.Traefik.ExternalNetwork
	}

	socketPath := "/var/run/docker.sock"
	if cfg.ContainerTool == "podman" {
		socketPath = "/run/podman/podman.sock"
	}

	data := TemplateData{
		Traefik:            cfg.Features.Traefik,
		PocketID:           cfg.Features.PocketID,
		MCP:                cfg.Features.MCP,
		TelegramAPI:        cfg.Features.TelegramAPI,
		Litestream:         cfg.Features.Litestream,
		NetworkName:        networkName,
		SocketPath:         socketPath,
		PocketIDEncryptKey: secrets.PocketIDEncryptKey,
		Config:             *cfg,
	}

	if includeAPIKey && secrets.PocketIDAPIKey != "" {
		data.PocketIDAPIKey = secrets.PocketIDAPIKey
	}

	return data
}

// Render executes the docker-compose template with the given data.
func Render(data TemplateData) (string, error) {
	tmplContent, err := templateFS.ReadFile(templateName)
	if err != nil {
		return "", fmt.Errorf("read embedded template: %w", err)
	}

	tmpl, err := template.New(templateName).Parse(string(tmplContent))
	if err != nil {
		return "", fmt.Errorf("parse template: %w", err)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute template: %w", err)
	}

	return buf.String(), nil
}

// WriteComposeFile writes the rendered docker-compose.yml to the install directory.
func WriteComposeFile(installDir string, content string) error {
	path := filepath.Join(installDir, "docker-compose.yml")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write docker-compose.yml: %w", err)
	}
	return nil
}
