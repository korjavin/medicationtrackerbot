package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Injected at build time via -ldflags.
var (
	DefaultFoodAPIURL = ""
	DefaultFoodAPIKey = ""
)

// GenerateEnv produces the main .env file content.
func GenerateEnv(cfg *Config, secrets *Secrets, pid *PocketIDState) string {
	var b strings.Builder

	// Core settings
	writeln(&b, "# Core Configuration")
	writeln(&b, "DOMAIN=%s", cfg.Domain)
	writeln(&b, "TELEGRAM_BOT_TOKEN=%s", cfg.BotToken)
	writeln(&b, "ALLOWED_USER_ID=%s", cfg.UserID)
	writeln(&b, "TZ=%s", cfg.Timezone)
	writeln(&b, "DB_PATH=/app/data/meds.db")
	writeln(&b, "PORT=8080")
	writeln(&b, "SESSION_SECRET=%s", secrets.SessionSecret)
	writeln(&b, "AUTH_TRUST_PROXY=false")
	writeln(&b, "")

	// Food API (injected at build time)
	if DefaultFoodAPIURL != "" {
		writeln(&b, "# Food API")
		writeln(&b, "FOOD_API_URL=%s", DefaultFoodAPIURL)
		if DefaultFoodAPIKey != "" {
			writeln(&b, "FOOD_API_KEY=%s", DefaultFoodAPIKey)
		}
		writeln(&b, "")
	}

	// Traefik network
	if cfg.Features.Traefik {
		writeln(&b, "# Traefik")
		writeln(&b, "NETWORK_NAME=traefik_proxy")
		writeln(&b, "LE_EMAIL=%s", cfg.Traefik.LetsEncryptEmail)
		writeln(&b, "")
	} else if cfg.Traefik.ExternalNetwork != "" {
		writeln(&b, "# External Proxy Network")
		writeln(&b, "NETWORK_NAME=%s", cfg.Traefik.ExternalNetwork)
		writeln(&b, "")
	}

	// Pocket-ID / OIDC
	if cfg.Features.PocketID && pid != nil {
		pocketIDDomain := cfg.PocketID.Domain
		writeln(&b, "# Pocket-ID / OIDC")
		writeln(&b, "POCKET_ID_DOMAIN=%s", pocketIDDomain)
		writeln(&b, "OIDC_ISSUER_URL=https://%s", pocketIDDomain)
		writeln(&b, "OIDC_AUTH_URL=https://%s/authorize", pocketIDDomain)
		writeln(&b, "OIDC_TOKEN_URL=https://%s/api/oidc/token", pocketIDDomain)
		writeln(&b, "OIDC_USERINFO_URL=https://%s/api/oidc/userinfo", pocketIDDomain)
		writeln(&b, "OIDC_CLIENT_ID=%s", pid.WebClientID)
		writeln(&b, "OIDC_CLIENT_SECRET=%s", pid.WebClientSecret)
		writeln(&b, "OIDC_MCP_CLIENT_ID=%s", pid.MCPClientID)
		writeln(&b, "OIDC_REDIRECT_URL=https://%s/auth/oidc/callback", cfg.Domain)
		writeln(&b, "OIDC_ADMIN_EMAIL=%s", cfg.PocketID.AdminEmail)
		writeln(&b, "OIDC_ALLOWED_SUBJECT=%s", pid.AllowedSubject)
		writeln(&b, `OIDC_BUTTON_LABEL=Sign in with Pocket-ID`)
		writeln(&b, "OIDC_BUTTON_COLOR=#DAA520")
		writeln(&b, "OIDC_BUTTON_TEXT_COLOR=#FFFFFF")
		writeln(&b, "OIDC_SCOPES=openid profile email")
		writeln(&b, "")
	}

	// Web Push
	if cfg.Features.WebPush {
		writeln(&b, "# Web Push")
		writeln(&b, "VAPID_PUBLIC_KEY=%s", secrets.VAPIDPublicKey)
		writeln(&b, "VAPID_PRIVATE_KEY=%s", secrets.VAPIDPrivateKey)
		writeln(&b, "VAPID_SUBJECT=mailto:%s", cfg.WebPush.ContactEmail)
		writeln(&b, "")
	}

	// MCP
	if cfg.Features.MCP {
		writeln(&b, "# MCP Server")
		writeln(&b, "MCP_DOMAIN=%s", cfg.MCP.Domain)
		writeln(&b, "")
	}

	return b.String()
}

// GenerateMCPEnv produces the .env.mcp file content.
func GenerateMCPEnv(cfg *Config, pid *PocketIDState) string {
	if !cfg.Features.MCP {
		return ""
	}

	var b strings.Builder
	writeln(&b, "# MCP Server Configuration")
	writeln(&b, "MCP_PORT=8081")
	writeln(&b, "MCP_DATABASE_PATH=/app/data/meds.db")
	writeln(&b, "MCP_MAX_QUERY_DAYS=90")
	writeln(&b, "MCP_SERVER_URL=https://%s", cfg.MCP.Domain)
	writeln(&b, "MCP_DOMAIN=%s", cfg.MCP.Domain)

	if pid != nil && pid.MCPClientID != "" {
		writeln(&b, "MCP_ALLOWED_SUBJECT=%s", pid.AllowedSubject)
		writeln(&b, "")
		writeln(&b, "# Pocket-ID Configuration")
		writeln(&b, "POCKET_ID_URL=https://%s", cfg.PocketID.Domain)
		writeln(&b, "POCKET_ID_CLIENT_ID=%s", pid.MCPClientID)
		writeln(&b, "POCKET_ID_CLIENT_SECRET=%s", pid.MCPClientSecret)
	}
	writeln(&b, "# Set to any non-empty value to expose only mcp_help and mcp_execute,")
	writeln(&b, "# hiding legacy granular tools (fitness, cardio, etc.).")
	writeln(&b, "# NO_LEGACY_MCP=1")
	writeln(&b, "")

	return b.String()
}

// WriteEnvFile writes the .env file to the install directory.
func WriteEnvFile(installDir string, content string) error {
	path := filepath.Join(installDir, ".env")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return fmt.Errorf("write .env: %w", err)
	}
	return nil
}

// WriteMCPEnvFile writes the .env.mcp file to the install directory.
func WriteMCPEnvFile(installDir string, content string) error {
	if content == "" {
		return nil
	}
	path := filepath.Join(installDir, ".env.mcp")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return fmt.Errorf("write .env.mcp: %w", err)
	}
	return nil
}

func writeln(b *strings.Builder, format string, args ...any) {
	fmt.Fprintf(b, format+"\n", args...)
}
