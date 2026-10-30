package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type voiceRelayFixture struct {
	api     *VoiceLLMRelayAPI
	h       http.Handler
	host    string
	session *http.Cookie
	client  *http.Client
}

func newVoiceRelayFixture(t *testing.T) *voiceRelayFixture {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"
	api := NewVoiceLLMRelayAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long").RegisterRoutes(mux)
	api.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	session := registerAndGetSession(t, h, host, claimToken)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &voiceRelayFixture{api: api, h: h, host: host, session: session, client: wsClientFor(srv.Listener.Addr().String())}
}

// dialDevice attaches a device leg (optionally reclaiming call) and returns it
// with the token from the hello frame.
func (f *voiceRelayFixture) dialDevice(t *testing.T, ctx context.Context, call string) (*websocket.Conn, string) {
	t.Helper()
	hdr := http.Header{}
	hdr.Set("Cookie", f.session.Name+"="+f.session.Value)
	url := "ws://" + f.host + "/api/voice-llm/device"
	if call != "" {
		url += "?call=" + call
	}
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: f.client, HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("dial device: %v", err)
	}
	hello := readVoiceFrame(t, ctx, conn)
	if hello.Type != "hello" || len(hello.Call) < 32 {
		t.Fatalf("hello frame = %+v", hello)
	}
	return conn, hello.Call
}

func readVoiceFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) voiceFrame {
	t.Helper()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("device read: %v", err)
	}
	var f voiceFrame
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("frame %q: %v", data, err)
	}
	return f
}

func sendVoiceFrame(t *testing.T, ctx context.Context, conn *websocket.Conn, f voiceFrame) {
	t.Helper()
	if err := writeVoiceFrame(ctx, conn, f); err != nil {
		t.Fatalf("device write: %v", err)
	}
}

func (f *voiceRelayFixture) post(t *testing.T, ctx context.Context, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+f.host+voiceLLMCompletionsPath, strings.NewReader(body))
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	return resp
}

func (f *voiceRelayFixture) waitDetached(t *testing.T, ctx context.Context, token string) {
	t.Helper()
	for {
		c := f.api.lookup(token)
		c.mu.Lock()
		attached := c.conn != nil
		c.mu.Unlock()
		if !attached {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("device leg never detached")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// Tests 1 + 6: the request reaches the device with elevenlabs_extra_body
// stripped and every other field byte-identical; chunks stream back in order,
// each flushed before the next is sent, and the stream ends with [DONE].
func TestVoiceLLMRelay_StreamsDeviceChunks(t *testing.T) {
	logs := &syncBuf{}
	captureSlog(t, slog.NewTextHandler(logs, nil))
	f := newVoiceRelayFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, token := f.dialDevice(t, ctx, "")
	defer device.CloseNow()

	fields := map[string]string{
		"model":    `"medtracker"`,
		"messages": `[{"role":"user","content":"hi"}]`,
		"stream":   `true`,
		"tools":    `[{"type":"function","function":{"name":"end_call"}}]`,
	}
	body := `{"model":"medtracker","messages":[{"role":"user","content":"hi"}],"stream":true,` +
		`"tools":[{"type":"function","function":{"name":"end_call"}}],"elevenlabs_extra_body":{"call":"` + token + `"}}`
	respCh := make(chan *http.Response, 1)
	go func() { respCh <- f.post(t, ctx, body) }()

	req := readVoiceFrame(t, ctx, device)
	if req.Type != "request" || req.ID == 0 {
		t.Fatalf("request frame = %+v", req)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(req.Body, &got); err != nil {
		t.Fatalf("body: %v", err)
	}
	if _, has := got["elevenlabs_extra_body"]; has {
		t.Fatal("elevenlabs_extra_body was forwarded")
	}
	if len(got) != len(fields) {
		t.Fatalf("forwarded fields = %d, want %d", len(got), len(fields))
	}
	for k, want := range fields {
		if string(got[k]) != want {
			t.Errorf("field %s = %s, want %s", k, got[k], want)
		}
	}

	resp := <-respCh
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	chunk1 := "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n"
	chunk2 := "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n"
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "chunk", Data: chunk1})
	buf := make([]byte, len(chunk1))
	if _, err := io.ReadFull(resp.Body, buf); err != nil || string(buf) != chunk1 {
		t.Fatalf("first chunk = %q, %v (not flushed?)", buf, err)
	}
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "chunk", Data: chunk2})
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "end"})
	rest, _ := io.ReadAll(resp.Body)
	if want := chunk2 + "data: [DONE]\n\n"; string(rest) != want {
		t.Fatalf("rest = %q, want %q", rest, want)
	}
	// The turn log line lands just after the handler returns.
	var line string
	for i := 0; i < 100 && !strings.Contains(line, "voice llm relay: turn"); i++ {
		time.Sleep(20 * time.Millisecond)
		line = logs.String()
	}
	if !strings.Contains(line, "ttfc_ms=") || strings.Contains(line, "ttfc_ms=-1") {
		t.Fatalf("turn log missing a real ttfc_ms: %q", line)
	}
}

// bd med-k80h: the hop secret guards anonymous calls only — an own-key call's
// POST without the header is still forwarded to the user's tab.
func TestVoiceLLMRelay_OwnKeyNeedsNoHopSecret(t *testing.T) {
	f := newVoiceRelayFixture(t)
	f.api.trial = &TrialProxyAPI{cfg: TrialConfig{VoiceRelaySecret: "hop-secret-value"}}
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, token := f.dialDevice(t, ctx, "")
	defer device.CloseNow()
	respCh := make(chan *http.Response, 1)
	go func() { respCh <- f.post(t, ctx, `{"messages":[],"elevenlabs_extra_body":{"call":"`+token+`"}}`) }()
	req := readVoiceFrame(t, ctx, device)
	if req.Type != "request" {
		t.Fatalf("frame = %+v", req)
	}
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "chunk", Data: "data: {}\n\n"})
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "end"})
	resp := <-respCh
	defer resp.Body.Close()
	if out, _ := io.ReadAll(resp.Body); string(out) != "data: {}\n\ndata: [DONE]\n\n" {
		t.Fatalf("own-key turn = %q", out)
	}
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// A device that sends its last chunk + end and closes at once still gets its
// answer through (queued frames win over the leg-gone signal), and a chunk
// cut mid-event is terminated before the fallback starts a fresh event.
func TestVoiceLLMRelay_DrainsBeforeLegGone(t *testing.T) {
	f := newVoiceRelayFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	body := func(tok string) string { return `{"messages":[],"elevenlabs_extra_body":{"call":"` + tok + `"}}` }

	device, token := f.dialDevice(t, ctx, "")
	respCh := make(chan *http.Response, 1)
	go func() { respCh <- f.post(t, ctx, body(token)) }()
	req := readVoiceFrame(t, ctx, device)
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "chunk", Data: "data: {}\n\n"})
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "end"})
	device.CloseNow()
	resp := <-respCh
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(out) != "data: {}\n\ndata: [DONE]\n\n" {
		t.Fatalf("drained turn = %q", out)
	}

	f.waitDetached(t, ctx, token)
	device, _ = f.dialDevice(t, ctx, token)
	defer device.CloseNow()
	go func() { respCh <- f.post(t, ctx, body(token)) }()
	req = readVoiceFrame(t, ctx, device)
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "chunk", Data: `data: {"choi`})
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "error", Message: "provider 500"})
	resp = <-respCh
	out, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.HasPrefix(string(out), "data: {\"choi\n\ndata: {") || strings.Contains(string(out), "provider 500") ||
		!isVoiceRetry(resp.StatusCode, string(out)) {
		t.Fatalf("fallback after a cut event = %q", out)
	}
}

// Account teardown closes the live device leg and kills the token, including
// a call sitting in its reclaim grace.
func TestVoiceLLMRelay_RevokeAccount(t *testing.T) {
	f := newVoiceRelayFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	live, liveTok := f.dialDevice(t, ctx, "")
	defer live.CloseNow()
	parked, parkedTok := f.dialDevice(t, ctx, "")
	parked.Close(websocket.StatusNormalClosure, "")
	f.waitDetached(t, ctx, parkedTok)

	acct := f.api.lookup(liveTok).accountID
	f.api.RevokeAccount(acct)

	if _, _, err := live.Read(ctx); err == nil {
		t.Fatal("live device leg survived account teardown")
	}
	for _, tok := range []string{liveTok, parkedTok} {
		resp := f.post(t, ctx, `{"messages":[],"elevenlabs_extra_body":{"call":"`+tok+`"}}`)
		out, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if !isVoiceFallback(resp.StatusCode, string(out)) {
			t.Fatalf("token after teardown = %d %q, want the spoken fallback", resp.StatusCode, out)
		}
	}
}

// isVoiceFallback reports whether a completion answer is the relay's spoken
// fallback stream — what an unknown call gets instead of an error status the
// custom-llm agent would turn into silence.
func isVoiceFallback(code int, body string) bool {
	return code == http.StatusOK && strings.Contains(body, "please hang up and call again") &&
		strings.HasSuffix(body, "data: [DONE]\n\n")
}

// isVoiceRetry reports whether a completion answer is the transient-failure
// sentence: the call is alive, so it must never tell the user to hang up.
func isVoiceRetry(code int, body string) bool {
	return code == http.StatusOK && strings.Contains(body, "could you say it again") &&
		!strings.Contains(body, "hang up") && strings.HasSuffix(body, "data: [DONE]\n\n")
}

// bd med-h849.11: a leg that drops after the request frame, before anything
// was written, gets the same body re-sent on the leg the browser redials and
// that leg's answer relayed; with no redial within the wait the turn ends in
// the retry sentence, not the hang-up one.
func TestVoiceLLMRelay_LegDropResendsOnReattach(t *testing.T) {
	f := newVoiceRelayFixture(t)
	f.api.noDeviceWait = 300 * time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, token := f.dialDevice(t, ctx, "")
	body := `{"messages":[{"role":"user","content":"hi"}],"elevenlabs_extra_body":{"call":"` + token + `"}}`
	respCh := make(chan *http.Response, 1)
	go func() { respCh <- f.post(t, ctx, body) }()
	req := readVoiceFrame(t, ctx, device)
	device.CloseNow()
	f.waitDetached(t, ctx, token)

	// The waiting turn's request may beat the hello on the new leg.
	hdr := http.Header{}
	hdr.Set("Cookie", f.session.Name+"="+f.session.Value)
	device2, _, err := websocket.Dial(ctx, "ws://"+f.host+"/api/voice-llm/device?call="+token,
		&websocket.DialOptions{HTTPClient: f.client, HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer device2.CloseNow()
	req2 := readVoiceFrame(t, ctx, device2)
	if req2.Type == "hello" {
		req2 = readVoiceFrame(t, ctx, device2)
	} else if hello := readVoiceFrame(t, ctx, device2); hello.Type != "hello" {
		t.Fatalf("second frame = %+v, want hello", hello)
	}
	if req2.Type != "request" || string(req2.Body) != string(req.Body) {
		t.Fatalf("re-sent frame = %+v, want the original body %s", req2, req.Body)
	}
	sendVoiceFrame(t, ctx, device2, voiceFrame{ID: req2.ID, Type: "chunk", Data: "data: {}\n\n"})
	sendVoiceFrame(t, ctx, device2, voiceFrame{ID: req2.ID, Type: "end"})
	resp := <-respCh
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(out) != "data: {}\n\ndata: [DONE]\n\n" {
		t.Fatalf("re-sent turn = %q", out)
	}

	// No redial: the retry sentence once the wait runs out.
	go func() { respCh <- f.post(t, ctx, body) }()
	readVoiceFrame(t, ctx, device2)
	device2.CloseNow()
	resp = <-respCh
	out, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !isVoiceRetry(resp.StatusCode, string(out)) {
		t.Fatalf("leg gone, no redial = %d %q, want the retry sentence", resp.StatusCode, out)
	}
}

// Test 2: unknown or missing token -> spoken fallback; repeated misses from
// one IP -> 429.
func TestVoiceLLMRelay_UnknownCallRateLimited(t *testing.T) {
	f := newVoiceRelayFixture(t)
	f.api.badCalls = newRateLimiter(3, time.Minute)
	do := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, voiceLLMCompletionsPath,
			strings.NewReader(`{"messages":[],"elevenlabs_extra_body":{"call":"nope"}}`))
		req.Host = f.host
		req.Header.Set("X-Forwarded-For", "203.0.113.7")
		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, req)
		return rec
	}
	for i := 0; i < 3; i++ {
		rec := do()
		if !isVoiceFallback(rec.Code, rec.Body.String()) || rec.Header().Get("Content-Type") != "text/event-stream" {
			t.Fatalf("attempt %d = %d %q, want the spoken fallback", i, rec.Code, rec.Body.String())
		}
	}
	logs := &syncBuf{}
	captureSlog(t, slog.NewTextHandler(logs, nil))
	if rec := do(); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4th attempt = %d, want 429", rec.Code)
	}
	if l := logs.String(); !strings.Contains(l, "level=WARN") || !strings.Contains(l, "voice llm relay: unknown call rate limited") {
		t.Fatalf("429 not logged at Warn: %q", l)
	}
}

// bd med-93u1: a known token past its per-call turn rate gets the retry
// sentence (never a status ElevenLabs would turn into silence), the device
// never sees the turn, and the refusal is logged at Warn.
func TestVoiceLLMRelay_CallTurnRateLimited(t *testing.T) {
	logs := &syncBuf{}
	captureSlog(t, slog.NewTextHandler(logs, nil))
	f := newVoiceRelayFixture(t)
	f.api.callTurns = newRateLimiter(1, time.Minute)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, token := f.dialDevice(t, ctx, "")
	defer device.CloseNow()
	body := `{"messages":[{"role":"user","content":"hi"}],"elevenlabs_extra_body":{"call":"` + token + `"}}`

	respCh := make(chan *http.Response, 1)
	go func() { respCh <- f.post(t, ctx, body) }()
	req := readVoiceFrame(t, ctx, device)
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "end"})
	resp := <-respCh
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(out) != "data: [DONE]\n\n" {
		t.Fatalf("first turn = %q", out)
	}

	resp = f.post(t, ctx, body)
	out, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !isVoiceRetry(resp.StatusCode, string(out)) {
		t.Fatalf("limited turn = %d %q, want the retry sentence", resp.StatusCode, out)
	}
	c := f.api.lookup(token)
	c.mu.Lock()
	sent := c.nextID
	c.mu.Unlock()
	if sent != 1 {
		t.Fatalf("device got %d requests, want only the first", sent)
	}
	if l := logs.String(); !strings.Contains(l, "level=WARN") || !strings.Contains(l, "voice llm relay: call turn rate limited") {
		t.Fatalf("limit not logged at Warn: %q", l)
	}
}

// Test 3: a known call with no device leg gets the spoken fallback + [DONE].
func TestVoiceLLMRelay_NoDeviceFallback(t *testing.T) {
	f := newVoiceRelayFixture(t)
	f.api.noDeviceWait = 100 * time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, token := f.dialDevice(t, ctx, "")
	device.Close(websocket.StatusNormalClosure, "")
	f.waitDetached(t, ctx, token)

	start := time.Now()
	resp := f.post(t, ctx, `{"messages":[],"elevenlabs_extra_body":{"call":"`+token+`"}}`)
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if !isVoiceRetry(resp.StatusCode, string(out)) {
		t.Fatalf("fallback = %d %q", resp.StatusCode, out)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("fallback took %v", d)
	}
}

// Test 4: ElevenLabs hanging up mid-stream sends cancel with the turn's id.
func TestVoiceLLMRelay_CancelOnHangup(t *testing.T) {
	f := newVoiceRelayFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, token := f.dialDevice(t, ctx, "")
	defer device.CloseNow()

	postCtx, hangUp := context.WithCancel(ctx)
	respCh := make(chan *http.Response, 1)
	go func() { respCh <- f.post(t, postCtx, `{"messages":[],"elevenlabs_extra_body":{"call":"`+token+`"}}`) }()
	req := readVoiceFrame(t, ctx, device)
	resp := <-respCh
	chunk := "data: {}\n\n"
	sendVoiceFrame(t, ctx, device, voiceFrame{ID: req.ID, Type: "chunk", Data: chunk})
	if _, err := io.ReadFull(resp.Body, make([]byte, len(chunk))); err != nil {
		t.Fatalf("read chunk: %v", err)
	}
	hangUp()
	resp.Body.Close()

	got := readVoiceFrame(t, ctx, device)
	if got.Type != "cancel" || got.ID != req.ID {
		t.Fatalf("frame after hang-up = %+v, want cancel id %d", got, req.ID)
	}
}

// Test 5: re-attaching with ?call= inside the grace keeps the token; after
// the grace it is gone.
func TestVoiceLLMRelay_ReattachWithinGrace(t *testing.T) {
	f := newVoiceRelayFixture(t)
	f.api.grace = 300 * time.Millisecond
	f.api.noDeviceWait = 100 * time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, token := f.dialDevice(t, ctx, "")
	device.Close(websocket.StatusNormalClosure, "")
	f.waitDetached(t, ctx, token)

	device2, token2 := f.dialDevice(t, ctx, token)
	if token2 != token {
		t.Fatalf("re-attach token = %q, want %q", token2, token)
	}
	body := `{"messages":[],"elevenlabs_extra_body":{"call":"` + token + `"}}`
	respCh := make(chan *http.Response, 1)
	go func() { respCh <- f.post(t, ctx, body) }()
	req := readVoiceFrame(t, ctx, device2)
	sendVoiceFrame(t, ctx, device2, voiceFrame{ID: req.ID, Type: "end"})
	resp := <-respCh
	out, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(out) != "data: [DONE]\n\n" {
		t.Fatalf("re-attached turn = %q", out)
	}

	device2.Close(websocket.StatusNormalClosure, "")
	f.waitDetached(t, ctx, token)
	time.Sleep(f.api.grace + 100*time.Millisecond)
	resp = f.post(t, ctx, body)
	out, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !isVoiceFallback(resp.StatusCode, string(out)) {
		t.Fatalf("after grace = %d %q, want the spoken fallback", resp.StatusCode, out)
	}
	// And the device can no longer reclaim it.
	hdr := http.Header{}
	hdr.Set("Cookie", f.session.Name+"="+f.session.Value)
	conn, _, err := websocket.Dial(ctx, "ws://"+f.host+"/api/voice-llm/device?call="+token,
		&websocket.DialOptions{HTTPClient: f.client, HTTPHeader: hdr})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, _, err = conn.Read(ctx)
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != voiceStatusUnknownCall {
		t.Fatalf("expired reclaim err = %v, want close %d", err, voiceStatusUnknownCall)
	}
}

// The base domain forwards exactly the completion path to the API (the shared
// trial agent's fixed URL) and still 404s every other /api/ path.
func TestRouter_BaseDomainForwardsVoiceLLMCompletions(t *testing.T) {
	store := setupStore(t)
	mux := http.NewServeMux()
	NewVoiceLLMRelayAPI(store, "test-session-secret-at-least-32-bytes-long").RegisterRoutes(mux)
	mux.HandleFunc("/api/other", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := New("app.example.com", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)

	req := httptest.NewRequest(http.MethodPost, voiceLLMCompletionsPath, bytes.NewReader([]byte(`{"messages":[]}`)))
	req.Host = "app.example.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	// No extra body at all (the relay leg never came up): the relay still
	// answers with the spoken fallback rather than leaving the agent silent.
	if !isVoiceFallback(rec.Code, rec.Body.String()) {
		t.Fatalf("base-domain completions = %d %q, want the relay's spoken fallback", rec.Code, rec.Body.String())
	}
	if csp := rec.Header().Get("Content-Security-Policy"); bareSchemeToken(cspDirective(csp, "connect-src")) != "" {
		t.Fatalf("CSP widened: %q", csp)
	}

	for _, path := range []string{"/api/other", "/api/voice-llm/device"} {
		req = httptest.NewRequest(http.MethodGet, path, nil)
		req.Host = "app.example.com"
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("base-domain GET %s = %d, want 404", path, rec.Code)
		}
	}
}

// bd med-h849.14: the fallback sentence follows the caller's language, taken
// from the last user message; English stays the default.
func TestVoiceLLMRelay_FallbackInCallerLanguage(t *testing.T) {
	f := newVoiceRelayFixture(t)
	ask := func(body string) string {
		req := httptest.NewRequest(http.MethodPost, voiceLLMCompletionsPath, strings.NewReader(body))
		req.Host = f.host
		rec := httptest.NewRecorder()
		f.h.ServeHTTP(rec, req)
		return rec.Body.String()
	}
	for _, c := range []struct{ msgs, want string }{
		{`[{"role":"user","content":"Привет, как дела?"}]`, "положите трубку"},
		{`[{"role":"user","content":[{"type":"text","text":"Привіт, як справи?"}]}]`, "покладіть слухавку"},
		{`[{"role":"user","content":"Привет"},{"role":"assistant","content":"Hi"},{"role":"user","content":"hello"}]`, "please hang up and call again"},
		{`[]`, "please hang up and call again"},
	} {
		if out := ask(`{"messages":` + c.msgs + `,"elevenlabs_extra_body":{"call":"nope"}}`); !strings.Contains(out, c.want) {
			t.Errorf("messages %s: got %q, want %q", c.msgs, out, c.want)
		}
	}
	for text, want := range map[string]string{"Wie geht's? Schön": "de", "¿Cómo estás?": "es", "ça va très bien": "fr", "hello": "en"} {
		if got := langOfText(text); got != want {
			t.Errorf("langOfText(%q) = %s, want %s", text, got, want)
		}
	}
}
