package bot

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func newTestBotWithTelegramRecorder(t *testing.T, sentMessageID int) (*Bot, *[]int, func()) {
	t.Helper()

	var mu sync.Mutex
	deleted := make([]int, 0)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(bodyBytes))

		switch {
		case strings.Contains(r.URL.Path, "sendMessage"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true, "result": {"message_id": ` + strconv.Itoa(sentMessageID) + `, "chat": {"id": 123456}}}`))
			return
		case strings.Contains(r.URL.Path, "deleteMessage"):
			msgID, _ := strconv.Atoi(form.Get("message_id"))
			mu.Lock()
			deleted = append(deleted, msgID)
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true, "result": true}`))
			return
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true, "result": {}}`))
		}
	}))

	api := &tgbotapi.BotAPI{
		Token:  "TEST_TOKEN",
		Client: &http.Client{},
		Buffer: 100,
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{
		api:           api,
		allowedUserID: 123456,
	}

	cleanup := func() {
		server.Close()
	}

	return b, &deleted, cleanup
}

func TestCleanupWorkoutSessionMessages_DeletesTrackedMessages(t *testing.T) {
	b, deleted, cleanup := newTestBotWithTelegramRecorder(t, 500)
	defer cleanup()

	sessionID := int64(42)
	b.trackWorkoutMessage(sessionID, 101)
	b.trackWorkoutMessage(sessionID, 202)

	if err := b.CleanupWorkoutSessionMessages(sessionID); err != nil {
		t.Fatalf("CleanupWorkoutSessionMessages: %v", err)
	}

	if len(*deleted) != 2 {
		t.Fatalf("expected 2 delete requests, got %d (%v)", len(*deleted), *deleted)
	}
	if !slices.Contains(*deleted, 101) || !slices.Contains(*deleted, 202) {
		t.Fatalf("expected delete requests for message IDs 101 and 202, got %v", *deleted)
	}

	// Ensure messages are consumed and not deleted again.
	if err := b.CleanupWorkoutSessionMessages(sessionID); err != nil {
		t.Fatalf("second CleanupWorkoutSessionMessages: %v", err)
	}
	if len(*deleted) != 2 {
		t.Fatalf("expected no extra deletes on second cleanup, got %d (%v)", len(*deleted), *deleted)
	}
}

func TestSendMarkdownNotification_TracksWorkoutMessageByActionID(t *testing.T) {
	b, deleted, cleanup := newTestBotWithTelegramRecorder(t, 777)
	defer cleanup()

	_, err := b.SendMarkdownNotification("test", []struct{ ID, Label string }{
		{ID: "workout_start_55", Label: "Start"},
	})
	if err != nil {
		t.Fatalf("SendMarkdownNotification: %v", err)
	}

	if err := b.CleanupWorkoutSessionMessages(55); err != nil {
		t.Fatalf("CleanupWorkoutSessionMessages: %v", err)
	}

	if len(*deleted) != 1 || (*deleted)[0] != 777 {
		t.Fatalf("expected a delete request for tracked notification message 777, got %v", *deleted)
	}
}
