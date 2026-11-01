package cloudserver

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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

// dropAttached reaps token's call as if a leg had attached, talked past its
// whole grant and dropped (so no refund applies, bd med-02b0 / med-dngs).
func (e *attestEnv) dropAttached(token string) {
	c := e.relay.lookup(token)
	if c == nil {
		e.t.Fatal("call not in the relay")
	}
	usedUp(c)
	e.reapNow(token)
}

// usedUp marks c as attached an hour ago with an answered turn: its end
// charges the whole grant.
func usedUp(c *voiceCall) {
	c.mu.Lock()
	c.anon.attached, c.anon.answered, c.anon.attachedAt = true, true, time.Now().Add(-time.Hour)
	c.mu.Unlock()
}

// dropAttachedUnused reaps token's call as if a leg had attached and dropped
// with no turn ever answered (bd med-dngs: refunded within the allowance).
func (e *attestEnv) dropAttachedUnused(token string) {
	c := e.relay.lookup(token)
	if c == nil {
		e.t.Fatal("call not in the relay")
	}
	c.mu.Lock()
	c.anon.attached, c.anon.attachedAt = true, time.Now()
	c.mu.Unlock()
	e.reapNow(token)
}

// waitReaped waits until install k has no call in the relay and the dropped
// call's refund has settled.
func (e *attestEnv) waitReaped(k *ecdsa.PrivateKey) {
	deadline := time.Now().Add(relayTestDeadline)
	for e.relay.HasAnonCall(attestKeyID(e.t, k)) {
		if time.Now().After(deadline) {
			e.t.Fatal("call never reaped")
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.relay.EndPendingAnonCall(attestKeyID(e.t, k)) // waits on a settling refund
}

func dialAnonVoice(ctx context.Context, srv *httptest.Server, call string) (*websocket.Conn, error) {
	return dialAnonVoiceFrom(ctx, srv, call, localAppOrigin)
}

func dialAnonVoiceFrom(ctx context.Context, srv *httptest.Server, call, origin string) (*websocket.Conn, error) {
	hdr := http.Header{}
	hdr.Set("Origin", origin)
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
	// One live call per install.
	rec, _ = e.voiceStart(k, 3)
	wantErr(t, rec, http.StatusConflict, "call_in_progress")

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

	// Hang up early (bd med-dngs): the call ends at once — no grace, the next
	// start is not call_in_progress — and is charged what it used (turns were
	// answered: at least a second), the rest refunded.
	_ = device.Close(websocket.StatusNormalClosure, "")
	e.waitReaped(k)
	if used := e.voiceUsed(k); used < 1 || used > 5 {
		t.Fatalf("after hang-up = %d, want the seconds used", used)
	}
	if e.relay.lookup(out.Call) != nil {
		t.Fatal("hung-up call still resolves")
	}
	before := e.voiceUsed(k)
	rec, out = e.voiceStart(k, 4)
	if rec.Code != http.StatusOK || out.Granted != 120 || out.Remaining != 600-before-120 {
		t.Fatalf("restart: %d %s", rec.Code, rec.Body.String())
	}
}

// bd med-k80h: with TRIAL_VOICE_RELAY_SECRET set, an anonymous call's turn
// without the trial agent's hop secret is an unknown call — spoken hang-up, a
// Warn line, a badCalls miss, no upstream call — and the right secret answers.
func TestAttestVoiceHopSecret(t *testing.T) {
	logs := &syncBuf{}
	captureSlog(t, slog.NewTextHandler(logs, nil))
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	const secret = "hop-secret-value"
	e.trial.cfg.VoiceRelaySecret = secret
	e.relay.badCalls = newRateLimiter(2, time.Minute)
	k := attestKey(t)
	e.enrolled(k, "tok-hop")
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
	defer device.CloseNow()
	readVoiceFrame(t, ctx, device) // hello

	turn := func(hdr map[string]string) *httptest.ResponseRecorder {
		return e.do("localhost", voiceLLMCompletionsPath,
			`{"stream":true,"messages":[{"role":"user","content":"hi"}],"elevenlabs_extra_body":{"call":"`+out.Call+`"}}`, hdr)
	}
	hits := e.upHits.Load()
	for _, hdr := range []map[string]string{nil, {voiceRelaySecretHeader: "wrong"}} {
		r := turn(hdr)
		if r.Code != http.StatusOK || !strings.Contains(r.Body.String(), voiceHangUp("en")) || strings.Contains(r.Body.String(), secret) {
			t.Fatalf("no/wrong secret turn: %d %q", r.Code, r.Body.String())
		}
	}
	if e.upHits.Load() != hits {
		t.Fatal("a turn without the hop secret reached the trial upstream")
	}
	if l := logs.String(); !strings.Contains(l, "anon hop secret mismatch") || !strings.Contains(l, "has_header=false") ||
		!strings.Contains(l, "has_header=true") || strings.Contains(l, secret) {
		t.Fatalf("logs = %q", l)
	}
	// Both misses counted against badCalls: the third is rate limited.
	if r := turn(nil); r.Code != http.StatusTooManyRequests {
		t.Fatalf("third miss = %d, want 429", r.Code)
	}
	if r := turn(map[string]string{voiceRelaySecretHeader: secret}); r.Code != http.StatusOK || !strings.Contains(r.Body.String(), "spoken answer") {
		t.Fatalf("secret turn: %d %q", r.Code, r.Body.String())
	}
}

// The attach-then-hang-up re-mint loop: every start is charged its whole
// grant up front; a hang-up with no answered turn gets it back only within the
// bucket's refund allowance (bd med-dngs: the lifetime budget here, no daily
// cap), so the starts an install can get add up to at most twice its budget
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
	// 4 refunded in full (480 of the 500 allowance), the 5th gets the last 20
	// back, then 120 × 3 + 40 charged: 9 starts, 1000 s granted, 500 charged.
	if starts != 9 || granted != 1000 || e.voiceUsed(k) != 500 {
		t.Fatalf("loop: %d starts, %d s granted, %d s charged; want 9 / 1000 / 500", starts, granted, e.voiceUsed(k))
	}
}

func TestAttestVoiceBudgets(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.attest.cfg.VoiceDaily = 300
	k1, k2 := attestKey(t), attestKey(t)
	e.enrolled(k1, "tok-b1")
	e.enrolled(k2, "tok-b2")

	// The per-call max caps the grant; daily 100 caps the next one. Attached
	// then dropped → charged in full.
	rec, out := e.voiceStart(k1, 1)
	if rec.Code != http.StatusOK || out.Granted != 120 || out.Remaining != 480 || out.DailyRemaining != 180 {
		t.Fatalf("call-max grant: %d %s", rec.Code, rec.Body.String())
	}
	e.dropAttached(out.Call)
	if used := e.voiceUsed(k1); used != 120 {
		t.Fatalf("attached call charged %d, want the full 120", used)
	}
	e.attest.cfg.VoiceDaily = 150
	rec, out = e.voiceStart(k1, 2)
	if rec.Code != http.StatusOK || out.Granted != 30 || out.DailyRemaining != 0 {
		t.Fatalf("daily grant: %d %s", rec.Code, rec.Body.String())
	}
	e.dropAttached(out.Call)

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

// bd med-iqbf: the anonymous device leg accepts the iOS and the Android local
// page origins, and nothing else cross-origin.
func TestAttestVoiceDeviceOrigins(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	for i, origin := range []string{localAppOrigin, androidLocalOrigin} {
		call, ok := e.relay.MintAnonCall("k-origin-"+string(rune('a'+i)), time.Minute, nil)
		if !ok {
			t.Fatal("mint")
		}
		device, err := dialAnonVoiceFrom(ctx, srv, call, origin)
		if err != nil {
			t.Fatalf("%s: %v", origin, err)
		}
		if hello := readVoiceFrame(t, ctx, device); hello.Type != "hello" || hello.Call != call {
			t.Fatalf("%s hello = %+v", origin, hello)
		}
		device.CloseNow()
	}
	call, _ := e.relay.MintAnonCall("k-origin-evil", time.Minute, nil)
	if device, err := dialAnonVoiceFrom(ctx, srv, call, "https://evil.example"); err == nil {
		device.CloseNow()
		t.Fatal("an arbitrary https origin attached")
	}
}

// bd med-02b0 / med-dngs, relay side: a call reaped with no leg ever attached
// runs its end hook exactly once as never-attached; one the device hung up
// runs it once as attached, at once (no grace), used 0 with no answered turn.
func TestVoiceAnonAbandonHook(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	var pending, attached atomic.Int32
	e.relay.attachWindow = 10 * time.Millisecond
	call, _ := e.relay.MintAnonCall("k-pending", time.Minute, func(att bool, _ int) {
		if !att {
			pending.Add(1)
		}
	})
	c := e.relay.lookup(call)
	deadline := time.Now().Add(relayTestDeadline)
	for e.relay.HasAnonCall("k-pending") {
		if time.Now().After(deadline) {
			t.Fatal("never reaped")
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.relay.reap(c) // a second reap (the exhaust timer's) is a no-op
	if n := pending.Load(); n != 1 {
		t.Fatalf("never-attached abandon ran %d times, want 1", n)
	}

	e.relay.attachWindow = time.Minute
	e.relay.grace = time.Hour // a hang-up must not wait for it
	call, _ = e.relay.MintAnonCall("k-attached", time.Minute, func(att bool, used int) {
		if att && used == 0 {
			attached.Add(1)
		}
	})
	device, err := dialAnonVoice(ctx, srv, call)
	if err != nil {
		t.Fatal(err)
	}
	readVoiceFrame(t, ctx, device) // hello
	_ = device.Close(websocket.StatusNormalClosure, "")
	deadline = time.Now().Add(relayTestDeadline)
	for e.relay.HasAnonCall("k-attached") {
		if time.Now().After(deadline) {
			t.Fatal("never reaped")
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.relay.EndPendingAnonCall("k-attached") // waits for the hook to finish
	if n := attached.Load(); n != 1 {
		t.Fatalf("hung-up end hook ran %d times as attached/unused, want 1", n)
	}
}

// bd med-02b0 (Argus 8447): while the reaper's abandon (the refund) is still
// running, the bucket's next start waits for it instead of reserving against
// the old charge.
func TestVoiceAnonAbandonSettlesBeforeNextStart(t *testing.T) {
	relay := NewVoiceLLMRelayAPI(nil, "s")
	relay.attachWindow = 5 * time.Millisecond
	entered, release := make(chan struct{}), make(chan struct{})
	relay.MintAnonCall("k-settle", time.Minute, func(bool, int) { close(entered); <-release })
	select {
	case <-entered: // the reaper dropped the call and is inside the refund
	case <-time.After(relayTestDeadline):
		t.Fatal("never reaped")
	}
	if relay.HasAnonCall("k-settle") {
		t.Fatal("call still in the table")
	}
	returned := make(chan bool)
	go func() { returned <- relay.EndPendingAnonCall("k-settle") }()
	select {
	case <-returned:
		t.Fatal("next start went on before the refund settled")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case busy := <-returned:
		if busy {
			t.Fatal("bucket reported busy")
		}
	case <-time.After(relayTestDeadline):
		t.Fatal("next start never resumed")
	}
	if relay.EndPendingAnonCall("k-other") {
		t.Fatal("unrelated bucket busy")
	}
}

// Argus 8452: free refunds are capped server-wide too (they give the global
// SUM back), each counted at max(grant, call max), and the cap resets daily.
func TestAttestVoiceFreeAbandonGlobalCap(t *testing.T) {
	a := &AttestAPI{cfg: AttestConfig{VoiceGlobal: 240, VoiceCallMax: 120}} // free cap 120 (half)
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	if !a.takeFreeAbandon("b1", now, 30) { // counted at the 120 call max
		t.Fatal("within the cap: not free")
	}
	if a.takeFreeAbandon("b2", now, 120) {
		t.Fatal("past the server-wide cap: still free")
	}
	if !a.takeFreeAbandon("b3", now.Add(24*time.Hour), 120) {
		t.Fatal("cap did not reset on the next UTC day")
	}
}

// bd med-02b0, end to end: a start no leg attaches to is refunded (daily and
// lifetime), a retry during a pending call replaces it instead of 409, a
// live or in-grace call still 409s, and only 3 abandonments a bucket per UTC
// day are free.
func TestAttestVoiceNeverAttachedRefund(t *testing.T) {
	logs := &syncBuf{}
	captureSlog(t, slog.NewTextHandler(logs, nil))
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.attest.cfg.VoiceDaily = 300
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	k := attestKey(t)
	e.enrolled(k, "tok-abandon")
	usage := func() (int, int) {
		life, day, err := e.store.AttestVoiceUsage(context.Background(), attestKeyID(t, k), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return life, day
	}
	start := func(counter uint32) voiceStartResp {
		t.Helper()
		rec, out := e.voiceStart(k, counter)
		if rec.Code != http.StatusOK {
			t.Fatalf("start %d: %d %s", counter, rec.Code, rec.Body.String())
		}
		return out
	}

	// 1st free abandonment: reaped after the attach window, fully refunded.
	e.relay.attachWindow = 20 * time.Millisecond
	start(1)
	e.waitReaped(k)
	if life, day := usage(); life != 0 || day != 0 {
		t.Fatalf("never-attached call kept %d/%d s", life, day)
	}
	if l := logs.String(); !strings.Contains(l, "attest voice start abandoned") || !strings.Contains(l, "refunded=true") || !strings.Contains(l, "seconds=120") {
		t.Fatalf("logs = %q", l)
	}
	e.relay.attachWindow = time.Minute

	// 2nd: an instant retry replaces the pending call (refunded), no 409.
	first := start(2)
	second := start(3)
	if second.Call == first.Call || e.relay.lookup(first.Call) != nil {
		t.Fatal("the pending call was not replaced")
	}
	if life, day := usage(); life != 120 || day != 120 || second.DailyRemaining != 180 {
		t.Fatalf("after replace: %d/%d s, daily left %d", life, day, second.DailyRemaining)
	}
	stale, err := dialAnonVoice(ctx, srv, first.Call)
	if err != nil {
		t.Fatal(err)
	}
	wantCloseCode(t, ctx, stale, voiceStatusUnknownCall)

	// Live, then in grace after a lost leg (no close frame — a hang-up ends
	// the call at once, bd med-dngs): 409; a call that used its grant is
	// charged.
	device, err := dialAnonVoice(ctx, srv, second.Call)
	if err != nil {
		t.Fatal(err)
	}
	readVoiceFrame(t, ctx, device) // hello
	wantErr(t, mustRec(e.voiceStart(k, 4)), http.StatusConflict, "call_in_progress")
	usedUp(e.relay.lookup(second.Call))
	device.CloseNow()
	waitLegDetached(t, e.relay.lookup(second.Call))
	wantErr(t, mustRec(e.voiceStart(k, 5)), http.StatusConflict, "call_in_progress")
	e.reapNow(second.Call)
	if life, _ := usage(); life != 120 {
		t.Fatalf("attached call refunded: %d", life)
	}

	// 3rd free (replaced by start 7), then the 4th (replaced by start 8) is
	// charged: 120 (attached) + 120 (4th) + 120 (start 8, pending).
	e.attest.cfg.VoiceDaily = 0
	start(6)
	start(7)
	start(8)
	if life, _ := usage(); life != 360 {
		t.Fatalf("after the 4th abandonment: %d s, want 360", life)
	}
	if !strings.Contains(logs.String(), "refunded=false") {
		t.Fatal("4th abandonment not logged as unrefunded")
	}
}

// bd med-dngs (owner device test, Play build 1092): the app's hang-up is a
// bare ws.close() — a close frame with no status (1005). It must end the call
// at once (no "call_in_progress" on the next start) and, with no turn ever
// answered (the agent was never heard), refund the whole grant; refunds stop
// at the bucket's daily cap, so a start/hang-up loop is bounded.
func TestAttestVoiceHangUpFreesSlotAndRefunds(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.attest.cfg.VoiceDaily = 300
	e.relay.grace = time.Hour // a hang-up must not wait for it
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	k := attestKey(t)
	e.enrolled(k, "tok-hangup")
	day := func() int {
		_, d, err := e.store.AttestVoiceUsage(context.Background(), attestKeyID(t, k), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	call := func(counter uint32, status websocket.StatusCode) {
		t.Helper()
		rec, out := e.voiceStart(k, counter)
		if rec.Code != http.StatusOK || out.Granted != 120 {
			t.Fatalf("start %d: %d %s", counter, rec.Code, rec.Body.String())
		}
		device, err := dialAnonVoice(ctx, srv, out.Call)
		if err != nil {
			t.Fatal(err)
		}
		readVoiceFrame(t, ctx, device) // hello
		_ = device.Close(status, "")
		e.waitReaped(k)
	}
	// Bare close, then a normal one: both free the slot and refund in full.
	call(1, websocket.StatusNoStatusRcvd)
	call(2, websocket.StatusNormalClosure)
	if d := day(); d != 0 {
		t.Fatalf("unanswered hung-up calls charged %d s, want 0", d)
	}
	// 240 of the 300 refund allowance used: the third gets 60 back, then none.
	call(3, websocket.StatusNormalClosure)
	if d := day(); d != 60 {
		t.Fatalf("after the allowance: %d s, want 60", d)
	}
	call(4, websocket.StatusNormalClosure)
	if d := day(); d != 180 {
		t.Fatalf("past the allowance: %d s, want 180", d)
	}
}

// bd med-dngs: refunds of unused seconds are capped per bucket per UTC day
// (the daily cap, or the lifetime budget without one) and share the
// server-wide half of the global cap with the free abandons.
func TestAttestVoiceUnusedRefundCaps(t *testing.T) {
	a := &AttestAPI{cfg: AttestConfig{VoiceLifetime: 600, VoiceDaily: 200, VoiceGlobal: 400, VoiceCallMax: 120}}
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	if got := a.takeUnusedRefund("b1", now, 150); got != 150 {
		t.Fatalf("first refund = %d", got)
	}
	if got := a.takeUnusedRefund("b1", now, 120); got != 50 {
		t.Fatalf("bucket cap: got %d, want 50", got)
	}
	if got := a.takeUnusedRefund("b2", now, 120); got != 0 {
		t.Fatalf("global cap (200 = 400/2 used): got %d, want 0", got)
	}
	if got := a.takeUnusedRefund("b1", now.Add(24*time.Hour), 120); got != 120 {
		t.Fatalf("next UTC day: got %d", got)
	}
	a.cfg.VoiceDaily = 0
	if got := a.takeUnusedRefund("b3", now.Add(24*time.Hour), 100); got != 80 {
		t.Fatalf("no daily cap, global 200 - 120 left: got %d, want 80", got)
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
