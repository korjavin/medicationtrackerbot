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

// TestMCPWorkoutLog_LogIdempotent_PreservesLoggedAt asserts that re-sending
// without occurred_at does not move the row's logged_at to "now". The agent's
// idempotent-update flow promises to refine sets/reps/weight, not the
// timestamp.
func TestMCPWorkoutLog_LogIdempotent_PreservesLoggedAt(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	day := time.Now()
	sess, err := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	payload := MCPWorkoutLogRequest{
		Operation: "log",
		SessionID: sess.ID,
		Exercises: []domain.ResolverInput{
			{Name: "Squat", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(80)},
		},
	}
	if w := postMCPWorkoutLog(t, srv, "test-secret", payload); w.Code != http.StatusOK {
		t.Fatalf("first call: got %d: %s", w.Code, w.Body.String())
	}

	logsBefore, err := db.GetExerciseLogs(sess.ID)
	if err != nil || len(logsBefore) != 1 {
		t.Fatalf("seed read: err=%v len=%d", err, len(logsBefore))
	}
	original := logsBefore[0].LoggedAt

	// Sleep so a buggy implementation that overwrites logged_at with time.Now()
	// produces a measurable diff.
	time.Sleep(1100 * time.Millisecond)

	payload.Exercises[0].WeightKg = floatPtr(85)
	if w := postMCPWorkoutLog(t, srv, "test-secret", payload); w.Code != http.StatusOK {
		t.Fatalf("second call: got %d: %s", w.Code, w.Body.String())
	}

	logsAfter, err := db.GetExerciseLogs(sess.ID)
	if err != nil || len(logsAfter) != 1 {
		t.Fatalf("post-update read: err=%v len=%d", err, len(logsAfter))
	}
	if !logsAfter[0].LoggedAt.Equal(original) {
		t.Errorf("logged_at moved on idempotent re-send: before=%s after=%s",
			original.Format(time.RFC3339Nano), logsAfter[0].LoggedAt.Format(time.RFC3339Nano))
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
					{Reps: intPtr(10), WeightKg: floatPtr(0)},
					{Reps: intPtr(8), WeightKg: floatPtr(0)},
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
					{Reps: intPtr(10), WeightKg: floatPtr(10)},
					{Reps: intPtr(8), WeightKg: floatPtr(12.5)},
					{Reps: intPtr(6), WeightKg: floatPtr(15)},
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

func TestMCPWorkoutLog_DurationPersistedToNotes(t *testing.T) {
	// Cardio-style payload: duration only, no sets/reps/weight. The schema has
	// no duration column, so the handler must preserve the value via a notes
	// prefix instead of silently dropping it.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{Name: "Running", DurationMinutes: intPtr(30), Notes: "easy pace"},
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

	logs, err := db.GetExerciseLogs(resp.SessionID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log persisted, got %d", len(logs))
	}
	if got := logs[0].Notes; got != "[duration: 30 min] easy pace" {
		t.Errorf("notes = %q, want %q", got, "[duration: 30 min] easy pace")
	}
}

func TestMCPWorkoutLog_DurationOnlyNotesPrefix(t *testing.T) {
	// When the agent supplies duration with no extra notes, the prefix alone
	// should land in the notes column.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{Name: "Running", DurationMinutes: intPtr(45)},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	logs, err := db.GetExerciseLogs(resp.SessionID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 || logs[0].Notes != "[duration: 45 min]" {
		t.Errorf("notes = %q, want %q", logs[0].Notes, "[duration: 45 min]")
	}
}

func TestMCPWorkoutLog_LogRejectsForeignSession(t *testing.T) {
	// A session belonging to another user must not be writable even when the
	// caller holds a valid HMAC secret.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	const otherUserID = 999999
	day := time.Now()
	foreign, err := db.CreateAdHocWorkoutSession(otherUserID, day, day.Format("15:04"))
	if err != nil {
		t.Fatalf("create foreign session: %v", err)
	}

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		SessionID: foreign.ID,
		Exercises: []domain.ResolverInput{
			{Name: "Squat", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(80)},
		},
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for foreign session, got %d: %s", w.Code, w.Body.String())
	}

	logs, _ := db.GetExerciseLogs(foreign.ID)
	if len(logs) != 0 {
		t.Errorf("foreign session got %d logs written; expected 0", len(logs))
	}
}

func TestMCPWorkoutLog_DeleteRejectsForeignSession(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	const otherUserID = 999999
	day := time.Now()
	foreign, err := db.CreateAdHocWorkoutSession(otherUserID, day, day.Format("15:04"))
	if err != nil {
		t.Fatalf("create foreign session: %v", err)
	}
	if _, err := db.LogExerciseWithSource(foreign.ID, 0, "Squat", intPtr(3), intPtr(8), floatPtr(80), "completed", "", "library"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation:    "delete_exercise",
		SessionID:    foreign.ID,
		ExerciseName: "Squat",
	})
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for foreign session, got %d: %s", w.Code, w.Body.String())
	}

	logs, _ := db.GetExerciseLogs(foreign.ID)
	if len(logs) != 1 {
		t.Errorf("foreign session log was deleted; expected 1 row to remain")
	}
}

func TestMCPWorkoutLog_LogAllFailDoesNotCreateSession(t *testing.T) {
	// When every exercise in a request is unresolvable, the handler must not
	// leave behind an empty ad-hoc session.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{Name: "totally new exercise"}, // missing_defaults: no history, no values
			{Name: ""},                     // missing_defaults: empty name
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionID != 0 {
		t.Errorf("expected SessionID=0 when no exercise was logged, got %d", resp.SessionID)
	}
	sessions, err := db.GetWorkoutHistory(123456, 50)
	if err != nil {
		t.Fatalf("GetWorkoutHistory: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("expected no sessions in DB, got %d", len(sessions))
	}
}

func TestMCPWorkoutLog_LogRejectsNegativeValues(t *testing.T) {
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{Name: "Squat", Sets: intPtr(-1), Reps: intPtr(8), WeightKg: floatPtr(80)},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp MCPWorkoutLogResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Results) != 1 || resp.Results[0].Status != "error" {
		t.Fatalf("expected 1 error result for negative sets, got %+v", resp.Results)
	}
	if resp.SessionID != 0 {
		t.Errorf("expected SessionID=0 when only invalid input was sent, got %d", resp.SessionID)
	}
}

func TestMCPWorkoutLog_LogPreservesScheduleSourceOnUpdate(t *testing.T) {
	// The agent re-logging an existing scheduled exercise must enrich the
	// row with the new values but preserve source="schedule" so that
	// CheckCompletion still treats the planned exercise as handled.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	day := time.Now()
	sess, _ := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))
	if _, err := db.LogExerciseWithSource(sess.ID, 42, "Bench Press", intPtr(3), intPtr(8), floatPtr(60), "completed", "scheduled", "schedule"); err != nil {
		t.Fatalf("seed scheduled log: %v", err)
	}

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		SessionID: sess.ID,
		Exercises: []domain.ResolverInput{
			{Name: "Bench Press", Sets: intPtr(4), Reps: intPtr(6), WeightKg: floatPtr(70)},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	logs, err := db.GetExerciseLogs(sess.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].Source != "schedule" {
		t.Errorf("source = %q, want %q (must not be relabeled to agent)", logs[0].Source, "schedule")
	}
	if logs[0].SetsCompleted == nil || *logs[0].SetsCompleted != 4 {
		t.Errorf("sets not updated, got %+v", logs[0].SetsCompleted)
	}
	if logs[0].WeightKg == nil || *logs[0].WeightKg != 70 {
		t.Errorf("weight not updated, got %+v", logs[0].WeightKg)
	}
}

func TestMCPWorkoutLog_LogScheduledSession_AttachesPlannedExerciseID(t *testing.T) {
	// When the agent logs into a scheduled session and the resolved name
	// matches a planned exercise (workout_exercises), the new log row must
	// carry that exercise_id and source="schedule" — otherwise CheckCompletion
	// (which counts only schedule-sourced planned IDs) would never mark the
	// scheduled exercise as handled.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	userID := int64(123456)
	group, err := db.CreateWorkoutGroup("Push", "", false, userID, "[1]", "09:00", 15)
	if err != nil {
		t.Fatalf("create group: %v", err)
	}
	variant, err := db.CreateWorkoutVariant(group.ID, "Day A", nil, "")
	if err != nil {
		t.Fatalf("create variant: %v", err)
	}
	planned, err := db.AddExerciseToVariant(variant.ID, "Bench Press", 3, 8, intPtr(10), floatPtr(60), 0)
	if err != nil {
		t.Fatalf("add exercise: %v", err)
	}
	day := time.Now()
	sess, err := db.CreateWorkoutSession(group.ID, variant.ID, userID, day, "09:00")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		SessionID: sess.ID,
		Exercises: []domain.ResolverInput{
			{Name: "Bench Press", Sets: intPtr(3), Reps: intPtr(8), WeightKg: floatPtr(70)},
		},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	logs, err := db.GetExerciseLogs(sess.ID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].ExerciseID != planned.ID {
		t.Errorf("exercise_id = %d, want %d (planned exercise)", logs[0].ExerciseID, planned.ID)
	}
	if logs[0].Source != "schedule" {
		t.Errorf("source = %q, want %q", logs[0].Source, "schedule")
	}
}

func TestMCPWorkoutLog_PerSetOmittedWeightInfersFromHistory(t *testing.T) {
	// When per_set entries omit weight_kg entirely, the resolver must infer
	// weight from history rather than treating omitted as explicit zero.
	srv, db := createMCPWorkoutLogTestServer(t, "test-secret")
	defer db.Close()

	day := time.Now().AddDate(0, 0, -1)
	prior, _ := db.CreateAdHocWorkoutSession(123456, day, day.Format("15:04"))
	if _, err := db.LogExerciseWithSource(prior.ID, 0, "Biceps Curls", intPtr(3), intPtr(10), floatPtr(12.5), "completed", "", "library"); err != nil {
		t.Fatalf("seed history: %v", err)
	}

	w := postMCPWorkoutLog(t, srv, "test-secret", MCPWorkoutLogRequest{
		Operation: "log",
		Exercises: []domain.ResolverInput{
			{
				Name: "Biceps Curls",
				PerSet: []domain.PerSetEntry{
					{Reps: intPtr(10)}, // weight_kg omitted
					{Reps: intPtr(8)},  // weight_kg omitted
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
		t.Fatalf("expected logged, got %+v", resp.Results)
	}
	if resp.Results[0].Applied.WeightKg == nil || *resp.Results[0].Applied.WeightKg != 12.5 {
		t.Errorf("weight should be inferred from history (12.5), got %+v", resp.Results[0].Applied.WeightKg)
	}
	if resp.Results[0].Sources.WeightKg != domain.SourceInferred {
		t.Errorf("weight source = %s, want inferred", resp.Results[0].Sources.WeightKg)
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
