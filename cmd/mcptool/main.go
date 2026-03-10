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

	// Initialize store (read-only access to the database)
	st, err := store.New(cfg.DatabasePath)
	if err != nil {
		slog.Error("[MCP] Failed to initialize store", "error", err)
		os.Exit(1)
	}
	defer st.Close()

	slog.Info("[MCP] Database connection established")

	// Create and start MCP server
	server, err := mcp.NewServer(cfg, st)
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
