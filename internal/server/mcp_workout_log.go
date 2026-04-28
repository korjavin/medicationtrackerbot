package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// MCPWorkoutLogRequest is the JSON envelope received from the MCP container.
// Operation selects between help / get / log / delete_exercise. Other fields
// are populated based on the operation; callers should consult the help-doc
// (returned via the `workout_log` tool's "help" operation) for the protocol.
type MCPWorkoutLogRequest struct {
	Operation string `json:"operation"`

	SessionID    int64                  `json:"session_id,omitempty"`
	SessionRef   string                 `json:"session_ref,omitempty"`
	OccurredAt   string                 `json:"occurred_at,omitempty"`
	Exercises    []domain.ResolverInput `json:"exercises,omitempty"`
	ExerciseName string                 `json:"exercise_name,omitempty"`
	Limit        int                    `json:"limit,omitempty"`
}

// MCPWorkoutLogExerciseResult is the per-exercise outcome of a "log" call.
type MCPWorkoutLogExerciseResult struct {
	InputName    string               `json:"input_name"`
	ResolvedName string               `json:"resolved_name,omitempty"`
	Status       string               `json:"status"`
	LogID        int64                `json:"log_id,omitempty"`
	Applied      domain.AppliedValues `json:"applied,omitempty"`
	Sources      domain.FieldSources  `json:"sources,omitempty"`
	Candidates   []string             `json:"candidates,omitempty"`
	Missing      []string             `json:"missing,omitempty"`
	Hint         string               `json:"hint,omitempty"`
	IsNew        bool                 `json:"is_new,omitempty"`
}

// MCPWorkoutLogResponse is returned for the "log" operation.
type MCPWorkoutLogResponse struct {
	SessionID  int64                         `json:"session_id"`
	OccurredAt string                        `json:"occurred_at,omitempty"`
	Results    []MCPWorkoutLogExerciseResult `json:"results"`
	Summary    string                        `json:"summary"`
}

// MCPWorkoutGetSession is the shape returned for "get".
type MCPWorkoutGetSession struct {
	Session   store.WorkoutSession       `json:"session"`
	Exercises []store.WorkoutExerciseLog `json:"exercises"`
}

// MCPWorkoutGetResponse is the response for "get".
type MCPWorkoutGetResponse struct {
	Sessions []MCPWorkoutGetSession `json:"sessions"`
}

// MCPWorkoutDeleteResponse is the response for "delete_exercise".
type MCPWorkoutDeleteResponse struct {
	Deleted int `json:"deleted"`
}

// handleMCPWorkoutLog is the HMAC-protected entry point for the MCP
// `workout_log` tool. Authentication errors return non-2xx; once
// authenticated, application-level errors (ambiguous exercise, missing
// defaults, etc.) are surfaced inside the JSON response so the agent can
// self-correct in a single round trip.
func (s *Server) handleMCPWorkoutLog(w http.ResponseWriter, r *http.Request) {
	if s.mcpAuditSecret == "" {
		http.Error(w, "MCP workout log endpoint not configured", http.StatusServiceUnavailable)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	signature := r.Header.Get("X-Signature")
	if signature == "" {
		http.Error(w, "Missing X-Signature header", http.StatusUnauthorized)
		return
	}

	mac := hmac.New(sha256.New, []byte(s.mcpAuditSecret))
	mac.Write(body)
	expectedSignatureBytes := mac.Sum(nil)

	signatureBytes, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(signatureBytes, expectedSignatureBytes) {
		slog.Warn("[Server] Invalid MCP workout log signature")
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	var req MCPWorkoutLogRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	switch req.Operation {
	case "log":
		s.mcpWorkoutLog(w, r, &req)
	case "get":
		s.mcpWorkoutGet(w, r, &req)
	case "delete_exercise":
		s.mcpWorkoutDelete(w, r, &req)
	case "":
		http.Error(w, "operation is required (help|get|log|delete_exercise)", http.StatusBadRequest)
	default:
		http.Error(w, fmt.Sprintf("unknown operation %q", req.Operation), http.StatusBadRequest)
	}
}

// mcpWorkoutLog handles the "log" operation: resolve each exercise, infer
// missing defaults, then upsert per (session_id, exercise_name).
func (s *Server) mcpWorkoutLog(w http.ResponseWriter, r *http.Request, req *MCPWorkoutLogRequest) {
	ctx := r.Context()
	resolver := domain.NewWorkoutResolver(s.workouts)

	session, occurredAt, err := s.resolveOrCreateSession(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if len(req.Exercises) == 0 {
		http.Error(w, "exercises is required for operation \"log\"", http.StatusBadRequest)
		return
	}

	resp := MCPWorkoutLogResponse{
		SessionID:  session.ID,
		OccurredAt: occurredAt.Format("2006-01-02 15:04"),
		Results:    make([]MCPWorkoutLogExerciseResult, 0, len(req.Exercises)),
	}

	var loggedCount, ambiguousCount, missingCount int

	for _, ex := range req.Exercises {
		plan, err := resolver.ResolveExercise(ctx, s.allowedUserID, ex)
		if err != nil {
			slog.Error("[Server] MCP resolve exercise failed", "name", ex.Name, "error", err)
			resp.Results = append(resp.Results, MCPWorkoutLogExerciseResult{
				InputName: ex.Name,
				Status:    "error",
				Hint:      "internal resolver error",
			})
			continue
		}

		result := MCPWorkoutLogExerciseResult{
			InputName:    plan.InputName,
			ResolvedName: plan.ResolvedName,
			Candidates:   plan.Candidates,
			Missing:      plan.Missing,
			Hint:         plan.Hint,
			Applied:      plan.Applied,
			Sources:      plan.Sources,
		}

		switch plan.Status {
		case domain.StatusResolved, domain.StatusCreateNew:
			id, isNew, err := s.workouts.UpsertExerciseLogByName(
				ctx,
				session.ID,
				plan.ResolvedName,
				plan.Applied.Sets,
				plan.Applied.Reps,
				plan.Applied.WeightKg,
				"completed",
				plan.Notes,
				"agent",
			)
			if err != nil {
				slog.Error("[Server] MCP upsert exercise log failed", "session", session.ID, "name", plan.ResolvedName, "error", err)
				result.Status = "error"
				result.Hint = "failed to write log"
			} else {
				result.Status = "logged"
				result.LogID = id
				result.IsNew = isNew
				loggedCount++
			}
		case domain.StatusAmbiguous:
			result.Status = "ambiguous"
			ambiguousCount++
		case domain.StatusMissingDefaults:
			result.Status = "missing_defaults"
			missingCount++
		default:
			result.Status = string(plan.Status)
		}

		resp.Results = append(resp.Results, result)
	}

	resp.Summary = fmt.Sprintf("%d logged, %d ambiguous, %d missing_defaults",
		loggedCount, ambiguousCount, missingCount)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// mcpWorkoutGet handles the "get" operation: most recent N sessions with
// their exercise logs for the user.
func (s *Server) mcpWorkoutGet(w http.ResponseWriter, _ *http.Request, req *MCPWorkoutLogRequest) {
	limit := req.Limit
	if limit <= 0 || limit > 50 {
		limit = 10
	}

	sessions, err := s.workouts.GetWorkoutHistory(s.allowedUserID, limit)
	if err != nil {
		slog.Error("[Server] MCP workout get history failed", "error", err)
		http.Error(w, "failed to load workout history", http.StatusInternalServerError)
		return
	}

	resp := MCPWorkoutGetResponse{Sessions: make([]MCPWorkoutGetSession, 0, len(sessions))}
	for _, sess := range sessions {
		logs, err := s.workouts.GetExerciseLogs(sess.ID)
		if err != nil {
			slog.Error("[Server] MCP workout get logs failed", "session", sess.ID, "error", err)
			continue
		}
		resp.Sessions = append(resp.Sessions, MCPWorkoutGetSession{
			Session:   sess,
			Exercises: logs,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// mcpWorkoutDelete handles the "delete_exercise" operation.
func (s *Server) mcpWorkoutDelete(w http.ResponseWriter, r *http.Request, req *MCPWorkoutLogRequest) {
	if req.SessionID == 0 {
		http.Error(w, "session_id is required for operation \"delete_exercise\"", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(req.ExerciseName)
	if name == "" {
		http.Error(w, "exercise_name is required for operation \"delete_exercise\"", http.StatusBadRequest)
		return
	}

	logs, err := s.workouts.GetExerciseLogs(req.SessionID)
	if err != nil {
		slog.Error("[Server] MCP workout delete: get logs failed", "session", req.SessionID, "error", err)
		http.Error(w, "failed to load session logs", http.StatusInternalServerError)
		return
	}

	deleted := 0
	for _, lg := range logs {
		if strings.EqualFold(lg.ExerciseName, name) {
			if err := s.workouts.DeleteExerciseLog(lg.ID); err != nil {
				slog.Error("[Server] MCP workout delete log failed", "id", lg.ID, "error", err)
				continue
			}
			deleted++
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(MCPWorkoutDeleteResponse{Deleted: deleted}); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// resolveOrCreateSession picks the workout session to write into, in order:
//  1. explicit session_id
//  2. session_ref ("last", "today", "YYYY-MM-DD")
//  3. otherwise create a new ad-hoc session
//
// The returned occurredAt is parsed from req.OccurredAt when present, falling
// back to time.Now().
func (s *Server) resolveOrCreateSession(req *MCPWorkoutLogRequest) (*store.WorkoutSession, time.Time, error) {
	occurredAt := time.Now()
	if strings.TrimSpace(req.OccurredAt) != "" {
		t, err := parseOccurredAt(req.OccurredAt)
		if err != nil {
			return nil, time.Time{}, fmt.Errorf("invalid occurred_at: %w", err)
		}
		occurredAt = t
	}

	if req.SessionID > 0 {
		sess, err := s.workouts.GetWorkoutSession(req.SessionID)
		if err != nil {
			return nil, time.Time{}, fmt.Errorf("load session: %w", err)
		}
		if sess == nil {
			return nil, time.Time{}, fmt.Errorf("session %d not found", req.SessionID)
		}
		return sess, occurredAt, nil
	}

	if ref := strings.TrimSpace(req.SessionRef); ref != "" {
		sess, err := s.lookupSessionByRef(ref)
		if err != nil {
			return nil, time.Time{}, err
		}
		if sess != nil {
			return sess, occurredAt, nil
		}
		return nil, time.Time{}, fmt.Errorf("no session matches session_ref %q", ref)
	}

	// Default: create ad-hoc session at occurredAt.
	sess, err := s.workouts.CreateAdHocWorkoutSession(s.allowedUserID, occurredAt, occurredAt.Format("15:04"))
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("create ad-hoc session: %w", err)
	}
	return sess, occurredAt, nil
}

// lookupSessionByRef resolves "last" / "today" / "YYYY-MM-DD" session_ref
// values. Searches up to the 30 most recent sessions, which is plenty for an
// agent that only references recent activity.
func (s *Server) lookupSessionByRef(ref string) (*store.WorkoutSession, error) {
	sessions, err := s.workouts.GetWorkoutHistory(s.allowedUserID, 30)
	if err != nil {
		return nil, fmt.Errorf("load history: %w", err)
	}
	if len(sessions) == 0 {
		return nil, nil
	}

	switch ref {
	case "last":
		sess := sessions[0]
		return &sess, nil
	case "today":
		today := time.Now().Format("2006-01-02")
		for i := range sessions {
			if sessions[i].ScheduledDate.Format("2006-01-02") == today {
				return &sessions[i], nil
			}
		}
		return nil, nil
	default:
		// Treat as YYYY-MM-DD.
		if _, err := time.Parse("2006-01-02", ref); err != nil {
			return nil, fmt.Errorf("session_ref must be \"last\", \"today\", or YYYY-MM-DD")
		}
		for i := range sessions {
			if sessions[i].ScheduledDate.Format("2006-01-02") == ref {
				return &sessions[i], nil
			}
		}
		return nil, nil
	}
}

// parseOccurredAt accepts "YYYY-MM-DD HH:MM" or RFC3339.
func parseOccurredAt(s string) (time.Time, error) {
	if t, err := time.ParseInLocation("2006-01-02 15:04", s, time.Local); err == nil {
		return t, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("expected YYYY-MM-DD HH:MM or RFC3339")
}
