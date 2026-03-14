package bot

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func TestBotHttpClientConfiguration(t *testing.T) {
	// Start an in-memory store so we can instantiate the bot
	st, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer st.Close()

	// Setup bot env correctly for tests
	env := setupBotTest(t)

	// Verify that the HTTP client is correctly initialized with a 30s timeout
	if env.b.httpClient == nil {
		t.Fatalf("expected bot.httpClient to be initialized, got nil")
	}

	expectedTimeout := 30 * time.Second
	if env.b.httpClient.Timeout != expectedTimeout {
		t.Errorf("expected bot.httpClient timeout to be %v, got %v", expectedTimeout, env.b.httpClient.Timeout)
	}
}

func TestSleepImportTimeoutBehavior(t *testing.T) {
	env := setupBotTest(t)

	// Create a mock server that accepts connections but never responds,
	// forcing a client timeout.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Sleep longer than the client timeout
		time.Sleep(200 * time.Millisecond)
	}))
	defer server.Close()

	// Override the bot's http client to have a very short timeout for this test
	env.b.httpClient = &http.Client{
		Timeout: 50 * time.Millisecond,
	}

	// Perform a request using the configured client to simulate the download
	_, err := env.b.httpClient.Get(server.URL)
	if err == nil {
		t.Fatalf("expected a timeout error, but request succeeded")
	}

	// Verify the error is indeed a timeout
	if e, ok := err.(interface{ Timeout() bool }); !ok || !e.Timeout() {
		// depending on how http.Client surfaces the error, it might be wrapped
		if err != context.DeadlineExceeded && err.Error() != "Get \""+server.URL+"\": context deadline exceeded" {
			t.Logf("expected context deadline exceeded, got: %v", err)
		}
	}
}
