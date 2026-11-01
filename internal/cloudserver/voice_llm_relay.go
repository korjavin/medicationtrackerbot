package cloudserver

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Voice LLM relay (bd med-h849): ElevenLabs' custom-LLM hop POSTs every voice
// turn to /api/voice-llm/chat/completions; the server hands the request to the
// caller's unlocked browser tab over a device WebSocket, the browser calls the
// user's own AI (or the trial proxy) and streams the provider's raw SSE text
// back, which is written to ElevenLabs verbatim.
//
// Deliberately no crypto on the device leg: ElevenLabs sends plaintext, so the
// server already holds every turn in transit. It never stores or logs content —
// only sizes, durations and outcomes.
//
// Frames (JSON text messages):
//
//	server -> device  {"type":"hello","call":"<token>"}        first frame on attach
//	server -> device  {"id":n,"type":"request","body":{...}}   one completion request
//	server -> device  {"id":n,"type":"cancel"}                 ElevenLabs dropped turn n
//	device -> server  {"id":n,"type":"chunk","data":"<sse>"}   written verbatim
//	device -> server  {"id":n,"type":"end"}
//	device -> server  {"id":n,"type":"error","message":"..."}
//	server -> device  {"type":"budget_exhausted"}              anonymous call's grant ran out;
//	                                                           the leg is then closed with 4429
//
// ponytail: in-memory call table — a process restart drops every live call;
// the user hangs up and calls again, same as the fallback sentence says.

const (
	voiceLLMCompletionsPath = "/api/voice-llm/chat/completions"

	voiceCallTokenBytes   = 24
	voiceCallGrace        = 30 * time.Second
	voiceCallLifetime     = 4 * time.Hour
	voiceNoDeviceWait     = 10 * time.Second
	voiceTurnTimeout      = 120 * time.Second
	voiceDeviceWriteLimit = 10 * time.Second
	voiceMaxBodyBytes     = 2 << 20
	voiceMaxFrameBytes    = 1 << 20
	voiceFrameQueue       = 64

	// Unknown-token misses per client IP. Real turns arrive from ElevenLabs'
	// egress IPs, so this bucket is shared by every user behind one of them
	// (an orphaned-call burst after a restart): generous, since the 192-bit
	// token, not this limit, is what stops guessing (bd med-93u1).
	voiceBadCallMax    = 60
	voiceBadCallWindow = time.Minute

	// voiceCallTurnsPerMin bounds the turns one known call token drives (own
	// key and anonymous alike), so a leaked token cannot run the user's AI or
	// the trial key faster than a conversation does. Matches the trial stream
	// limiter: one turn per user utterance plus one per tool round.
	voiceCallTurnsPerMin = trialStreamRatePerMin
	// voiceAnonTurnsPerMin is the ceiling on anonymous turns across ALL calls,
	// a belt over the persisted TRIAL_ANON_VOICE_GLOBAL_DAILY_SECONDS budget:
	// that one bounds minutes, this one bounds the trial key's turn rate
	// however many calls run at once (bd med-93u1).
	voiceAnonTurnsPerMin = 600

	// voiceHangUpText is for a call nothing can recover (unknown or expired
	// token); voiceRetryText for every transient failure on a live call — the
	// tab is still open and the next turn may well work (bd med-h849.11).
	// Texts are per language: see voice_lang.go (English is the default).
)

// Close codes on the device leg, mirroring the MCP relay's (see StatusNoPairing
// / StatusPairingReplaced): the browser sees a close code, never an HTTP status.
const (
	voiceStatusUnknownCall websocket.StatusCode = 4404
	voiceStatusReplaced    websocket.StatusCode = 4409
	// voiceStatusBudget ends an anonymous trial call whose minute grant ran out.
	voiceStatusBudget websocket.StatusCode = 4429
)

// Anonymous trial calls (bd med-o7zq.22, docs/cloud-mode.md → Anonymous trial
// → Voice): minted by the attested POST /api/attest/voice/start, the device
// leg attaches with the token alone (GET /api/attest/voice/device?call=), and
// the relay answers their turns itself through the trial proxy — no request
// frame ever goes to the device. The relay never touches money: the minting
// side charged the whole grant up front, because the ElevenLabs session the
// signed URL opened can outlive the leg (see docs/cloud-mode.md, threat model);
// the relay only reports how the call ended (anonVoice.end), and the minting
// side decides what to refund, bounded (bd med-dngs).
const voiceAnonAttachWindow = 60 * time.Second

type anonVoice struct {
	keyID string
	timer *time.Timer
	// end is the minting side's refund hook (bd med-02b0, med-dngs): the relay
	// calls it exactly once when it drops a call whose grant did not run out —
	// attached reports whether a leg ever attached, used the seconds the call
	// is charged (0 when no turn was ever answered, else first attach → drop,
	// rounded up). The relay itself never touches money.
	end func(attached bool, used int)
	// Guarded by the call's mu.
	exhausted  bool
	attached   bool      // a device leg attached at least once; never reset
	attachedAt time.Time // first attach
	answered   bool      // at least one turn got the AI's answer
}

type voiceFrame struct {
	ID      int64           `json:"id,omitempty"`
	Type    string          `json:"type"`
	Call    string          `json:"call,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
	Data    string          `json:"data,omitempty"`
	Message string          `json:"message,omitempty"`
}

// VoiceLLMRelayAPI serves the device leg and the ElevenLabs-facing endpoint.
type VoiceLLMRelayAPI struct {
	store         mcpRelayStore
	sessionSecret string
	badCalls      *rateLimiter
	callTurns     *rateLimiter // keyed by call token
	anonTurns     *rateLimiter // one global key
	// trial answers anonymous calls' turns (SetVoiceRelay wires it); nil = no
	// anonymous calls are ever minted.
	trial *TrialProxyAPI

	// Overridable in tests.
	grace        time.Duration
	noDeviceWait time.Duration
	turnTimeout  time.Duration
	attachWindow time.Duration // anonymous calls: mint → first attach
	callLifetime time.Duration // authenticated calls only; fixed in production
	now          func() time.Time

	mu    sync.Mutex
	calls map[string]*voiceCall
	// settling[subject] is closed once a dropped never-attached call's abandon
	// hook (its refund) has finished, so the bucket's next start reserves
	// against the settled balance (EndPendingAnonCall waits on it).
	settling map[string]chan struct{}
}

// NewVoiceLLMRelayAPI builds the voice LLM relay handlers.
func NewVoiceLLMRelayAPI(store mcpRelayStore, sessionSecret string) *VoiceLLMRelayAPI {
	return &VoiceLLMRelayAPI{
		store:         store,
		sessionSecret: sessionSecret,
		badCalls:      newRateLimiter(voiceBadCallMax, voiceBadCallWindow),
		callTurns:     newRateLimiter(voiceCallTurnsPerMin, time.Minute),
		anonTurns:     newRateLimiter(voiceAnonTurnsPerMin, time.Minute),
		grace:         voiceCallGrace,
		noDeviceWait:  voiceNoDeviceWait,
		turnTimeout:   voiceTurnTimeout,
		attachWindow:  voiceAnonAttachWindow,
		callLifetime:  voiceCallLifetime,
		now:           time.Now,
		calls:         make(map[string]*voiceCall),
		settling:      make(map[string]chan struct{}),
	}
}

// RegisterRoutes adds the device leg (session-authed) and the completion
// endpoint (no session: the per-call token in elevenlabs_extra_body is the
// capability, like /mcp/<token>).
func (a *VoiceLLMRelayAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/voice-llm/device", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeviceSocket)))
	mux.HandleFunc("POST "+voiceLLMCompletionsPath, a.ChatCompletions)
}

// voiceWaiter is one in-flight completion: frames for its id land on ch; gone
// closes when the leg it was sent on detaches; done closes when the HTTP
// request is finished, so a late frame never blocks the device read loop.
type voiceWaiter struct {
	conn *websocket.Conn
	ch   chan voiceFrame
	gone chan struct{}
	done chan struct{}
}

// voiceCall is one call token: at most one live device leg, plus the
// in-flight requests sent over it.
type voiceCall struct {
	token     string
	accountID string

	mu      sync.Mutex
	conn    *websocket.Conn // nil while detached
	ready   chan struct{}   // closed while a conn is attached
	expires time.Time       // set on detach; zero while attached
	nextID  int64
	waiters map[int64]*voiceWaiter
	// Authenticated capabilities have an immutable deadline, independent of
	// reconnect/detach grace. done also wakes a turn that already holds c.
	deadline time.Time
	timer    *time.Timer
	done     chan struct{}
	retired  bool
	now      func() time.Time
	onRetire func()

	anon *anonVoice // non-nil for an anonymous trial call; set at mint, never changed
}

func (c *voiceCall) expired(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.retired || (!c.deadline.IsZero() && !now.Before(c.deadline)) ||
		(c.conn == nil && !c.expires.IsZero() && now.After(c.expires))
}

// retireLocked is idempotent and never waits on a network handshake. Closing
// done/failing waiters happens before the asynchronous 4404 close, so relay
// work stops even when the device or cleanup timer is slow.
func (c *voiceCall) retireLocked() {
	if c.retired {
		return
	}
	c.retired = true
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	close(c.done)
	if c.onRetire != nil {
		// Cached-pointer checks can win the deadline timer. Remove their
		// terminal call from the table without taking a.mu under c.mu.
		go c.onRetire()
	}
	if conn := c.conn; conn != nil {
		c.failWaitersLocked(conn)
		c.conn = nil
		go conn.Close(voiceStatusUnknownCall, "unknown or expired call")
	}
}

func (c *voiceCall) liveLocked() bool {
	if c.retired {
		return false
	}
	if !c.deadline.IsZero() && !c.now().Before(c.deadline) {
		c.retireLocked()
		return false
	}
	return true
}

func (c *voiceCall) live() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.liveLocked()
}

// attach makes conn the live leg, replacing (4409) any previous one and
// failing the requests that were in flight on it.
func (c *voiceCall) attach(conn *websocket.Conn) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.liveLocked() {
		return false
	}
	c.attachLocked(conn)
	return true
}

// attachAnon attaches conn to an anonymous call unless its grant ran out.
func (c *voiceCall) attachAnon(conn *websocket.Conn) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.anon.exhausted {
		return false
	}
	if !c.anon.attached {
		c.anon.attachedAt = c.now()
	}
	c.anon.attached = true
	c.attachLocked(conn)
	return true
}

func (c *voiceCall) attachLocked(conn *websocket.Conn) {
	if old := c.conn; old != nil {
		c.failWaitersLocked(old)
		// Graceful close blocks on the handshake; never under c.mu.
		go old.Close(voiceStatusReplaced, "replaced by a newer device leg")
	} else {
		close(c.ready)
	}
	c.conn = conn
	c.expires = time.Time{}
}

// detach clears conn if it is still the live leg; true starts the grace.
func (c *voiceCall) detach(conn *websocket.Conn, grace time.Duration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.liveLocked() || c.conn != conn {
		return false
	}
	c.failWaitersLocked(conn)
	c.conn = nil
	c.ready = make(chan struct{})
	c.expires = c.now().Add(grace)
	return true
}

func (c *voiceCall) failWaitersLocked(conn *websocket.Conn) {
	for id, w := range c.waiters {
		if w.conn == conn {
			close(w.gone)
			delete(c.waiters, id)
		}
	}
}

// waitConn returns the live leg, waiting up to d for one to attach.
func (c *voiceCall) waitConn(ctx context.Context, d time.Duration) *websocket.Conn {
	c.mu.Lock()
	if !c.deadline.IsZero() {
		d = min(d, c.deadline.Sub(c.now()))
	}
	c.mu.Unlock()
	t := time.NewTimer(d)
	defer t.Stop()
	for {
		c.mu.Lock()
		if !c.liveLocked() {
			c.mu.Unlock()
			return nil
		}
		conn, ready := c.conn, c.ready
		c.mu.Unlock()
		if conn != nil {
			return conn
		}
		select {
		case <-ready:
		case <-t.C:
			return nil
		case <-ctx.Done():
			return nil
		case <-c.done:
			return nil
		}
	}
}

// register allocates the next id on conn; false if conn was replaced or
// dropped in the meantime.
func (c *voiceCall) register(conn *websocket.Conn) (int64, *voiceWaiter, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.liveLocked() || c.conn != conn {
		return 0, nil, false
	}
	c.nextID++
	w := &voiceWaiter{conn: conn, ch: make(chan voiceFrame, voiceFrameQueue), gone: make(chan struct{}), done: make(chan struct{})}
	c.waiters[c.nextID] = w
	return c.nextID, w, true
}

func (c *voiceCall) unregister(id int64, w *voiceWaiter) {
	c.mu.Lock()
	if c.waiters[id] == w {
		delete(c.waiters, id)
	}
	c.mu.Unlock()
	close(w.done)
}

// dispatch routes a device frame to its waiter; unknown ids are dropped.
func (c *voiceCall) dispatch(f voiceFrame) {
	c.mu.Lock()
	if !c.liveLocked() {
		c.mu.Unlock()
		return
	}
	w := c.waiters[f.ID]
	c.mu.Unlock()
	if w == nil {
		return
	}
	// Never block: this runs on the leg's only read loop, which also processes
	// keepalive pongs. A turn whose HTTP client cannot keep up with its queue
	// is failed (gone) instead of stalling every turn on the leg.
	select {
	case w.ch <- f:
	default:
		c.mu.Lock()
		if c.waiters[f.ID] == w {
			close(w.gone)
			delete(c.waiters, f.ID)
		}
		c.mu.Unlock()
	}
}

// attachLeg binds conn to a call: a fresh one (token == "") or the existing
// call token names, if it belongs to accountID and has not expired. It runs
// under a.mu so a reclaim can never race reap into acknowledging an evicted
// call. Returns nil if token names no live call of this account.
func (a *VoiceLLMRelayAPI) attachLeg(accountID, token string, conn *websocket.Conn) *voiceCall {
	a.mu.Lock()
	defer a.mu.Unlock()
	var c *voiceCall
	if token != "" {
		c = a.calls[token]
		if c == nil || c.accountID != accountID || c.expired(a.now()) {
			if c != nil && c.accountID == accountID && c.anon == nil {
				a.dropLocked(c)
			}
			return nil
		}
	} else {
		c = &voiceCall{
			token:     newVoiceCallToken(),
			accountID: accountID,
			ready:     make(chan struct{}),
			waiters:   make(map[int64]*voiceWaiter),
			deadline:  a.now().Add(a.callLifetime),
			done:      make(chan struct{}),
			now:       a.now,
		}
		c.onRetire = func() { a.reap(c) }
		a.calls[c.token] = c
		c.timer = time.AfterFunc(a.callLifetime, func() { a.reap(c) })
	}
	if !c.attach(conn) {
		a.dropLocked(c)
		return nil
	}
	return c
}

// lookup returns the live (attached or within grace) call for token.
func (a *VoiceLLMRelayAPI) lookup(token string) *voiceCall {
	if token == "" {
		return nil
	}
	a.mu.Lock()
	c := a.calls[token]
	if c != nil && c.expired(a.now()) {
		if c.anon == nil {
			a.dropLocked(c)
		}
		c = nil
	}
	a.mu.Unlock()
	return c
}

// RevokeAccount kills every call of accountID (account teardown): tokens stop
// resolving at once, grace included, and live device legs are closed.
func (a *VoiceLLMRelayAPI) RevokeAccount(accountID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for token, c := range a.calls {
		if c.accountID != accountID {
			continue
		}
		delete(a.calls, token)
		c.mu.Lock()
		c.retireLocked()
		c.mu.Unlock()
	}
}

// reap drops a call after detach grace, its hard deadline or retirement.
func (a *VoiceLLMRelayAPI) reap(c *voiceCall) {
	a.mu.Lock()
	var abandon func()
	if a.calls[c.token] == c && c.expired(a.now()) {
		abandon = a.dropLocked(c)
	}
	a.mu.Unlock()
	if abandon != nil {
		abandon() // store I/O: never under a.mu
	}
}

// dropLocked removes c from the table and returns the end hook to run
// (outside a.mu) when c is an anonymous call whose grant did not run out. The
// table delete is the "exactly once": a dropped call is never dropped again.
func (a *VoiceLLMRelayAPI) dropLocked(c *voiceCall) func() {
	delete(a.calls, c.token)
	if c.anon == nil {
		c.mu.Lock()
		c.retireLocked()
		c.mu.Unlock()
		return nil
	}
	c.anon.timer.Stop()
	c.mu.Lock()
	attached, exhausted := c.anon.attached, c.anon.exhausted
	used := 0
	if c.anon.answered {
		used = int((c.now().Sub(c.anon.attachedAt) + time.Second - 1) / time.Second)
	}
	c.mu.Unlock()
	if exhausted || c.anon.end == nil {
		return nil
	}
	// The bucket is free in the table from here on, but its refund is not done
	// yet: a start for the same bucket waits on done before reserving.
	done := make(chan struct{})
	a.settling[c.accountID] = done
	end := c.anon.end
	return func() {
		// Deferred: a panicking hook must still release the bucket's starts.
		defer func() {
			a.mu.Lock()
			if a.settling[c.accountID] == done {
				delete(a.settling, c.accountID)
			}
			a.mu.Unlock()
			close(done)
		}()
		end(attached, used)
	}
}

// EndPendingAnonCall drops bucket keyID's call if no leg ever attached to it
// (its end hook runs before this returns), so a retry after a failed
// attach mints anew instead of waiting out the attach window (bd med-02b0).
// True when the bucket still has a call: live, or within a grace after a
// leg attached — that one still answers call_in_progress. A leg dialing the
// dropped token gets 4404.
func (a *VoiceLLMRelayAPI) EndPendingAnonCall(keyID string) bool {
	subject := cloudstore.AttestSubject(keyID)
	a.mu.Lock()
	var abandons []func()
	// A drop by someone else (the reaper, a concurrent retry) still settling.
	pending := a.settling[subject]
	for _, c := range a.calls {
		if c.accountID != subject || c.anon == nil {
			continue
		}
		c.mu.Lock()
		attached := c.anon.attached
		c.mu.Unlock()
		if !attached {
			if f := a.dropLocked(c); f != nil {
				abandons = append(abandons, f)
			}
		}
	}
	busy := a.hasCallLocked(subject)
	a.mu.Unlock()
	for _, f := range abandons {
		f()
	}
	if pending != nil {
		<-pending
	}
	return busy
}

func newVoiceCallToken() string {
	b := make([]byte, voiceCallTokenBytes)
	if _, err := rand.Read(b); err != nil {
		panic("voice llm relay: crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// HasAnonCall reports whether trial bucket keyID (bd med-o7zq.26: the
// device's budget, shared by its installs) has a call in the table (live,
// pending attach, or within grace): one call per bucket at a time.
func (a *VoiceLLMRelayAPI) HasAnonCall(keyID string) bool {
	subject := cloudstore.AttestSubject(keyID)
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.hasCallLocked(subject)
}

// ponytail: linear scan of the live-call table, fine at one instance's call counts.
func (a *VoiceLLMRelayAPI) hasCallLocked(subject string) bool {
	for _, c := range a.calls {
		if c.accountID == subject {
			return true
		}
	}
	return false
}

// MintAnonCall pre-registers an anonymous trial call for trial bucket keyID with a
// grant of call time. It must be attached within attachWindow; grant after
// the mint the budget timer ends it (budget_exhausted + close 4429). end runs
// once when the relay drops a call whose grant did not run out (nil: none).
// ("", false) when the bucket already has a call.
func (a *VoiceLLMRelayAPI) MintAnonCall(keyID string, grant time.Duration, end func(attached bool, used int)) (string, bool) {
	subject := cloudstore.AttestSubject(keyID)
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.hasCallLocked(subject) {
		return "", false
	}
	c := &voiceCall{
		token:     newVoiceCallToken(),
		accountID: subject,
		ready:     make(chan struct{}),
		expires:   now.Add(a.attachWindow), // pending attach ages out like a grace
		waiters:   make(map[int64]*voiceWaiter),
		anon:      &anonVoice{keyID: keyID, end: end},
		done:      make(chan struct{}),
		now:       a.now,
	}
	a.calls[c.token] = c
	c.anon.timer = time.AfterFunc(grant, func() { a.exhaustAnon(c) })
	time.AfterFunc(a.attachWindow+time.Millisecond, func() { a.reap(c) })
	slog.Info("voice llm relay: anon call minted", "account_id", subject, "call", endpointFingerprint(c.token), "grant_seconds", int(grant.Seconds()))
	return c.token, true
}

// exhaustAnon ends an anonymous call whose grant ran out: later turns speak
// the minutes-used-up sentence until the call is reaped (no refund).
func (a *VoiceLLMRelayAPI) exhaustAnon(c *voiceCall) {
	c.mu.Lock()
	c.anon.exhausted = true
	conn := c.conn
	if conn == nil {
		c.expires = time.Now().Add(a.grace)
	}
	c.mu.Unlock()
	slog.Info("voice llm relay: anon budget exhausted", "account_id", c.accountID, "call", endpointFingerprint(c.token))
	if conn == nil {
		time.AfterFunc(a.grace+time.Millisecond, func() { a.reap(c) })
		return
	}
	// The leg's detach (serveDeviceLeg) starts the grace and the reap.
	_ = writeDeviceFrame(context.Background(), conn, voiceFrame{Type: "budget_exhausted"})
	_ = conn.Close(voiceStatusBudget, "voice budget exhausted")
}

func writeVoiceFrame(ctx context.Context, conn *websocket.Conn, f voiceFrame) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

// writeDeviceFrame writes to the device leg with a bounded context that is NOT
// cancelled by the caller: a cancelled write ctx makes coder/websocket close
// the connection (see peerWriteContext), and an ElevenLabs hang-up must never
// tear down the browser's leg.
func writeDeviceFrame(parent context.Context, conn *websocket.Conn, f voiceFrame) error {
	ctx, cancel := peerWriteContext(parent, time.Now().Add(voiceDeviceWriteLimit))
	defer cancel()
	return writeVoiceFrame(ctx, conn, f)
}

// DeviceSocket is the browser leg. A plain attach mints a new call token; an
// attach with ?call=<token> reclaims that call (same account, within grace).
func (a *VoiceLLMRelayAPI) DeviceSocket(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(voiceMaxFrameBytes)

	call := a.attachLeg(session.AccountID, r.URL.Query().Get("call"), conn)
	if call == nil {
		conn.Close(voiceStatusUnknownCall, "unknown or expired call")
		return
	}
	a.serveDeviceLeg(r, conn, call)
}

// AnonDeviceSocket is the device leg of an anonymous trial call (served under
// /api/attest/voice/device by AttestAPI, which already ran the trial gates).
// No session: the token the attested start minted is the capability, as it
// is for ElevenLabs' side. It only attaches anonymous calls (an account
// call's token answers 4404 here, and an anonymous token 4404s on the session
// route because its subject is never an account id).
func (a *VoiceLLMRelayAPI) AnonDeviceSocket(w http.ResponseWriter, r *http.Request) {
	// The iOS and Android local pages (same install, already CORS-trusted on
	// the attest REST routes; bd med-iqbf).
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{localAppOrigin, androidLocalOrigin}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(voiceMaxFrameBytes)

	token := r.URL.Query().Get("call")
	a.mu.Lock()
	call := a.calls[token]
	if call == nil || call.anon == nil || call.expired(time.Now()) {
		a.mu.Unlock()
		conn.Close(voiceStatusUnknownCall, "unknown or expired call")
		return
	}
	attached := call.attachAnon(conn)
	a.mu.Unlock()
	if !attached {
		conn.Close(voiceStatusBudget, "voice budget exhausted")
		return
	}
	a.serveDeviceLeg(r, conn, call)
}

// serveDeviceLeg runs an attached leg until it drops: hello, keepalive, and
// the read loop dispatching chunk/end/error frames.
func (a *VoiceLLMRelayAPI) serveDeviceLeg(r *http.Request, conn *websocket.Conn, call *voiceCall) {
	// Detach on every exit path (a failed hello included), so even a call that
	// never got a working leg ages out through the grace + reap. An anonymous
	// leg the device closed itself (1000, or 1005: a close frame with no
	// status) is the hang-up: the call ends at
	// once, no grace, so the bucket's next start is free (bd med-dngs).
	clean := false
	defer func() {
		if clean && call.anon != nil && call.detach(conn, 0) {
			a.mu.Lock()
			var end func()
			if a.calls[call.token] == call {
				end = a.dropLocked(call)
			}
			a.mu.Unlock()
			slog.Info("voice llm relay: anon call hung up", "account_id", call.accountID, "call", endpointFingerprint(call.token))
			if end != nil {
				end() // store I/O: never under a.mu
			}
			return
		}
		if call.detach(conn, a.grace) {
			slog.Info("voice llm relay: device detached", "account_id", call.accountID, "call", endpointFingerprint(call.token))
			time.AfterFunc(a.grace+time.Millisecond, func() { a.reap(call) })
		}
	}()
	slog.Info("voice llm relay: device attached", "account_id", call.accountID, "call", endpointFingerprint(call.token))
	// On a re-attach a turn already waiting for the leg may get its request
	// frame out before this hello; the browser already knows the token then.
	if err := writeDeviceFrame(r.Context(), conn, voiceFrame{Type: "hello", Call: call.token}); err != nil {
		return
	}

	legCtx, cancelLeg := context.WithCancel(r.Context())
	defer cancelLeg()
	go func() {
		defer cancelLeg()
		keepalive(legCtx, conn, "voice-device", call.accountID)
	}()

	for {
		_, data, err := conn.Read(legCtx)
		if err != nil {
			// The responder's stop() is a bare ws.close(): no status (1005).
			code := websocket.CloseStatus(err)
			clean = code == websocket.StatusNormalClosure || code == websocket.StatusNoStatusRcvd
			break
		}
		var f voiceFrame
		if json.Unmarshal(data, &f) != nil || f.ID == 0 {
			continue
		}
		call.dispatch(f)
	}
}

// ChatCompletions is the ElevenLabs custom-LLM endpoint. Short of the miss
// rate limit it always answers with an SSE stream that ends in [DONE] — the
// provider's answer relayed verbatim, or a fixed spoken fallback sentence
// (hang-up for an unknown call, retry for a transient
// failure) — and never returns content of its own beyond that sentence. A
// device leg that drops before anything was written gets one re-send on the
// leg the browser redials (bd med-h849.11).
func (a *VoiceLLMRelayAPI) ChatCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	body, err := io.ReadAll(io.LimitReader(r.Body, voiceMaxBodyBytes+1))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	if len(body) > voiceMaxBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
		return
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil || payload == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	var extra struct {
		Call string `json:"call"`
	}
	_ = json.Unmarshal(payload["elevenlabs_extra_body"], &extra)
	delete(payload, "elevenlabs_extra_body")

	lang := voiceLang(payload)
	call := a.lookup(extra.Call)
	if call != nil && call.anon != nil && !a.anonHopOK(r) {
		// An anonymous token alone does not prove the POST came from the
		// operator's trial agent (the attested client holds the token too):
		// without the hop secret it is an unknown call. Own-key calls never
		// read the header (bd med-k80h).
		slog.Warn("voice llm relay: anon hop secret mismatch", "has_header", r.Header.Get(voiceRelaySecretHeader) != "")
		call = nil
	}
	if call == nil {
		a.unknownCall(w, r, lang, extra.Call != "")
		return
	}
	allowed := a.callTurns.Allow(call.token)
	if call.anon == nil && !call.live() {
		// The limiter can yield after lookup. Expiry wins even a denial;
		// the existing unknown-token limiter/terminal answer still applies.
		a.unknownCall(w, r, lang, true)
		return
	}
	if !allowed {
		// The call is alive: the retry sentence, never an error status
		// (ElevenLabs would turn that into silence).
		slog.Warn("voice llm relay: call turn rate limited", "account_id", call.accountID, "call", endpointFingerprint(call.token))
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		writeVoiceFallback(func(s string) error { _, err := io.WriteString(w, s); return err }, voiceRetry(lang))
		return
	}
	if call.anon != nil {
		a.anonTurn(w, r, call, payload, lang, len(body), start)
		return
	}
	forward, err := json.Marshal(payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}

	// Lift cmd/cloud's 15s read / 45s write server deadlines for this turn.
	rc := http.NewResponseController(w)
	// Logical expiry is enforced below, not by poisoning the HTTP writer's
	// socket at cutoff. Already-admitted I/O keeps its existing finite bound;
	// the terminal operation gets one bounded cleanup allowance.
	deadline := time.Now().Add(a.noDeviceWait + a.turnTimeout + 15*time.Second)
	_ = rc.SetReadDeadline(deadline)
	_ = rc.SetWriteDeadline(deadline)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = rc.Flush()

	respBytes := 0
	ttfcMs := int64(-1) // -1: no chunk written
	write := func(s string) error {
		n, err := io.WriteString(w, s)
		respBytes += n
		if ttfcMs < 0 && err == nil && s != "" {
			ttfcMs = time.Since(start).Milliseconds()
		}
		if err == nil {
			err = rc.Flush()
		}
		return err
	}
	outcome := "error"
	defer func() {
		slog.Info("voice llm relay: turn", "account_id", call.accountID, "call", endpointFingerprint(call.token),
			"request_bytes", len(body), "response_bytes", respBytes,
			"duration_ms", time.Since(start).Milliseconds(), "ttfc_ms", ttfcMs, "outcome", outcome)
	}()

	var (
		id     int64
		waiter *voiceWaiter
		conn   *websocket.Conn
	)
	sawDone := false
	tail := "\n\n" // last two bytes written; terminal SSE starts a fresh event
	terminalStarted := false
	// Expiry is terminal, unlike a transient device drop. Never splice a
	// spoken fallback into an answer whose model output already started.
	expired := func() {
		if terminalStarted {
			return
		}
		terminalStarted = true
		outcome = "expired"
		// Only terminal SSE is allowed beyond the model-write deadline.
		_ = rc.SetWriteDeadline(time.Now().Add(voiceDeviceWriteLimit))
		if respBytes == 0 {
			writeVoiceFallback(write, voiceHangUp(lang))
		} else if !sawDone {
			if tail != "\n\n" {
				_ = write("\n\n")
			}
			_ = write("data: [DONE]\n\n")
		}
	}
	defer func() {
		if waiter != nil {
			call.unregister(id, waiter)
		}
	}()
	// send waits for a live leg, registers the turn on it and writes the
	// request frame; false means the turn already ended (fallback or cancel).
	send := func() bool {
		waitCtx, cancelWait := context.WithTimeout(r.Context(), a.noDeviceWait+a.turnTimeout)
		defer cancelWait()
		for waiter == nil {
			if conn = call.waitConn(waitCtx, a.noDeviceWait); conn == nil {
				if !call.live() {
					expired()
					return false
				}
				if r.Context().Err() != nil {
					outcome = "cancel"
					return false
				}
				outcome = "no_device"
				writeVoiceFallback(write, voiceRetry(lang))
				return false
			}
			id, waiter, _ = call.register(conn)
		}
		if !call.live() {
			expired()
			return false
		}
		// Admission is checked immediately before this bounded write. Do not
		// expire its context at the capability boundary: coder/websocket
		// aborts TCP on a cancelled write, preempting the terminal 4404 close.
		err := writeDeviceFrame(r.Context(), conn, voiceFrame{ID: id, Type: "request", Body: forward})
		if !call.live() {
			expired()
			return false
		}
		if err != nil {
			writeVoiceFallback(write, voiceRetry(lang))
			return false
		}
		return true
	}
	if !send() {
		return
	}
	cancel := func() {
		if call.live() {
			_ = writeDeviceFrame(r.Context(), conn, voiceFrame{ID: id, Type: "cancel"})
		}
	}

	turnTimer := time.NewTimer(a.turnTimeout) // re-armed on a re-send
	defer turnTimer.Stop()
	resent := false
	fallback := func() {
		if !call.live() {
			expired()
			return
		}
		if tail != "\n\n" {
			_ = write("\n\n")
		}
		if !call.live() {
			expired()
			return
		}
		writeVoiceFallback(write, voiceRetry(lang))
	}
	// handle applies one device frame; true ends the turn.
	handle := func(f voiceFrame) bool {
		if !call.live() {
			expired()
			return true
		}
		switch f.Type {
		case "chunk":
			if err := write(f.Data); err != nil {
				if !call.live() {
					expired()
					return true
				}
				cancel()
				outcome = "cancel"
				return true
			}
			if t := tail + f.Data; len(t) >= 2 {
				tail = t[len(t)-2:]
			}
			// ponytail: per-chunk check; a [DONE] split across chunks just
			// gets a harmless second [DONE] below.
			sawDone = sawDone || strings.Contains(f.Data, "data: [DONE]")
			if !call.live() {
				expired()
				return true
			}
		case "end":
			if !sawDone {
				_ = write("data: [DONE]\n\n")
			}
			outcome = "ok"
			return true
		case "error":
			fallback()
			return true
		}
		return false
	}
	for {
		if !call.live() {
			expired()
			return
		}
		select {
		case <-call.done:
			expired()
			return
		case f := <-waiter.ch:
			if handle(f) {
				return
			}
		case <-waiter.gone:
			if !call.live() {
				expired()
				return
			}
			// Frames read before the leg dropped (maybe its final chunks and
			// end) are already queued; honour them before calling it a failure.
		drain:
			for {
				select {
				case f := <-waiter.ch:
					if handle(f) {
						return
					}
				default:
					break drain
				}
			}
			if !call.live() {
				expired()
				return
			}
			// Leg dropped or this turn overflowed its queue; in the latter
			// case the device is still streaming, so stop it.
			oldConn, oldID := conn, id
			go func() {
				if call.live() {
					_ = writeDeviceFrame(r.Context(), oldConn, voiceFrame{ID: oldID, Type: "cancel"})
				}
			}()
			if resent || respBytes > 0 {
				fallback()
				return
			}
			// Nothing reached ElevenLabs yet: the browser redials with ?call=
			// within the grace, so re-send the request once on the new leg.
			resent = true
			call.unregister(id, waiter)
			waiter = nil
			if !send() {
				return
			}
			_ = rc.SetWriteDeadline(time.Now().Add(a.noDeviceWait + a.turnTimeout + 15*time.Second))
			turnTimer.Reset(a.turnTimeout)
		case <-r.Context().Done():
			if !call.live() {
				expired()
				return
			}
			cancel()
			outcome = "cancel"
			return
		case <-turnTimer.C:
			if !call.live() {
				expired()
				return
			}
			cancel()
			fallback()
			return
		}
	}
}

// unknownCall preserves the public fallback and per-IP miss limiter for both
// initial lookup failures and a capability that expires during admission.
func (a *VoiceLLMRelayAPI) unknownCall(w http.ResponseWriter, r *http.Request, lang string, hasToken bool) {
	if !a.badCalls.Allow(clientIP(r)) {
		slog.Warn("voice llm relay: unknown call rate limited")
		http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
		return
	}
	// ElevenLabs has no backup model for this custom-LLM hop; a terminal
	// spoken answer also covers orphaned calls after a process restart.
	slog.Info("voice llm relay: unknown call", "has_token", hasToken)
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(voiceDeviceWriteLimit))
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	writeVoiceFallback(func(s string) error { _, err := io.WriteString(w, s); return err }, voiceHangUp(lang))
}

// voiceRelaySecretHeader carries TRIAL_VOICE_RELAY_SECRET from the shared trial
// agent (custom_llm.request_headers, set by scripts/provision-trial-agent.mjs).
const voiceRelaySecretHeader = "X-Voice-Relay-Secret"

// anonHopOK reports whether an anonymous call's POST carries the trial agent's
// hop secret. No secret configured = today's unauthenticated hop (cmd/cloud
// warns once at startup).
func (a *VoiceLLMRelayAPI) anonHopOK(r *http.Request) bool {
	if a.trial == nil || a.trial.cfg.VoiceRelaySecret == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(r.Header.Get(voiceRelaySecretHeader)), []byte(a.trial.cfg.VoiceRelaySecret)) == 1
}

// anonTurn answers one turn of an anonymous trial call with the operator's
// trial AI directly (no device frame). Same contract as the forwarded path:
// always HTTP 200 SSE ending in [DONE] — the provider's stream relayed by
// proxyChat, or a spoken sentence (minutes used up; retry on a rate limit or
// any upstream failure). Not counted as a trial AI request: the call's minute
// budget bounds these turns. Content is never logged.
func (a *VoiceLLMRelayAPI) anonTurn(w http.ResponseWriter, r *http.Request, call *voiceCall, payload map[string]json.RawMessage, lang string, reqBytes int, start time.Time) {
	rec := &anonTurnWriter{ResponseWriter: w}
	outcome := "error"
	defer func() {
		// A limiter refusal is what the operator watches for: Warn, same line.
		level := slog.LevelInfo
		if strings.HasSuffix(outcome, "rate_limited") {
			level = slog.LevelWarn
		}
		slog.Log(r.Context(), level, "voice llm relay: turn", "account_id", call.accountID, "call", endpointFingerprint(call.token),
			"request_bytes", reqBytes, "response_bytes", rec.n,
			"duration_ms", time.Since(start).Milliseconds(), "outcome", outcome)
	}()
	speak := func(text string) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		writeVoiceFallback(func(s string) error { n, err := io.WriteString(w, s); rec.n += n; return err }, text)
	}
	call.mu.Lock()
	exhausted, attached := call.anon.exhausted, call.conn != nil
	call.mu.Unlock()
	switch {
	case exhausted:
		outcome = "budget_exhausted"
		speak(voiceMinutesUp(lang))
		return
	case !attached:
		// No AI answer while the leg is not attached (never attached, or
		// within the grace after a drop): a session without the app is not
		// a call the trial pays AI for.
		outcome = "no_device"
		speak(voiceRetry(lang))
		return
	case a.trial == nil:
		speak(voiceRetry(lang))
		return
	case !a.trial.streamLimiter.Allow(call.accountID):
		outcome = "rate_limited"
		speak(voiceRetry(lang))
		return
	case !a.anonTurns.Allow("all"):
		outcome = "global_rate_limited"
		speak(voiceRetry(lang))
		return
	}
	extendTrialDeadlines(w)
	maxTokens := clampMaxTokens(payload, a.trial.cfg.Provider)
	delete(payload, "n")
	payload["stream"] = json.RawMessage("true")
	a.trial.proxyChat(rec, r, "install", call.anon.keyID, payload, false, true, maxTokens)
	if rec.failed || !rec.wrote {
		outcome = "upstream_error"
		speak(voiceRetry(lang))
		return
	}
	outcome = "ok"
	call.mu.Lock()
	call.anon.answered = true
	call.mu.Unlock()
}

// anonTurnWriter passes a 200 stream through and swallows any other answer
// (proxyChat's sanitized JSON 502), so anonTurn can speak instead.
type anonTurnWriter struct {
	http.ResponseWriter
	wrote, failed bool
	n             int
}

func (t *anonTurnWriter) WriteHeader(code int) {
	if t.wrote {
		return
	}
	t.wrote = true
	if code != http.StatusOK {
		t.failed = true
		return
	}
	t.ResponseWriter.WriteHeader(code)
}

func (t *anonTurnWriter) Write(b []byte) (int, error) {
	if !t.wrote {
		t.WriteHeader(http.StatusOK)
	}
	if t.failed {
		return len(b), nil
	}
	n, err := t.ResponseWriter.Write(b)
	t.n += n
	return n, err
}

func (t *anonTurnWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

// writeVoiceFallback speaks one fixed sentence and ends the stream.
func writeVoiceFallback(write func(string) error, text string) {
	chunk := func(delta any, finish any) string {
		b, _ := json.Marshal(map[string]any{
			"id":      "relay",
			"object":  "chat.completion.chunk",
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		})
		return "data: " + string(b) + "\n\n"
	}
	_ = write(chunk(map[string]string{"role": "assistant", "content": text}, nil))
	_ = write(chunk(map[string]string{}, "stop"))
	_ = write("data: [DONE]\n\n")
}
