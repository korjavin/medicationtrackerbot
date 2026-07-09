package bot

import (
	"context"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// sendCmd sends a slash command to the bot and returns the captured response body.
// Returns "" if no response arrives within 1 second.
func sendCmd(env *botTestEnv, command string) string {
	msg := &tgbotapi.Message{
		Chat:     &tgbotapi.Chat{ID: 123},
		Text:     command,
		From:     &tgbotapi.User{ID: 123456},
		Date:     int(time.Now().Unix()),
		Entities: []tgbotapi.MessageEntity{{Type: "bot_command", Offset: 0, Length: len(command)}},
	}
	env.b.handleMessage(msg)
	select {
	case body := <-env.messageChan:
		return body
	case <-time.After(1 * time.Second):
		return ""
	}
}

// testBP is a convenience constructor for a BloodPressure fixture.
func testBP(userID int64, systolic, diastolic int, pulse *int, measuredAt time.Time) *store.BloodPressure {
	return &store.BloodPressure{
		UserID:     userID,
		MeasuredAt: measuredAt,
		Systolic:   systolic,
		Diastolic:  diastolic,
		Pulse:      pulse,
	}
}

// --- /bpstats ---

func TestHandleBPStatsCommand_Empty(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendCmd(env, "/bpstats")
	if body == "" {
		t.Fatal("Timeout waiting for /bpstats response")
	}
	if !strings.Contains(body, "Statistics") {
		t.Errorf("Expected 'Statistics' in response, got: %s", body)
	}
}

func TestHandleBPStatsCommand_WithData(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	ctx := context.Background()
	env.s.BP.CreateReading(ctx, testBP(123456, 120, 80, nil, time.Now()))
	env.s.BP.CreateReading(ctx, testBP(123456, 130, 85, nil, time.Now().Add(-time.Hour)))

	body := sendCmd(env, "/bpstats")
	if body == "" {
		t.Fatal("Timeout")
	}
	if !strings.Contains(body, "Statistics") {
		t.Errorf("Expected 'Statistics' in response, got: %s", body)
	}
}

// --- /next ---

func TestHandleNextIntakeCommand_NoMedications(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendCmd(env, "/next")
	if body == "" {
		t.Fatal("Timeout waiting for /next response")
	}
	// Any non-empty response is fine; just verify the handler doesn't crash
}

func TestHandleNextIntakeCommand_WithScheduledMed(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	futureTime := time.Now().Add(30 * time.Minute).Format("15:04")
	schedule := `{"type":"daily","times":["` + futureTime + `"]}`
	env.s.Medication.Create("Metoprolol", "50mg", schedule, nil, nil, "", "", "")

	body := sendCmd(env, "/next")
	if body == "" {
		t.Fatal("Timeout waiting for /next response")
	}
	if !strings.Contains(body, "Metoprolol") {
		t.Errorf("Expected medication name in /next response, got: %s", body)
	}
}

// --- /help ---

func TestHandleHelpCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendCmd(env, "/help")
	if body == "" {
		t.Fatal("Timeout waiting for /help response")
	}
	if !strings.Contains(body, "/") {
		t.Errorf("Expected command list in /help, got: %s", body)
	}
}

// --- unknown command ---

func TestHandleUnknownCommand(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

	body := sendCmd(env, "/thisdoesnotexist")
	if body == "" {
		t.Fatal("Timeout waiting for unknown command response")
	}
	if !strings.Contains(body, "Unknown command") {
		t.Errorf("Expected 'Unknown command', got: %s", body)
	}
}
