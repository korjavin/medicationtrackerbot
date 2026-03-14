package bot

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	workoutsvc "github.com/korjavin/medicationtrackerbot/internal/workout"
)

type botTestEnv struct {
	b           *Bot
	s           *store.Store
	server      *httptest.Server
	messageChan chan string
	requestChan chan string
}

func setupBotTest(t *testing.T) *botTestEnv {
	return setupBotTestCustom(t, func(path, body string) string {
		return `{"ok":true, "result": {"message_id": 123, "chat": {"id": 123}}}`
	})
}

func setupBotTestCustom(t *testing.T, handler func(path, body string) string) *botTestEnv {
	s, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}

	messageChan := make(chan string, 100)
	requestChan := make(chan string, 100)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("Failed to read request body: %v", err)
			return
		}
		bodyStr, err := url.QueryUnescape(string(bodyBytes))
		if err != nil {
			bodyStr = string(bodyBytes)
		}

		requestChan <- r.URL.Path + "|" + bodyStr

		if strings.Contains(r.URL.Path, "sendMessage") {
			messageChan <- bodyStr
		}

		if strings.Contains(r.URL.Path, "editMessageText") {
			messageChan <- bodyStr
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(handler(r.URL.Path, bodyStr)))
	}))

	api := &tgbotapi.BotAPI{
		Token:  "TEST_TOKEN",
		Client: &http.Client{},
		Buffer: 100,
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{
		api:           api,
		meds:          s,
		medSvc:        domain.NewMedicationService(s),
		bp:            s,
		weight:        s,
		workouts:      s,
		workoutSvc:    workoutsvc.New(s),
		exerciseSvc:   domain.NewExerciseService(s),
		reminderSvc:   domain.NewReminderService(s),
		food:          s,
		imports:       s,
		allowedUserID: 123456,
		httpClient:    &http.Client{Timeout: 30 * time.Second},
	}

	return &botTestEnv{
		b:           b,
		s:           s,
		server:      server,
		messageChan: messageChan,
		requestChan: requestChan,
	}
}

func (e *botTestEnv) teardown() {
	e.server.Close()
}
