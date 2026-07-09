package tgclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeTelegram is an httptest stand-in for api.telegram.org that lets a test
// script the {ok,result}/{ok:false,description} envelope per method and records
// the last request body + headers so the SetWebhook secret-token contract can
// be asserted.
type fakeTelegram struct {
	t          *testing.T
	responses  map[string]string // method → JSON envelope
	statuses   map[string]int    // method → HTTP status (default 200)
	lastBody   map[string]any
	lastMethod string
}

func newFake(t *testing.T) (*fakeTelegram, *httptest.Server) {
	f := &fakeTelegram{t: t, responses: map[string]string{}, statuses: map[string]int{}}
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
		// Telegram sends the error envelope with a real 4xx/5xx status; the
		// status is what IsClientError classifies on, so tests must be able to
		// set it. Default 200 keeps every existing success case unchanged.
		if code := f.statuses[f.lastMethod]; code != 0 {
			w.WriteHeader(code)
		}
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

// med-jjd: a 429 is the one 4xx that retrying fixes. IsClientError callers drop
// the event when it reports true, and managed_bot_created is never re-sent — so
// misclassifying a rate limit strands the account unbound forever.
func TestRateLimitIsNotAPermanentClientError(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()
	f.statuses["getManagedBotToken"] = http.StatusTooManyRequests
	f.responses["getManagedBotToken"] = `{"ok":false,"description":"Too Many Requests: retry after 30","parameters":{"retry_after":30}}`

	c := New("123:ABC", srv.URL)
	_, err := c.GetManagedBotToken(context.Background(), 999)
	if err == nil {
		t.Fatal("expected an error on 429")
	}
	if IsClientError(err) {
		t.Errorf("429 must not be a permanent client error, got IsClientError=true for %v", err)
	}
	wait, ok := RetryAfter(err)
	if !ok || wait != 30*time.Second {
		t.Errorf("RetryAfter = (%v, %v), want (30s, true)", wait, ok)
	}
}

// Every other 4xx stays permanent — the guard above must not widen into "all
// 4xx are retryable", which would re-drive dead events forever.
func TestNon429ClientErrorsStayPermanent(t *testing.T) {
	for _, code := range []int{http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound} {
		f, srv := newFake(t)
		f.statuses["getManagedBotToken"] = code
		f.responses["getManagedBotToken"] = `{"ok":false,"description":"user is deactivated"}`

		c := New("123:ABC", srv.URL)
		_, err := c.GetManagedBotToken(context.Background(), 999)
		if !IsClientError(err) {
			t.Errorf("status %d: IsClientError = false, want true (err=%v)", code, err)
		}
		if _, ok := RetryAfter(err); ok {
			t.Errorf("status %d: RetryAfter reported a cooldown for a non-429", code)
		}
		srv.Close()
	}
}

// 5xx and transport failures were already transient; pin it so the 429 guard
// can't accidentally invert them.
func TestServerErrorIsNotAClientError(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()
	f.statuses["getManagedBotToken"] = http.StatusBadGateway
	f.responses["getManagedBotToken"] = `{"ok":false,"description":"bad gateway"}`

	c := New("123:ABC", srv.URL)
	_, err := c.GetManagedBotToken(context.Background(), 999)
	if err == nil || IsClientError(err) {
		t.Errorf("5xx must stay transient, got IsClientError=true for %v", err)
	}
}

func TestSetMyCommandsPayloadShape(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()

	c := New("123:ABC", srv.URL)
	err := c.SetMyCommands(context.Background(), []BotCommand{
		{Command: "start", Description: "Start the bot and open the App"},
	})
	if err != nil {
		t.Fatalf("SetMyCommands: %v", err)
	}
	if f.lastMethod != "setMyCommands" {
		t.Fatalf("called %q, want setMyCommands", f.lastMethod)
	}
	cmds, ok := f.lastBody["commands"].([]any)
	if !ok || len(cmds) != 1 {
		t.Fatalf("commands payload = %#v, want a 1-element array", f.lastBody["commands"])
	}
	first, _ := cmds[0].(map[string]any)
	if first["command"] != "start" || first["description"] != "Start the bot and open the App" {
		t.Errorf("command entry = %#v", first)
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
	f.responses["getManagedBotToken"] = `{"ok":true,"result":"555:CHILD"}`

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

func TestSetMyProfilePhotoMultipartShape(t *testing.T) {
	var gotContentType string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		b, err := io.ReadAll(r.Body)
		if err == nil {
			gotBody = b
		}
		w.Write([]byte(`{"ok": true, "result": true}`))
	}))
	defer srv.Close()

	client := New("dummy_token", srv.URL)
	err := client.SetMyProfilePhoto(context.Background(), []byte("fake_image_data"))
	if err != nil {
		t.Fatalf("SetMyProfilePhoto failed: %v", err)
	}

	if !strings.HasPrefix(gotContentType, "multipart/form-data; boundary=") {
		t.Errorf("expected multipart/form-data, got %q", gotContentType)
	}

	bodyStr := string(gotBody)
	if !strings.Contains(bodyStr, `name="photo"`) {
		t.Errorf("missing photo field name")
	}
	if !strings.Contains(bodyStr, `{"type":"static","photo":"attach://profile_photo"}`) {
		t.Errorf("missing correct JSON for photo field")
	}
	if !strings.Contains(bodyStr, `name="profile_photo"`) {
		t.Errorf("missing profile_photo file part name")
	}
	if !strings.Contains(bodyStr, "fake_image_data") {
		t.Errorf("missing image payload")
	}
}
