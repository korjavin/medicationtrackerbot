package cloudserver

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Anonymous voice (bd med-o7zq.22) over the attest_test.go fixtures: fake
// App Attest/DeviceCheck, fake OpenAI upstream (SSE when stream:true), fake
// ElevenLabs get_signed_url.

// voiceOn turns anonymous voice on: a 600 s lifetime (the default is off),
// no daily cap, the default global and per-call budgets.
func (e *attestEnv) voiceOn() {
	e.trial.cfg.ElevenLabsAPIKey, e.trial.cfg.ElevenLabsAgentID = "xi-trial", "agent_trial"
	e.attest.cfg.VoiceLifetime, e.attest.cfg.VoiceDaily = 600, 0
	e.attest.cfg.VoiceGlobal, e.attest.cfg.VoiceCallMax = attestDefaultVoiceGlobalDaily, attestDefaultVoiceCallMax
}

type voiceStartResp struct {
	SignedURL      string `json:"signed_url"`
	Call           string `json:"call"`
	Granted        int    `json:"granted_seconds"`
	Remaining      int    `json:"remaining_seconds"`
	DailyRemaining int    `json:"daily_remaining_seconds"`
}

// voiceStart is the attested start: empty body, the URI signed.
func (e *attestEnv) voiceStart(k *ecdsa.PrivateKey, counter uint32) (*httptest.ResponseRecorder, voiceStartResp) {
	rec := e.chatAt(k, counter, e.challenge(), attestVoiceStart, attestVoiceStart, "", "")
	var out voiceStartResp
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func (e *attestEnv) enrolled(k *ecdsa.PrivateKey, token string) {
	if rec := e.enroll(k, attestTestAppID, e.challenge(), token); rec.Code != http.StatusOK {
		e.t.Fatalf("enroll: %d %s", rec.Code, rec.Body.String())
	}
}

func (e *attestEnv) voiceUsed(k *ecdsa.PrivateKey) int {
	n, err := e.store.AttestVoiceUsed(context.Background(), attestKeyID(e.t, k))
	if err != nil {
		e.t.Fatal(err)
	}
	return n
}

// voiceTurn is ElevenLabs' custom-LLM POST for call, on the base domain.
func (e *attestEnv) voiceTurn(call string) *httptest.ResponseRecorder {
	return e.do("localhost", voiceLLMCompletionsPath,
		`{"model":"m","n":3,"stream":true,"messages":[{"role":"user","content":"hi"}],"elevenlabs_extra_body":{"call":"`+call+`"}}`, nil)
}

// reapNow ends a detached call's grace at once and reaps it.
func (e *attestEnv) reapNow(token string) {
	c := e.relay.lookup(token)
	if c == nil {
		e.t.Fatal("call not in the relay")
	}
	c.mu.Lock()
	c.expires = time.Now().Add(-time.Second)
	c.mu.Unlock()
	e.relay.reap(c)
}

// waitReaped waits until install k has no call in the relay.
func (e *attestEnv) waitReaped(k *ecdsa.PrivateKey) {
	deadline := time.Now().Add(relayTestDeadline)
	for e.relay.HasAnonCall(attestKeyID(e.t, k)) {
		if time.Now().After(deadline) {
			e.t.Fatal("call never reaped")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func dialAnonVoice(ctx context.Context, srv *httptest.Server, call string) (*websocket.Conn, error) {
	hdr := http.Header{}
	hdr.Set("Origin", localAppOrigin)
	conn, _, err := websocket.Dial(ctx, "ws://localhost"+attestVoiceDevice+"?call="+call,
		&websocket.DialOptions{HTTPClient: wsClientFor(srv.Listener.Addr().String()), HTTPHeader: hdr})
	return conn, err
}

func wantCloseCode(t *testing.T, ctx context.Context, conn *websocket.Conn, code websocket.StatusCode) {
	t.Helper()
	for {
		_, _, err := conn.Read(ctx)
		if err == nil {
			continue
		}
		if got := websocket.CloseStatus(err); got != code {
			t.Fatalf("close = %v (%v), want %d", got, err, code)
		}
		return
	}
}

func waitLegDetached(t *testing.T, c *voiceCall) {
	t.Helper()
	deadline := time.Now().Add(relayTestDeadline)
	for {
		c.mu.Lock()
		gone := c.conn == nil
		c.mu.Unlock()
		if gone {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("device leg never detached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAttestVoiceStartAndHangUp(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	k := attestKey(t)
	e.enrolled(k, "tok-v1")

	// ElevenLabs agent unset: 503 voice_not_configured.
	rec, _ := e.voiceStart(k, 1)
	wantErr(t, rec, http.StatusServiceUnavailable, "voice_not_configured")
	e.voiceOn()

	rec, out := e.voiceStart(k, 2)
	if rec.Code != http.StatusOK || out.Call == "" || !strings.HasPrefix(out.SignedURL, "wss://") || out.Granted != 120 || out.Remaining != 480 ||
		rec.Header().Get("X-Trial-Voice-Remaining") != "480" || rec.Header().Get("X-Attest-Challenge") == "" {
		t.Fatalf("start: %d %s %v", rec.Code, rec.Body.String(), rec.Header())
	}
	if used := e.voiceUsed(k); used != 120 {
		t.Fatalf("charged = %d", used)
	}
	// Single-use signature: one charged start opens one ElevenLabs session.
	if q, _ := e.mintQuery.Load().(string); q != "agent_id=agent_trial&include_conversation_id=true" {
		t.Fatalf("mint query = %q", q)
	}
	// One live call per install.
	rec, _ = e.voiceStart(k, 3)
	wantErr(t, rec, http.StatusConflict, "call_in_progress")

	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	// Unknown token → 4404; an account call's token → 4404 here; the anon
	// token never attaches for an account.
	bad, err := dialAnonVoice(ctx, srv, "nope")
	if err != nil {
		t.Fatal(err)
	}
	wantCloseCode(t, ctx, bad, voiceStatusUnknownCall)
	acct := e.relay.attachLeg("acct-1", "", nil)
	other, err := dialAnonVoice(ctx, srv, acct.token)
	if err != nil {
		t.Fatal(err)
	}
	wantCloseCode(t, ctx, other, voiceStatusUnknownCall)
	if e.relay.attachLeg("acct-1", out.Call, nil) != nil {
		t.Fatal("an account attached an anonymous call")
	}

	// No leg attached yet: no AI answer (the leg gates answers; the start already paid).
	hits := e.upHits.Load()
	if turn := e.voiceTurn(out.Call); turn.Code != http.StatusOK || !strings.Contains(turn.Body.String(), voiceRetry("en")) || e.upHits.Load() != hits {
		t.Fatalf("unattached turn: %d %q", turn.Code, turn.Body.String())
	}

	device, err := dialAnonVoice(ctx, srv, out.Call)
	if err != nil {
		t.Fatal(err)
	}
	if hello := readVoiceFrame(t, ctx, device); hello.Type != "hello" || hello.Call != out.Call {
		t.Fatalf("hello = %+v", hello)
	}

	// Turns are answered by the server: the upstream stream (model stripped),
	// a clamped body, no device frame, the stream limiter (a 1/min shared
	// limiter does not trip), no AI budget.
	e.trial.limiter = newRateLimiter(1, time.Minute)
	for range 2 {
		turn := e.voiceTurn(out.Call)
		if b := turn.Body.String(); turn.Code != http.StatusOK || !strings.Contains(b, "spoken answer") || !strings.Contains(b, "data: [DONE]") || strings.Contains(b, "trial-model") {
			t.Fatalf("turn: %d %q", turn.Code, b)
		}
	}
	if b, _ := e.lastBody.Load().(string); !strings.Contains(b, `"max_completion_tokens":1024`) || strings.Contains(b, `"n":`) || strings.Contains(b, "elevenlabs_extra_body") {
		t.Fatalf("upstream body = %s", b)
	}
	c := e.relay.lookup(out.Call)
	c.mu.Lock()
	sent := c.nextID
	c.mu.Unlock()
	if sent != 0 {
		t.Fatalf("anon turns sent %d device requests", sent)
	}
	// Upstream failure: still HTTP 200, the spoken retry sentence and [DONE].
	e.upstream.Store(500)
	if turn := e.voiceTurn(out.Call); turn.Code != http.StatusOK || !strings.Contains(turn.Body.String(), voiceRetry("en")) || !strings.Contains(turn.Body.String(), "data: [DONE]") {
		t.Fatalf("upstream 500 turn: %d %q", turn.Code, turn.Body.String())
	}
	e.upstream.Store(0)
	// Stream limiter exhausted: spoken retry, no upstream call.
	e.trial.streamLimiter = newRateLimiter(0, time.Minute)
	hits = e.upHits.Load()
	if turn := e.voiceTurn(out.Call); turn.Code != http.StatusOK || !strings.Contains(turn.Body.String(), voiceRetry("en")) || e.upHits.Load() != hits {
		t.Fatalf("stream-limited turn: %d %q", turn.Code, turn.Body.String())
	}
	// Global anonymous turn ceiling (bd med-93u1) exhausted: same, no upstream call.
	e.trial.streamLimiter = newRateLimiter(100, time.Minute)
	e.relay.anonTurns = newRateLimiter(0, time.Minute)
	if turn := e.voiceTurn(out.Call); turn.Code != http.StatusOK || !strings.Contains(turn.Body.String(), voiceRetry("en")) || e.upHits.Load() != hits {
		t.Fatalf("globally limited turn: %d %q", turn.Code, turn.Body.String())
	}
	e.relay.anonTurns = newRateLimiter(100, time.Minute)
	if in, _ := e.store.AttestInstall(context.Background(), attestKeyID(t, k)); in.Used != 0 {
		t.Fatalf("voice turns spent AI requests: %d", in.Used)
	}
	if ok, _, _ := e.store.ConsumeTrialRequest(context.Background(), "probe", time.Now().UTC(), 0, 1); !ok {
		t.Fatal("voice turns spent the AI global budget")
	}

	// Hang up early: the ElevenLabs session may outlive the leg, so nothing is
	// refunded; a new call can start on what is left.
	_ = device.Close(websocket.StatusNormalClosure, "")
	waitLegDetached(t, c)
	e.reapNow(out.Call)
	if used := e.voiceUsed(k); used != 120 {
		t.Fatalf("after hang-up = %d, want the full 120", used)
	}
	if e.relay.lookup(out.Call) != nil {
		t.Fatal("reaped call still resolves")
	}
	rec, out = e.voiceStart(k, 4)
	if rec.Code != http.StatusOK || out.Granted != 120 || out.Remaining != 360 {
		t.Fatalf("restart: %d %s", rec.Code, rec.Body.String())
	}
}

// The attach-then-drop re-mint loop: every start is charged its whole grant,
// so the starts an install can get add up to at most its lifetime budget
// (each ElevenLabs session is then capped by the agent's max_duration_seconds,
// which is kept at or below the per-call grant).
func TestAttestVoiceRemintLoopStaysInBudget(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.attest.cfg.VoiceLifetime = 500 // 120 × 4 + a 20 s tail under the floor
	e.relay.grace = 10 * time.Millisecond
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	k := attestKey(t)
	e.enrolled(k, "tok-loop")
	granted, starts := 0, 0
	for counter := uint32(1); ; counter++ {
		rec, out := e.voiceStart(k, counter)
		if rec.Code == http.StatusTooManyRequests {
			wantErr(t, rec, http.StatusTooManyRequests, "trial_budget_exhausted")
			break
		}
		if rec.Code != http.StatusOK || starts > 10 {
			t.Fatalf("start %d: %d %s", starts, rec.Code, rec.Body.String())
		}
		starts++
		granted += out.Granted
		device, err := dialAnonVoice(ctx, srv, out.Call)
		if err != nil {
			t.Fatal(err)
		}
		readVoiceFrame(t, ctx, device) // hello
		_ = device.Close(websocket.StatusNormalClosure, "")
		e.waitReaped(k)
	}
	if starts != 4 || granted != 480 || e.voiceUsed(k) != 480 {
		t.Fatalf("loop: %d starts, %d s granted, %d s charged; want 4 / 480 / 480", starts, granted, e.voiceUsed(k))
	}
}

func TestAttestVoiceBudgets(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.attest.cfg.VoiceDaily = 300
	e.relay.attachWindow = 20 * time.Millisecond
	k1, k2 := attestKey(t), attestKey(t)
	e.enrolled(k1, "tok-b1")
	e.enrolled(k2, "tok-b2")

	// The per-call max caps the grant; daily 100 caps the next one. Never
	// attached → reaped after the attach window and charged in full.
	rec, out := e.voiceStart(k1, 1)
	if rec.Code != http.StatusOK || out.Granted != 120 || out.Remaining != 480 || out.DailyRemaining != 180 {
		t.Fatalf("call-max grant: %d %s", rec.Code, rec.Body.String())
	}
	e.waitReaped(k1)
	if used := e.voiceUsed(k1); used != 120 {
		t.Fatalf("never-attached call charged %d, want the full 120", used)
	}
	e.attest.cfg.VoiceDaily = 150
	rec, out = e.voiceStart(k1, 2)
	if rec.Code != http.StatusOK || out.Granted != 30 || out.DailyRemaining != 0 {
		t.Fatalf("daily grant: %d %s", rec.Code, rec.Body.String())
	}
	e.waitReaped(k1)

	scopeOf := func(rec *httptest.ResponseRecorder) map[string]string {
		var body map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != http.StatusTooManyRequests || body["error"] != "trial_budget_exhausted" {
			t.Fatalf("want 429 trial_budget_exhausted: %d %s", rec.Code, rec.Body.String())
		}
		return body
	}
	// voice-day: 150 a day, all spent.
	rec, _ = e.voiceStart(k1, 3)
	if b := scopeOf(rec); b["scope"] != cloudstore.AttestScopeVoiceDay || b["resets_at"] == "" {
		t.Fatalf("voice-day: %v", b)
	}
	// global: shared across installs (k1's 150 today).
	e.attest.cfg.VoiceDaily, e.attest.cfg.VoiceGlobal = 0, 170
	rec, _ = e.voiceStart(k2, 1)
	if b := scopeOf(rec); b["scope"] != cloudstore.TrialScopeGlobal || b["resets_at"] == "" {
		t.Fatalf("global: %v", b)
	}
	// voice (lifetime): no resets_at.
	e.attest.cfg.VoiceGlobal, e.attest.cfg.VoiceLifetime = 0, 170
	rec, _ = e.voiceStart(k1, 4)
	if b := scopeOf(rec); b["scope"] != cloudstore.AttestScopeVoice || b["resets_at"] != "" || rec.Header().Get("X-Trial-Voice-Remaining") != "20" {
		t.Fatalf("lifetime: %v %v", b, rec.Header())
	}

	// Mint failure → 502 upstream_error, the reservation refunded in full, no call.
	e.attest.cfg.VoiceLifetime = 600
	e.mintFail.Store(true)
	rec, _ = e.voiceStart(k2, 2)
	wantErr(t, rec, http.StatusBadGateway, "upstream_error")
	if used := e.voiceUsed(k2); used != 0 || e.relay.HasAnonCall(attestKeyID(t, k2)) {
		t.Fatalf("mint failure kept %d s / a call", used)
	}
	if strings.Contains(rec.Body.String(), "xi-trial") || strings.Contains(rec.Body.String(), "agent_trial") {
		t.Fatal("trial config leaked")
	}
}

func TestAttestVoiceBudgetTimer(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	k := attestKey(t)
	e.enrolled(k, "tok-t1")
	rec, out := e.voiceStart(k, 1)
	if rec.Code != http.StatusOK {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	device, err := dialAnonVoice(ctx, srv, out.Call)
	if err != nil {
		t.Fatal(err)
	}
	readVoiceFrame(t, ctx, device) // hello

	// The grant runs out (fired by hand instead of waiting 120 s).
	c := e.relay.lookup(out.Call)
	c.anon.timer.Stop()
	go e.relay.exhaustAnon(c)
	if f := readVoiceFrame(t, ctx, device); f.Type != "budget_exhausted" {
		t.Fatalf("frame = %+v", f)
	}
	wantCloseCode(t, ctx, device, voiceStatusBudget)
	if turn := e.voiceTurn(out.Call); turn.Code != http.StatusOK || !strings.Contains(turn.Body.String(), voiceMinutesUp("en")) {
		t.Fatalf("turn after budget: %d %q", turn.Code, turn.Body.String())
	}
	// A re-attach is refused with the budget code.
	waitLegDetached(t, c)
	again, err := dialAnonVoice(ctx, srv, out.Call)
	if err != nil {
		t.Fatal(err)
	}
	wantCloseCode(t, ctx, again, voiceStatusBudget)
	// Reaped: no refund.
	e.reapNow(out.Call)
	if used := e.voiceUsed(k); used != 120 {
		t.Fatalf("exhausted call refunded: used %d", used)
	}
}

func TestAttestVoiceRouting(t *testing.T) {
	// Attest unconfigured → the existing trial_not_configured on both routes.
	store := setupStore(t)
	mux := http.NewServeMux()
	api := NewAttestAPI(store, NewTrialProxyAPI(store, "s", TrialConfig{RatePerMinute: 1}), nil, AttestConfig{})
	api.SetVoiceRelay(NewVoiceLLMRelayAPI(store, "s"))
	api.RegisterRoutes(mux)
	h := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false)
	routes := [][2]string{{http.MethodPost, attestVoiceStart}, {http.MethodGet, attestVoiceDevice}}
	for _, m := range routes {
		req := httptest.NewRequest(m[0], m[1], nil)
		req.Host = "localhost"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		wantErr(t, rec, http.StatusServiceUnavailable, "trial_not_configured")
	}
	// Account hosts never answer the anonymous voice routes.
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	account, _ := setupInvite(t, e.store)
	for _, m := range routes {
		req := httptest.NewRequest(m[0], m[1], nil)
		req.Host = account.Subdomain + ".localhost"
		rec := httptest.NewRecorder()
		e.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("account host %s: %d", m[1], rec.Code)
		}
	}
	k := attestKey(t)
	e.enrolled(k, "tok-r1")
	// DEFAULT OFF: ElevenLabs + trial AI configured (as in prod) but no
	// TRIAL_ANON_VOICE_* set → the default lifetime 0 → 503, nothing charged.
	e.attest.cfg.VoiceLifetime = attestDefaultVoiceLifetime
	rec, _ := e.voiceStart(k, 1)
	wantErr(t, rec, http.StatusServiceUnavailable, "voice_not_configured")
	if used := e.voiceUsed(k); used != 0 {
		t.Fatalf("default-off charged %d", used)
	}
	// Voice on but trial AI off (the relay answers turns with it): 503.
	e.attest.cfg.VoiceLifetime = 600
	e.trial.cfg.OpenAIAPIKey = ""
	rec, _ = e.voiceStart(k, 2)
	wantErr(t, rec, http.StatusServiceUnavailable, "voice_not_configured")
}

func TestAttestConfigFromEnvVoice(t *testing.T) {
	cfg, err := AttestConfigFromEnv()
	if err != nil || cfg.VoiceLifetime != 0 || cfg.VoiceDaily != 300 || cfg.VoiceGlobal != 7200 || cfg.VoiceCallMax != 120 {
		t.Fatalf("voice defaults (off): %+v %v", cfg, err)
	}
	t.Setenv("TRIAL_ANON_VOICE_LIFETIME_SECONDS", "600")
	t.Setenv("TRIAL_ANON_VOICE_DAILY_SECONDS", "0")
	if cfg, err := AttestConfigFromEnv(); err != nil || cfg.VoiceLifetime != 600 || cfg.VoiceDaily != 0 {
		t.Fatalf("set: %+v %v", cfg, err)
	}
	for name, v := range map[string]string{"TRIAL_ANON_VOICE_GLOBAL_DAILY_SECONDS": "-1", "TRIAL_ANON_VOICE_CALL_MAX_SECONDS": "29"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, v)
			if _, err := AttestConfigFromEnv(); err == nil || !strings.Contains(err.Error(), name) || strings.Contains(err.Error(), v) {
				t.Fatalf("%s=%s: %v", name, v, err)
			}
		})
	}
}
