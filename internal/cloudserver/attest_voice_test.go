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

// waitVoiceUsed waits until install k's lifetime voice seconds are want (the
// settlement runs in the background, bd med-v1uz).
func (e *attestEnv) waitVoiceUsed(k *ecdsa.PrivateKey, want int) {
	e.t.Helper()
	deadline := time.Now().Add(relayTestDeadline)
	for e.voiceUsed(k) != want {
		if time.Now().After(deadline) {
			e.t.Fatalf("voice used = %d, want %d", e.voiceUsed(k), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// convAnswers sets the fake conversations endpoint's answer.
func (e *attestEnv) convAnswers(f func(id string, n int) (int, string)) { e.convAnswer.Store(f) }

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
	// start is not call_in_progress — and is charged what ElevenLabs says the
	// conversation ran (bd med-v1uz), the rest refunded.
	e.convAnswers(func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "done", 3) })
	_ = device.Close(websocket.StatusNormalClosure, "")
	e.waitReaped(k)
	e.waitVoiceUsed(k, 3)
	if e.relay.lookup(out.Call) != nil {
		t.Fatal("hung-up call still resolves")
	}
	rec, out = e.voiceStart(k, 4)
	if rec.Code != http.StatusOK || out.Granted != 120 || out.Remaining != 600-3-120 {
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
// grant up front, and a hang-up whose ElevenLabs session kept talking past the
// grant gets nothing back (bd med-v1uz: the refund is what ElevenLabs did not
// run), so the starts add up to the budget and no more.
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
	// Every session ran past its grant (the fake's default): 4 × 120, the
	// 20 s tail under the floor.
	if starts != 4 || granted != 480 || e.voiceUsed(k) != 480 {
		t.Fatalf("loop: %d starts, %d s granted, %d s charged; want 4 / 480 / 480", starts, granted, e.voiceUsed(k))
	}
}

// bd med-v1uz acceptance (a)-(e): settleVoice refunds grant − the seconds
// ElevenLabs reports, on the reservation's lifetime and UTC-day rows.
func TestAttestVoiceSettle(t *testing.T) {
	logs := &syncBuf{}
	captureSlog(t, slog.NewTextHandler(logs, nil))
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	ctx := context.Background()
	counter := uint32(100)
	reserve := func(k *ecdsa.PrivateKey, global int) (int, time.Time) {
		t.Helper()
		counter++
		now := time.Now().UTC()
		grant, _, _, _, err := e.store.ReserveAttestVoice(ctx, attestKeyID(t, k), counter, now, 1000, 0, global, 120, attestVoiceFloorSeconds)
		if err != nil {
			t.Fatal(err)
		}
		return grant, now
	}
	usage := func(k *ecdsa.PrivateKey) (int, int) {
		life, day, err := e.store.AttestVoiceUsage(ctx, attestKeyID(t, k), time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return life, day
	}
	settle := func(name string, k *ecdsa.PrivateKey, answer func(id string, n int) (int, string), wantLife int) {
		t.Helper()
		e.convAnswers(answer)
		grant, at := reserve(k, 0)
		before, _ := usage(k)
		<-e.attest.settleVoice(attestKeyID(t, k), attestKeyID(t, k), "conv_"+name, at, grant).done
		if life, day := usage(k); life != before-grant+wantLife || day != life {
			t.Fatalf("%s: life %d day %d, want charged %d", name, life, day, wantLife)
		}
	}
	k, other := attestKey(t), attestKey(t)
	e.enrolled(k, "tok-settle")
	e.enrolled(other, "tok-settle-2")

	// (a) 20 s call on a 120 s grant: 100 back on both rows, and the global SUM
	// (other's start sees it: 140 global, 120 of it held until the refund).
	e.convAnswers(func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "done", 20) })
	grant, at := reserve(k, 0)
	if g, _ := reserve(other, 140); g != 0 {
		t.Fatalf("global before the refund granted %d", g)
	}
	<-e.attest.settleVoice(attestKeyID(t, k), attestKeyID(t, k), "conv_a", at, grant).done
	if life, day := usage(k); life != 20 || day != 20 {
		t.Fatalf("(a) life %d day %d, want 20/20", life, day)
	}
	if g, _ := reserve(other, 140); g != 120 {
		t.Fatalf("(a) global after the refund granted %d, want 120", g)
	}
	if l := logs.String(); !strings.Contains(l, "attest voice settle") || !strings.Contains(l, "conversation=conv_a") || !strings.Contains(l, "refunded_seconds=100") {
		t.Fatalf("(a) logs = %q", l)
	}

	// (b) in-progress first, done on the second poll: settles once.
	hits := e.convHits.Load()
	settle("b", k, func(id string, n int) (int, string) {
		if n == 1 {
			return http.StatusOK, elConversation(id, "in-progress", 5)
		}
		return http.StatusOK, elConversation(id, "done", 30)
	}, 30)
	if n := e.convHits.Load() - hits; n != 2 {
		t.Fatalf("(b) polled %d times, want 2", n)
	}
	// failed counts as final too.
	settle("b2", k, func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "failed", 7) }, 7)

	// (c) ran the whole grant or longer: nothing back.
	settle("c", k, func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "done", 120) }, 120)

	// (d) 404 (or still initiated) through the deadline: no session ever ran,
	// full refund — provisional at the first poll, final at the deadline.
	settle("d", k, func(string, int) (int, string) { return http.StatusNotFound, `{"detail":"not found"}` }, 0)
	settle("d2", k, func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "initiated", 0) }, 0)
	if l := logs.String(); !strings.Contains(l, "conversation=conv_d outcome=provisional") || !strings.Contains(l, "conversation=conv_d outcome=never_started") {
		t.Fatalf("(d) logs = %q", l)
	}
	// A provisionally refunded URL used later: the seconds that ran are charged back once.
	settle("d3", k, func(id string, n int) (int, string) {
		if n == 1 {
			return http.StatusNotFound, `{"detail":"not found"}`
		}
		return http.StatusOK, elConversation(id, "done", 50)
	}, 50)

	// (e) 500, or still running, through the deadline: no refund + Warn.
	settle("e", k, func(string, int) (int, string) { return http.StatusInternalServerError, "" }, 120)
	settle("e2", k, func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "in-progress", 60) }, 120)
	if l := logs.String(); !strings.Contains(l, "attest voice settle failed") || !strings.Contains(l, "conversation=conv_e") || strings.Contains(l, "xi-trial") {
		t.Fatalf("(e) logs = %q", l)
	}
	// A provisional refund whose session started but never resolved stands
	// (the bounded under-charge) and Warns.
	settle("e3", k, func(id string, n int) (int, string) {
		if n == 1 {
			return http.StatusNotFound, `{"detail":"not found"}`
		}
		return http.StatusOK, elConversation(id, "in-progress", 10)
	}, 0)
	if l := logs.String(); !strings.Contains(l, "conversation=conv_e3 http_status=200 status=in-progress transport_error=false provisional=true") {
		t.Fatalf("(e3) logs = %q", l)
	}
}

// bd med-v1uz acceptance (h): a never-attached call dropped by the next
// start of a bucket at its cap: the provisional refund lands through the
// relay's settling wait, so the budget check passes; a later done with 50 s
// charges 50 s back.
func TestAttestVoiceNeverAttachedAtCap(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.attest.cfg.VoiceLifetime = 120 // one call
	k := attestKey(t)
	e.enrolled(k, "tok-cap")
	e.convAnswers(func(id string, n int) (int, string) {
		if id == "conv_test1" && n > 2 { // 404 at the drop and the pre-check, then used
			return http.StatusOK, elConversation(id, "done", 50)
		}
		return http.StatusNotFound, `{"detail":"not found"}`
	})
	if rec, _ := e.voiceStart(k, 1); rec.Code != http.StatusOK {
		t.Fatalf("start 1: %d %s", rec.Code, rec.Body.String())
	}
	rec, out := e.voiceStart(k, 2)
	if rec.Code != http.StatusOK || out.Granted != 120 || out.Remaining != 0 {
		t.Fatalf("start at the cap: %d %s", rec.Code, rec.Body.String())
	}
	e.waitVoiceUsed(k, 170) // call 2's 120 + call 1's 50 charged back, past the cap
	e.reapNow(out.Call)
}

// bd med-v1uz acceptance (i): a hang-up whose conversation is still
// processing at drop and done at the next start is refunded by that start's
// pre-check, before ReserveAttestVoice.
func TestAttestVoicePrecheckSettlesBeforeReserve(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.attest.cfg.VoiceLifetime = 120
	e.attest.settlePoll, e.attest.settleFor = time.Hour, time.Hour // only the pre-check polls
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	k := attestKey(t)
	e.enrolled(k, "tok-precheck")
	e.convAnswers(func(id string, n int) (int, string) {
		if n == 1 {
			return http.StatusOK, elConversation(id, "processing", 20)
		}
		return http.StatusOK, elConversation(id, "done", 20)
	})
	_, out := e.voiceStart(k, 1)
	device, err := dialAnonVoice(ctx, srv, out.Call)
	if err != nil {
		t.Fatal(err)
	}
	readVoiceFrame(t, ctx, device) // hello
	_ = device.Close(websocket.StatusNormalClosure, "")
	e.waitReaped(k)
	deadline := time.Now().Add(relayTestDeadline)
	for e.convHits.Load() != 1 { // the hang-up's synchronous first poll
		if time.Now().After(deadline) {
			t.Fatal("no first poll")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if used := e.voiceUsed(k); used != 120 {
		t.Fatalf("refunded while processing: %d", used)
	}
	rec, out := e.voiceStart(k, 2)
	if rec.Code != http.StatusOK || out.Granted != 100 {
		t.Fatalf("start after the pre-check: %d %s", rec.Code, rec.Body.String())
	}
	e.reapNow(out.Call)
}

// bd med-v1uz acceptance (f): one settlement per call — the end hook twice,
// then the relay's own drop, refund once.
func TestAttestVoiceSettlesOnce(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	e.convAnswers(func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "done", 20) })
	k := attestKey(t)
	e.enrolled(k, "tok-once")
	rec, out := e.voiceStart(k, 1)
	if rec.Code != http.StatusOK {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
	c := e.relay.lookup(out.Call)
	c.anon.end(true, 5)
	c.anon.end(true, 5)
	e.reapNow(out.Call) // pending: the relay drops it and runs the hook again
	e.waitVoiceUsed(k, 20)
	time.Sleep(50 * time.Millisecond)
	if used, hits := e.voiceUsed(k), e.convHits.Load(); used != 20 || hits != 1 {
		t.Fatalf("used %d after %d polls, want 20 after 1", used, hits)
	}
}

// bd med-v1uz acceptance (g): the anonymous mint returns the conversation id
// from the signed URL's query (the live-measured location) or a top-level
// field; the account mint asks for none.
func TestMintTrialSignedURLConversationID(t *testing.T) {
	body := `{"signed_url":"wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_trial&conversation_signature=sig&conversation_id=conv_q1"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
	t.Cleanup(srv.Close)
	a := NewTrialProxyAPI(nil, "s", TrialConfig{RatePerMinute: 1, ElevenLabsAPIKey: "xi", ElevenLabsAgentID: "agent_trial"})
	a.elevenLabsSignedURLBase = srv.URL
	if u, id, err := a.mintTrialSignedURL(context.Background(), "install", "k", true); err != nil || id != "conv_q1" || !strings.Contains(u, "conversation_signature=sig") {
		t.Fatalf("query id: %q %q %v", u, id, err)
	}
	if _, id, err := a.mintTrialSignedURL(context.Background(), "account", "a", false); err != nil || id != "" {
		t.Fatalf("account mint id = %q %v", id, err)
	}
	body = `{"signed_url":"wss://x/conversation?conversation_signature=sig","conversation_id":"conv_top"}`
	if _, id, _ := a.mintTrialSignedURL(context.Background(), "install", "k", true); id != "conv_top" {
		t.Fatalf("top-level id = %q", id)
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
	for attached.Load() != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("hung-up end hook ran %d times as attached/unused, want 1", attached.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if e.relay.HasAnonCall("k-attached") {
		t.Fatal("hung-up call still in the table")
	}

	// bd med-v1uz: an exhausted call runs the hook too (it is settled like any other).
	var exhausted atomic.Int32
	call, _ = e.relay.MintAnonCall("k-exhausted", time.Minute, func(bool, int) { exhausted.Add(1) })
	c = e.relay.lookup(call)
	c.anon.timer.Stop()
	e.relay.exhaustAnon(c)
	e.reapNow(call)
	if n := exhausted.Load(); n != 1 {
		t.Fatalf("exhausted call's end hook ran %d times, want 1", n)
	}
}

// bd med-02b0 (Argus 8447), kept by med-v1uz: while the reaper's end hook
// (the settlement's first poll and refund) is still running, the bucket's next
// start waits for it instead of reserving against the old charge.
func TestVoiceAnonAbandonSettlesBeforeNextStart(t *testing.T) {
	relay := NewVoiceLLMRelayAPI(nil, "s")
	relay.attachWindow = 5 * time.Millisecond
	entered, release := make(chan struct{}), make(chan struct{})
	relay.MintAnonCall("k-settle", time.Minute, func(bool, int) { close(entered); <-release })
	select {
	case <-entered: // the reaper dropped the call and is inside the hook
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
		t.Fatal("next start went on before the hook settled")
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

// bd med-02b0 / med-v1uz, end to end: a start no leg attaches to is refunded
// in full (daily and lifetime) at its drop — provisionally, final once its
// settlement deadline passes with ElevenLabs answering 404 — however many a
// day; a retry during a pending call replaces it instead of 409 and reserves
// against the refunded balance; a live or in-grace call still 409s.
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

	// The signed URLs are never used (ElevenLabs knows no such conversation),
	// except the 3rd mint's session, which runs its whole grant.
	e.convAnswers(func(id string, _ int) (int, string) {
		if id == "conv_test3" {
			return http.StatusOK, elConversation(id, "done", 120)
		}
		return http.StatusNotFound, `{"detail":"not found"}`
	})
	e.attest.settleFor = time.Second
	waitUsage := func(want int) {
		t.Helper()
		deadline := time.Now().Add(relayTestDeadline)
		for life, day := usage(); life != want || day != want; life, day = usage() {
			if time.Now().After(deadline) {
				t.Fatalf("usage %d/%d s, want %d", life, day, want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	// Reaped after the attach window: refunded in full at the drop.
	e.relay.attachWindow = 20 * time.Millisecond
	start(1)
	e.waitReaped(k)
	waitUsage(0)
	e.relay.attachWindow = time.Minute
	deadline := time.Now().Add(relayTestDeadline)
	for !strings.Contains(logs.String(), "outcome=never_started") {
		if time.Now().After(deadline) {
			t.Fatalf("logs = %q", logs.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if l := logs.String(); !strings.Contains(l, "attest voice call ended") || !strings.Contains(l, "attached=false") ||
		!strings.Contains(l, "outcome=provisional") || !strings.Contains(l, "refunded_seconds=120") {
		t.Fatalf("logs = %q", l)
	}

	// An instant retry replaces the pending call, no 409, and reserves after
	// the replaced call's refund (the relay's settling wait).
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
	// the call at once, bd med-dngs): 409; a session that ran its grant is
	// charged.
	device, err := dialAnonVoice(ctx, srv, second.Call)
	if err != nil {
		t.Fatal(err)
	}
	readVoiceFrame(t, ctx, device) // hello
	wantErr(t, mustRec(e.voiceStart(k, 4)), http.StatusConflict, "call_in_progress")
	device.CloseNow()
	waitLegDetached(t, e.relay.lookup(second.Call))
	wantErr(t, mustRec(e.voiceStart(k, 5)), http.StatusConflict, "call_in_progress")
	e.reapNow(second.Call)
	time.Sleep(50 * time.Millisecond)
	waitUsage(120)

	// No per-day cap on never-started refunds (med-02b0's 3 a day is gone).
	e.attest.cfg.VoiceDaily = 0
	start(6)
	start(7)
	last := start(8)
	e.reapNow(last.Call)
	waitUsage(120)
}

// bd med-dngs (owner device test, Play build 1092): the app's hang-up is a
// bare ws.close() — a close frame with no status (1005). It must end the call
// at once (no "call_in_progress" on the next start); with ElevenLabs reporting
// no connected seconds the whole grant comes back, however many times (bd
// med-v1uz: the old per-day refund allowance is gone).
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
	e.convAnswers(func(id string, _ int) (int, string) { return http.StatusOK, elConversation(id, "done", 0) })
	waitDay := func(want int) {
		t.Helper()
		deadline := time.Now().Add(relayTestDeadline)
		for day() != want {
			if time.Now().After(deadline) {
				t.Fatalf("day = %d s, want %d", day(), want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	// Bare close, then normal ones: all free the slot and refund in full.
	call(1, websocket.StatusNoStatusRcvd)
	waitDay(0)
	for counter := uint32(2); counter <= 4; counter++ {
		call(counter, websocket.StatusNormalClosure)
		waitDay(0)
	}
}

// bd med-dngs (Argus 11345): a hang-up detaches and drops the call under one
// relay lock, so a re-attach (which holds that lock from lookup to attach)
// can never land between the two and have its live call dropped. Held lock →
// the hung-up leg is still attached; released → the call is gone.
func TestVoiceAnonHangUpDetachesUnderRelayLock(t *testing.T) {
	e := newAttestEnv(t, 50, 0, 0)
	e.voiceOn()
	srv := httptest.NewServer(e.h)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()
	call, _ := e.relay.MintAnonCall("k-lock", time.Minute, nil)
	c := e.relay.lookup(call)
	device, err := dialAnonVoice(ctx, srv, call)
	if err != nil {
		t.Fatal(err)
	}
	readVoiceFrame(t, ctx, device) // hello
	e.relay.mu.Lock()
	_ = device.Close(websocket.StatusNormalClosure, "")
	time.Sleep(100 * time.Millisecond) // the leg's read loop has seen the close
	c.mu.Lock()
	attached := c.conn != nil
	c.mu.Unlock()
	e.relay.mu.Unlock()
	if !attached {
		t.Fatal("hang-up detached outside the relay lock")
	}
	deadline := time.Now().Add(relayTestDeadline)
	for e.relay.HasAnonCall("k-lock") {
		if time.Now().After(deadline) {
			t.Fatal("hung-up call never dropped")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// bd med-dngs (Codex review): a call counts as answered from the first byte
// of the AI's stream, not when the turn returns, so a hang-up mid-answer is
// charged; a swallowed error answer never counts.
func TestAnonTurnWriterMarksFirstByte(t *testing.T) {
	n := 0
	w := &anonTurnWriter{ResponseWriter: httptest.NewRecorder(), onFirst: func() { n++ }}
	_, _ = w.Write([]byte("data: a\n\n"))
	_, _ = w.Write([]byte("data: b\n\n"))
	if n != 1 {
		t.Fatalf("onFirst ran %d times, want 1", n)
	}
	n = 0
	w = &anonTurnWriter{ResponseWriter: httptest.NewRecorder(), onFirst: func() { n++ }}
	w.WriteHeader(http.StatusBadGateway)
	_, _ = w.Write([]byte(`{"error":"upstream"}`))
	if n != 0 {
		t.Fatal("a swallowed error answer counted as answered")
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
