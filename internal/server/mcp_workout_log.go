package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
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
//
// Ad-hoc session creation is deferred until at least one exercise is
// writable, so a request where every exercise is ambiguous / missing /
// invalid does not leave behind an empty session.
func (s *Server) mcpWorkoutLog(w http.ResponseWriter, r *http.Request, req *MCPWorkoutLogRequest) {
	ctx := r.Context()
	resolver := domain.NewWorkoutResolver(s.workouts)

	if len(req.Exercises) == 0 {
		http.Error(w, "exercises is required for operation \"log\"", http.StatusBadRequest)
		return
	}

	loc := s.userLocation()
	occurredAt := time.Now().In(loc)
	occurredAtSupplied := strings.TrimSpace(req.OccurredAt) != ""
	if occurredAtSupplied {
		t, err := parseOccurredAt(req.OccurredAt, loc)
		if err != nil {
			http.Error(w, fmt.Sprintf("invalid occurred_at: %v", err), http.StatusBadRequest)
			return
		}
		occurredAt = t
	}

	session, mayCreateAdHoc, err := s.lookupSessionForLog(req, occurredAt, loc)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Pre-load planned exercises for scheduled sessions so a name-matched
	// agent log can register against the schedule (exercise_id, source=schedule)
	// and satisfy CheckCompletion. Loaded lazily — ad-hoc sessions skip this.
	var plannedByName map[string]store.WorkoutExercise
	if session != nil && session.VariantID != -1 {
		plannedByName = s.loadPlannedExercisesByName(session.VariantID)
	}

	resp := MCPWorkoutLogResponse{
		OccurredAt: occurredAt.Format("2006-01-02 15:04"),
		Results:    make([]MCPWorkoutLogExerciseResult, 0, len(req.Exercises)),
	}

	var loggedCount, ambiguousCount, missingCount, errorCount int

	for _, ex := range req.Exercises {
		if hint := validateResolverInputValues(ex); hint != "" {
			resp.Results = append(resp.Results, MCPWorkoutLogExerciseResult{
				InputName: ex.Name,
				Status:    "error",
				Hint:      hint,
			})
			errorCount++
			continue
		}

		plan, err := resolver.ResolveExercise(ctx, s.allowedUserID, ex)
		if err != nil {
			slog.Error("[Server] MCP resolve exercise failed", "name", ex.Name, "error", err)
			resp.Results = append(resp.Results, MCPWorkoutLogExerciseResult{
				InputName: ex.Name,
				Status:    "error",
				Hint:      "internal resolver error",
			})
			errorCount++
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
			if session == nil {
				if !mayCreateAdHoc {
					// Should not happen: lookupSessionForLog returns nil session
					// only when ad-hoc creation is allowed. Defensive guard.
					result.Status = "error"
					result.Hint = "no session available"
					errorCount++
					resp.Results = append(resp.Results, result)
					continue
				}
				sess, err := s.workouts.CreateAdHocSession(s.allowedUserID, occurredAt, occurredAt.Format("15:04"))
				if err != nil {
					slog.Error("[Server] MCP create ad-hoc session failed", "error", err)
					result.Status = "error"
					result.Hint = "failed to create session"
					errorCount++
					resp.Results = append(resp.Results, result)
					continue
				}
				session = sess
			}

			// workout_exercise_logs has no duration column; preserve duration in
			// notes so cardio payloads (sets/reps/weight all nil, duration set)
			// don't silently drop the only data they carried.
			notes := plan.Notes
			if plan.Applied.DurationMinutes != nil {
				prefix := fmt.Sprintf("[duration: %d min]", *plan.Applied.DurationMinutes)
				if notes == "" {
					notes = prefix
				} else {
					notes = prefix + " " + notes
				}
			}

			// If the session is scheduled and the resolved name matches a planned
			// exercise, attach the schedule's exercise_id + source so a brand-new
			// log row counts toward CheckCompletion. Otherwise fall back to
			// ad-hoc (exercise_id=0, source=agent).
			exerciseID := int64(0)
			source := "agent"
			if plannedByName != nil {
				if planned, ok := plannedByName[strings.ToLower(plan.ResolvedName)]; ok {
					exerciseID = planned.ID
					source = "schedule"
				}
			}

			// Pass a zero time when the agent did not supply occurred_at so that
			// idempotent re-sends update sets/reps/weight without overwriting the
			// row's logged_at to "now". On insert, zero falls back to the column
			// default (CURRENT_TIMESTAMP).
			storeLoggedAt := time.Time{}
			if occurredAtSupplied {
				storeLoggedAt = occurredAt
			}
			id, isNew, err := s.workouts.UpsertExerciseLogByName(
				ctx,
				session.ID,
				exerciseID,
				plan.ResolvedName,
				plan.Applied.Sets,
				plan.Applied.Reps,
				plan.Applied.WeightKg,
				"completed",
				notes,
				source,
				storeLoggedAt,
			)
			if err != nil {
				slog.Error("[Server] MCP upsert exercise log failed", "session", session.ID, "name", plan.ResolvedName, "error", err)
				result.Status = "error"
				result.Hint = "failed to write log"
				errorCount++
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

	if session != nil {
		resp.SessionID = session.ID
	}

	resp.Summary = fmt.Sprintf("%d logged, %d ambiguous, %d missing_defaults, %d error",
		loggedCount, ambiguousCount, missingCount, errorCount)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("encode response", "error", err)
	}
}

// loadPlannedExercisesByName returns the variant's planned exercises keyed by
// lowercased name. Returns nil on lookup failure so callers fall back to the
// ad-hoc (exercise_id=0, source=agent) write path — completion may not update,
// but the log itself is preserved.
func (s *Server) loadPlannedExercisesByName(variantID int64) map[string]store.WorkoutExercise {
	exercises, err := s.workouts.ListExercisesByVariant(variantID)
	if err != nil {
		slog.Error("[Server] MCP list variant exercises failed", "variant", variantID, "error", err)
		return nil
	}
	if len(exercises) == 0 {
		return nil
	}
	byName := make(map[string]store.WorkoutExercise, len(exercises))
	for _, ex := range exercises {
		byName[strings.ToLower(ex.ExerciseName)] = ex
	}
	return byName
}

// validateResolverInputValues rejects payloads with negative numeric values
// before they reach the resolver. The web update path enforces non-negative
// sets/reps/weight; the MCP path must do the same so a stray "-1" doesn't
// corrupt the database. Returns a hint string when invalid, empty otherwise.
func validateResolverInputValues(ex domain.ResolverInput) string {
	if ex.Sets != nil && *ex.Sets < 0 {
		return "sets must be non-negative"
	}
	if ex.Reps != nil && *ex.Reps < 0 {
		return "reps must be non-negative"
	}
	if ex.WeightKg != nil {
		if *ex.WeightKg < 0 {
			return "weight_kg must be non-negative"
		}
		if math.IsNaN(*ex.WeightKg) || math.IsInf(*ex.WeightKg, 0) {
			return "weight_kg must be a finite number"
		}
	}
	if ex.DurationMinutes != nil && *ex.DurationMinutes < 0 {
		return "duration_minutes must be non-negative"
	}
	for i, p := range ex.PerSet {
		if p.Reps != nil && *p.Reps < 0 {
			return fmt.Sprintf("per_set[%d].reps must be non-negative", i)
		}
		if p.WeightKg != nil {
			if *p.WeightKg < 0 {
				return fmt.Sprintf("per_set[%d].weight_kg must be non-negative", i)
			}
			if math.IsNaN(*p.WeightKg) || math.IsInf(*p.WeightKg, 0) {
				return fmt.Sprintf("per_set[%d].weight_kg must be a finite number", i)
			}
		}
	}
	return ""
}

// mcpWorkoutGet handles the "get" operation: most recent N sessions with
// their exercise logs for the user.
func (s *Server) mcpWorkoutGet(w http.ResponseWriter, _ *http.Request, req *MCPWorkoutLogRequest) {
	limit := req.Limit
	if limit <= 0 || limit > 50 {
		limit = 10
	}

	sessions, err := s.workouts.ListHistory(s.allowedUserID, limit)
	if err != nil {
		slog.Error("[Server] MCP workout get history failed", "error", err)
		http.Error(w, "failed to load workout history", http.StatusInternalServerError)
		return
	}

	resp := MCPWorkoutGetResponse{Sessions: make([]MCPWorkoutGetSession, 0, len(sessions))}
	for _, sess := range sessions {
		logs, err := s.workouts.ListExerciseLogs(sess.ID)
		if err != nil {
			// Fail the whole request rather than silently omitting the session —
			// the agent's caller would see fewer sessions than expected with no
			// indication that anything went wrong.
			slog.Error("[Server] MCP workout get logs failed", "session", sess.ID, "error", err)
			http.Error(w, "failed to load session exercises", http.StatusInternalServerError)
			return
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

	sess, err := s.workouts.GetSession(req.SessionID)
	if err != nil {
		slog.Error("[Server] MCP workout delete: get session failed", "session", req.SessionID, "error", err)
		http.Error(w, "failed to load session", http.StatusInternalServerError)
		return
	}
	if sess == nil || sess.UserID != s.allowedUserID {
		http.Error(w, fmt.Sprintf("session %d not found", req.SessionID), http.StatusNotFound)
		return
	}

	logs, err := s.workouts.ListExerciseLogs(req.SessionID)
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

// lookupSessionForLog resolves the workout session to write into, in order:
//  1. explicit session_id
//  2. session_ref ("last", "today", "YYYY-MM-DD")
//  3. otherwise no session (caller creates ad-hoc lazily on first write)
//
// The returned mayCreateAdHoc flag tells the caller whether it is allowed
// to create a brand-new ad-hoc session if `session` is nil. It is true
// only when the request omitted both session_id and session_ref, or the
// agent supplied session_ref:"today" with no existing match — neither
// case is an error, but neither implies a session yet exists.
//
// occurredAt is the already-parsed reference timestamp (defaults to now);
// "today" matches sessions on its calendar date so a backfill request with
// occurred_at:"YYYY-MM-DD ..." resolves to that day's session, not today's.
// loc is the user's timezone (from settings, fallback time.Local) — date
// comparisons happen in this zone so a UTC-hosted bot still matches the
// user's calendar day.
func (s *Server) lookupSessionForLog(req *MCPWorkoutLogRequest, occurredAt time.Time, loc *time.Location) (*store.WorkoutSession, bool, error) {
	if req.SessionID > 0 {
		sess, err := s.workouts.GetSession(req.SessionID)
		if err != nil {
			return nil, false, fmt.Errorf("load session: %w", err)
		}
		if sess == nil || sess.UserID != s.allowedUserID {
			return nil, false, fmt.Errorf("session %d not found", req.SessionID)
		}
		return sess, false, nil
	}

	if ref := strings.TrimSpace(req.SessionRef); ref != "" {
		sess, err := s.lookupSessionByRef(ref, occurredAt, loc)
		if err != nil {
			return nil, false, err
		}
		if sess != nil {
			return sess, false, nil
		}
		// "today" with no existing session falls through to ad-hoc creation —
		// the agent is documented to use session_ref:"today" for the natural
		// "log today's workout" flow and shouldn't have to retry.
		if ref != "today" {
			return nil, false, fmt.Errorf("no session matches session_ref %q", ref)
		}
	}

	// Defer ad-hoc creation to the first writable plan.
	return nil, true, nil
}

// lookupSessionByRef resolves "last" / "today" / "YYYY-MM-DD" session_ref
// values. Searches up to the 30 most recent sessions, which is plenty for an
// agent that only references recent activity. refDate is the agent's
// occurred_at (or now); date comparisons format both sides in `loc` so a
// stored ScheduledDate (possibly UTC after driver round-trip) compared at the
// boundary midnight does not silently miss the matching session.
func (s *Server) lookupSessionByRef(ref string, refDate time.Time, loc *time.Location) (*store.WorkoutSession, error) {
	sessions, err := s.workouts.ListHistory(s.allowedUserID, 30)
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
		target := refDate.In(loc).Format("2006-01-02")
		for i := range sessions {
			if sessions[i].ScheduledDate.In(loc).Format("2006-01-02") == target {
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
			if sessions[i].ScheduledDate.In(loc).Format("2006-01-02") == ref {
				return &sessions[i], nil
			}
		}
		return nil, nil
	}
}

// userLocation returns the user's stored timezone (falls back to time.Local
// if unset / lookup fails). The MCP path matches the rest of the server in
// formatting "today" and parsing wall-clock occurred_at strings in the
// user's calendar — a UTC-hosted bot would otherwise misalign at midnight.
func (s *Server) userLocation() *time.Location {
	if s.timezone == nil {
		return time.Local
	}
	tz, err := s.timezone.GetCurrent()
	if err != nil || tz == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.Local
	}
	return loc
}

// parseOccurredAt accepts "YYYY-MM-DD HH:MM" (interpreted in loc) or RFC3339
// (which carries its own offset and ignores loc).
func parseOccurredAt(s string, loc *time.Location) (time.Time, error) {
	if t, err := time.ParseInLocation("2006-01-02 15:04", s, loc); err == nil {
		return t, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("expected YYYY-MM-DD HH:MM or RFC3339")
}
