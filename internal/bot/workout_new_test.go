package bot

import (
	"fmt"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

// makeWorkoutEnv creates a test environment with a workout group, variant,
// exercise, and a pending session scheduled for today.
func makeWorkoutEnv(t *testing.T) (*botTestEnv, int64 /*sessionID*/, int64 /*exerciseID*/) {
	t.Helper()
	env := setupBotTest(t)

	userID := int64(123456)
	group, err := env.s.CreateWorkoutGroup("Pull Day", "", false, userID, "[1]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateWorkoutGroup: %v", err)
	}
	variant, err := env.s.CreateWorkoutVariant(group.ID, "Heavy", nil, "")
	if err != nil {
		t.Fatalf("CreateWorkoutVariant: %v", err)
	}
	ex, err := env.s.AddExerciseToVariant(variant.ID, "Pull-up", 4, 8, nil, nil, 0)
	if err != nil {
		t.Fatalf("AddExerciseToVariant: %v", err)
	}
	session, err := env.s.CreateWorkoutSession(group.ID, variant.ID, userID, time.Now(), "09:00")
	if err != nil {
		t.Fatalf("CreateWorkoutSession: %v", err)
	}
	return env, session.ID, ex.ID
}

// workoutCB creates a tgbotapi.CallbackQuery for workout callback tests.
func workoutCB(data string) *tgbotapi.CallbackQuery {
	return &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: 123456},
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: 123456},
		},
		Data: data,
	}
}

// drainMessages discards all queued messages in env.messageChan.
func drainMessages(env *botTestEnv) {
	for {
		select {
		case <-env.messageChan:
		default:
			return
		}
	}
}

// --- workout_start ---

func TestWorkoutStart_SessionBecomesInProgress(t *testing.T) {
	env, sessionID, _ := makeWorkoutEnv(t)
	defer env.teardown()

	cb := workoutCB(fmt.Sprintf("workout_start_%d", sessionID))
	env.b.handleCallback(cb)

	session, err := env.s.GetWorkoutSession(sessionID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if session.Status != "in_progress" {
		t.Errorf("Expected status 'in_progress' after start, got %q", session.Status)
	}
	if session.StartedAt == nil {
		t.Error("Expected StartedAt to be set after start")
	}
}

func TestWorkoutStart_SendsExercisePrompt(t *testing.T) {
	env, sessionID, _ := makeWorkoutEnv(t)
	defer env.teardown()
	drainMessages(env)

	cb := workoutCB(fmt.Sprintf("workout_start_%d", sessionID))
	env.b.handleCallback(cb)

	// Should receive at least one message (the exercise loop overview + prompt)
	select {
	case msg := <-env.messageChan:
		if msg == "" {
			t.Error("Expected non-empty exercise loop message")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for exercise prompt after workout_start")
	}
}

// TestWorkoutStart_AdHocSendsConfirmation verifies that tapping "Start Now"
// on a notification for a scheduled ad-hoc session (group_id = -1) produces
// a confirmation message instead of the variant-driven exercise loop, which
// would otherwise hit ListExercisesByVariant(-1) and reply "No exercises
// found for this workout".
func TestWorkoutStart_AdHocSendsConfirmation(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	scheduled := time.Now().Add(time.Hour)
	session, err := env.s.CreatePlannedAdHocSession(userID, scheduled, "12:00")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}
	if _, err := env.s.LogExerciseWithSource(session.ID, 0, "Burpees", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}
	drainMessages(env)

	cb := workoutCB(fmt.Sprintf("workout_start_%d", session.ID))
	env.b.handleCallback(cb)

	var got string
	select {
	case got = <-env.messageChan:
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for ad-hoc start confirmation message")
	}
	if strings.Contains(got, "No exercises found") {
		t.Fatalf("ad-hoc start hit variant-driven path: %q", got)
	}
	if !strings.Contains(got, "Burpees") {
		t.Errorf("expected confirmation to list planned exercise %q, got %q", "Burpees", got)
	}

	updated, err := env.s.GetWorkoutSession(session.ID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if updated.Status != "in_progress" {
		t.Errorf("expected ad-hoc session to be in_progress after start, got %q", updated.Status)
	}
}

// TestStartWorkoutFlowFromWeb_AdHocSendsConfirmation mirrors the bot
// callback-side test for the API/MCP-driven start path: when /api/workout/sessions/{id}/start
// fires StartWorkoutFlowFromWeb on a scheduled ad-hoc session (group_id = -1),
// it must send a confirmation listing the planned exercises rather than the
// variant-driven "No exercises found" reply.
func TestStartWorkoutFlowFromWeb_AdHocSendsConfirmation(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	scheduled := time.Now().Add(time.Hour)
	session, err := env.s.CreatePlannedAdHocSession(userID, scheduled, "12:00")
	if err != nil {
		t.Fatalf("CreatePlannedAdHocSession: %v", err)
	}
	if _, err := env.s.LogExerciseWithSource(session.ID, 0, "Burpees", nil, nil, nil, "", "", "schedule"); err != nil {
		t.Fatalf("LogExerciseWithSource: %v", err)
	}
	drainMessages(env)

	if err := env.b.StartWorkoutFlowFromWeb(session.ID); err != nil {
		t.Fatalf("StartWorkoutFlowFromWeb: %v", err)
	}

	var got string
	select {
	case got = <-env.messageChan:
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for ad-hoc start confirmation message")
	}
	if strings.Contains(got, "No exercises found") {
		t.Fatalf("ad-hoc StartWorkoutFlowFromWeb hit variant-driven path: %q", got)
	}
	if !strings.Contains(got, "Burpees") {
		t.Errorf("expected confirmation to list planned exercise %q, got %q", "Burpees", got)
	}
}

// --- workout_snooze ---

func TestWorkoutSnooze1_SnoozesDuration(t *testing.T) {
	env, sessionID, _ := makeWorkoutEnv(t)
	defer env.teardown()

	before := time.Now()
	cb := workoutCB(fmt.Sprintf("workout_snooze1_%d", sessionID))
	env.b.handleCallback(cb)

	session, err := env.s.GetWorkoutSession(sessionID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if session.SnoozedUntil == nil {
		t.Fatal("Expected SnoozedUntil to be set after snooze1")
	}
	// snooze1 = 1h; SnoozedUntil should be roughly before+1h
	expected := before.Add(1 * time.Hour)
	diff := session.SnoozedUntil.Sub(expected)
	if diff < -5*time.Second || diff > 5*time.Second {
		t.Errorf("SnoozedUntil = %v, want ~%v (±5s)", *session.SnoozedUntil, expected)
	}
}

func TestWorkoutSnooze2_SnoozesDuration(t *testing.T) {
	env, sessionID, _ := makeWorkoutEnv(t)
	defer env.teardown()

	before := time.Now()
	cb := workoutCB(fmt.Sprintf("workout_snooze2_%d", sessionID))
	env.b.handleCallback(cb)

	session, err := env.s.GetWorkoutSession(sessionID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if session.SnoozedUntil == nil {
		t.Fatal("Expected SnoozedUntil to be set after snooze2")
	}
	expected := before.Add(2 * time.Hour)
	diff := session.SnoozedUntil.Sub(expected)
	if diff < -5*time.Second || diff > 5*time.Second {
		t.Errorf("SnoozedUntil = %v, want ~%v (±5s)", *session.SnoozedUntil, expected)
	}
}

// --- workout_skip ---

func TestWorkoutSkip_StatusBecomesSkipped(t *testing.T) {
	env, sessionID, _ := makeWorkoutEnv(t)
	defer env.teardown()

	cb := workoutCB(fmt.Sprintf("workout_skip_%d", sessionID))
	env.b.handleCallback(cb)

	session, err := env.s.GetWorkoutSession(sessionID)
	if err != nil {
		t.Fatalf("GetWorkoutSession: %v", err)
	}
	if session.Status != "skipped" {
		t.Errorf("Expected status 'skipped', got %q", session.Status)
	}
}

func TestWorkoutSkip_AdvancesRotationForRotatingGroup(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	userID := int64(123456)
	// Rotating group with two variants
	group, _ := env.s.CreateWorkoutGroup("PPL", "", true, userID, "[1]", "09:00", 15)
	v1, _ := env.s.CreateWorkoutVariant(group.ID, "Push", nil, "")
	v2, _ := env.s.CreateWorkoutVariant(group.ID, "Pull", nil, "")
	env.s.InitializeRotation(group.ID, v1.ID)

	session, _ := env.s.CreateWorkoutSession(group.ID, v1.ID, userID, time.Now(), "09:00")

	cb := workoutCB(fmt.Sprintf("workout_skip_%d", session.ID))
	env.b.handleCallback(cb)

	// After skip+rotation advance, current variant should be v2
	rotState, err := env.s.GetRotationState(group.ID)
	if err != nil {
		t.Fatalf("GetRotationState: %v", err)
	}
	if rotState.CurrentVariantID != v2.ID {
		t.Errorf("Expected rotation to advance to v2 (%d), got %d", v2.ID, rotState.CurrentVariantID)
	}
}

// --- exercise callbacks ---

func TestExerciseDone_CreatesLog(t *testing.T) {
	env, sessionID, exerciseID := makeWorkoutEnv(t)
	defer env.teardown()

	// Start the session first
	if err := env.s.StartSession(sessionID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	cb := workoutCB(fmt.Sprintf("exercise_done_%d_%d", sessionID, exerciseID))
	env.b.handleExerciseCallback(cb, cb.Data)

	logs, err := env.s.GetExerciseLogs(sessionID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) == 0 {
		t.Error("Expected exercise log to be created after exercise_done")
	}
	if logs[0].Status != "completed" {
		t.Errorf("Expected log status 'completed', got %q", logs[0].Status)
	}
}

func TestExerciseDone_ExistingSkippedLogBecomesCompleted(t *testing.T) {
	env, sessionID, exerciseID := makeWorkoutEnv(t)
	defer env.teardown()

	if err := env.s.StartSession(sessionID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if _, err := env.s.LogExercise(sessionID, exerciseID, "Pull-up", nil, nil, nil, "skipped", ""); err != nil {
		t.Fatalf("LogExercise skipped: %v", err)
	}

	cb := workoutCB(fmt.Sprintf("exercise_done_%d_%d", sessionID, exerciseID))
	env.b.handleExerciseCallback(cb, cb.Data)

	log, err := env.s.GetExerciseLogBySessionAndExercise(sessionID, exerciseID)
	if err != nil {
		t.Fatalf("GetExerciseLogBySessionAndExercise: %v", err)
	}
	if log == nil {
		t.Fatal("Expected existing log after exercise_done")
	}
	if log.Status != "completed" {
		t.Fatalf("Expected status 'completed' after exercise_done, got %q", log.Status)
	}
}

func TestExerciseSkip_CreatesLogAsSkipped(t *testing.T) {
	env, sessionID, exerciseID := makeWorkoutEnv(t)
	defer env.teardown()

	if err := env.s.StartSession(sessionID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	cb := workoutCB(fmt.Sprintf("exercise_skip_%d_%d", sessionID, exerciseID))
	env.b.handleExerciseCallback(cb, cb.Data)

	logs, err := env.s.GetExerciseLogs(sessionID)
	if err != nil {
		t.Fatalf("GetExerciseLogs: %v", err)
	}
	if len(logs) == 0 {
		t.Error("Expected exercise log after exercise_skip")
	}
	if logs[0].Status != "skipped" {
		t.Errorf("Expected log status 'skipped', got %q", logs[0].Status)
	}
}

func TestExerciseEdit_SendsWebAppHint(t *testing.T) {
	env, sessionID, exerciseID := makeWorkoutEnv(t)
	defer env.teardown()

	if err := env.s.StartSession(sessionID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	drainMessages(env)

	cb := workoutCB(fmt.Sprintf("exercise_edit_%d_%d", sessionID, exerciseID))
	env.b.handleExerciseCallback(cb, cb.Data)

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "web") {
			t.Errorf("Expected web app hint in edit response, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for exercise_edit response")
	}
}

// --- handleAddExerciseCallback ---

func TestAddExerciseCallback_SendsExerciseList(t *testing.T) {
	env, sessionID, _ := makeWorkoutEnv(t)
	defer env.teardown()

	if err := env.s.StartSession(sessionID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	drainMessages(env)

	cb := workoutCB(fmt.Sprintf("add_exercise_%d", sessionID))
	env.b.handleAddExerciseCallback(cb, sessionID)

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "exercise") && !strings.Contains(msg, "Select") {
			t.Errorf("Expected exercise list message, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for exercise list")
	}
}

func TestAddExerciseCallback_WrongUser_Denied(t *testing.T) {
	env, sessionID, _ := makeWorkoutEnv(t)
	defer env.teardown()

	if err := env.s.StartSession(sessionID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	drainMessages(env)

	// Build a callback from a different user
	cb := &tgbotapi.CallbackQuery{
		ID:   "cid",
		From: &tgbotapi.User{ID: 999999}, // wrong user
		Message: &tgbotapi.Message{
			MessageID: 200,
			Chat:      &tgbotapi.Chat{ID: 999999},
		},
	}
	env.b.handleAddExerciseCallback(cb, sessionID)

	select {
	case msg := <-env.messageChan:
		if !strings.Contains(msg, "denied") && !strings.Contains(msg, "Access") {
			t.Errorf("Expected access denied message, got: %s", msg)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for denied message")
	}
}

// --- handleSelectExerciseCallback ---

func TestSelectExerciseCallback_SendsExercisePrompt(t *testing.T) {
	env, sessionID, exerciseID := makeWorkoutEnv(t)
	defer env.teardown()

	if err := env.s.StartSession(sessionID); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	drainMessages(env)

	cb := workoutCB(fmt.Sprintf("select_exercise_%d_%d", sessionID, exerciseID))
	env.b.handleSelectExerciseCallback(cb, sessionID, exerciseID)

	select {
	case msg := <-env.messageChan:
		if msg == "" {
			t.Error("Expected exercise prompt message")
		}
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for exercise prompt")
	}
}

// --- handleAdHocWorkoutCommand ---

func TestAdHocWorkoutCommand_CreatesSession(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()
	env.b.timezone = &mockTimezoneStore{}

	// Add some exercises so SendExerciseList has something to send
	group, _ := env.s.CreateWorkoutGroup("Misc", "", false, 123456, "[1]", "09:00", 15)
	variant, _ := env.s.CreateWorkoutVariant(group.ID, "A", nil, "")
	env.s.AddExerciseToVariant(variant.ID, "Push-up", 3, 10, nil, nil, 0)

	msgConfig := &tgbotapi.MessageConfig{
		BaseChat: tgbotapi.BaseChat{ChatID: 123456},
	}
	env.b.handleAdHocWorkoutCommand(msgConfig)

	// The function sets Text on the msgConfig
	if !strings.Contains(msgConfig.Text, "Ad-hoc Workout") {
		t.Errorf("Expected 'Ad-hoc Workout' in msgConfig.Text, got: %s", msgConfig.Text)
	}

	// Give the goroutine time to run and create any needed messages
	time.Sleep(200 * time.Millisecond)
}
