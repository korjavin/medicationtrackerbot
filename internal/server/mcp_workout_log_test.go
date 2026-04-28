package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func floatPtr(v float64) *float64 { return &v }

func createMCPWorkoutLogTestServer(t *testing.T, secret string) (*Server, *store.Store) {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create test store: %v", err)
	}
	srv := New(db, "test-token", "test-session-secret", 123456, OIDCConfig{}, "test-bot", "")
	srv.mcpAuditSecret = secret
	return srv, db
}

// signMCPWorkoutBody re-uses the same HMAC pattern as signBody (which lives in
// mcp_food_log_test.go) — duplicated here would be redundant, so we just call
// the shared helper that is in the same _test package.

func postMCPWorkoutLog(t *testing.T, srv *Server, secret string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/mcp-workout-log", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("X-Signature", signBody(body, secret))
	}
	w := httptest.NewRecorder()
	srv.handleMCPWorkoutLog(w, req)
	return w
}

func TestMCPWorkoutLog_HMACFailure(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	body, _ := json.Marshal(MCPWorkoutLogRequest{Operation: "log"})
	req := httptest.NewRequest(http.MethodPost, "/api/mcp-workout-log", bytes.NewReader(body))
	req.Header.Set("X-Signature", "deadbeef")
	w := httptest.NewRecorder()
	srv.handleMCPWorkoutLog(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestMCPWorkoutLog_MissingSignature(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	body, _ := json.Marshal(MCPWorkoutLogRequest{Operation: "log"})
	req := httptest.NewRequest(http.MethodPost, "/api/mcp-workout-log", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.handleMCPWorkoutLog(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestMCPWorkoutLog_NotConfigured(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "")
	defer db.Close()

	body, _ := json.Marshal(MCPWorkoutLogRequest{Operation: "log"})
	req := httptest.NewRequest(http.MethodPost, "/api/mcp-workout-log", bytes.NewReader(body))
	req.Header.Set("X-Signature", signBody(body, ""))
	w := httptest.NewRecorder()
	srv.handleMCPWorkoutLog(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
}

func TestMCPWorkoutLog_UnknownOperation(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{Operation: "noop"})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestMCPWorkoutLog_LogAdHocCreatesSession(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	payload := MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{Name: "Biceps Curls", Sets: intPtr(3), Reps: intPtr(10), WeightKg: floatPtr(12.5)},
		},
	}
	w := postMCPWorkoutLog(t, srv, "test-secret", payload)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionID == 0 {
		t.Errorf("expected ad-hoc session created, got SessionID=0")
	}
	if len(resp.Results) != 1 || resp.Results[0].Status != "logged" {
		t.Fatalf("expected 1 logged result, got %+v", resp.Results)
	}
	if resp.Results[0].Applied.Sets == nil || *resp.Results[0].Applied.Sets != 3 {
		t.Errorf("applied sets = %+v, want 3", resp.Results[0].Applied.Sets)
	}
	if !resp.Results[0].IsNew {
		t.Errorf("expected is_new=true on first insert")
	}

	// Verify the row exists in the DB.
	logs, err := db.GetExerciseLogs(resp.SessionID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log in DB, got %d", len(logs))
	}
}

func TestMCPWorkoutLog_LogIdempotent(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	// Pre-create a session so we have a stable session_id between two calls.
	day := time.Now()
	sess, err := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	payload := MCPWorkoutLogRequest{
		Operation: "log",
		SessionID: sess.ID,
		Exercises: []domain.ResolverInput{
			{Name: "Biceps Curls", Sets: intPtr(3), Reps: intPtr(10), WeightKg: floatPtr(12.5)},
		},
	}
	w := postMCPWorkoutLog(t, srv, "test-secret", payload)
	if w.Code != http.StatusOK {
		t.Fatalf("first call: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Re-send: should update, not duplicate.
	payload.Exercises[0].Sets = intPtr(4)
	payload.Exercises[0].WeightKg = floatPtr(15.0)
	w2 := postMCPWorkoutLog(t, srv, "test-secret", payload)
	if w2.Code != http.StatusOK {
		t.Fatalf("second call: expected 200, got %d: %s", w2.Code, w2.Body.String())
	}

	var resp2 MCPWorkoutLogResponse
	if err := json.NewDecoder(w2.Body).Decode(&resp2); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp2.Results[0].IsNew {
		t.Errorf("expected is_new=false on idempotent re-send")
	}

	logs, err := db.GetExerciseLogs(sess.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log after idempotent re-send, got %d", len(logs))
	}
	if logs[0].SetsCompleted == nil || *logs[0].SetsCompleted != 4 {
		t.Errorf("sets not updated, got %+v", logs[0].SetsCompleted)
	}
	if logs[0].WeightKg == nil || *logs[0].WeightKg != 15.0 {
		t.Errorf("weight not updated, got %+v", logs[0].WeightKg)
	}
	if logs[0].Source != "agent" {
		t.Errorf("source = %q, want %q", logs[0].Source, "agent")
	}
}

func TestMCPWorkoutLog_LogRequiresExercises(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{Operation: "log"})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty exercises, got %d: %s", w.Code, w.Body.String())
	}
}

func TestMCPWorkoutLog_SessionRefTodayAutoCreates(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	// No session exists yet; session_ref:"today" should fall through to ad-hoc.
	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation:  "log",
		SessionRef: "today",
		Exercises: []domain.ResolverInput{
			{Name: "Squat", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(80)},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 with auto-created session, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionID == 0 {
		t.Errorf("expected ad-hoc session created on session_ref:\"today\" with no match")
	}
	if len(resp.Results) != 1 || resp.Results[0].Status != "logged" {
		t.Fatalf("expected 1 logged result, got %+v", resp.Results)
	}
}

func TestMCPWorkoutLog_SessionRefDateNotFoundErrors(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	// Explicit historical date with no match still errors (only "today" auto-creates).
	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation:  "log",
		SessionRef: "2020-01-01",
		Exercises: []domain.ResolverInput{
			{Name: "Squat", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(80)},
		},
	})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing historical session, got %d: %s", w.Code, w.Body.String())
	}
}

func TestMCPWorkoutLog_PerSetBodyweightLogs(t *testing.T) {
	// Bodyweight exercises must log successfully even when per_set weight is 0.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{
				Name: "Pull Up",
				PerSet: []domain.PerSetEntry{
					{Reps: 10, WeightKg: 0},
					{Reps: 8, WeightKg: 0},
				},
			},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Results) != 1 || resp.Results[0].Status != "logged" {
		t.Fatalf("expected 1 logged result, got %+v", resp.Results)
	}
	if resp.Results[0].Applied.WeightKg == nil || *resp.Results[0].Applied.WeightKg != 0 {
		t.Errorf("expected applied weight 0 (bodyweight), got %+v", resp.Results[0].Applied.WeightKg)
	}
}

func TestMCPWorkoutLog_PartialSuccess(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	// Seed two exercises that both contain "press" so a "press" lookup is
	// ambiguous. Also seed one exercise we can match exactly.
	day := time.Now()
	sess, _ := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))
	if _, err := db.LogExerciseWithSource(sess.ID, 0, "Bench Press", intPtr(3), intPtr(8), floatPtr(80), "completed", "", "library"); err != nil {
		t.Fatalf("seed bench press: %v", err)
	}
	if _, err := db.LogExerciseWithSource(sess.ID, 0, "Inclined Press", intPtr(3), intPtr(8), floatPtr(60), "completed", "", "library"); err != nil {
		t.Fatalf("seed inclined press: %v", err)
	}
	if _, err := db.LogExerciseWithSource(sess.ID, 0, "Biceps Curls", intPtr(3), intPtr(10), floatPtr(12.5), "completed", "", "library"); err != nil {
		t.Fatalf("seed biceps: %v", err)
	}

	// New session for the actual log call so we don't collide with the seed
	// rows on idempotency.
	target, _ := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))

	payload := MCPWorkoutLogRequest{
		Operation: "log",
		SessionID: target.ID,
		Exercises: []domain.ResolverInput{
			{Name: "biceps curls"},         // resolves via history (inferred defaults)
			{Name: "press"},                // ambiguous (Bench Press, Inclined Press)
			{Name: "totally new exercise"}, // missing_defaults: no history, no values
		},
	}
	w := postMCPWorkoutLog(t, srv, "test-secret", payload)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(resp.Results))
	}

	statuses := map[string]string{}
	for _, r := range resp.Results {
		statuses[r.InputName] = r.Status
	}
	if statuses["biceps curls"] != "logged" {
		t.Errorf("biceps curls: expected logged, got %q", statuses["biceps curls"])
	}
	if statuses["press"] != "ambiguous" {
		t.Errorf("press: expected ambiguous, got %q", statuses["press"])
	}
	if statuses["totally new exercise"] != "missing_defaults" {
		t.Errorf("new exercise: expected missing_defaults, got %q", statuses["totally new exercise"])
	}
}

func TestMCPWorkoutLog_PerSetAggregation(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	payload := MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{
				Name: "Biceps Curls",
				PerSet: []domain.PerSetEntry{
					{Reps: 10, WeightKg: 10},
					{Reps: 8, WeightKg: 12.5},
					{Reps: 6, WeightKg: 15},
				},
			},
		},
	}
	w := postMCPWorkoutLog(t, srv, "test-secret", payload)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	r := resp.Results[0]
	if r.Status != "logged" {
		t.Fatalf("expected logged, got %q", r.Status)
	}
	if r.Applied.Sets == nil || *r.Applied.Sets != 3 {
		t.Errorf("expected sets=3 from per_set length, got %+v", r.Applied.Sets)
	}
	if r.Applied.Reps == nil || *r.Applied.Reps != 10 {
		t.Errorf("expected reps=10 (max), got %+v", r.Applied.Reps)
	}
	if r.Applied.WeightKg == nil || *r.Applied.WeightKg != 15 {
		t.Errorf("expected weight=15 (max), got %+v", r.Applied.WeightKg)
	}
}

func TestMCPWorkoutLog_Get(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	day := time.Now()
	sess, _ := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))
	if _, err := db.LogExerciseWithSource(sess.ID, 0, "Squat", intPtr(3), intPtr(8), floatPtr(80), "completed", "", "library"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{Operation: "get", Limit: 5})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutGetResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Sessions) == 0 {
		t.Fatalf("expected at least one session")
	}
	found := false
	for _, ws := range resp.Sessions {
		if ws.Session.ID == sess.ID {
			if len(ws.Exercises) != 1 {
				t.Errorf("session %d: expected 1 exercise, got %d", sess.ID, len(ws.Exercises))
			} else if ws.Exercises[0].ExerciseName != "Squat" {
				t.Errorf("expected Squat, got %q", ws.Exercises[0].ExerciseName)
			}
			found = true
		}
	}
	if !found {
		t.Errorf("seeded session %d not in response", sess.ID)
	}
}

func TestMCPWorkoutLog_DeleteExercise(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	day := time.Now()
	sess, _ := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))
	if _, err := db.LogExerciseWithSource(sess.ID, 0, "Squat", intPtr(3), intPtr(8), floatPtr(80), "completed", "", "library"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := db.LogExerciseWithSource(sess.ID, 0, "Biceps Curls", intPtr(3), intPtr(10), floatPtr(12.5), "completed", "", "library"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation:    "delete_exercise",
		SessionID:    sess.ID,
		ExerciseName: "biceps curls", // case-insensitive
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutDeleteResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Deleted != 1 {
		t.Errorf("expected deleted=1, got %d", resp.Deleted)
	}

	logs, err := db.GetExerciseLogs(sess.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 || logs[0].ExerciseName != "Squat" {
		t.Errorf("expected only Squat to remain, got %+v", logs)
	}
}

func TestMCPWorkoutLog_DeleteRequiresSessionAndName(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{Operation: "delete_exercise"})
	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 missing session, got %d", w.Code)
	}

	w2 := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{Operation: "delete_exercise", SessionID: 99})
	if w2.Code != http.StatusBadRequest {
		t.Errorf("expected 400 missing exercise_name, got %d", w2.Code)
	}
}

func TestMCPWorkoutLog_LogSessionRefLast(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	day := time.Now()
	sess, _ := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation:  "log",
		SessionRef: "last",
		Exercises: []domain.ResolverInput{
			{Name: "Squat", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(80)},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionID != sess.ID {
		t.Errorf("expected session_ref=last to resolve to %d, got %d", sess.ID, resp.SessionID)
	}
}
