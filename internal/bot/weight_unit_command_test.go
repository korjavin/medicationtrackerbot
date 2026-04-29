package bot

import (
	"context"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func sendWeightCmd(t *testing.T, env *botTestEnv, command string) string {
	t.Helper()
	msg := &tgbotapi.Message{
		Chat:     &tgbotapi.Chat{ID: 123},
		Text:     command,
		From:     &tgbotapi.User{ID: 123456},
		Date:     int(time.Now().Unix()),
		Entities: []tgbotapi.MessageEntity{{Type: "bot_command", Offset: 0, Length: len("/weight")}},
	}
	env.b.handleMessage(msg)
	select {
	case body := <-env.messageChan:
		return body
	case <-time.After(1 * time.Second):
		t.Fatal("Timeout waiting for /weight response")
		return ""
	}
}

func TestHandleWeightCommand_BareNumberUsesPreference(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ctx := context.Background()
	if err := env.s.SetWeightUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference: %v", err)
	}

	body := sendWeightCmd(t, env, "/weight 150")
	if !strings.Contains(body, "150.0 lb") {
		t.Errorf("Expected '150.0 lb' in reply, got: %s", body)
	}
	// Storage stays in kg; 150 lb ≈ 68.0 kg.
	logs, err := env.s.GetWeightLogs(ctx, 123456, time.Time{})
	if err != nil {
		t.Fatalf("GetWeightLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].Weight < 67.9 || logs[0].Weight > 68.1 {
		t.Errorf("expected stored kg ~ 68.0, got %v", logs[0].Weight)
	}
	// Preference should NOT change because no explicit suffix was provided.
	pref, _ := env.s.GetWeightUnitPreference(ctx)
	if pref != "lb" {
		t.Errorf("expected pref unchanged 'lb', got %q", pref)
	}
}

func TestHandleWeightCommand_LbSuffixSetsPreferenceToLb(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ctx := context.Background()
	// default pref starts at kg
	body := sendWeightCmd(t, env, "/weight 150lb")
	if !strings.Contains(body, "150.0 lb") {
		t.Errorf("Expected '150.0 lb' in reply, got: %s", body)
	}
	if !strings.Contains(body, "kg)") {
		t.Errorf("Expected kg shown in parens for lb reply, got: %s", body)
	}
	pref, err := env.s.GetWeightUnitPreference(ctx)
	if err != nil {
		t.Fatalf("GetWeightUnitPreference: %v", err)
	}
	if pref != "lb" {
		t.Errorf("expected pref 'lb' after explicit suffix, got %q", pref)
	}
}

func TestHandleWeightCommand_KgSuffixSetsPreferenceToKg(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ctx := context.Background()
	if err := env.s.SetWeightUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference: %v", err)
	}

	body := sendWeightCmd(t, env, "/weight 70kg")
	if !strings.Contains(body, "70.0 kg") {
		t.Errorf("Expected '70.0 kg' in reply, got: %s", body)
	}
	pref, _ := env.s.GetWeightUnitPreference(ctx)
	if pref != "kg" {
		t.Errorf("expected pref 'kg' after explicit kg suffix, got %q", pref)
	}
}

func TestHandleWeightCommand_InvalidSuffixRejected(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendWeightCmd(t, env, "/weight 150oz")
	if !strings.Contains(body, "Invalid weight unit") {
		t.Errorf("Expected invalid-unit error, got: %s", body)
	}
	logs, _ := env.s.GetWeightLogs(context.Background(), 123456, time.Time{})
	if len(logs) != 0 {
		t.Errorf("expected no log saved, got %d", len(logs))
	}
}

func TestHandleWeightCommand_OutOfRangeRejected(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendWeightCmd(t, env, "/weight 500")
	if !strings.Contains(body, "30-300") {
		t.Errorf("Expected range error, got: %s", body)
	}
}

func TestHandleWeightCommand_ReplyFormatMatchesPreference(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ctx := context.Background()
	// Pre-load a previous weight so the change/trend formatting is exercised.
	prev := 154.3 * 0.45359237 // 154.3 lb ≈ 70.0 kg
	prevTrend := prev
	if _, err := env.s.CreateWeightLog(ctx, &store.WeightLog{
		UserID:      123456,
		MeasuredAt:  time.Now().Add(-24 * time.Hour),
		Weight:      prev,
		WeightTrend: &prevTrend,
	}); err != nil {
		t.Fatalf("seed weight log: %v", err)
	}

	if err := env.s.SetWeightUnitPreference(ctx, "lb"); err != nil {
		t.Fatalf("SetWeightUnitPreference: %v", err)
	}

	body := sendWeightCmd(t, env, "/weight 156lb")
	if !strings.Contains(body, "156.0 lb") {
		t.Errorf("Expected '156.0 lb' in reply, got: %s", body)
	}
	// kg shown in parens after primary
	if !strings.Contains(body, " kg)") {
		t.Errorf("Expected 'kg)' in lb reply, got: %s", body)
	}
}
