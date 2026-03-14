package bot

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

func TestBotHttpClientConfiguration(t *testing.T) {
	env := setupBotTest(t)
	defer env.teardown()

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
	apiEnv := setupBotTestCustom(t, func(path, body string) string {
		if strings.Contains(path, "getFile") {
			return `{"ok":true,"result":{"file_id":"doc-1","file_path":"slow/file.nxk"}}`
		}
		return `{"ok":true, "result": {"message_id": 123, "chat": {"id": 123}}}`
	})
	defer apiEnv.teardown()

	fileServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
	}))
	defer fileServer.Close()

	fileServerURL, err := url.Parse(fileServer.URL)
	if err != nil {
		t.Fatalf("failed to parse file server URL: %v", err)
	}

	apiEnv.b.httpClient = &http.Client{
		Timeout: 50 * time.Millisecond,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // test-only transport
		},
	}
	apiEnv.b.httpClient.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		dialer := &net.Dialer{}
		return dialer.DialContext(ctx, network, fileServerURL.Host)
	}

	msg := &tgbotapi.Message{
		Chat: &tgbotapi.Chat{ID: 123456},
		From: &tgbotapi.User{ID: 123456},
		Document: &tgbotapi.Document{
			FileID:   "doc-1",
			FileName: "sleep.nxk",
			FileSize: 128,
		},
	}

	apiEnv.b.handleDocumentUpload(msg)

	var sawDownloadError bool
	var requests []string
	for {
		select {
		case req := <-apiEnv.requestChan:
			requests = append(requests, req)
			if strings.Contains(req, "editMessageText|") && strings.Contains(req, "downloading") {
				sawDownloadError = true
			}
		default:
			if !sawDownloadError {
				t.Fatalf("expected timeout path to edit the status message with a download error, got requests: %v", requests)
			}
			return
		}
	}
}
