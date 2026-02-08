package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Config holds MCP server configuration
type Config struct {
	Port           int
	DatabasePath   string
	PocketIDURL    string
	ClientID       string
	ClientSecret   string
	AllowedSubject string
	MaxQueryDays   int
	MCPServerURL   string // The public URL of this MCP server (for OAuth audience validation)
	JWKSJSON       string // Optional fallback JWKS JSON content
	UserID         int64  // The database user ID to query data for
}

// LoadConfigFromEnv loads configuration from environment variables
func LoadConfigFromEnv() (*Config, error) {
	port, _ := strconv.Atoi(os.Getenv("MCP_PORT"))
	if port == 0 {
		port = 8081 // default
	}

	maxQueryDays, _ := strconv.Atoi(os.Getenv("MCP_MAX_QUERY_DAYS"))
	if maxQueryDays == 0 {
		maxQueryDays = 90 // default 3 months
	}

	userID, _ := strconv.ParseInt(os.Getenv("ALLOWED_USER_ID"), 10, 64)
	if userID == 0 {
		return nil, fmt.Errorf("ALLOWED_USER_ID is required")
	}

	cfg := &Config{
		Port:           port,
		DatabasePath:   os.Getenv("MCP_DATABASE_PATH"),
		PocketIDURL:    os.Getenv("POCKET_ID_URL"),
		ClientID:       os.Getenv("POCKET_ID_CLIENT_ID"),
		ClientSecret:   os.Getenv("POCKET_ID_CLIENT_SECRET"),
		AllowedSubject: os.Getenv("MCP_ALLOWED_SUBJECT"),
		MaxQueryDays:   maxQueryDays,
		MCPServerURL:   os.Getenv("MCP_SERVER_URL"),
		JWKSJSON:       os.Getenv("POCKET_ID_JWKS_JSON"),
		UserID:         userID,
	}

	if cfg.DatabasePath == "" {
		return nil, fmt.Errorf("MCP_DATABASE_PATH is required")
	}
	if cfg.PocketIDURL == "" {
		return nil, fmt.Errorf("POCKET_ID_URL is required")
	}
	// AllowedSubject is optional if you want to allow any subject (though not recommended for production)
	// if cfg.AllowedSubject == "" {
	// 	return nil, fmt.Errorf("MCP_ALLOWED_SUBJECT is required")
	// }
	if cfg.MCPServerURL == "" {
		return nil, fmt.Errorf("MCP_SERVER_URL is required")
	}

	return cfg, nil
}

// Server represents the MCP server
type Server struct {
	config    *Config
	store     *store.Store
	mcpServer *mcp.Server
	oauth     *OAuthHandler
}

// NewServer creates a new MCP server
func NewServer(cfg *Config, st *store.Store) (*Server, error) {
	s := &Server{
		config: cfg,
		store:  st,
	}

	// Create MCP server instance
	s.mcpServer = mcp.NewServer(
		&mcp.Implementation{
			Name:    "health-tracker-mcp",
			Version: "v1.0.0",
		},
		nil,
	)

	// Create OAuth handler
	s.oauth = NewOAuthHandler(cfg)

	// Register tools
	s.registerTools()

	return s, nil
}

// registerTools registers all MCP tools
func (s *Server) registerTools() {
	// Blood Pressure Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_blood_pressure",
			Description: "Retrieve blood pressure readings for a date range. Returns systolic, diastolic, pulse, and category for each reading. Maximum 90 days per query.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to 90 days before end_date if omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					}
				}
			}`),
		},
		s.handleGetBloodPressure,
	)

	// Weight Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_weight",
			Description: "Retrieve weight logs for a date range. Returns weight, trend, and body fat if available. Maximum 90 days per query.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to 90 days before end_date if omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					}
				}
			}`),
		},
		s.handleGetWeight,
	)

	// Medication Intake Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_medication_intake",
			Description: "Retrieve medication intake history for a date range. Returns medication names, dosages, scheduled and taken times, and status. Maximum 90 days per query.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to 90 days before end_date if omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					},
					"medication_name": {
						"type": "string",
						"description": "Optional filter by medication name (case-insensitive partial match)."
					}
				}
			}`),
		},
		s.handleGetMedicationIntake,
	)

	// Workout History Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_workout_history",
			Description: "Retrieve workout session history for a date range. Returns workout groups, variants, completion status, and optionally exercise details with sets/reps/weight. Maximum 90 days per query.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to 90 days before end_date if omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					},
					"include_exercises": {
						"type": "boolean",
						"description": "If true, include detailed exercise logs for each workout session. Defaults to false."
					}
				}
			}`),
		},
		s.handleGetWorkoutHistory,
	)

	// Sleep Logs Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_sleep_logs",
			Description: "Retrieve sleep logs for a date range. Returns sleep phases, duration, and health metrics. Maximum 90 days per query.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to 90 days before end_date if omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					}
				}
			}`),
		},
		s.handleGetSleepLogs,
	)
}

// parseDateRange parses and validates the date range, enforcing the max query days limit
func (s *Server) parseDateRange(startStr, endStr string) (time.Time, time.Time, string, error) {
	now := time.Now()
	var endDate, startDate time.Time
	var warning string

	log.Printf("[MCP] parseDateRange Input: start=%q, end=%q", startStr, endStr)

	// Parse end date (defaults to now)
	if endStr == "" {
		endDate = now
	} else {
		parsed, err := time.Parse("2006-01-02", endStr)
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("invalid end_date format, expected YYYY-MM-DD: %w", err)
		}
		endDate = parsed.Add(23*time.Hour + 59*time.Minute + 59*time.Second) // End of day
	}

	// Parse start date (defaults to maxQueryDays before end)
	if startStr == "" {
		startDate = endDate.AddDate(0, 0, -s.config.MaxQueryDays)
	} else {
		parsed, err := time.Parse("2006-01-02", startStr)
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("invalid start_date format, expected YYYY-MM-DD: %w", err)
		}
		startDate = parsed
	}

	// Enforce max query days
	maxStart := endDate.AddDate(0, 0, -s.config.MaxQueryDays)
	if startDate.Before(maxStart) {
		warning = fmt.Sprintf("Query range exceeded maximum of %d days. Truncated to start from %s.",
			s.config.MaxQueryDays, maxStart.Format("2006-01-02"))
		startDate = maxStart
	}

	log.Printf("[MCP] parseDateRange Output: start=%s, end=%s", startDate, endDate)
	return startDate, endDate, warning, nil
}

// Run starts the HTTP server and blocks until shutdown
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()

	// OAuth endpoints
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.oauth.HandleProtectedResourceMetadata)

	// MCP endpoint (with OAuth middleware)
	// Use SDK's SSEHandler to handle both SSE (GET) and Messages (POST)
	sseHandler := mcp.NewSSEHandler(func(r *http.Request) *mcp.Server {
		return s.mcpServer
	}, nil)

	mcpHandler := s.oauth.Middleware(sseHandler)
	mux.Handle("/mcp", mcpHandler)

	// Health check
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	addr := fmt.Sprintf(":%d", s.config.Port)
	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("[MCP] Shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()

	log.Printf("[MCP] Server starting on %s", addr)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		return err
	}
	return nil
}
