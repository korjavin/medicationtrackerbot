package tgclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeTelegram is an httptest stand-in for api.telegram.org that lets a test
// script the {ok,result}/{ok:false,description} envelope per method and records
// the last request body + headers so the SetWebhook secret-token contract can
// be asserted.
type fakeTelegram struct {
	t          *testing.T
	responses  map[string]string // method → JSON envelope
	lastBody   map[string]any
	lastMethod string
}

func newFake(t *testing.T) (*fakeTelegram, *httptest.Server) {
	f := &fakeTelegram{t: t, responses: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Path is /bot<token>/<method>.
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if len(parts) != 2 {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		f.lastMethod = parts[1]
		body, _ := io.ReadAll(r.Body)
		f.lastBody = nil
		if len(body) > 0 {
			if err := json.Unmarshal(body, &f.lastBody); err != nil {
				t.Fatalf("decode request body for %s: %v", f.lastMethod, err)
			}
		}
		env, ok := f.responses[f.lastMethod]
		if !ok {
			env = `{"ok":true,"result":{}}`
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, env)
	}))
	return f, srv
}

func TestGetMe(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()
	f.responses["getMe"] = `{"ok":true,"result":{"id":7,"is_bot":true,"username":"mt_manager_bot","can_manage_bots":true}}`

	c := New("123:ABC", srv.URL)
	me, err := c.GetMe(context.Background())
	if err != nil {
		t.Fatalf("GetMe: %v", err)
	}
	if me.Username != "mt_manager_bot" || !me.CanManageBots {
		t.Fatalf("unexpected user: %+v", me)
	}
}

func TestAPIErrorEnvelope(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()
	f.responses["getManagedBotToken"] = `{"ok":false,"description":"bot not found"}`

	c := New("123:ABC", srv.URL)
	_, err := c.GetManagedBotToken(context.Background(), 999)
	if err == nil || !strings.Contains(err.Error(), "bot not found") {
		t.Fatalf("expected api-error envelope surfaced, got %v", err)
	}
}

func TestSetWebhookSecretToken(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()

	c := New("123:ABC", srv.URL)
	if err := c.SetWebhook(context.Background(), "https://example.test/tg/manager/abc", "sekret"); err != nil {
		t.Fatalf("SetWebhook: %v", err)
	}
	if f.lastMethod != "setWebhook" {
		t.Fatalf("expected setWebhook call, got %q", f.lastMethod)
	}
	if f.lastBody["url"] != "https://example.test/tg/manager/abc" {
		t.Fatalf("url not forwarded: %v", f.lastBody["url"])
	}
	if f.lastBody["secret_token"] != "sekret" {
		t.Fatalf("secret_token not forwarded: %v", f.lastBody["secret_token"])
	}
}

func TestGetManagedBotTokenSuccess(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()
	f.responses["getManagedBotToken"] = `{"ok":true,"result":{"token":"555:CHILD"}}`

	c := New("123:ABC", srv.URL)
	tok, err := c.GetManagedBotToken(context.Background(), 555)
	if err != nil {
		t.Fatalf("GetManagedBotToken: %v", err)
	}
	if tok != "555:CHILD" {
		t.Fatalf("got token %q", tok)
	}
	// The managed bot is identified by user_id (bots are users), set to the
	// bot's own id — not bot_id, and not the human creator.
	if f.lastBody["user_id"] != float64(555) {
		t.Fatalf("user_id (bot id) not forwarded: %v", f.lastBody["user_id"])
	}
	if _, ok := f.lastBody["bot_id"]; ok {
		t.Fatalf("bot_id should not be sent; got %v", f.lastBody["bot_id"])
	}
}

// TestTransportErrorRedactsToken guards the log-leak fix: a transport-level
// failure returns a *url.Error whose message embeds the token as a URL path
// segment. The client must strip it so callers logging the error don't leak
// the bot token.
func TestTransportErrorRedactsToken(t *testing.T) {
	// Point at a closed listener so http.Do fails at the transport layer.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()

	const token = "123456:AA-secret-token"
	c := New(token, url)
	_, err := c.GetMe(context.Background())
	if err == nil {
		t.Fatal("expected transport error, got nil")
	}
	if strings.Contains(err.Error(), token) {
		t.Fatalf("token leaked in error: %q", err.Error())
	}
}
