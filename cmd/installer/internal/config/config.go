package config

import "time"

// Features represents optional features that can be enabled.
type Features struct {
	Traefik  bool `json:"traefik"`
	PocketID bool `json:"pocketId"`
	WebPush  bool `json:"webPush"`
	MCP      bool `json:"mcp"`
}

// TraefikConfig holds Traefik-specific settings.
type TraefikConfig struct {
	LetsEncryptEmail string `json:"letsEncryptEmail"`
	ExternalNetwork  string `json:"externalNetwork,omitempty"`
}

// PocketIDConfig holds Pocket-ID specific settings.
type PocketIDConfig struct {
	Domain     string `json:"domain"`
	AdminEmail string `json:"adminEmail"`
}

// MCPConfig holds MCP server settings.
type MCPConfig struct {
	Domain string `json:"domain"`
}

// WebPushConfig holds Web Push notification settings.
type WebPushConfig struct {
	ContactEmail string `json:"contactEmail"`
}

// Config holds all wizard answers.
type Config struct {
	InstallDir    string `json:"installDir"`
	Domain        string `json:"domain"`
	Timezone      string `json:"timezone"`
	BotToken      string `json:"botToken"`
	UserID        string `json:"userId"`
	ContainerTool string `json:"containerTool"` // "docker" or "podman"

	Features Features `json:"features"`

	Traefik  TraefikConfig  `json:"traefik,omitempty"`
	PocketID PocketIDConfig `json:"pocketId,omitempty"`
	MCP      MCPConfig      `json:"mcp,omitempty"`
	WebPush  WebPushConfig  `json:"webPush,omitempty"`
}

// Secrets holds generated cryptographic keys.
type Secrets struct {
	SessionSecret        string `json:"sessionSecret"`
	PocketIDAPIKey       string `json:"pocketIdApiKey,omitempty"`
	PocketIDEncryptKey   string `json:"pocketIdEncryptKey,omitempty"`
	VAPIDPublicKey       string `json:"vapidPublicKey,omitempty"`
	VAPIDPrivateKey      string `json:"vapidPrivateKey,omitempty"`
}

// PocketIDState holds Pocket-ID API setup results.
type PocketIDState struct {
	UserID           string `json:"userId,omitempty"`
	WebClientID      string `json:"webClientId,omitempty"`
	WebClientSecret  string `json:"webClientSecret,omitempty"`
	MCPClientID      string `json:"mcpClientId,omitempty"`
	MCPClientSecret  string `json:"mcpClientSecret,omitempty"`
	AllowedSubject   string `json:"allowedSubject,omitempty"`
}

// DeployState tracks which services have been started.
type DeployState struct {
	TraefikStarted     bool `json:"traefikStarted,omitempty"`
	PocketIDStarted    bool `json:"pocketIdStarted,omitempty"`
	PocketIDConfigured bool `json:"pocketIdConfigured,omitempty"`
	MedtrackerStarted  bool `json:"medtrackerStarted,omitempty"`
	MCPStarted         bool `json:"mcpStarted,omitempty"`
}

// InstallerState is the complete persistent state of the installer.
type InstallerState struct {
	Version   int           `json:"version"`
	LastStep  string        `json:"lastStep"`
	StartedAt time.Time    `json:"startedAt"`
	Config    Config        `json:"config"`
	Secrets   Secrets       `json:"secrets"`
	PocketID  PocketIDState `json:"pocketId"`
	Deploy    DeployState   `json:"deploy"`
}
