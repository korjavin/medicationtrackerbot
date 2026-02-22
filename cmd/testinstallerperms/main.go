package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/korjavin/medicationtrackerbot/installer/internal/compose"
	"github.com/korjavin/medicationtrackerbot/installer/internal/config"
)

func main() {
	outputDir := flag.String("output", "", "Output directory for test files")
	flag.Parse()

	if *outputDir == "" {
		fmt.Fprintf(os.Stderr, "Usage: testinstallerperms -output /path/to/output\n")
		os.Exit(1)
	}

	if err := os.MkdirAll(*outputDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create output directory: %v\n", err)
		os.Exit(1)
	}

	// Create sample config
	cfg := &config.Config{
		Domain:        "example.com",
		Timezone:      "UTC",
		BotToken:      "sample-bot-token-for-testing",
		UserID:        "123456789",
		ContainerTool: "docker",
		Features: config.Features{
			Traefik:  true,
			PocketID: true,
			WebPush:  true,
			MCP:      true,
		},
		Traefik: config.TraefikConfig{
			LetsEncryptEmail: "admin@example.com",
		},
		PocketID: config.PocketIDConfig{
			Domain:     "pocket-id.example.com",
			AdminEmail: "admin@example.com",
		},
		MCP: config.MCPConfig{
			Domain: "mcp.example.com",
		},
		WebPush: config.WebPushConfig{
			ContactEmail: "notifications@example.com",
		},
	}

	// Create sample secrets
	secrets := &config.Secrets{
		SessionSecret:      "sample-session-secret-long-enough",
		VAPIDPublicKey:     "sample-vapid-public-key",
		VAPIDPrivateKey:    "sample-vapid-private-key",
		PocketIDEncryptKey: "sample-pocket-id-encrypt-key",
	}

	// Create sample Pocket-ID state
	pid := &config.PocketIDState{
		WebClientID:     "sample-web-client-id",
		WebClientSecret: "sample-web-client-secret",
		MCPClientID:     "sample-mcp-client-id",
		MCPClientSecret: "sample-mcp-client-secret",
		AllowedSubject:  "user@example.com",
	}

	// Generate and write .env file
	envContent := config.GenerateEnv(cfg, secrets, pid)
	if err := config.WriteEnvFile(*outputDir, envContent); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write .env file: %v\n", err)
		os.Exit(1)
	}

	// Generate and write .env.mcp file
	mcpEnvContent := config.GenerateMCPEnv(cfg, pid)
	if err := config.WriteMCPEnvFile(*outputDir, mcpEnvContent); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write .env.mcp file: %v\n", err)
		os.Exit(1)
	}

	// Generate and write docker-compose.yml
	tmplData := compose.NewTemplateData(cfg, secrets, true)
	composeContent, err := compose.Render(tmplData)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to render docker-compose.yml: %v\n", err)
		os.Exit(1)
	}
	if err := compose.WriteComposeFile(*outputDir, composeContent); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write docker-compose.yml: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Generated test files in %s\n", *outputDir)
	fmt.Printf("  - .env\n")
	fmt.Printf("  - .env.mcp\n")
	fmt.Printf("  - docker-compose.yml\n")
}
