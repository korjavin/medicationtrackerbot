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
		"getManagedBotToken": `{"ok":true,"result":{"token":"555:CHILD"}}`,
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
	update := `{"update_id":1,"managed_bot":{"bot_id":909,"bot_username":"` + prov.Suggested + `"}}`
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
	edited := `{"update_id":2,"managed_bot":{"bot_id":42,"bot_username":"mt_edited_by_user_bot"}}`
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
