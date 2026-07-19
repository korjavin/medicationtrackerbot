package cloudserver

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/tgclient"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
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
				w.WriteHeader(http.StatusBadRequest)
				io.WriteString(w, `{"ok":false,"error_code":400,"description":"Bad Request: invalid user_id specified"}`)
				return
			}
		}
		env, ok := responses[method]
		if !ok {
			env = `{"ok":true,"result":{}}`
		}
		w.Header().Set("Content-Type", "application/json")
		// The real API pairs an ok:false envelope with a matching HTTP status,
		// and tgclient.IsClientError classifies on that status — so a fake that
		// always answered 200 could never exercise the permanent-vs-transient
		// split. Mirror error_code onto the status line.
		var probe struct {
			OK        bool `json:"ok"`
			ErrorCode int  `json:"error_code"`
		}
		_ = json.Unmarshal([]byte(env), &probe)
		if !probe.OK && probe.ErrorCode != 0 {
			w.WriteHeader(probe.ErrorCode)
		}
		io.WriteString(w, env)
	}))
	t.Cleanup(srv.Close)
	return srv
}

const tgTestSecret = "test-session-secret-at-least-32-bytes-long"

// countingGetMe serves getMe: the first failUntil calls answer 502 (the startup
// race where the local Bot API proxy hasn't bound its port yet), then success.
// Returns the server and a pointer to the live hit counter.
func countingGetMe(t *testing.T, failUntil int64) (*httptest.Server, *int64) {
	t.Helper()
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt64(&hits, 1)
		if strings.HasSuffix(r.URL.Path, "/getMe") && n <= failUntil {
			w.WriteHeader(http.StatusBadGateway)
			io.WriteString(w, `{"ok":false,"error_code":502,"description":"Bad Gateway"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"result":{"id":7,"is_bot":true,"username":"mt_manager_bot"}}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// TestBootstrapGetMeRetry proves the getMe retry rides out a proxy that isn't up
// yet (bd med-eas.42): failing twice then succeeding still resolves the username,
// while a URL that never answers gives up after the budget instead of hanging.
func TestBootstrapGetMeRetry(t *testing.T) {
	t.Run("succeeds after transient failures", func(t *testing.T) {
		srv, hits := countingGetMe(t, 2)
		tgAPI := NewTelegramAPI(nil, tgTestSecret, "MANAGER:TOKEN", "localhost", srv.URL, "", time.Hour)
		me, err := tgAPI.getMeWithRetry(t.Context(), time.Second, 5*time.Millisecond)
		if err != nil {
			t.Fatalf("getMeWithRetry after transient failures: %v", err)
		}
		if me.Username != "mt_manager_bot" {
			t.Fatalf("username = %q, want mt_manager_bot", me.Username)
		}
		if got := atomic.LoadInt64(hits); got != 3 {
			t.Fatalf("getMe hits = %d, want 3 (2 failures + 1 success)", got)
		}
	})

	t.Run("gives up after budget", func(t *testing.T) {
		srv, hits := countingGetMe(t, 1<<30) // never succeeds
		tgAPI := NewTelegramAPI(nil, tgTestSecret, "MANAGER:TOKEN", "localhost", srv.URL, "", time.Hour)
		me, err := tgAPI.getMeWithRetry(t.Context(), 30*time.Millisecond, 5*time.Millisecond)
		if err == nil {
			t.Fatalf("getMeWithRetry over budget: want error, got username %q", me.Username)
		}
		if atomic.LoadInt64(hits) < 2 {
			t.Fatalf("getMe hits = %d, want at least 2 (retried before giving up)", atomic.LoadInt64(hits))
		}
	})

	t.Run("context cancellation stops retrying", func(t *testing.T) {
		srv, _ := countingGetMe(t, 1<<30) // never succeeds
		tgAPI := NewTelegramAPI(nil, tgTestSecret, "MANAGER:TOKEN", "localhost", srv.URL, "", time.Hour)
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if _, err := tgAPI.getMeWithRetry(ctx, time.Hour, time.Minute); err == nil {
			t.Fatal("getMeWithRetry with cancelled context: want error, got nil")
		}
	})
}

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
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tgSrv.URL, "", 14*24*time.Hour)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
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
	provRec2 := doReq(t, top, http.MethodPost, "http://"+host2+"/api/telegram/provision", host2, session2, nil)
	if provRec2.Code != http.StatusOK {
		t.Fatalf("provision 2 status = %d", provRec2.Code)
	}
	var prov2 struct {
		Suggested string `json:"suggested_username"`
	}
	if err := json.Unmarshal(provRec2.Body.Bytes(), &prov2); err != nil {
		t.Fatalf("decode provision 2: %v", err)
	}
	edited := `{"update_id":2,"message":{"message_id":2,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":42,"username":"mt_edited_by_user_bot"}}}}`
	if whRec2 := postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret, edited); whRec2.Code != http.StatusOK {
		t.Fatalf("edited-username webhook status = %d (must drop with 200)", whRec2.Code)
	}
	if got := tgState(t, top, host2, session2); got != "pending" {
		t.Fatalf("status after edited-username webhook = %q, want pending (unmatched drop)", got)
	}

	// reset clears the stuck pending row → status back to none, no TTL wait
	if resetRec := doReq(t, top, http.MethodPost, "http://"+host2+"/api/telegram/reset", host2, session2, nil); resetRec.Code != http.StatusOK {
		t.Fatalf("reset status = %d, body %q", resetRec.Code, resetRec.Body.String())
	}
	if got := tgState(t, top, host2, session2); got != "none" {
		t.Fatalf("status after reset = %q, want none", got)
	}
	// reset must not touch account 1's bound bot
	if got := tgState(t, top, host, session); got != "bot_created" {
		t.Fatalf("status of account 1 after account 2 reset = %q, want bot_created", got)
	}

	// A managed_bot webhook that arrives after reset deleted the pending row
	// (the "start over" race) must NOT bind a bot — the atomic pending gate in
	// UpsertManagedBotIfPending drops it with 200 and status stays none.
	rc := postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret,
		`{"update_id":3,"message":{"message_id":3,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":911,"username":"`+prov2.Suggested+`"}}}}`)
	if rc.Code != http.StatusOK {
		t.Fatalf("post-reset webhook status = %d, want 200 drop", rc.Code)
	}
	if got := tgState(t, top, host2, session2); got != "none" {
		t.Fatalf("status after post-reset webhook = %q, want none (no bind after reset)", got)
	}

	// wrong secret → 403
	if whRec3 := postWebhook(t, top, "/tg/manager/deadbeef", "deadbeef", update); whRec3.Code != http.StatusForbidden {
		t.Fatalf("wrong-secret webhook status = %d, want 403", whRec3.Code)
	}
}

// fakePhotoBytes is what the fake file endpoint streams for a getFile download,
// standing in for JPEG bytes the relay proxy forwards without inspecting.
const fakePhotoBytes = "\xff\xd8\xffFAKEJPEG"

// recordingTG is a fake api.telegram.org that records sendMessage payloads and
// rejects getMe for a sentinel bad token — enough to exercise the linking +
// BYO-validation contract of Task 4.
type recordingTG struct {
	srv *httptest.Server
	mu  *recordMu
	url string
}

type recordMu struct {
	sync.Mutex
	sent     []string
	answered []string
	commands []string
	edits    []string
	// fileBody overrides what the /file download endpoint streams; nil serves
	// fakePhotoBytes. The NXK document test points this at real .nxk bytes.
	fileBody []byte
	// getFileTooBig makes getFile return Telegram's ">20 MB" rejection, standing
	// in for a large Mi Band backup the public Bot API refuses to resolve.
	getFileTooBig bool
}

func newRecordingTG(t *testing.T) *recordingTG {
	t.Helper()
	rec := &recordingTG{mu: &recordMu{}}
	rec.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		// The file-download endpoint (/file/bot<token>/<path>) streams raw bytes,
		// not the {ok,result} envelope — handle it before the JSON content type.
		if len(parts) > 0 && parts[0] == "file" {
			rec.mu.Lock()
			body := rec.mu.fileBody
			rec.mu.Unlock()
			if body != nil {
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Write(body)
				return
			}
			w.Header().Set("Content-Type", "image/jpeg")
			io.WriteString(w, fakePhotoBytes)
			return
		}
		method := parts[len(parts)-1]
		w.Header().Set("Content-Type", "application/json")
		switch method {
		case "getFile":
			rec.mu.Lock()
			tooBig := rec.mu.getFileTooBig
			rec.mu.Unlock()
			if tooBig {
				io.WriteString(w, `{"ok":false,"error_code":400,"description":"Bad Request: file is too big"}`)
				return
			}
			io.WriteString(w, `{"ok":true,"result":{"file_id":"AgACPHOTO","file_path":"photos/food_0.jpg","file_size":`+strconv.Itoa(len(fakePhotoBytes))+`}}`)
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
			rec.mu.Lock()
			rec.mu.sent = append(rec.mu.sent, string(b))
			n := len(rec.mu.sent)
			rec.mu.Unlock()
			// Real Telegram returns the sent Message; the seal path reads its
			// message_id so a client can later edit that exact message.
			fmt.Fprintf(w, `{"ok":true,"result":{"message_id":%d}}`, 1000+n)
		case "editMessageText":
			b, _ := io.ReadAll(r.Body)
			rec.mu.Lock()
			rec.mu.edits = append(rec.mu.edits, string(b))
			rec.mu.Unlock()
			io.WriteString(w, `{"ok":true,"result":{}}`)
		case "setMyCommands":
			b, _ := io.ReadAll(r.Body)
			rec.mu.Lock()
			rec.mu.commands = append(rec.mu.commands, string(b))
			rec.mu.Unlock()
			io.WriteString(w, `{"ok":true,"result":true}`)
		case "answerCallbackQuery":
			b, _ := io.ReadAll(r.Body)
			rec.mu.Lock()
			rec.mu.answered = append(rec.mu.answered, string(b))
			rec.mu.Unlock()
			io.WriteString(w, `{"ok":true,"result":true}`)
		default:
			io.WriteString(w, `{"ok":true,"result":{}}`)
		}
	}))
	t.Cleanup(rec.srv.Close)
	rec.url = rec.srv.URL
	return rec
}

// med-jjd: Telegram never re-sends managed_bot_created on demand, so a dropped
// event strands the account unbound with no recovery path. A 429 on
// getManagedBotToken is transient — the handler must answer non-2xx so Telegram
// redelivers, NOT 200 (which reads as "handled, stop retrying"). The pending row
// is a plain lookup, not consumed here, so the redelivery still binds inside its
// TTL. A permanent 4xx (bot deleted) must still drop with 200.
func TestManagerWebhookRateLimitIsRedeliveredNotDropped(t *testing.T) {
	for _, tc := range []struct {
		name     string
		envelope string
		wantCode int
	}{
		{
			name:     "429 rate limit is transient, ask Telegram to redeliver",
			envelope: `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 30","parameters":{"retry_after":30}}`,
			wantCode: http.StatusInternalServerError,
		},
		{
			name:     "403 deactivated bot is permanent, drop it",
			envelope: `{"ok":false,"error_code":403,"description":"Forbidden: user is deactivated"}`,
			wantCode: http.StatusOK,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := setupStore(t)
			account, claimToken := setupInvite(t, store)
			host := account.Subdomain + ".localhost"

			tgSrv := fakeTG(t, map[string]string{
				"getMe":              `{"ok":true,"result":{"id":7,"is_bot":true,"username":"mt_manager_bot","can_manage_bots":true}}`,
				"getManagedBotToken": tc.envelope,
			})

			webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
			tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tgSrv.URL, "", 14*24*time.Hour)
			if err := tgAPI.Bootstrap(t.Context()); err != nil {
				t.Fatalf("Bootstrap: %v", err)
			}
			apiMux := http.NewServeMux()
			webauthnAPI.RegisterRoutes(apiMux)
			tgAPI.RegisterAPIRoutes(apiMux)
			router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
			top := http.NewServeMux()
			tgAPI.RegisterWebhookRoutes(top)
			top.Handle("/", router)

			session := registerAndGetSession(t, top, host, claimToken)
			provRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/provision", host, session, nil)
			if provRec.Code != http.StatusOK {
				t.Fatalf("provision status = %d", provRec.Code)
			}
			var prov struct {
				Suggested string `json:"suggested_username"`
			}
			if err := json.Unmarshal(provRec.Body.Bytes(), &prov); err != nil {
				t.Fatalf("decode provision: %v", err)
			}

			managerSecret := deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")
			update := `{"update_id":1,"message":{"message_id":1,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":909,"username":"` + prov.Suggested + `"}}}}`
			rec := postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret, update)
			if rec.Code != tc.wantCode {
				t.Fatalf("manager webhook status = %d, want %d", rec.Code, tc.wantCode)
			}

			// Either way no bot was bound, and the pending row must survive so a
			// redelivery (429) or a fresh create (403) can still bind.
			if _, err := store.BotByAccount(t.Context(), account.ID); err == nil {
				t.Fatal("a bot was bound despite the token fetch failing")
			}
			if _, err := store.PendingAccountByUsername(t.Context(), prov.Suggested, time.Now()); err != nil {
				t.Fatalf("pending row gone, redelivery can never bind: %v", err)
			}
		})
	}
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
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", 14*24*time.Hour)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
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

	// BYO from the pending page clears the leftover pending row — a later
	// unlink must land on none, not resurrect the stale pending state.
	if provRec2 := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/provision", host, session, nil); provRec2.Code != http.StatusOK {
		t.Fatalf("re-provision status = %d", provRec2.Code)
	}
	if got := tgState(t, top, host, session); got != "pending" {
		t.Fatalf("status after re-provision = %q, want pending", got)
	}
	if byoOK := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/byo", host, session, []byte(`{"token":"777:GOODTOKEN"}`)); byoOK.Code != http.StatusOK {
		t.Fatalf("BYO from pending status = %d, body %q", byoOK.Code, byoOK.Body.String())
	}
	if got := tgState(t, top, host, session); got != "bot_created" {
		t.Fatalf("status after BYO = %q, want bot_created", got)
	}
	if delRec2 := doReq(t, top, http.MethodDelete, "http://"+host+"/api/telegram", host, session, nil); delRec2.Code != http.StatusOK {
		t.Fatalf("delete after BYO status = %d", delRec2.Code)
	}
	if got := tgState(t, top, host, session); got != "none" {
		t.Fatalf("status after unlink of BYO bot = %q, want none (stale pending row resurrected)", got)
	}
}

// TestTelegramBYOWebhookFailureLeavesNoBot guards that a SetWebhook failure on
// the BYO path never commits a bot_created row whose webhook was never set: the
// bot row is the commit point (set webhook first). Because the pending row is
// deleted up front, a failed bind cleanly falls back to none so the user can
// retry — never a phantom bot_created that /start can't reach.
func TestTelegramBYOWebhookFailureLeavesNoBot(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	// getMe validates the token; setWebhook is scripted to fail.
	tgSrv := fakeTG(t, map[string]string{
		"getMe":      `{"ok":true,"result":{"id":7,"is_bot":true,"username":"byo_bot","can_manage_bots":false}}`,
		"setWebhook": `{"ok":false,"error_code":400,"description":"Bad Request: bad webhook"}`,
	})

	webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
	// No Bootstrap: it would call the (scripted-to-fail) manager setWebhook. BYO
	// doesn't need the resolved manager username.
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tgSrv.URL, "", 14*24*time.Hour)
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	top.Handle("/", router)

	session := registerAndGetSession(t, top, host, claimToken)

	// provision → pending, then BYO from the pending page with setWebhook failing
	if provRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/provision", host, session, nil); provRec.Code != http.StatusOK {
		t.Fatalf("provision status = %d", provRec.Code)
	}
	if got := tgState(t, top, host, session); got != "pending" {
		t.Fatalf("status after provision = %q, want pending", got)
	}

	byoRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/byo", host, session, []byte(`{"token":"888:BYOTOKEN"}`))
	if byoRec.Code != http.StatusInternalServerError {
		t.Fatalf("BYO with failing setWebhook status = %d, want 500", byoRec.Code)
	}
	// No bot row written (bot row is the commit point) and pending deleted → none.
	if _, err := store.BotByAccount(t.Context(), account.ID); err == nil {
		t.Fatal("bot row written despite setWebhook failure; want no row")
	}
	if got := tgState(t, top, host, session); got != "none" {
		t.Fatalf("status after failed BYO = %q, want none (no phantom bot_created)", got)
	}
}

// managerFixture wires just the manager webhook against a recording Telegram —
// the onboarding conversation needs no session, no subdomain routing, and no
// Bootstrap (it never builds a deep link).
func managerFixture(t *testing.T) (*cloudstore.Repo, *recordingTG, http.Handler, string) {
	t.Helper()
	store := setupStore(t)
	tg := newRecordingTG(t)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", 14*24*time.Hour)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	return store, tg, top, deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")
}

// tgMessage posts a private-chat message from user 4242 to the manager webhook.
func tgMessage(t *testing.T, h http.Handler, secret, text string) *httptest.ResponseRecorder {
	t.Helper()
	body := `{"update_id":9,"message":{"message_id":1,"text":"` + text +
		`","from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"private"}}}`
	rec := postWebhook(t, h, "/tg/manager/"+secret, secret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("manager message %q status = %d, want 200", text, rec.Code)
	}
	return rec
}

// mintedBy counts accounts attributed to creator, ever.
func mintedBy(t *testing.T, store *cloudstore.Repo, creator string) int {
	t.Helper()
	n, err := store.CountAccountsCreatedBy(t.Context(), creator, time.Unix(0, 0))
	if err != nil {
		t.Fatalf("CountAccountsCreatedBy: %v", err)
	}
	return n
}

const tgCreator = "tg:4242"

// TestManagerOnboarding guards the managebot's private-chat conversation:
// /start explains without minting, "yes" mints an invite attributed to
// "tg:<uid>" and replies with its claim link, a 4th "yes" inside the window is
// refused, an already-claimed user is told to unlock instead, and non-private /
// bot-authored messages are ignored entirely.
func TestManagerOnboarding(t *testing.T) {
	t.Run("start explains and offers, mints nothing", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		tgMessage(t, top, secret, "/start")
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "personal health-tracking bot") {
			t.Fatalf("no offer reply sent: %v", tg.mu.sent)
		}
		if n := mintedBy(t, store, tgCreator); n != 0 {
			t.Fatalf("/start minted %d accounts, want 0", n)
		}
	})

	t.Run("unrecognized text stays silent", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		tgMessage(t, top, secret, "what is this")
		if len(tg.mu.sent) != 0 {
			t.Fatalf("stray chatter should get no reply, sent: %v", tg.mu.sent)
		}
		if n := mintedBy(t, store, tgCreator); n != 0 {
			t.Fatalf("nudge minted %d accounts, want 0", n)
		}
	})

	t.Run("yes mints one invite and replies with its claim link", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		tgMessage(t, top, secret, "yes")
		if n := mintedBy(t, store, tgCreator); n != 1 {
			t.Fatalf("minted %d accounts, want exactly 1 attributed to %s", n, tgCreator)
		}
		accounts, err := store.ListAccounts(t.Context())
		if err != nil || len(accounts) != 1 {
			t.Fatalf("ListAccounts = (%d, %v), want 1", len(accounts), err)
		}
		want := "https://" + accounts[0].Subdomain + ".localhost/#claim="
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], want) {
			t.Fatalf("reply missing claim URL %q: %v", want, tg.mu.sent)
		}
	})

	t.Run("fourth yes while three invites are live is refused", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		now := time.Now().UTC()
		for i := 0; i < managerInviteQuota; i++ {
			if _, err := Provision(t.Context(), store, 14*24*time.Hour, now, tgCreator); err != nil {
				t.Fatalf("seed mint %d: %v", i, err)
			}
		}
		tgMessage(t, top, secret, "yes")
		if n := mintedBy(t, store, tgCreator); n != managerInviteQuota {
			t.Fatalf("minted %d accounts, want the quota %d (no new mint)", n, managerInviteQuota)
		}
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "limit per person") {
			t.Fatalf("reply is not the wait message: %v", tg.mu.sent)
		}
	})

	// The cap counts live invites over the whole claim TTL, not a rolling day.
	// Yesterday's unclaimed invites are still claimable, so they must still
	// occupy the quota — otherwise a user could stack quota × TTL/day claim
	// links by saying "yes" three times a day until the first batch expires.
	t.Run("day-old unclaimed invites still occupy the quota", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		yesterday := time.Now().UTC().Add(-25 * time.Hour)
		for i := 0; i < managerInviteQuota; i++ {
			if _, err := Provision(t.Context(), store, 14*24*time.Hour, yesterday, tgCreator); err != nil {
				t.Fatalf("seed mint %d: %v", i, err)
			}
		}
		tgMessage(t, top, secret, "yes")
		if n := mintedBy(t, store, tgCreator); n != managerInviteQuota {
			t.Fatalf("minted %d accounts, want the quota %d (yesterday's live invites freed a slot)", n, managerInviteQuota)
		}
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "limit per person") {
			t.Fatalf("reply is not the wait message: %v", tg.mu.sent)
		}
	})

	// Liveness comes from the row's own claim_expires_unix, not from a window
	// derived from the *current* CLOUD_CLAIM_TTL: shortening the TTL after a
	// batch was minted must not hand back quota while those links still work.
	t.Run("shortening the claim TTL does not free live invites", func(t *testing.T) {
		store := setupStore(t)
		tg := newRecordingTG(t)
		tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", time.Hour)
		top := http.NewServeMux()
		tgAPI.RegisterWebhookRoutes(top)
		secret := deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")

		old := time.Now().UTC().Add(-25 * time.Hour) // older than the new 1h TTL...
		for i := 0; i < managerInviteQuota; i++ {
			// ...but minted under the old 14d TTL, so still claimable.
			if _, err := Provision(t.Context(), store, 14*24*time.Hour, old, tgCreator); err != nil {
				t.Fatalf("seed mint %d: %v", i, err)
			}
		}
		tgMessage(t, top, secret, "yes")
		if n := mintedBy(t, store, tgCreator); n != managerInviteQuota {
			t.Fatalf("minted %d accounts, want the quota %d (TTL change freed live slots)", n, managerInviteQuota)
		}
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "limit per person") {
			t.Fatalf("reply is not the wait message: %v", tg.mu.sent)
		}
	})

	// ...but once they expire the sweep frees the quota, so "I lost my link"
	// still recovers — just not before the old link is dead.
	t.Run("expired unclaimed invites free the quota", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		old := time.Now().UTC().Add(-15 * 24 * time.Hour)
		for i := 0; i < managerInviteQuota; i++ {
			if _, err := Provision(t.Context(), store, 14*24*time.Hour, old, tgCreator); err != nil {
				t.Fatalf("seed mint %d: %v", i, err)
			}
		}
		tgMessage(t, top, secret, "yes")
		if n := mintedBy(t, store, tgCreator); n != 1 {
			t.Fatalf("minted %d accounts, want 1 (expired invites swept, one fresh mint)", n)
		}
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "#claim=") {
			t.Fatalf("reply missing a fresh claim URL: %v", tg.mu.sent)
		}
	})

	// Concurrent "yes" deliveries (Telegram retries, or a user tapping twice)
	// must not all read a sub-quota count and all provision. mintMu serializes
	// the count-then-insert; this races 8 of them for the one free slot.
	t.Run("concurrent yes cannot exceed the quota", func(t *testing.T) {
		store, _, top, secret := managerFixture(t)
		now := time.Now().UTC()
		for i := 0; i < managerInviteQuota-1; i++ {
			if _, err := Provision(t.Context(), store, 14*24*time.Hour, now, tgCreator); err != nil {
				t.Fatalf("seed mint %d: %v", i, err)
			}
		}

		const racers = 8
		body := `{"update_id":9,"message":{"message_id":1,"text":"yes",` +
			`"from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"private"}}}`
		var wg sync.WaitGroup
		codes := make([]int, racers)
		for i := 0; i < racers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				codes[i] = postWebhook(t, top, "/tg/manager/"+secret, secret, body).Code
			}()
		}
		wg.Wait()

		for i, code := range codes {
			if code != http.StatusOK {
				t.Fatalf("racer %d status = %d, want 200", i, code)
			}
		}
		if n := mintedBy(t, store, tgCreator); n != managerInviteQuota {
			t.Errorf("minted %d accounts, want the quota %d (concurrent mints overran the cap)", n, managerInviteQuota)
		}
	})

	t.Run("already-claimed user is never handed a second account", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		now := time.Now().UTC()
		inv, err := Provision(t.Context(), store, 14*24*time.Hour, now, tgCreator)
		if err != nil {
			t.Fatalf("Provision: %v", err)
		}
		raw, err := hex.DecodeString(inv.Token)
		if err != nil {
			t.Fatalf("decode claim token: %v", err)
		}
		sum := sha256.Sum256(raw)
		if _, err := store.ConsumeClaimToken(t.Context(), inv.Account.Subdomain, sum[:], now); err != nil {
			t.Fatalf("ConsumeClaimToken: %v", err)
		}

		tgMessage(t, top, secret, "yes")
		if n := mintedBy(t, store, tgCreator); n != 1 {
			t.Fatalf("minted %d accounts, want 1 (the claimed one)", n)
		}
		if len(tg.mu.sent) != 1 || !strings.Contains(tg.mu.sent[0], "passkey") {
			t.Fatalf("reply does not tell the user to unlock with a passkey: %v", tg.mu.sent)
		}
	})

	t.Run("group chats and bot senders are ignored", func(t *testing.T) {
		store, tg, top, secret := managerFixture(t)
		group := `{"update_id":9,"message":{"message_id":1,"text":"yes","from":{"id":4242,"is_bot":false},"chat":{"id":77,"type":"group"}}}`
		fromBot := `{"update_id":9,"message":{"message_id":1,"text":"yes","from":{"id":4242,"is_bot":true},"chat":{"id":77,"type":"private"}}}`
		noFrom := `{"update_id":9,"message":{"message_id":1,"text":"yes","chat":{"id":77,"type":"private"}}}`
		for _, body := range []string{group, fromBot, noFrom} {
			if rec := postWebhook(t, top, "/tg/manager/"+secret, secret, body); rec.Code != http.StatusOK {
				t.Fatalf("ignored update status = %d, want 200", rec.Code)
			}
		}
		if len(tg.mu.sent) != 0 {
			t.Fatalf("replied to a non-private or bot message: %v", tg.mu.sent)
		}
		if n := mintedBy(t, store, tgCreator); n != 0 {
			t.Fatalf("minted %d accounts from ignored updates, want 0", n)
		}
	})
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

// TestChildWebhookRace guards against the race condition where Telegram delivers
// a deep-link auto-/start to the child webhook immediately after SetWebhook but
// before the UpsertBot transaction fully commits. It verifies that ChildWebhook
// waits for the row to appear rather than immediately returning a 403 Forbidden.
func TestChildWebhookRace(t *testing.T) {
	store := setupStore(t)
	tgSrv := fakeTG(t, map[string]string{
		"getMe":       `{"ok":true,"result":{"id":99,"is_bot":true,"username":"manager_bot","can_manage_bots":true}}`,
		"sendMessage": `{"ok":true,"result":{}}`,
	})

	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tgSrv.URL, "", 14*24*time.Hour)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)

	accountID := "acc-123"
	botSecret := "secret123"

	ct, nonce, _ := sealTGToken(tgTestSecret, "123:VALIDTOKEN")

	// Run the webhook in a goroutine so it blocks waiting for the bot row
	done := make(chan bool)
	go func() {
		update := `{"update_id":1,"message":{"message_id":1,"text":"/start","chat":{"id":123,"type":"private"}}}`
		req := httptest.NewRequest(http.MethodPost, "/tg/bot/"+accountID+"/"+botSecret, bytes.NewBufferString(update))
		req.Header.Set("X-Telegram-Bot-Api-Secret-Token", botSecret)
		rec := httptest.NewRecorder()
		top.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("ChildWebhook returned %d, want 200 OK", rec.Code)
		}
		done <- true
	}()

	// Simulate the manager webhook's transaction committing shortly after the child webhook arrives
	time.Sleep(150 * time.Millisecond)

	err := store.UpsertBot(context.Background(), cloudstore.TGBot{
		AccountID:     accountID,
		BotID:         123,
		BotUsername:   "test_bot",
		TokenCT:       ct,
		TokenNonce:    nonce,
		Kind:          "managed",
		WebhookSecret: botSecret,
		CreatedAt:     time.Now(),
	})
	if err != nil {
		t.Fatalf("UpsertBot failed: %v", err)
	}

	// Wait for the webhook to finish processing
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ChildWebhook timed out waiting for bot row")
	}
}

// --- med-76c.2 part 2: inbound Confirm/Snooze taps -------------------------

type tapFixture struct {
	store     *cloudstore.Repo
	accountID string
	top       *http.ServeMux
	childPath string
	secret    string
}

// linkedBotTap builds an account whose bot is provisioned and whose chat (12345)
// is linked — the state a Confirm/Snooze tap arrives in.
func linkedBotTap(t *testing.T, tg *recordingTG) tapFixture {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", 14*24*time.Hour)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	top.Handle("/", router)

	session := registerAndGetSession(t, top, host, claimToken)
	provRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/provision", host, session, nil)
	if provRec.Code != http.StatusOK {
		t.Fatalf("provision status = %d", provRec.Code)
	}
	var prov struct {
		Suggested string `json:"suggested_username"`
	}
	if err := json.Unmarshal(provRec.Body.Bytes(), &prov); err != nil {
		t.Fatalf("decode provision: %v", err)
	}
	managerSecret := deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")
	update := `{"update_id":1,"message":{"message_id":1,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":909,"username":"` + prov.Suggested + `"}}}}`
	if rec := postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret, update); rec.Code != http.StatusOK {
		t.Fatalf("manager webhook status = %d", rec.Code)
	}
	bot, err := store.BotByAccount(t.Context(), account.ID)
	if err != nil {
		t.Fatalf("BotByAccount: %v", err)
	}
	childPath := "/tg/bot/" + account.ID + "/" + bot.WebhookSecret
	start := `{"update_id":2,"message":{"message_id":1,"text":"/start","chat":{"id":12345,"type":"private"}}}`
	if rec := postWebhook(t, top, childPath, bot.WebhookSecret, start); rec.Code != http.StatusOK {
		t.Fatalf("/start webhook status = %d", rec.Code)
	}

	// Forget the welcome message so tests assert only on what the tap produced.
	tg.mu.Lock()
	tg.mu.sent = nil
	tg.mu.answered = nil
	tg.mu.Unlock()

	return tapFixture{store: store, accountID: account.ID, top: top, childPath: childPath, secret: bot.WebhookSecret}
}

func callbackUpdate(data string, chatID int64) string {
	return `{"update_id":3,"callback_query":{"id":"cbq-1","data":"` + data +
		`","from":{"id":6918132008},"message":{"message_id":9,"chat":{"id":` +
		strconv.FormatInt(chatID, 10) + `,"type":"private"}}}}`
}

// publishInboxKey gives the account a real X25519 inbox key and returns the raw
// private half so the test can open whatever the webhook sealed.
func publishInboxKey(t *testing.T, store *cloudstore.Repo, accountID string) []byte {
	t.Helper()
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate inbox key: %v", err)
	}
	if err := store.SetAccountInboxPublicKey(t.Context(), accountID, priv.PublicKey().Bytes()); err != nil {
		t.Fatalf("SetAccountInboxPublicKey: %v", err)
	}
	return priv.Bytes()
}

func inboxCount(t *testing.T, store *cloudstore.Repo, accountID string) int {
	t.Helper()
	events, err := store.ListInboxEvents(t.Context(), accountID, 100)
	if err != nil {
		t.Fatalf("ListInboxEvents: %v", err)
	}
	return len(events)
}

// The happy path: a Confirm tap is sealed to the account's inbox key, queued,
// and the button is answered. The server applies nothing and stores no plaintext.
func TestChildWebhook_CallbackQuerySealsEventToMailbox(t *testing.T) {
	tg := newRecordingTG(t)
	f := linkedBotTap(t, tg)
	privRaw := publishInboxKey(t, f.store, f.accountID)

	before := time.Now().UTC().Unix()
	rec := postWebhook(t, f.top, f.childPath, f.secret, callbackUpdate("s:1767225600:confirm", 12345))
	if rec.Code != http.StatusOK {
		t.Fatalf("callback webhook status = %d, body %q", rec.Code, rec.Body.String())
	}

	events, err := f.store.ListInboxEvents(t.Context(), f.accountID, 10)
	if err != nil {
		t.Fatalf("ListInboxEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("queued %d events, want 1", len(events))
	}
	// Nothing readable is stored: the row must not contain the action in clear.
	if bytes.Contains(events[0].CT, []byte("confirm")) || bytes.Contains(events[0].CT, []byte("intake_slot_action")) {
		t.Fatal("mailbox row contains plaintext")
	}

	opened, err := openInbox(privRaw, f.accountID, events[0].CT)
	if err != nil {
		t.Fatalf("openInbox: %v", err)
	}
	var got intakeSlotEvent
	if err := json.Unmarshal(opened, &got); err != nil {
		t.Fatalf("unmarshal sealed event: %v", err)
	}
	if got.Kind != inboxEventKindIntakeSlot || got.SlotUnix != 1767225600 || got.Action != tgclient.CallbackActionConfirm {
		t.Fatalf("sealed event = %+v", got)
	}
	// The callback's message_id is plumbed through so the drain can edit that
	// message to a receipt and drop its buttons (bug 1). callbackUpdate sends 9.
	if got.MessageID != 9 {
		t.Errorf("message_id = %d, want 9 (plumbed from cq.Message.MessageID)", got.MessageID)
	}
	// The SERVER stamps the tap instant — that is what backdates the intake.
	if got.AtUnix < before || got.AtUnix > time.Now().UTC().Unix()+2 {
		t.Errorf("at_unix = %d, want a server timestamp near now (%d)", got.AtUnix, before)
	}

	tg.mu.Lock()
	defer tg.mu.Unlock()
	if len(tg.mu.answered) != 1 || !strings.Contains(tg.mu.answered[0], "cbq-1") {
		t.Fatalf("button not answered: %v", tg.mu.answered)
	}
}

// Telegram omits the Message object on a callback_query for a message too old to
// edit. The handler must not nil-panic on cq.Message and must seal the event with
// message_id 0 — the confirm still records; the drain-time edit is a safe no-op.
func TestChildWebhook_CallbackQueryWithoutMessage(t *testing.T) {
	tg := newRecordingTG(t)
	f := linkedBotTap(t, tg)
	privRaw := publishInboxKey(t, f.store, f.accountID)

	// callback_query with NO "message" field (cq.Message == nil).
	update := `{"update_id":3,"callback_query":{"id":"cbq-nomsg","data":"s:1767225600:confirm","from":{"id":6918132008}}}`
	rec := postWebhook(t, f.top, f.childPath, f.secret, update)
	if rec.Code != http.StatusOK {
		t.Fatalf("callback webhook status = %d, body %q", rec.Code, rec.Body.String())
	}

	events, err := f.store.ListInboxEvents(t.Context(), f.accountID, 10)
	if err != nil {
		t.Fatalf("ListInboxEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("queued %d events, want 1", len(events))
	}
	opened, err := openInbox(privRaw, f.accountID, events[0].CT)
	if err != nil {
		t.Fatalf("openInbox: %v", err)
	}
	var got intakeSlotEvent
	if err := json.Unmarshal(opened, &got); err != nil {
		t.Fatalf("unmarshal sealed event: %v", err)
	}
	if got.MessageID != 0 {
		t.Errorf("message_id = %d, want 0 (cq.Message absent)", got.MessageID)
	}
	if got.SlotUnix != 1767225600 || got.Action != tgclient.CallbackActionConfirm {
		t.Errorf("sealed event = %+v", got)
	}
}

// The zero-knowledge invariant. An account that never unlocked a client has no
// inbox key, so there is nothing to seal to. The tap is DROPPED — never written
// readable — and the user is told to open the app.
func TestChildWebhook_CallbackQueryWithoutInboxKeyDropsRatherThanStorePlaintext(t *testing.T) {
	tg := newRecordingTG(t)
	f := linkedBotTap(t, tg) // no publishInboxKey

	rec := postWebhook(t, f.top, f.childPath, f.secret, callbackUpdate("s:1767225600:confirm", 12345))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a dropped tap is not re-driven)", rec.Code)
	}
	if n := inboxCount(t, f.store, f.accountID); n != 0 {
		t.Fatalf("queued %d events without an inbox key, want 0", n)
	}

	tg.mu.Lock()
	defer tg.mu.Unlock()
	if len(tg.mu.answered) != 1 || !strings.Contains(tg.mu.answered[0], "Open the app") {
		t.Fatalf("expected the open-the-app answer, got %v", tg.mu.answered)
	}
}

// Garbage callback_data is answered (so the button stops spinning) and dropped.
func TestChildWebhook_CallbackQueryUnparseableIsAnsweredAndDropped(t *testing.T) {
	tg := newRecordingTG(t)
	f := linkedBotTap(t, tg)
	publishInboxKey(t, f.store, f.accountID)

	for _, data := range []string{"i:intake-7-1:confirm", "s:abc:confirm", "s:1767225600:detonate", "nonsense"} {
		rec := postWebhook(t, f.top, f.childPath, f.secret, callbackUpdate(data, 12345))
		if rec.Code != http.StatusOK {
			t.Fatalf("data %q: status = %d", data, rec.Code)
		}
	}
	if n := inboxCount(t, f.store, f.accountID); n != 0 {
		t.Fatalf("queued %d events from unparseable data, want 0", n)
	}
	tg.mu.Lock()
	defer tg.mu.Unlock()
	if len(tg.mu.answered) != 4 {
		t.Fatalf("answered %d of 4 taps — a button would spin forever", len(tg.mu.answered))
	}
}

// A tap from a chat that is not the linked one is not this account's user.
func TestChildWebhook_CallbackQueryFromForeignChatIsIgnored(t *testing.T) {
	tg := newRecordingTG(t)
	f := linkedBotTap(t, tg)
	publishInboxKey(t, f.store, f.accountID)

	rec := postWebhook(t, f.top, f.childPath, f.secret, callbackUpdate("s:1767225600:confirm", 999))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if n := inboxCount(t, f.store, f.accountID); n != 0 {
		t.Fatalf("queued %d events from a foreign chat, want 0", n)
	}
}

// Re-delivery of the same tap queues a second event. That is fine — the client's
// apply is idempotent — but it must never be lost, and it must never 500.
func TestChildWebhook_CallbackQueryRedeliveryQueuesAgainAndStays200(t *testing.T) {
	tg := newRecordingTG(t)
	f := linkedBotTap(t, tg)
	publishInboxKey(t, f.store, f.accountID)

	body := callbackUpdate("s:1767225600:snooze", 12345)
	for i := 0; i < 2; i++ {
		if rec := postWebhook(t, f.top, f.childPath, f.secret, body); rec.Code != http.StatusOK {
			t.Fatalf("delivery %d: status = %d", i, rec.Code)
		}
	}
	if n := inboxCount(t, f.store, f.accountID); n != 2 {
		t.Fatalf("queued %d events, want 2 (at-least-once; the client converges)", n)
	}
}

// TestChildWebhook_HelpAndUnknownCommands (bd med-26y): before this, the child
// webhook answered only /start and CallbackQuery — every other message hit a
// silent 200. /help therefore did nothing, and the autocomplete menu stayed
// empty until the user's first /start (setMyCommands lived inside that branch).
// TestHelpAdvertisesSupportedChatCommands pins that /help lists /food (a real
// chat command since bd med-eas.29.4 — sealed by the relay, AI-parsed on an
// unlocked client) and /workout (bd med-eas.29.5 — a structured "I did a
// workout" log applied through the shared workout domain at drain time).
func TestHelpAdvertisesSupportedChatCommands(t *testing.T) {
	for _, cmd := range []string{"/food", "/workout"} {
		if !strings.Contains(helpMessage, cmd) {
			t.Errorf("helpMessage should advertise %s, a supported chat command: %q", cmd, helpMessage)
		}
	}
}

func TestChildWebhook_HelpAndUnknownCommands(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	tg := newRecordingTG(t)
	webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", 14*24*time.Hour)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	top.Handle("/", router)

	session := registerAndGetSession(t, top, host, claimToken)
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

	// Commands are registered at MINT — before any /start has been sent, so
	// Telegram autocomplete is populated the moment the user opens the chat.
	tg.mu.Lock()
	minted := append([]string(nil), tg.mu.commands...)
	tg.mu.Unlock()
	if len(minted) != 1 {
		t.Fatalf("setMyCommands calls at mint = %d, want 1: %v", len(minted), minted)
	}
	for _, want := range []string{`"start"`, `"help"`} {
		if !strings.Contains(minted[0], want) {
			t.Errorf("mint-time command menu missing %s: %s", want, minted[0])
		}
	}

	bot, err := store.BotByAccount(t.Context(), account.ID)
	if err != nil {
		t.Fatalf("BotByAccount: %v", err)
	}
	childPath := "/tg/bot/" + account.ID + "/" + bot.WebhookSecret

	sentSince := func(n int) []string {
		tg.mu.Lock()
		defer tg.mu.Unlock()
		return append([]string(nil), tg.mu.sent[n:]...)
	}

	// /help is answered WITHOUT a prior /start — it reads no vault data and
	// needs no linked chat.
	if rec := postWebhook(t, top, childPath, bot.WebhookSecret,
		`{"update_id":2,"message":{"message_id":1,"text":"/help","chat":{"id":777,"type":"private"}}}`); rec.Code != http.StatusOK {
		t.Fatalf("/help status = %d", rec.Code)
	}
	sent := sentSince(0)
	if len(sent) != 1 || !strings.Contains(sent[0], "/start") || !strings.Contains(sent[0], "777") {
		t.Fatalf("/help reply not sent to chat 777: %v", sent)
	}

	// "/help@some_bot" (group form) resolves to the same command.
	if rec := postWebhook(t, top, childPath, bot.WebhookSecret,
		`{"update_id":3,"message":{"message_id":2,"text":"/help@mt_child_bot","chat":{"id":777,"type":"private"}}}`); rec.Code != http.StatusOK {
		t.Fatalf("/help@bot status = %d", rec.Code)
	}
	if got := sentSince(1); len(got) != 1 || !strings.Contains(got[0], "/start") {
		t.Fatalf("/help@bot did not produce the help reply: %v", got)
	}

	// An unknown command is answered, not silently dropped. Since med-eas.29.2
	// the relay may NOT tell /bogus from /bp (that would mean reading the
	// command surface of a message it must not understand), so it tries to seal
	// it. This account has published no inbox key, so the event is DROPPED —
	// never stored in the clear — and the user is told how to fix that.
	if rec := postWebhook(t, top, childPath, bot.WebhookSecret,
		`{"update_id":4,"message":{"message_id":3,"text":"/bogus","chat":{"id":777,"type":"private"}}}`); rec.Code != http.StatusOK {
		t.Fatalf("/bogus status = %d", rec.Code)
	}
	if got := sentSince(2); len(got) != 1 || !strings.Contains(got[0], "finish setting up") {
		t.Fatalf("unknown command not answered: %v", got)
	}

	// Free text is now sealed for the drain-time AI agent (bd med-vcv.2), the
	// same as an unknown command — the relay still parses nothing. This account
	// has published no inbox key, so it too is DROPPED and the user is told how
	// to fix that (rather than silently ignored, as before med-vcv.2).
	if rec := postWebhook(t, top, childPath, bot.WebhookSecret,
		`{"update_id":5,"message":{"message_id":4,"text":"I ate two eggs","chat":{"id":777,"type":"private"}}}`); rec.Code != http.StatusOK {
		t.Fatalf("free text status = %d", rec.Code)
	}
	if got := sentSince(3); len(got) != 1 || !strings.Contains(got[0], "finish setting up") {
		t.Fatalf("free text not routed to the mailbox: %v", got)
	}
}

func TestBotCommand(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"/start", "/start"},
		{"/help", "/help"},
		{"/Help", "/help"},
		{"/help@mt_child_bot", "/help"},
		{"/start deep-link-payload", "/start"},
		{"I ate two eggs", ""},
		{"", ""},
		{"/", "/"},
	} {
		if got := botCommand(tc.in); got != tc.want {
			t.Errorf("botCommand(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// tgCommandFixture links a bot AND publishes an inbox key, so sealCommand has
// somewhere to put events. Returns the child webhook path and the X25519
// private key the "client" uses to open what the relay sealed.
func tgCommandFixture(t *testing.T) (http.Handler, *recordingTG, string, string, *http.Cookie, string, *ecdh.PrivateKey) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	tg := newRecordingTG(t)
	webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
	inboxAPI := NewInboxAPI(store, tgTestSecret)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", 14*24*time.Hour)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	inboxAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	top.Handle("/", router)

	session := registerAndGetSession(t, top, host, claimToken)

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
	// /start links the chat, which EditReply needs (it takes the chat from the
	// bot row, never from the request).
	startBody := `{"update_id":2,"message":{"message_id":2,"text":"/start","chat":{"id":12345,"type":"private"}}}`
	if rec := postWebhook(t, top, "/tg/bot/"+account.ID+"/"+bot.WebhookSecret, bot.WebhookSecret, startBody); rec.Code != http.StatusOK {
		t.Fatalf("/start status = %d", rec.Code)
	}

	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	if code := putInboxKey(t, top, host, session, priv.PublicKey().Bytes()); code != http.StatusNoContent && code != http.StatusOK {
		t.Fatalf("PUT /api/inbox/key = %d", code)
	}
	childPath := "/tg/bot/" + account.ID + "/" + bot.WebhookSecret
	return top, tg, host, childPath, session, account.ID, priv
}

// TestChildWebhook_SealsCommandVerbatim (bd med-eas.29.2) pins the core
// zero-knowledge contract: the relay seals the RAW text, parses nothing, logs
// no content, and replies with a fixed constant carrying the message id the
// client will later edit.
func TestChildWebhook_SealsCommandVerbatim(t *testing.T) {
	// Drop the timestamp: the leak assertions below search for bare digits, and
	// a wall-clock time like 12:37:54.184196 contains "84" a fraction of the
	// time. The clock is not what is under test.
	var logBuf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{
		Level: slog.LevelDebug,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		},
	})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	top, tg, host, childPath, session, accountID, priv := tgCommandFixture(t)

	// Only the webhook's own logging is under test. Fixture setup logs the
	// manager webhook URL, whose random hex secret can contain any digit pair.
	logBuf.Reset()

	tg.mu.Lock()
	before := len(tg.mu.sent)
	tg.mu.Unlock()

	const cmd = "/bp 128 84 66"
	secret := childPath[strings.LastIndex(childPath, "/")+1:]
	body := `{"update_id":9,"message":{"message_id":7,"text":"` + cmd + `","chat":{"id":12345,"type":"private"}}}`
	if rec := postWebhook(t, top, childPath, secret, body); rec.Code != http.StatusOK {
		t.Fatalf("/bp status = %d", rec.Code)
	}

	// Replied "queued" — never anything derived from the numbers.
	tg.mu.Lock()
	sent := append([]string(nil), tg.mu.sent[before:]...)
	tg.mu.Unlock()
	if len(sent) != 1 || !strings.Contains(sent[0], "Queued") {
		t.Fatalf("expected a single queued reply, got %v", sent)
	}
	if strings.Contains(sent[0], "128") || strings.Contains(sent[0], "84") {
		t.Fatalf("SECURITY: reply echoed the reading: %q", sent[0])
	}

	// The mailbox holds the message VERBATIM, sealed.
	res := listInbox(t, top, host, session)
	if len(res.Events) != 1 {
		t.Fatalf("inbox events = %d, want 1", len(res.Events))
	}
	pt, err := openInbox(priv.Bytes(), accountID, res.Events[0].CT)
	if err != nil {
		t.Fatalf("openInbox: %v", err)
	}
	var ev tgCommandEvent
	if err := json.Unmarshal(pt, &ev); err != nil {
		t.Fatalf("unmarshal sealed event: %v", err)
	}
	if ev.Kind != inboxEventKindTGCommand || ev.Text != cmd {
		t.Fatalf("sealed event = %+v, want kind=%s text=%q", ev, inboxEventKindTGCommand, cmd)
	}
	if ev.ReplyMessageID == 0 {
		t.Errorf("sealed event carries no reply_message_id — the client cannot edit the placeholder")
	}
	if ev.AtUnix == 0 {
		t.Errorf("sealed event carries no server timestamp — backdating (drain rule 4) breaks")
	}

	// SECURITY INVARIANT: message content never reaches a log line.
	logged := logBuf.String()
	for _, leak := range []string{"128", "84", "/bp", cmd} {
		if strings.Contains(logged, leak) {
			t.Errorf("SECURITY: log leaked message content (%q): %s", leak, logged)
		}
	}
	// The ciphertext must not be logged either.
	if strings.Contains(logged, "ct=") || strings.Contains(logged, "\"ct\"") {
		t.Errorf("SECURITY: log leaked the sealed ciphertext: %s", logged)
	}
}

// TestChildWebhook_SealsPhotoFileIDNotBytes (bd med-vcv.1) pins the photo half of
// the zero-knowledge contract: a photo message seals only the LARGEST rendition's
// file_id (+mime/size), never pixels, and replies "Queued" like any command.
func TestChildWebhook_SealsPhotoFileIDNotBytes(t *testing.T) {
	top, tg, host, childPath, session, accountID, priv := tgCommandFixture(t)

	tg.mu.Lock()
	before := len(tg.mu.sent)
	tg.mu.Unlock()

	secret := childPath[strings.LastIndex(childPath, "/")+1:]
	// Ascending sizes — the relay must seal the LAST (largest) file_id.
	body := `{"update_id":9,"message":{"message_id":7,"chat":{"id":12345,"type":"private"},` +
		`"photo":[{"file_id":"small","file_size":100,"width":90,"height":90},` +
		`{"file_id":"large","file_size":9000,"width":900,"height":900}]}}`
	if rec := postWebhook(t, top, childPath, secret, body); rec.Code != http.StatusOK {
		t.Fatalf("photo webhook status = %d", rec.Code)
	}

	tg.mu.Lock()
	sent := append([]string(nil), tg.mu.sent[before:]...)
	tg.mu.Unlock()
	if len(sent) != 1 || !strings.Contains(sent[0], "Queued") {
		t.Fatalf("expected a single queued reply, got %v", sent)
	}

	res := listInbox(t, top, host, session)
	if len(res.Events) != 1 {
		t.Fatalf("inbox events = %d, want 1", len(res.Events))
	}
	pt, err := openInbox(priv.Bytes(), accountID, res.Events[0].CT)
	if err != nil {
		t.Fatalf("openInbox: %v", err)
	}
	var ev tgPhotoEvent
	if err := json.Unmarshal(pt, &ev); err != nil {
		t.Fatalf("unmarshal sealed event: %v", err)
	}
	if ev.Kind != inboxEventKindTGPhoto {
		t.Fatalf("sealed kind = %q, want %q", ev.Kind, inboxEventKindTGPhoto)
	}
	if ev.FileID != "large" {
		t.Errorf("sealed file_id = %q, want the largest rendition %q", ev.FileID, "large")
	}
	if ev.Mime != "image/jpeg" || ev.Size != 9000 {
		t.Errorf("sealed mime/size = %q/%d, want image/jpeg/9000", ev.Mime, ev.Size)
	}
	if ev.ReplyMessageID == 0 || ev.AtUnix == 0 {
		t.Errorf("sealed photo event missing reply id / timestamp: %+v", ev)
	}
}

// TestGetPhoto_StreamsBytesForOwnAccount (bd med-vcv.1) pins the byte-proxy: a
// session resolves a file_id through its OWN bot token and gets the raw image
// streamed back, with a missing file_id and a missing session both rejected.
func TestGetPhoto_StreamsBytesForOwnAccount(t *testing.T) {
	top, _, host, _, session, _, _ := tgCommandFixture(t)

	rec := doReq(t, top, http.MethodGet, "http://"+host+"/api/telegram/photo?file_id=AgACPHOTO", host, session, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET photo status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("content-type = %q, want image/jpeg", ct)
	}
	if rec.Body.String() != fakePhotoBytes {
		t.Errorf("streamed body = %q, want the upstream bytes verbatim", rec.Body.String())
	}

	// Missing file_id → 400.
	if bad := doReq(t, top, http.MethodGet, "http://"+host+"/api/telegram/photo", host, session, nil); bad.Code != http.StatusBadRequest {
		t.Errorf("missing file_id status = %d, want 400", bad.Code)
	}
	// No session → 401 (RequireSession rejects before the handler).
	if noAuth := doReq(t, top, http.MethodGet, "http://"+host+"/api/telegram/photo?file_id=AgACPHOTO", host, nil, nil); noAuth.Code != http.StatusUnauthorized {
		t.Errorf("no-session status = %d, want 401", noAuth.Code)
	}
}

// TestChildWebhook_SealsFreeTextForTheAgent (bd med-vcv.2) pins that a non-command
// message is sealed verbatim as a tg_text event (for the drain-time AI agent),
// while a message with no text at all is dropped, not sealed empty.
func TestChildWebhook_SealsFreeTextForTheAgent(t *testing.T) {
	top, tg, host, childPath, session, accountID, priv := tgCommandFixture(t)
	secret := childPath[strings.LastIndex(childPath, "/")+1:]

	tg.mu.Lock()
	before := len(tg.mu.sent)
	tg.mu.Unlock()

	const msg = "how did my blood pressure look this week?"
	body := `{"update_id":9,"message":{"message_id":7,"text":"` + msg + `","chat":{"id":12345,"type":"private"}}}`
	if rec := postWebhook(t, top, childPath, secret, body); rec.Code != http.StatusOK {
		t.Fatalf("free-text status = %d", rec.Code)
	}

	tg.mu.Lock()
	sent := append([]string(nil), tg.mu.sent[before:]...)
	tg.mu.Unlock()
	if len(sent) != 1 || !strings.Contains(sent[0], "Queued") {
		t.Fatalf("expected a single queued reply, got %v", sent)
	}

	res := listInbox(t, top, host, session)
	if len(res.Events) != 1 {
		t.Fatalf("inbox events = %d, want 1", len(res.Events))
	}
	pt, err := openInbox(priv.Bytes(), accountID, res.Events[0].CT)
	if err != nil {
		t.Fatalf("openInbox: %v", err)
	}
	var ev tgTextEvent
	if err := json.Unmarshal(pt, &ev); err != nil {
		t.Fatalf("unmarshal sealed event: %v", err)
	}
	if ev.Kind != inboxEventKindTGText || ev.Text != msg {
		t.Fatalf("sealed event = %+v, want kind=%s text=%q", ev, inboxEventKindTGText, msg)
	}
	if ev.ReplyMessageID == 0 || ev.AtUnix == 0 {
		t.Errorf("sealed text event missing reply id / timestamp: %+v", ev)
	}

	// A message with no text (e.g. a sticker) has nothing to seal → dropped, no
	// new event, no extra reply.
	empty := `{"update_id":10,"message":{"message_id":8,"text":"","chat":{"id":12345,"type":"private"}}}`
	if rec := postWebhook(t, top, childPath, secret, empty); rec.Code != http.StatusOK {
		t.Fatalf("empty-message status = %d", rec.Code)
	}
	if res := listInbox(t, top, host, session); len(res.Events) != 1 {
		t.Errorf("empty message sealed an event: inbox now has %d, want 1", len(res.Events))
	}
}

// TestChildWebhook_CommandWithoutInboxKeyIsDropped: no key means the plaintext
// has nowhere safe to go, so it must be discarded — never stored in the clear.
func TestChildWebhook_CommandWithoutInboxKeyIsDropped(t *testing.T) {
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	tg := newRecordingTG(t)
	webauthnAPI := NewWebAuthnAPI(store, tgTestSecret)
	inboxAPI := NewInboxAPI(store, tgTestSecret)
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", tg.url, "", 14*24*time.Hour)
	if err := tgAPI.Bootstrap(t.Context()); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	apiMux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(apiMux)
	inboxAPI.RegisterRoutes(apiMux)
	tgAPI.RegisterAPIRoutes(apiMux)
	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), apiMux, "", false, false)
	top := http.NewServeMux()
	tgAPI.RegisterWebhookRoutes(top)
	top.Handle("/", router)
	session := registerAndGetSession(t, top, host, claimToken)
	provRec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/provision", host, session, nil)
	var prov struct {
		Suggested string `json:"suggested_username"`
	}
	json.Unmarshal(provRec.Body.Bytes(), &prov)
	managerSecret := deriveWebhookSecret(tgTestSecret, "mt/tg-manager-webhook/v1")
	postWebhook(t, top, "/tg/manager/"+managerSecret, managerSecret,
		`{"update_id":1,"message":{"message_id":1,"from":{"id":6918132008},"chat":{"id":100,"type":"private"},"managed_bot_created":{"bot":{"id":909,"username":"`+prov.Suggested+`"}}}}`)
	bot, _ := store.BotByAccount(t.Context(), account.ID)

	rec := postWebhook(t, top, "/tg/bot/"+account.ID+"/"+bot.WebhookSecret, bot.WebhookSecret,
		`{"update_id":9,"message":{"message_id":7,"text":"/bp 128 84","chat":{"id":12345,"type":"private"}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a non-2xx makes Telegram redeliver)", rec.Code)
	}
	if res := listInbox(t, top, host, session); len(res.Events) != 0 {
		t.Fatalf("event stored despite no inbox key: %d events", len(res.Events))
	}
	tg.mu.Lock()
	sent := append([]string(nil), tg.mu.sent...)
	tg.mu.Unlock()
	last := sent[len(sent)-1]
	if !strings.Contains(last, "finish setting up") {
		t.Fatalf("user not told how to fix it: %q", last)
	}
	if strings.Contains(last, "128") {
		t.Errorf("SECURITY: reply echoed the dropped reading: %q", last)
	}
}

// TestEditReply drives the client-composed confirmation through the relay. The
// relay must forward the text verbatim and take the chat from the bot row, so a
// session can never edit a message in someone else's chat.
func TestEditReply(t *testing.T) {
	top, tg, host, _, session, _, _ := tgCommandFixture(t)

	body := []byte(`{"message_id":1001,"text":"✅ Recorded BP 128/84."}`)
	rec := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/reply-edit", host, session, body)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("edit status = %d, body %q", rec.Code, rec.Body.String())
	}
	tg.mu.Lock()
	edits := append([]string(nil), tg.mu.edits...)
	tg.mu.Unlock()
	if len(edits) != 1 {
		t.Fatalf("editMessageText calls = %d, want 1: %v", len(edits), edits)
	}
	if !strings.Contains(edits[0], "Recorded BP 128/84") {
		t.Errorf("client text not forwarded verbatim: %s", edits[0])
	}
	// chat_id comes from the linked bot row (/start linked chat 12345).
	if !strings.Contains(edits[0], "12345") {
		t.Errorf("edit did not target the linked chat: %s", edits[0])
	}
	if !strings.Contains(edits[0], "1001") {
		t.Errorf("edit did not target the requested message: %s", edits[0])
	}

	// Guard rails.
	for _, bad := range []string{`{"message_id":0,"text":"x"}`, `{"message_id":5,"text":""}`, `not json`} {
		r := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/reply-edit", host, session, []byte(bad))
		if r.Code != http.StatusBadRequest {
			t.Errorf("edit %q = %d, want 400", bad, r.Code)
		}
	}
	// Unauthenticated.
	r := doReq(t, top, http.MethodPost, "http://"+host+"/api/telegram/reply-edit", host, nil, body)
	if r.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated edit = %d, want 401", r.Code)
	}
}

// --- med-eas.43: cloud->local Bot API proxy migration ------------------------

// countingTG is an httptest Bot API fake that records, per method, how many
// times it was called and the last request body — enough to assert that logOut
// hit the cloud fake and setWebhook hit the proxy fake (with the child URL).
type countingTG struct {
	mu       sync.Mutex
	calls    map[string]int
	lastBody map[string]map[string]any
	srv      *httptest.Server
}

func newCountingTG(t *testing.T) *countingTG {
	t.Helper()
	rec := &countingTG{calls: map[string]int{}, lastBody: map[string]map[string]any{}}
	rec.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		method := parts[len(parts)-1]
		var body map[string]any
		if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		rec.mu.Lock()
		rec.calls[method]++
		rec.lastBody[method] = body
		rec.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"result":true}`)
	}))
	t.Cleanup(rec.srv.Close)
	return rec
}

func (rec *countingTG) count(method string) int {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.calls[method]
}

func TestMigrateBotsToProxy(t *testing.T) {
	store := setupStore(t)
	ctx := context.Background()

	// A pre-proxy bot: created without the migrated flag (proxy_migrated_at_unix
	// NULL), exactly the shape a bot minted before the proxy was enabled has.
	ct, nonce, err := sealTGToken(tgTestSecret, "123:CHILDTOKEN")
	if err != nil {
		t.Fatalf("sealTGToken: %v", err)
	}
	const accountID = "acc-migrate"
	const botSecret = "botsecret-xyz"
	if err := store.UpsertBot(ctx, cloudstore.TGBot{
		AccountID: accountID, BotID: 123, BotUsername: "child_bot",
		TokenCT: ct, TokenNonce: nonce, Kind: "byo", WebhookSecret: botSecret,
		CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("UpsertBot: %v", err)
	}

	cloud := newCountingTG(t) // stands in for api.telegram.org (logOut target)
	proxy := newCountingTG(t) // stands in for the local Bot API proxy

	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", proxy.srv.URL, "", time.Hour)
	tgAPI.cloudAPIBaseURL = cloud.srv.URL

	migrated, failed, err := tgAPI.MigrateBotsToProxy(ctx)
	if err != nil {
		t.Fatalf("MigrateBotsToProxy: %v", err)
	}
	if migrated != 1 || failed != 0 {
		t.Fatalf("migrated=%d failed=%d, want 1/0", migrated, failed)
	}

	// logOut must go to the cloud, setWebhook to the proxy — file_ids are
	// server-bound, so mixing these up is the whole bug.
	if cloud.count("logOut") != 1 {
		t.Errorf("cloud logOut count = %d, want 1", cloud.count("logOut"))
	}
	if cloud.count("setWebhook") != 0 {
		t.Errorf("setWebhook must not hit the cloud (count=%d)", cloud.count("setWebhook"))
	}
	if proxy.count("setWebhook") != 1 {
		t.Errorf("proxy setWebhook count = %d, want 1", proxy.count("setWebhook"))
	}
	if proxy.count("logOut") != 0 {
		t.Errorf("logOut must not hit the proxy (count=%d)", proxy.count("logOut"))
	}
	// The re-registered webhook must point at the child route on the base host.
	if url, _ := proxy.lastBody["setWebhook"]["url"].(string); !strings.Contains(url, "/tg/bot/"+accountID+"/"+botSecret) {
		t.Errorf("setWebhook url = %q, want child route for %s", url, accountID)
	}

	// The flag is now persisted.
	bot, err := store.BotByAccount(ctx, accountID)
	if err != nil {
		t.Fatalf("BotByAccount: %v", err)
	}
	if bot.ProxyMigratedAt == nil {
		t.Fatal("ProxyMigratedAt still nil after migration")
	}

	// Idempotent: a re-run finds nothing to migrate and does not logOut again
	// (which would needlessly lock the bot out of the cloud for ~10 min).
	migrated, failed, err = tgAPI.MigrateBotsToProxy(ctx)
	if err != nil || migrated != 0 || failed != 0 {
		t.Fatalf("re-run migrated=%d failed=%d err=%v, want 0/0/nil", migrated, failed, err)
	}
	if cloud.count("logOut") != 1 {
		t.Errorf("re-run logged out again: cloud logOut count = %d, want 1", cloud.count("logOut"))
	}
}

func TestMigrateBotsToProxyRequiresProxy(t *testing.T) {
	store := setupStore(t)
	// No proxy configured (apiBaseURL "").
	tgAPI := NewTelegramAPI(store, tgTestSecret, "MANAGER:TOKEN", "localhost", "", "", time.Hour)
	if _, _, err := tgAPI.MigrateBotsToProxy(context.Background()); err == nil {
		t.Fatal("expected an error when no proxy is configured")
	}
}

// TestProxyScoping pins bd med-eas.46: with a proxy configured (via ConfigureProxy),
// child webhooks register the INTERNAL origin (the proxy can't reach the public
// host) and the manager client hits the CLOUD base (the local server lacks the
// managed-bot token method) — while children keep the proxy. With no proxy, both
// stay on the public URL / shared base, unchanged.
func TestProxyScoping(t *testing.T) {
	t.Run("child webhook internal + manager on cloud when proxy on", func(t *testing.T) {
		tgAPI := NewTelegramAPI(nil, tgTestSecret, "MANAGER:TOKEN", "cloud.example.com", "http://proxy:8081", "", time.Hour)
		tgAPI.ConfigureProxy("", "http://cloud:8080")

		got := tgAPI.childWebhookURL("acc1", "sec1")
		if want := "http://cloud:8080/tg/bot/acc1/sec1"; got != want {
			t.Errorf("childWebhookURL = %q, want internal %q", got, want)
		}
		// Manager routes to the cloud base (""→real cloud); children keep the proxy
		// (asserted by TestMigrateBotsToProxy's proxy setWebhook count).
		if base := tgAPI.managerClient().BaseURL(); base != tgclient.DefaultBaseURL {
			t.Errorf("manager base = %q, want cloud default %q", base, tgclient.DefaultBaseURL)
		}
	})

	t.Run("public webhook + shared base when proxy off", func(t *testing.T) {
		// No ConfigureProxy call — the no-proxy default path.
		tgAPI := NewTelegramAPI(nil, tgTestSecret, "MANAGER:TOKEN", "cloud.example.com", "", "", time.Hour)
		got := tgAPI.childWebhookURL("acc1", "sec1")
		if want := "https://cloud.example.com/tg/bot/acc1/sec1"; got != want {
			t.Errorf("childWebhookURL = %q, want public %q", got, want)
		}
		if base := tgAPI.managerClient().BaseURL(); base != tgclient.DefaultBaseURL {
			t.Errorf("manager base = %q, want cloud default %q", base, tgclient.DefaultBaseURL)
		}
	})
}

// TestDownloadDocumentInvalidFileIDIsClassified pins the condition the child
// webhook's actionable-hint branch keys on: a cloud-issued file_id sent to the
// local proxy fails getFile with an error that IsInvalidFileID recognizes.
func TestDownloadDocumentInvalidFileIDIsClassified(t *testing.T) {
	tgSrv := fakeTG(t, map[string]string{
		"getFile": `{"ok":false,"error_code":400,"description":"Bad Request: invalid file_id"}`,
	})
	tgAPI := NewTelegramAPI(setupStore(t), tgTestSecret, "MANAGER:TOKEN", "localhost", tgSrv.URL, "", time.Hour)
	client := tgclient.New("123:CHILDTOKEN", tgSrv.URL)

	_, err := tgAPI.downloadDocument(context.Background(), client,
		&tgclient.Document{FileID: "cloud-issued-id", FileName: "band.nxk", FileSize: 1})
	if err == nil {
		t.Fatal("expected getFile error")
	}
	if !tgclient.IsInvalidFileID(err) {
		t.Fatalf("IsInvalidFileID(%v) = false, want true", err)
	}
}
