package main

import (
	"context"
	"log"
	"os"

	"github.com/korjavin/medicationtrackerbot/internal/mcp"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Println("[MCP] Starting MCP Server for Health Tracker...")

	// Load configuration from environment
	cfg, err := mcp.LoadConfigFromEnv()
	if err != nil {
		log.Fatalf("[MCP] Configuration error: %v", err)
	}

	log.Printf("[MCP] Configuration loaded:")
	log.Printf("[MCP]   Port: %d", cfg.Port)
	log.Printf("[MCP]   Database: %s", cfg.DatabasePath)
	log.Printf("[MCP]   Pocket-ID URL: %s", cfg.PocketIDURL)
	log.Printf("[MCP]   Max Query Days: %d", cfg.MaxQueryDays)

	// Initialize store (read-only access to the database)
	st, err := store.New(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("[MCP] Failed to initialize store: %v", err)
	}
	defer st.Close()

	log.Println("[MCP] Database connection established")

	// Create and start MCP server
	server, err := mcp.NewServer(cfg, st)
	if err != nil {
		log.Fatalf("[MCP] Failed to create server: %v", err)
	}

	log.Println("[MCP] Server initialized, starting HTTP listener...")

	if err := server.Run(context.Background()); err != nil {
		log.Fatalf("[MCP] Server error: %v", err)
		os.Exit(1)
	}

	log.Println("[MCP] Server stopped")
}
