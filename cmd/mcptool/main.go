package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))

	slog.Info("[MCP] Starting MCP Server for Health Tracker...")

	// Load configuration from environment
	cfg, err := mcp.LoadConfigFromEnv()
	if err != nil {
		slog.Error("[MCP] Configuration error", "error", err)
		os.Exit(1)
	}

	slog.Info("[MCP] Configuration loaded:",
		"port", cfg.Port,
		"database", cfg.DatabasePath,
		"pocketIDURL", cfg.PocketIDURL,
		"maxQueryDays", cfg.MaxQueryDays,
	)

	// Initialize store. The MCP server needs write access for goose migrations
	// on startup and for the loopback admin API that manages api_tokens.
	st, err := store.New(cfg.DatabasePath)
	if err != nil {
		slog.Error("[MCP] Failed to initialize store", "error", err)
		os.Exit(1)
	}
	defer st.Close()

	slog.Info("[MCP] Database connection established")

	// Initialize audit buffer if configured
	var auditBuffer *mcp.AuditBuffer
	if cfg.AuditEndpoint != "" && cfg.AuditSecret != "" {
		auditBuffer = mcp.NewAuditBuffer(cfg.AuditEndpoint, cfg.AuditSecret)
		auditBuffer.Start(context.Background())
		slog.Info("[MCP] Audit logging enabled", "endpoint", cfg.AuditEndpoint)
	} else if cfg.AuditEndpoint != "" && cfg.AuditSecret == "" {
		slog.Warn("[MCP] Audit logging is disabled because MCP_AUDIT_SECRET is empty")
	}

	// Create and start MCP server
	server, err := mcp.NewServer(cfg, st, auditBuffer)
	if err != nil {
		slog.Error("[MCP] Failed to create server", "error", err)
		os.Exit(1)
	}

	slog.Info("[MCP] Server initialized, starting HTTP listener...")

	if err := server.Run(context.Background()); err != nil {
		slog.Error("[MCP] Server error", "error", err)
		os.Exit(1)
	}

	slog.Info("[MCP] Server stopped")
}
