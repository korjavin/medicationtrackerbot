package bot

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type botTestEnv struct {
	b           *Bot
	s           *store.Store
	server      *httptest.Server
	messageChan chan string
}

func setupBotTest(t *testing.T) *botTestEnv {
	s, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create store: %v", err)
	}

	messageChan := make(chan string, 100)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "sendMessage") {
			bodyBytes, _ := io.ReadAll(r.Body)
			bodyStr, _ := url.QueryUnescape(string(bodyBytes))
			messageChan <- bodyStr
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true, "result": {"message_id": 123, "chat": {"id": 123}}}`))
	}))

	api := &tgbotapi.BotAPI{
		Token:  "TEST_TOKEN",
		Client: &http.Client{},
		Buffer: 100,
	}
	api.SetAPIEndpoint(server.URL + "/bot%s/%s")

	b := &Bot{
		api:           api,
		store:         s,
		allowedUserID: 123456,
	}

	return &botTestEnv{
		b:           b,
		s:           s,
		server:      server,
		messageChan: messageChan,
	}
}

func (e *botTestEnv) teardown() {
	e.server.Close()
}
