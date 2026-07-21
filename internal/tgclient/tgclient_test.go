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

func TestLogOutHitsLogOutMethod(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()
	f.responses["logOut"] = `{"ok":true,"result":true}`

	c := New("123:ABC", srv.URL)
	if err := c.LogOut(context.Background()); err != nil {
		t.Fatalf("LogOut: %v", err)
	}
	if f.lastMethod != "logOut" {
		t.Fatalf("expected logOut call, got %q", f.lastMethod)
	}
}

func TestIsInvalidFileID(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()
	f.responses["getFile"] = `{"ok":false,"error_code":400,"description":"Bad Request: invalid file_id"}`
	f.statuses["getFile"] = 400

	c := New("123:ABC", srv.URL)
	_, err := c.GetFile(context.Background(), "cloud-issued-id")
	if err == nil {
		t.Fatal("expected getFile error")
	}
	if !IsInvalidFileID(err) {
		t.Fatalf("IsInvalidFileID(%v) = false, want true", err)
	}
	// A different rejection must not be misclassified.
	if IsInvalidFileID(&apiError{Code: 400, Description: "Bad Request: file is too big"}) {
		t.Fatal("IsInvalidFileID matched 'file is too big'")
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

// med-76c.2: callback_data is the only thing that crosses back from a button
// tap, so its grammar is a contract. "s:<slotUnix>:<action>" — anything else is
// a tap we must refuse rather than guess at.
func TestParseCallbackData(t *testing.T) {
	for _, tc := range []struct {
		data     string
		wantSlot int64
		wantAct  string
		wantOK   bool
	}{
		{data: "s:1767225600:confirm", wantSlot: 1767225600, wantAct: "confirm", wantOK: true},
		{data: "s:1767225600:snooze", wantSlot: 1767225600, wantAct: "snooze", wantOK: true},
		{data: "s:1767225600:detonate"},  // unknown action
		{data: "i:intake-7-123:confirm"}, // retired per-intake namespace
		{data: "s::confirm"},             // empty slot
		{data: "s:abc:confirm"},          // non-numeric slot
		{data: "s:-5:confirm"},           // non-positive slot
		{data: "s:1767225600"},           // no action
		{data: "confirm"},                // no namespace
		{data: ""},                       // empty
		{data: "s:1767225600:confirm:extra", wantSlot: 1767225600, wantAct: "", wantOK: false},
	} {
		slot, action, ok := ParseCallbackData(tc.data)
		if ok != tc.wantOK {
			t.Errorf("ParseCallbackData(%q) ok = %v, want %v", tc.data, ok, tc.wantOK)
			continue
		}
		if ok && (slot != tc.wantSlot || action != tc.wantAct) {
			t.Errorf("ParseCallbackData(%q) = (%d, %q), want (%d, %q)", tc.data, slot, action, tc.wantSlot, tc.wantAct)
		}
	}
}

// ValidCallbackStem gates what a client may put in the queue and therefore what
// the relay puts in a button. Empty means "no buttons" and must stay legal.
func TestValidCallbackStem(t *testing.T) {
	valid := []string{"", "s:1", "s:1767225600"}
	for _, s := range valid {
		if !ValidCallbackStem(s) {
			t.Errorf("ValidCallbackStem(%q) = false, want true", s)
		}
	}
	invalid := []string{
		"s:", "s:abc", "i:intake-7-1:confirm", "x:1", "1767225600",
		"s:1767225600:confirm",         // an already-built callback_data, not a stem
		"s:99999999999999999999999999", // over the length cap
	}
	for _, s := range invalid {
		if ValidCallbackStem(s) {
			t.Errorf("ValidCallbackStem(%q) = true, want false", s)
		}
	}
}

// A round-trip guard: whatever stem the relay accepts, appending an action must
// produce data ParseCallbackData reads back — and stay inside Telegram's 64-byte
// callback_data limit.
func TestCallbackStemRoundTripsAndFitsTelegramLimit(t *testing.T) {
	stem := "s:1767225600"
	if !ValidCallbackStem(stem) {
		t.Fatalf("stem %q rejected", stem)
	}
	for _, action := range []string{CallbackActionConfirm, CallbackActionSnooze} {
		data := stem + ":" + action
		if len(data) > 64 {
			t.Errorf("callback_data %q is %d bytes, over Telegram's 64-byte limit", data, len(data))
		}
		slot, got, ok := ParseCallbackData(data)
		if !ok || slot != 1767225600 || got != action {
			t.Errorf("round-trip %q = (%d, %q, %v)", data, slot, got, ok)
		}
	}
}

func TestSendMessageWithButtonsPayloadShape(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()

	c := New("123:ABC", srv.URL)
	err := c.SendMessageWithButtons(context.Background(), 42, "Time to take: Lisinopril", []InlineKeyboardButton{
		{Text: "✅ Confirm", CallbackData: "s:1767225600:confirm"},
		{Text: "⏰ Snooze", CallbackData: "s:1767225600:snooze"},
	})
	if err != nil {
		t.Fatalf("SendMessageWithButtons: %v", err)
	}
	if f.lastMethod != "sendMessage" {
		t.Fatalf("called %q, want sendMessage", f.lastMethod)
	}
	markup, ok := f.lastBody["reply_markup"].(map[string]any)
	if !ok {
		t.Fatalf("reply_markup missing: %#v", f.lastBody)
	}
	rows, ok := markup["inline_keyboard"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("inline_keyboard = %#v, want one row", markup["inline_keyboard"])
	}
	buttons, _ := rows[0].([]any)
	if len(buttons) != 2 {
		t.Fatalf("want 2 buttons, got %d", len(buttons))
	}
	first, _ := buttons[0].(map[string]any)
	if first["callback_data"] != "s:1767225600:confirm" {
		t.Errorf("first button = %#v", first)
	}
}

// No buttons must mean no reply_markup at all — Telegram renders an empty
// keyboard object as a stuck, tappable-but-dead row.
func TestSendMessageWithButtonsOmitsMarkupWhenEmpty(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()

	c := New("123:ABC", srv.URL)
	if err := c.SendMessageWithButtons(context.Background(), 42, "BP reminder", nil); err != nil {
		t.Fatalf("SendMessageWithButtons: %v", err)
	}
	if _, present := f.lastBody["reply_markup"]; present {
		t.Errorf("reply_markup present for a button-less message: %#v", f.lastBody)
	}
}

// EditMessageTextClearMarkup must send an EMPTY inline_keyboard so Telegram
// drops the message's buttons (unlike EditMessageText, which omits reply_markup
// and so leaves existing buttons live).
func TestEditMessageTextClearMarkupDropsButtons(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()

	c := New("123:ABC", srv.URL)
	if err := c.EditMessageTextClearMarkup(context.Background(), 42, 9, "✅ Confirmed"); err != nil {
		t.Fatalf("EditMessageTextClearMarkup: %v", err)
	}
	if f.lastMethod != "editMessageText" {
		t.Fatalf("called %q, want editMessageText", f.lastMethod)
	}
	if f.lastBody["text"] != "✅ Confirmed" {
		t.Errorf("text = %#v, want the static receipt", f.lastBody["text"])
	}
	markup, ok := f.lastBody["reply_markup"].(map[string]any)
	if !ok {
		t.Fatalf("reply_markup missing: %#v", f.lastBody)
	}
	rows, ok := markup["inline_keyboard"].([]any)
	if !ok || len(rows) != 0 {
		t.Errorf("inline_keyboard = %#v, want an empty array to drop buttons", markup["inline_keyboard"])
	}
}

func TestAnswerCallbackQueryPayloadShape(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()

	c := New("123:ABC", srv.URL)
	if err := c.AnswerCallbackQuery(context.Background(), "cbq-1", "Saved"); err != nil {
		t.Fatalf("AnswerCallbackQuery: %v", err)
	}
	if f.lastMethod != "answerCallbackQuery" {
		t.Fatalf("called %q", f.lastMethod)
	}
	if f.lastBody["callback_query_id"] != "cbq-1" || f.lastBody["text"] != "Saved" {
		t.Errorf("body = %#v", f.lastBody)
	}
}

func TestUpdateDecodesCallbackQuery(t *testing.T) {
	var upd Update
	raw := `{"update_id":5,"callback_query":{"id":"cbq-9","data":"s:1767225600:confirm","from":{"id":7},"message":{"message_id":3,"chat":{"id":100,"type":"private"}}}}`
	if err := json.Unmarshal([]byte(raw), &upd); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if upd.CallbackQuery == nil || upd.CallbackQuery.ID != "cbq-9" || upd.CallbackQuery.Data != "s:1767225600:confirm" {
		t.Fatalf("callback_query = %#v", upd.CallbackQuery)
	}
	if upd.CallbackQuery.Message == nil || upd.CallbackQuery.Message.Chat.ID != 100 {
		t.Fatalf("callback_query.message = %#v", upd.CallbackQuery.Message)
	}
}

func TestMessageDecodesVoiceAndCaption(t *testing.T) {
	var upd Update
	raw := `{"update_id":6,"message":{"message_id":4,"chat":{"id":100,"type":"private"},"caption":"my screenshot","voice":{"file_id":"vf-1","mime_type":"audio/ogg","duration":7,"file_size":2048},"photo":[{"file_id":"p1","file_size":10}]}}`
	if err := json.Unmarshal([]byte(raw), &upd); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	m := upd.Message
	if m == nil {
		t.Fatal("message nil")
	}
	if m.Caption != "my screenshot" {
		t.Errorf("caption = %q", m.Caption)
	}
	if m.Voice == nil || m.Voice.FileID != "vf-1" || m.Voice.MimeType != "audio/ogg" || m.Voice.Duration != 7 || m.Voice.FileSize != 2048 {
		t.Errorf("voice = %#v", m.Voice)
	}

	var bare Update
	if err := json.Unmarshal([]byte(`{"update_id":7,"message":{"message_id":5,"text":"hi","chat":{"id":1,"type":"private"}}}`), &bare); err != nil {
		t.Fatalf("unmarshal bare: %v", err)
	}
	if bare.Message.Voice != nil || bare.Message.Caption != "" {
		t.Errorf("bare message = %#v", bare.Message)
	}
}

// The invariant the two functions must jointly hold: a stem the relay accepts,
// with an action appended, is data the webhook can parse. Guards against the two
// drifting apart (an over-long or overflowing slot was accepted once).
func TestEveryAcceptedStemParsesBack(t *testing.T) {
	for _, stem := range []string{"s:1", "s:1767225600", "s:9223372036854775807"} {
		if !ValidCallbackStem(stem) {
			continue // rejected is fine; accepted-but-unparseable is not
		}
		if _, _, ok := ParseCallbackData(stem + ":" + CallbackActionConfirm); !ok {
			t.Errorf("stem %q accepted but its callback_data does not parse back", stem)
		}
	}
}

// TestValidCallbackStemWorkout covers the workout ("w:") namespace added for
// med-eas.70 alongside the existing med ("s:") stems.
func TestValidCallbackStemWorkout(t *testing.T) {
	valid := []string{"w:6:20260720", "w:1:20000101", "w:9223372036854775807:20991231"}
	for _, s := range valid {
		if !ValidCallbackStem(s) {
			t.Errorf("ValidCallbackStem(%q) = false, want true", s)
		}
	}
	invalid := []string{
		"w:", "w:6", "w:6:2026072", // date too short (7 digits)
		"w:6:202607200",                 // date too long (9 digits)
		"w:0:20260720", "w:-1:20260720", // non-positive group
		"w:abc:20260720",        // non-numeric group
		"w:6:2026072a",          // non-digit in date
		"w:6:20260720:snooze1h", // an already-built callback_data, not a stem
	}
	for _, s := range invalid {
		if ValidCallbackStem(s) {
			t.Errorf("ValidCallbackStem(%q) = true, want false", s)
		}
	}
}

func TestParseWorkoutCallback(t *testing.T) {
	cases := []struct {
		data      string
		wantGroup int64
		wantDate  string
		wantAct   string
		wantOK    bool
	}{
		{"w:6:20260720:snooze1h", 6, "2026-07-20", "snooze1h", true},
		{"w:6:20260720:snooze2h", 6, "2026-07-20", "snooze2h", true},
		{"w:42:20991231:skip", 42, "2099-12-31", "skip", true},
		{"w:6:20260720:confirm", 0, "", "", false}, // med action on a workout stem
		{"w:6:20260720:snooze", 0, "", "", false},  // med action
		{"w:0:20260720:skip", 0, "", "", false},    // non-positive group
		{"w:abc:20260720:skip", 0, "", "", false},  // non-numeric group
		{"w:6:2026072:skip", 0, "", "", false},     // date too short
		{"w:6:20260720", 0, "", "", false},         // missing action (stem, not data)
		{"s:1767225600:confirm", 0, "", "", false}, // med namespace
		{"", 0, "", "", false},
	}
	for _, tc := range cases {
		g, d, a, ok := ParseWorkoutCallback(tc.data)
		if g != tc.wantGroup || d != tc.wantDate || a != tc.wantAct || ok != tc.wantOK {
			t.Errorf("ParseWorkoutCallback(%q) = (%d, %q, %q, %v), want (%d, %q, %q, %v)",
				tc.data, g, d, a, ok, tc.wantGroup, tc.wantDate, tc.wantAct, tc.wantOK)
		}
	}
}

func TestIsWorkoutCallback(t *testing.T) {
	if !IsWorkoutCallback("w:6:20260720:snooze1h") {
		t.Error("IsWorkoutCallback(w:…) = false, want true")
	}
	if IsWorkoutCallback("s:1767225600:confirm") {
		t.Error("IsWorkoutCallback(s:…) = true, want false")
	}
}

// TestWorkoutStemRoundTripsAndFitsTelegramLimit mirrors the med round-trip guard:
// every accepted workout stem + action must parse back and stay under 64 bytes.
func TestWorkoutStemRoundTripsAndFitsTelegramLimit(t *testing.T) {
	stem := "w:9223372036854775807:20991231"
	if !ValidCallbackStem(stem) {
		t.Fatalf("stem %q rejected", stem)
	}
	for _, action := range []string{CallbackActionSnooze1h, CallbackActionSnooze2h, CallbackActionSkip} {
		data := stem + ":" + action
		if len(data) > 64 {
			t.Errorf("callback_data %q is %d bytes, over Telegram's 64-byte limit", data, len(data))
		}
		g, d, got, ok := ParseWorkoutCallback(data)
		if !ok || g != 9223372036854775807 || d != "2099-12-31" || got != action {
			t.Errorf("round-trip %q = (%d, %q, %q, %v)", data, g, d, got, ok)
		}
	}
}

// A URL button must serialize `url` and omit `callback_data` entirely — a
// button carrying both is rejected by Telegram.
func TestURLButtonMarshalsURLOnly(t *testing.T) {
	f, srv := newFake(t)
	defer srv.Close()

	c := New("123:ABC", srv.URL)
	err := c.SendMessageWithButtons(context.Background(), 42, "BP reminder", []InlineKeyboardButton{
		{Text: "🌐 Open", URL: "https://acme.example.com/?tab=bp"},
		{Text: "⏰ Snooze 1h", CallbackData: "bp:1767225600:snooze1h"},
	})
	if err != nil {
		t.Fatalf("SendMessageWithButtons: %v", err)
	}
	markup, _ := f.lastBody["reply_markup"].(map[string]any)
	rows, _ := markup["inline_keyboard"].([]any)
	if len(rows) != 1 {
		t.Fatalf("inline_keyboard = %#v, want one row", markup["inline_keyboard"])
	}
	buttons, _ := rows[0].([]any)
	if len(buttons) != 2 {
		t.Fatalf("want 2 buttons, got %d", len(buttons))
	}
	urlBtn, _ := buttons[0].(map[string]any)
	if urlBtn["url"] != "https://acme.example.com/?tab=bp" {
		t.Errorf("url button = %#v", urlBtn)
	}
	if _, present := urlBtn["callback_data"]; present {
		t.Errorf("url button leaked callback_data: %#v", urlBtn)
	}
	cbBtn, _ := buttons[1].(map[string]any)
	if _, present := cbBtn["url"]; present {
		t.Errorf("callback button leaked url: %#v", cbBtn)
	}
}

func TestParseMeasureCallback(t *testing.T) {
	for _, tc := range []struct {
		data     string
		wantKind string
		wantSlot int64
		wantAct  string
		wantOK   bool
	}{
		{data: "bp:1767225600:snooze1h", wantKind: "bp", wantSlot: 1767225600, wantAct: "snooze1h", wantOK: true},
		{data: "bp:1767225600:skip", wantKind: "bp", wantSlot: 1767225600, wantAct: "skip", wantOK: true},
		{data: "wt:1767225600:snooze1h", wantKind: "weight", wantSlot: 1767225600, wantAct: "snooze1h", wantOK: true},
		{data: "wt:1767225600:skip", wantKind: "weight", wantSlot: 1767225600, wantAct: "skip", wantOK: true},
		{data: "bp:1767225600:confirm"},  // action not whitelisted for measures
		{data: "bp:1767225600:snooze2h"}, // workout-only action
		{data: "s:1767225600:confirm"},   // med namespace not cross-parsed
		{data: "w:6:20260720:snooze1h"},  // workout namespace not cross-parsed
		{data: "bp::skip"},               // empty slot
		{data: "bp:abc:skip"},            // non-numeric slot
		{data: "bp:-5:skip"},             // non-positive slot
		{data: "bp:1767225600"},          // no action
		{data: ""},                       // empty
	} {
		kind, slot, action, ok := ParseMeasureCallback(tc.data)
		if ok != tc.wantOK {
			t.Errorf("ParseMeasureCallback(%q) ok = %v, want %v", tc.data, ok, tc.wantOK)
			continue
		}
		if ok && (kind != tc.wantKind || slot != tc.wantSlot || action != tc.wantAct) {
			t.Errorf("ParseMeasureCallback(%q) = (%q, %d, %q), want (%q, %d, %q)",
				tc.data, kind, slot, action, tc.wantKind, tc.wantSlot, tc.wantAct)
		}
	}
}

func TestIsMeasureCallback(t *testing.T) {
	for _, s := range []string{"bp:1767225600:skip", "wt:1767225600:snooze1h"} {
		if !IsMeasureCallback(s) {
			t.Errorf("IsMeasureCallback(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"s:1767225600:confirm", "w:6:20260720:skip", ""} {
		if IsMeasureCallback(s) {
			t.Errorf("IsMeasureCallback(%q) = true, want false", s)
		}
	}
}

// ValidCallbackStem must accept the bp:/wt: stems so SendReminder keeps the
// buttons, round-trip to a parseable callback_data, and reject oversize.
func TestValidCallbackStemMeasure(t *testing.T) {
	valid := []string{"bp:1", "bp:1767225600", "wt:1767225600"}
	for _, s := range valid {
		if !ValidCallbackStem(s) {
			t.Errorf("ValidCallbackStem(%q) = false, want true", s)
		}
	}
	invalid := []string{
		"bp:", "bp:abc", "wt:-5",
		"bp:1767225600:skip",            // an already-built callback_data, not a stem
		"bp:99999999999999999999999999", // over the length cap
	}
	for _, s := range invalid {
		if ValidCallbackStem(s) {
			t.Errorf("ValidCallbackStem(%q) = true, want false", s)
		}
	}
	for _, stem := range valid {
		for _, action := range []string{CallbackActionSnooze1h, CallbackActionSkip} {
			data := stem + ":" + action
			if len(data) > 64 {
				t.Errorf("callback_data %q is %d bytes, over Telegram's 64-byte limit", data, len(data))
			}
			if _, _, _, ok := ParseMeasureCallback(data); !ok {
				t.Errorf("accepted stem %q does not round-trip with action %q", stem, action)
			}
		}
	}
}
