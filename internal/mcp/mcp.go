package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/mcp/registry"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// HealthDataReader provides read-only access to health tracking data.
type HealthDataReader interface {
	GetBloodPressureEnabled(ctx context.Context) (bool, error)
	GetWeightEnabled(ctx context.Context) (bool, error)
	GetMedicationEnabled(ctx context.Context) (bool, error)
	GetWorkoutEnabled(ctx context.Context) (bool, error)
	GetFoodIntakeEnabled(ctx context.Context) (bool, error)
	GetBloodPressureReadings(ctx context.Context, userID int64, since time.Time) ([]store.BloodPressure, error)
	GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]store.WeightLog, error)
	GetIntakesSince(since time.Time) ([]store.IntakeWithMedication, error)
	GetWorkoutHistory(userID int64, limit int) ([]store.WorkoutSession, error)
	GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error)
	GetWorkoutVariant(variantID int64) (*store.WorkoutVariant, error)
	GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error)
	GetSleepLogs(ctx context.Context, userID int64, since time.Time) ([]store.SleepLog, error)
	GetFoodLogs(ctx context.Context, userID int64, date time.Time, days int) ([]store.FoodLog, error)
	GetFoodTargets(ctx context.Context) (store.FoodTargets, error)
	GetDayStats(ctx context.Context, userID int64, since time.Time) ([]store.DayStat, error)
	GetVitalsHeart(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsHeartLog, error)
	GetVitalsSpO2(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsSpO2Log, error)
	GetVitalsStress(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsStressLog, error)
	ListMiBandWorkouts(ctx context.Context, userID int64, limit int) ([]store.MiBandWorkout, error)
	ListDiaryNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error)
	ListMedications(showArchived bool) ([]store.Medication, error)
}

// Config holds MCP server configuration
type Config struct {
	Port                 int
	DatabasePath         string
	PocketIDURL          string
	ClientID             string
	ClientSecret         string // #nosec G117 -- OAuth client secret, loaded from env var
	AllowedSubject       string
	MaxQueryDays         int
	MCPServerURL         string // The public URL of this MCP server (for OAuth audience validation)
	JWKSJSON             string // Optional fallback JWKS JSON content
	UserID               int64  // The database user ID to query data for
	AuditEndpoint        string
	AuditSecret          string
	AdminPort            int   // Port for the loopback-only admin API (0 disables it)
	MaxExecutorTimeoutMS int64 // cap for caller-provided timeout_ms; default 30000 (30s)
	MaxExecutorAPICalls  int   // cap for caller-provided max_api_calls; default 100
	NoLegacyMCP          bool  // when true, only mcp_help and mcp_execute are registered
	// Python executor wiring. The executor service hosts a loopback /call
	// listener for the runner subprocess and forwards each call to the bot's
	// HMAC-protected bridge endpoint.
	ExecutorBridgeURL     string // URL of the bot's /internal/mcp/bridge endpoint
	ExecutorProxyURL      string // Loopback URL the runner subprocess uses (e.g. http://127.0.0.1:8090/call)
	ExecutorRunnerScript  string // Absolute path to python/runner/runner.py
	ExecutorRunnerCwd     string // Working dir passed to python (typically the python/ directory)
	ExecutorMaxConcurrent int    // Max concurrent runs (default 4)
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

	adminPort := 8082 // default
	if raw := strings.TrimSpace(os.Getenv("MCP_ADMIN_PORT")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid MCP_ADMIN_PORT %q: %w", raw, err)
		}
		if v < 0 || v > 65535 {
			return nil, fmt.Errorf("MCP_ADMIN_PORT out of range (0-65535): %d", v)
		}
		adminPort = v
	}

	userID, _ := strconv.ParseInt(os.Getenv("ALLOWED_USER_ID"), 10, 64)
	if userID == 0 {
		return nil, fmt.Errorf("ALLOWED_USER_ID is required")
	}

	maxExecTimeoutMS, _ := strconv.ParseInt(os.Getenv("MCP_EXECUTOR_MAX_TIMEOUT_MS"), 10, 64)
	maxExecAPICalls, _ := strconv.Atoi(os.Getenv("MCP_EXECUTOR_MAX_API_CALLS"))
	maxExecConcurrent, _ := strconv.Atoi(os.Getenv("MCP_EXECUTOR_MAX_CONCURRENT"))
	noLegacyMCP := strings.TrimSpace(os.Getenv("NO_LEGACY_MCP")) != ""

	// MCP_EXECUTOR_BRIDGE_URL is the explicit opt-in for the in-process Python
	// executor. We deliberately do NOT derive this from MCP_AUDIT_ENDPOINT:
	// upgrading deployments that already wired audit notifications would
	// otherwise silently enable mcp_execute, which contradicts the documented
	// behavior and the MVP isolation gap warning in docs/mcp-deployment.md.
	executorBridgeURL := strings.TrimSpace(os.Getenv("MCP_EXECUTOR_BRIDGE_URL"))

	cfg := &Config{
		Port:                  port,
		DatabasePath:          os.Getenv("MCP_DATABASE_PATH"),
		PocketIDURL:           os.Getenv("POCKET_ID_URL"),
		ClientID:              os.Getenv("POCKET_ID_CLIENT_ID"),
		ClientSecret:          os.Getenv("POCKET_ID_CLIENT_SECRET"),
		AllowedSubject:        os.Getenv("MCP_ALLOWED_SUBJECT"),
		MaxQueryDays:          maxQueryDays,
		MCPServerURL:          os.Getenv("MCP_SERVER_URL"),
		JWKSJSON:              os.Getenv("POCKET_ID_JWKS_JSON"),
		UserID:                userID,
		AuditEndpoint:         os.Getenv("MCP_AUDIT_ENDPOINT"),
		AuditSecret:           os.Getenv("MCP_AUDIT_SECRET"),
		AdminPort:             adminPort,
		MaxExecutorTimeoutMS:  maxExecTimeoutMS,
		MaxExecutorAPICalls:   maxExecAPICalls,
		ExecutorBridgeURL:     executorBridgeURL,
		ExecutorProxyURL:      strings.TrimSpace(os.Getenv("MCP_EXECUTOR_PROXY_URL")),
		ExecutorRunnerScript:  strings.TrimSpace(os.Getenv("MCP_EXECUTOR_RUNNER_SCRIPT")),
		ExecutorRunnerCwd:     strings.TrimSpace(os.Getenv("MCP_EXECUTOR_RUNNER_CWD")),
		ExecutorMaxConcurrent: maxExecConcurrent,
		NoLegacyMCP:           noLegacyMCP,
	}

	if cfg.AdminPort > 0 && cfg.AdminPort == cfg.Port {
		return nil, fmt.Errorf("MCP_ADMIN_PORT (%d) must not equal MCP_PORT", cfg.AdminPort)
	}

	if cfg.DatabasePath == "" {
		return nil, fmt.Errorf("MCP_DATABASE_PATH is required")
	}
	if cfg.PocketIDURL == "" {
		return nil, fmt.Errorf("POCKET_ID_URL is required")
	}
	if cfg.MCPServerURL == "" {
		return nil, fmt.Errorf("MCP_SERVER_URL is required")
	}
	if strings.TrimSpace(cfg.AllowedSubject) == "" {
		return nil, fmt.Errorf("MCP_ALLOWED_SUBJECT is required")
	}

	return cfg, nil
}

// Server represents the MCP server
type Server struct {
	config        *Config
	data          HealthDataReader
	mcpServer     *mcp.Server
	oauth         *OAuthHandler
	audit         *AuditBuffer
	foodWriter    *FoodWriter
	workoutWriter *WorkoutWriter
	admin         AdminStore
	reg           *registry.Registry
	executor      ExecutionService
}

// AuditBuffer returns the audit buffer used by granular tools. The executor
// wiring in cmd/mcptool/main.go reads this so write runs of mcp_execute can
// fan out into the same Telegram audit notification path.
func (s *Server) AuditBuffer() *AuditBuffer { return s.audit }

// NewServer creates a new MCP server
func NewServer(cfg *Config, st *store.Store, audit *AuditBuffer) (*Server, error) {
	s := &Server{
		config: cfg,
		data:   st,
		audit:  audit,
		admin:  st,
	}

	// Create MCP server instance
	s.mcpServer = mcp.NewServer(
		&mcp.Implementation{
			Name:    "health-tracker-mcp",
			Version: "v1.0.0",
		},
		nil,
	)

	// Build the default operation registry.
	reg := registry.New()
	if err := reg.Register(registry.DefaultOperations()...); err != nil {
		return nil, fmt.Errorf("operation registry: %w", err)
	}
	s.reg = reg

	// Create OAuth handler. The store satisfies APITokenStore so long-lived
	// API tokens can be validated alongside JWTs.
	s.oauth = NewOAuthHandler(cfg, st)

	// Wire food + workout writers using the audit endpoint base URL.
	if cfg.AuditEndpoint != "" && cfg.AuditSecret != "" {
		if u, err := url.Parse(cfg.AuditEndpoint); err == nil {
			foodURL := *u
			foodURL.Path = path.Join(path.Dir(u.Path), "mcp-food-log")
			s.foodWriter = NewFoodWriter(foodURL.String(), cfg.AuditSecret)

			workoutURL := *u
			workoutURL.Path = path.Join(path.Dir(u.Path), "mcp-workout-log")
			s.workoutWriter = NewWorkoutWriter(workoutURL.String(), cfg.AuditSecret)
		}
	}

	// Register tools
	s.registerTools()

	return s, nil
}

// registerTools registers all MCP tools
func (s *Server) registerTools() {
	// mcp_help: catalog of allowed backend operations for mcp_execute scripts
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "mcp_help",
			Description: "List available backend operations for use in mcp_execute scripts. Filter by topic or look up a single operation_id. Each entry includes params, body schema, and a Python example.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"topic": {
						"type": "string",
						"description": "Domain to filter by (e.g. 'workouts', 'food', 'health'). Omit or pass 'all' for the full catalog."
					},
					"operation_id": {
						"type": "string",
						"description": "Exact operation ID for a single-entry lookup (e.g. 'workouts.groups.list'). Takes precedence over topic."
					}
				}
			}`),
		},
		s.handleMCPHelp,
	)

	// mcp_execute: run a sandboxed Python script against backend APIs
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "mcp_execute",
			Description: "Run a sandboxed Python script against backend APIs. Scripts call api.call(operation_id, params, body) and record a final result with output(value). Use mcp_help to discover available operations and their schemas before writing scripts.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"required": ["script"],
				"properties": {
					"script": {
						"type": "string",
						"description": "Python script to execute. Must call output(value) exactly once to record the result."
					},
					"mode": {
						"type": "string",
						"enum": ["read_only", "write"],
						"description": "Execution mode. Defaults to 'read_only'. Write operations require mode='write' and a non-empty intent."
					},
					"intent": {
						"type": "string",
						"description": "Human-readable description of what the script intends to change. Required when mode='write'."
					},
					"timeout_ms": {
						"type": "integer",
						"description": "Wall-clock timeout in milliseconds. Capped by server config (default 30000)."
					},
					"max_api_calls": {
						"type": "integer",
						"description": "Maximum number of API calls the script may make. Capped by server config (default 100)."
					},
					"topic_allowlist": {
						"type": "array",
						"items": {"type": "string"},
						"description": "Optional list of topics the script may access (e.g. ['workouts']). Empty means all topics allowed."
					}
				}
			}`),
		},
		s.handleMCPExecute,
	)

	if s.config.NoLegacyMCP {
		return
	}

	// Blood Pressure Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_blood_pressure",
			Description: "Retrieve blood pressure readings for a date range. Returns systolic, diastolic, pulse, and category for each reading. Includes diary notes from the same period for context. Pass exclude_notes=true to suppress. Maximum 90 days per query.",
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
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Defaults to false."
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
			Description: "Retrieve weight logs for a date range. Returns weight, trend, and body fat if available. All weights are returned in kilograms (kg) and the response field names use the _kg suffix (weight_kg, trend_kg). The user's display unit preference does not affect this tool. Includes diary notes from the same period for context. Pass exclude_notes=true to suppress. Maximum 90 days per query.",
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
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Defaults to false."
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
			Description: "Retrieve medication intake history for a date range. Returns medication names, dosages, scheduled and taken times, and status. Includes diary notes from the same period for context. Pass exclude_notes=true to suppress. Maximum 90 days per query.",
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
					},
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Defaults to false."
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
			Description: "Retrieve workout session history for a date range. Returns both manual gym workouts (with sets/reps) and outdoor Mi Band workouts (cycling, walking, etc. with distance/calories/heart rate). Includes diary notes from the same period for context. Pass exclude_notes=true to suppress. Maximum 90 days per query.",
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
						"description": "If true, include detailed exercise logs for manual gym workout sessions. Defaults to false."
					},
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Defaults to false."
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
			Description: "Retrieve sleep logs for a date range. Returns sleep phases, duration, and health metrics. Includes diary notes from the same period for context. Pass exclude_notes=true to suppress. Maximum 90 days per query.",
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
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Defaults to false."
					}
				}
			}`),
		},
		s.handleGetSleepLogs,
	)

	// Food Intake Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_food_intake",
			Description: "Retrieve food intake logs for a date range. Returns eaten time, meal type, food name, and macros (calories/carbs/protein/fat), plus optional configured daily target if set. Includes diary notes from the same period for context. Pass exclude_notes=true to suppress. Maximum MCP_MAX_QUERY_DAYS per query (default 90).",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"start_date": {
						"type": "string",
						"description": "Start date in YYYY-MM-DD format. Defaults to MCP_MAX_QUERY_DAYS before end_date (default 90) if omitted."
					},
					"end_date": {
						"type": "string",
						"description": "End date in YYYY-MM-DD format. Defaults to today if omitted."
					},
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Defaults to false."
					}
				}
			}`),
		},
		s.handleGetFoodIntake,
	)

	// Step history Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_step_history",
			Description: "Retrieve daily step counts, calories, and distance for a date range. Includes diary notes from the same period for context. Pass exclude_notes=true to suppress. Maximum 90 days per query.",
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
					"exclude_notes": {
						"type": "boolean",
						"description": "If true, omit diary notes from the response. Defaults to false."
					}
				}
			}`),
		},
		s.handleGetStepHistory,
	)

	// Log Food Intake Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "log_food_intake",
			Description: "Log a food intake entry with macros (calories, carbs, protein, fat) and the time it was eaten. Use this when you can estimate or look up nutritional info from a description or photo of a meal. You can backfill past meals by specifying eaten_at.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"required": ["name", "eaten_at", "calories", "carbs_g", "protein_g", "fat_g", "weight_g"],
				"properties": {
					"name": {
						"type": "string",
						"description": "Name or description of the food item or meal."
					},
					"eaten_at": {
						"type": "string",
						"description": "Date and time the food was eaten. Accepts 'YYYY-MM-DD HH:MM' or RFC3339. Use local time."
					},
					"calories": {
						"type": "integer",
						"description": "Total calories (kcal) for this serving."
					},
					"carbs_g": {
						"type": "integer",
						"description": "Total carbohydrates in grams for this serving."
					},
					"protein_g": {
						"type": "integer",
						"description": "Total protein in grams for this serving."
					},
					"fat_g": {
						"type": "integer",
						"description": "Total fat in grams for this serving."
					},
					"weight_g": {
						"type": "integer",
						"description": "Serving weight in grams (best estimate; use 0 if unknown)."
					}
				}
			}`),
		},
		s.handleLogFoodIntake,
	)

	// Workout Log Tool — call operation:"help" for the full protocol.
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "workout_log",
			Description: "Log, retrieve, and delete workout exercises. The 'operation' field selects one of: help (returns full protocol — call this first), log (append/upsert exercises to a session), get (recent N sessions with exercise logs), delete_exercise (remove an exercise log). Always call operation:\"help\" first to get input/response shapes, resolution rules, and idempotency semantics.",
			InputSchema: json.RawMessage(`{
				"type": "object",
				"required": ["operation"],
				"properties": {
					"operation": {
						"type": "string",
						"enum": ["help", "log", "get", "delete_exercise"],
						"description": "Selects the operation. Call \"help\" first for the full protocol document."
					},
					"session_id": {
						"type": "integer",
						"description": "Workout session ID. Optional for log; required for delete_exercise."
					},
					"session_ref": {
						"type": "string",
						"description": "Alternative to session_id: \"last\", \"today\", or YYYY-MM-DD."
					},
					"occurred_at": {
						"type": "string",
						"description": "When the workout happened. \"YYYY-MM-DD HH:MM\" or RFC3339. Defaults to now for log."
					},
					"exercises": {
						"type": "array",
						"description": "Exercises to log. See operation:\"help\" for the per-exercise shape (sets/reps/weight_kg/duration_minutes/notes/per_set, all optional except name).",
						"items": {
							"type": "object",
							"required": ["name"],
							"properties": {
								"name": {"type": "string"},
								"sets": {"type": "integer"},
								"reps": {"type": "integer"},
								"weight_kg": {"type": "number"},
								"duration_minutes": {"type": "integer"},
								"notes": {"type": "string"},
								"per_set": {
									"type": "array",
									"items": {
										"type": "object",
										"properties": {
											"reps": {"type": "integer"},
											"weight_kg": {"type": "number"}
										}
									}
								}
							}
						}
					},
					"exercise_name": {
						"type": "string",
						"description": "For delete_exercise: the resolved exercise name to remove from the session."
					},
					"limit": {
						"type": "integer",
						"description": "For get: max number of recent sessions to return (default 10, max 50)."
					}
				}
			}`),
		},
		s.handleWorkoutLog,
	)

	// Diary Notes Tool
	mcp.AddTool(s.mcpServer,
		&mcp.Tool{
			Name:        "get_diary_notes",
			Description: "Retrieve personal diary notes for a date range. Notes capture mood, feelings, and self-observations. Maximum 90 days per query.",
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
					"limit": {
						"type": "integer",
						"description": "Maximum number of notes to return. Defaults to 50."
					}
				}
			}`),
		},
		s.handleGetDiaryNotes,
	)

	// Register Vitals & Health Overview Tools
	registerVitalsTools(s.mcpServer, s)

	// Register Composite Analysis Tools
	registerCardiovascularTool(s.mcpServer, s)
	registerFitnessTool(s.mcpServer, s)
}

// parseDateRange parses and validates the date range, enforcing the max query days limit
func (s *Server) parseDateRange(startStr, endStr string) (time.Time, time.Time, string, error) {
	now := time.Now()
	var endDate, startDate time.Time
	var warningParts []string

	startStr = strings.TrimSpace(startStr)
	endStr = strings.TrimSpace(endStr)
	loc := now.Location()

	slog.Info("parseDateRange Input", "start", startStr, "end", endStr)

	// Parse end date (defaults to now)
	if endStr == "" {
		endDate = now
		warningParts = append(warningParts,
			fmt.Sprintf("end_date was omitted; defaulted to today (%s).", endDate.Format("2006-01-02")))
	} else {
		parsed, err := time.ParseInLocation("2006-01-02", endStr, loc)
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("invalid end_date %q: expected YYYY-MM-DD", endStr)
		}
		endDate = time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 23, 59, 59, 0, loc) // End of day
	}

	// Parse start date (defaults to maxQueryDays before end)
	if startStr == "" {
		startDate = endDate.AddDate(0, 0, -s.config.MaxQueryDays)
		warningParts = append(warningParts,
			fmt.Sprintf("start_date was omitted; defaulted to %d days before end_date (%s).",
				s.config.MaxQueryDays, startDate.Format("2006-01-02")))
	} else {
		parsed, err := time.ParseInLocation("2006-01-02", startStr, loc)
		if err != nil {
			return time.Time{}, time.Time{}, "", fmt.Errorf("invalid start_date %q: expected YYYY-MM-DD", startStr)
		}
		startDate = time.Date(parsed.Year(), parsed.Month(), parsed.Day(), 0, 0, 0, 0, loc)
	}

	if startDate.After(endDate) {
		return time.Time{}, time.Time{}, "", fmt.Errorf(
			"invalid date range: start_date %s is after end_date %s",
			startDate.Format("2006-01-02"),
			endDate.Format("2006-01-02"),
		)
	}

	// Enforce max query days
	requestedStart := startDate
	maxStart := endDate.AddDate(0, 0, -s.config.MaxQueryDays)
	if startDate.Before(maxStart) {
		warningParts = append(warningParts,
			fmt.Sprintf("requested range exceeded maximum of %d days; start_date was truncated from %s to %s.",
				s.config.MaxQueryDays,
				requestedStart.Format("2006-01-02"),
				maxStart.Format("2006-01-02")))
		startDate = maxStart
	}

	slog.Info("parseDateRange Output",
		"start", startDate.Format(time.RFC3339),
		"end", endDate.Format(time.RFC3339),
		"max_days", s.config.MaxQueryDays)
	return startDate, endDate, strings.Join(warningParts, " "), nil
}

func appendWarnings(parts ...string) string {
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			filtered = append(filtered, p)
		}
	}
	return strings.Join(filtered, " ")
}

// Run starts the HTTP server and blocks until shutdown
func (s *Server) Run(ctx context.Context) error {
	mux := http.NewServeMux()

	// OAuth endpoints
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.oauth.HandleProtectedResourceMetadata)

	// MCP endpoint — Streamable HTTP transport (2025-03-26 spec) at /mcp
	streamableHandler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		return s.mcpServer
	}, &mcp.StreamableHTTPOptions{
		SessionTimeout: 30 * time.Minute,
		Logger:         slog.Default(),
	})

	mcpHandler := s.oauth.Middleware(streamableHandler)

	// Limit request body size to 1MB to prevent memory exhaustion
	maxBytesMiddleware := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		mcpHandler.ServeHTTP(w, r)
	})

	mux.Handle("/mcp", maxBytesMiddleware)
	mux.Handle("/mcp/{$}", maxBytesMiddleware)

	// Legacy SSE transport (2024-11-05 spec) at /sse, for clients like
	// ElevenLabs that haven't moved to Streamable HTTP yet.
	sseHandler := mcp.NewSSEHandler(func(r *http.Request) *mcp.Server {
		return s.mcpServer
	}, nil)

	sseAuthHandler := s.oauth.Middleware(sseHandler)
	sseMaxBytes := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		sseAuthHandler.ServeHTTP(w, r)
	})

	mux.Handle("/sse", sseMaxBytes)
	mux.Handle("/sse/{$}", sseMaxBytes)

	// Health check
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("ok")); err != nil {
			slog.Error("health write", "error", err)
		}
	})

	addr := fmt.Sprintf(":%d", s.config.Port)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Optional admin API on a loopback-only listener. Bind synchronously so a
	// bind failure (e.g. EADDRINUSE) is surfaced before the main server starts,
	// rather than being silently buffered until shutdown.
	var adminServer *http.Server
	adminErrCh := make(chan error, 1)
	if s.config.AdminPort > 0 && s.admin != nil {
		adminAddr := fmt.Sprintf("127.0.0.1:%d", s.config.AdminPort)
		adminLn, err := net.Listen("tcp", adminAddr)
		if err != nil {
			return fmt.Errorf("admin listener bind failed: %w", err)
		}
		adminServer = &http.Server{
			Addr:              adminAddr,
			Handler:           NewAdminHandler(s.admin).Mux(),
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
		}
		slog.Info("[MCP/Admin] Admin API listening", "addr", adminAddr)
		go func() {
			if err := adminServer.Serve(adminLn); err != nil && err != http.ErrServerClosed {
				slog.Error("[MCP/Admin] admin server error", "error", err)
				adminErrCh <- err
				return
			}
			adminErrCh <- nil
		}()
	} else {
		adminErrCh <- nil
	}

	shutdownAdmin := func() {
		if adminServer == nil {
			return
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := adminServer.Shutdown(shutdownCtx); err != nil {
			slog.Error("[MCP/Admin] shutdown error", "error", err)
		}
	}

	// Graceful shutdown on SIGINT/SIGTERM. Bring down both servers.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		signal.Stop(sigCh)
		slog.Info("[MCP] Shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("[MCP] shutdown error", "error", err)
		}
		shutdownAdmin()
	}()

	slog.Info("[MCP] Server starting", "addr", addr)
	mainErr := server.ListenAndServe()
	signal.Stop(sigCh)
	if mainErr != http.ErrServerClosed {
		// Main server crashed before graceful shutdown — bring admin down too.
		shutdownAdmin()
		<-adminErrCh
		return mainErr
	}
	// Main shut down cleanly; ensure admin is also stopped and surface its
	// error (e.g. early bind failure) instead of silently swallowing it.
	shutdownAdmin()
	if err := <-adminErrCh; err != nil {
		return err
	}
	return nil
}
