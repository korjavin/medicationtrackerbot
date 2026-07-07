package cloudserver

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeTG is an httptest stand-in for api.telegram.org for the provisioning
// state-machine test: it scripts the {ok,result} envelope per Bot API method
// and defaults unknown methods to a bare success (setWebhook et al).
func fakeTG(t *testing.T, responses map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		method := parts[len(parts)-1]
		// Mirror the real API: getManagedBotToken rejects a call that omits a
		// non-zero user_id ("400: invalid user_id specified"). user_id is the
		// managed bot's own id (bots are users); guards that we send it.
		if method == "getManagedBotToken" {
			var req struct {
				UserID int64 `json:"user_id"`
			}
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &req)
			if req.UserID == 0 {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"ok":false,"error_code":400,"description":"Bad Request: invalid user_id specified"}`)
				return
			}
		}
		env, ok := responses[method]
		if !ok {
			env = `{"ok":true,"result":{}}`
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, env)
	}))
	t.Cleanup(srv.Close)
	return srv
}

const tgTestSecret = "test-session-secret-at-least-32-bytes-long"

// TestTelegramProvisioningStateMachine guards the managed-bot binding flow end
// to end against a fake Telegram API: provision → status pending → managed_bot
// webhook → status bot_created with the token sealed at rest; a webhook whose
// username never matched a pending row (edited username) leaves status pending.
func TestTelegramProvisioningStateMachine(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	tgSrv := fakeTG(t, map[string]string{
		"getMe":              `{"ok":true,"result":{"id":7,"is_bot":true,"username":"mt_manager_bot","can_manage_bots":true}}`,
		"getManagedBotToken": `{"ok":true,"result":"555:CHILD"}`,
	})

	webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tgSrv.URL)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "")
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	top.Handle("/", router)

	session := registerAndGetSession(t, top, host, claimToken)

	// provision → deep link + suggested username
	provRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/provision", host, session, nil)
	if provRec.Code != http.StatusOK {
		t.Fatalf("provision status = %d, body %q", provRec.Code, provRec.Body.String())
	}
	var prov struct {
		DeepLink  string `json:"deep_link"`
		Suggested string `json:"suggested_username"`
	}
	if err := json.Unmarshal(provRec.Body.Bytes(), &prov); err != nil {
		t.Fatalf("decode provision: %v", err)
	}
	if !strings.HasPrefix(prov.Suggested, "mt_") || !strings.HasSuffix(prov.Suggested, "_bot") {
		t.Fatalf("suggested username %q not mt_*_bot shaped", prov.Suggested)
	}
	if !strings.Contains(prov.DeepLink, "https://t.me/newbot/mt_manager_bot/"+prov.Suggested) {
		t.Fatalf("deep link %q missing manager/suggested path", prov.DeepLink)
	}

	if got := tgState(t, top, host, session); got != "pending" {
		t.Fatalf("status after provision = %q, want pending", got)
	}

	// managed_bot webhook with the matching suggested username → bot created
	managerSecret := deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")
	update := `{"update_id":1,"message":{"message_id":1,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":909,"username":"` + prov.Suggested + `"}}}}`
	whRec := postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret, update)
	if whRec.Code != http.StatusOK {
		t.Fatalf("manager webhook status = %d, body %q", whRec.Code, whRec.Body.String())
	}

	if got := tgState(t, top, host, session); got != "bot_created" {
		t.Fatalf("status after managed_bot = %q, want bot_created", got)
	}

	// token sealed at rest, decrypts to the fetched child token
	bot, err := store.BotByAccount(t.Context(), account.ID)
	if err != nil {
		t.Fatalf("BotByAccount: %v", err)
	}
	if bot.BotUsername != prov.Suggested || bot.Kind != "managed" {
		t.Fatalf("bot = %+v, want managed %q", bot, prov.Suggested)
	}
	if bytes.Contains(bot.TokenCT, []byte("555:CHILD")) {
		t.Fatal("stored ciphertext contains plaintext token")
	}
	opened, err := openTGToken(tgTestSecret, bot.TokenCT, bot.TokenNonce)
	if err != nil || opened != "555:CHILD" {
		t.Fatalf("openTGToken = (%q, %v), want 555:CHILD", opened, err)
	}

	// edited-username webhook (no pending match) on a second account leaves it pending
	account2, claim2 := setupInvite(t, store)
	host2 := account2.Subdomain + ".localhost"
	session2 := registerAndGetSession(t, top, host2, claim2)
	if provRec2 := doReq(t, top, http.MethodPost, "http://"+host2+"/api/telegram/provision", host2, session2, nil); provRec2.Code != http.StatusOK {
		t.Fatalf("provision 2 status = %d", provRec2.Code)
	}
	edited := `{"update_id":2,"message":{"message_id":2,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":42,"username":"mt_edited_by_user_bot"}}}}`
	if whRec2 := postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret, edited); whRec2.Code != http.StatusOK {
		t.Fatalf("edited-username webhook status = %d (must drop with 200)", whRec2.Code)
	}
	if got := tgState(t, top, host2, session2); got != "pending" {
		t.Fatalf("status after edited-username webhook = %q, want pending (unmatched drop)", got)
	}

	// wrong secret → 403
	if whRec3 := postWebhook(t, top, "/tg/manager/deadbeef", "deadbeef", update); whRec3.Code != http.StatusForbidden {
		t.Fatalf("wrong-secret webhook status = %d, want 403", whRec3.Code)
	}
}

// recordingTG is a fake api.telegram.org that records sendMessage payloads and
// rejects getMe for a sentinel bad token — enough to exercise the linking +
// BYO-validation contract of Task 4.
type recordingTG struct {
	srv *httptest.Server
	mu  *recordMu
	url string
}

type recordMu struct {
	sent []string
}

func newRecordingTG(t *testing.T) *recordingTG {
	t.Helper()
	rec := &recordingTG{mu: &recordMu{}}
	rec.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		method := parts[len(parts)-1]
		w.Header().Set("Content-Type", "application/json")
		switch method {
		case "getMe":
			if strings.Contains(parts[0], "BAD:TOKEN") {
				io.WriteString(w, `{"ok":false,"error_code":401,"description":"Unauthorized"}`)
				return
			}
			io.WriteString(w, `{"ok":true,"result":{"id":7,"is_bot":true,"username":"mt_manager_bot","can_manage_bots":true}}`)
		case "getManagedBotToken":
			io.WriteString(w, `{"ok":true,"result":"555:CHILD"}`)
		case "sendMessage":
			b, _ := io.ReadAll(r.Body)
			rec.mu.sent = append(rec.mu.sent, string(b))
			io.WriteString(w, `{"ok":true,"result":{}}`)
		default:
			io.WriteString(w, `{"ok":true,"result":{}}`)
		}
	}))
	t.Cleanup(rec.srv.Close)
	rec.url = rec.srv.URL
	return rec
}

// TestTelegramLinkingAndBYO guards Task 4: /start links the chat and emits the
// welcome message; a wrong child-webhook secret 403s; a BYO token that getMe
// rejects returns 400; DELETE cascades the bot row away.
func TestTelegramLinkingAndBYO(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	tg := newRecordingTG(t)
	webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "")
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	top.Handle("/", router)

	session := registerAndGetSession(t, top, host, claimToken)

	// provision + managed_bot webhook → a linked bot row exists (unlinked chat)
	provRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/provision", host, session, nil)
	if provRec.Code != http.StatusOK {
		t.Fatalf("provision status = %d", provRec.Code)
	}
	var prov struct {
		Suggested string `json:"suggested_username"`
	}
	json.Unmarshal(provRec.Body.Bytes(), &prov)
	managerSecret := deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")
	update := `{"update_id":1,"message":{"message_id":1,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":909,"username":"` + prov.Suggested + `"}}}}`
	if whRec := postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret, update); whRec.Code != http.StatusOK {
		t.Fatalf("manager webhook status = %d", whRec.Code)
	}

	bot, err := store.BotByAccount(t.Context(), account.ID)
	if err != nil {
		t.Fatalf("BotByAccount: %v", err)
	}
	childPath := "/tg/bot/" + account.ID + "/" + bot.WebhookSecret

	// wrong child secret → 403
	startBody := `{"update_id":2,"message":{"message_id":1,"text":"/start","chat":{"id":12345,"type":"private"}}}`
	if wrong := postWebhook(t, top, "/tg/bot/"+account.ID+"/deadbeef", "deadbeef", startBody); wrong.Code != http.StatusForbidden {
		t.Fatalf("wrong child secret status = %d, want 403", wrong.Code)
	}

	// /start with the right secret → chat linked + welcome sent
	if ok := postWebhook(t, top, childPath, bot.WebhookSecret, startBody); ok.Code != http.StatusOK {
		t.Fatalf("/start webhook status = %d, body %q", ok.Code, ok.Body.String())
	}
	if got := tgState(t, top, host, session); got != "linked" {
		t.Fatalf("status after /start = %q, want linked", got)
	}
	if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], welcomeMessage) || !strings.Contains(tg.mu.sent[0], "12345") {
		t.Fatalf("welcome not sent to chat 12345: %v", tg.mu.sent)
	}

	// BYO with a token getMe rejects → 400
	byoRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/byo", host, session, []byte(`{"token":"BAD:TOKEN"}`))
	if byoRec.Code != http.StatusBadRequest {
		t.Fatalf("BYO invalid token status = %d, want 400", byoRec.Code)
	}

	// test notification through the linked bot
	testRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/test", host, session, nil)
	if testRec.Code != http.StatusOK {
		t.Fatalf("test notification status = %d, body %q", testRec.Code, testRec.Body.String())
	}
	if len(tg.mu.sent) != 2 || !strings.Contains(tg.mu.sent[1], testMessage) {
		t.Fatalf("test message not sent: %v", tg.mu.sent)
	}

	// DELETE cascades the row away → status back to none
	if delRec := doReq(t, top, http.MethodDelete, "http://"+host+"/api/telegram", host, session, nil); delRec.Code != http.StatusOK {
		t.Fatalf("delete status = %d", delRec.Code)
	}
	if got := tgState(t, top, host, session); got != "none" {
		t.Fatalf("status after delete = %q, want none", got)
	}
}

func tgState(t *testing.T, h http.Handler, host string, session *http.Cookie) string {
	t.Helper()
	rec := doReq(t, h, http.MethodGet, "http://"+host+"/api/telegram/status", host, session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status endpoint = %d, body %q", rec.Code, rec.Body.String())
	}
	var s struct {
		State string `json:"state"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return s.State
}

func doReq(t *testing.T, h http.Handler, method, target, host string, session *http.Cookie, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, target, bytes.NewReader(body))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.Host = host
	if session != nil {
		r.AddCookie(session)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func postWebhook(t *testing.T, h http.Handler, path, secretHeader, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "http://localhost"+path, strings.NewReader(body))
	r.Host = "localhost"
	r.Header.Set("X-Telegram-Bot-Api-Secret-Token", secretHeader)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}
