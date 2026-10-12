package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
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
//
// ponytail: in-memory call table — a process restart drops every live call;
// the user hangs up and calls again, same as the fallback sentence says.

const (
	voiceLLMCompletionsPath = "/api/voice-llm/chat/completions"

	voiceCallTokenBytes   = 24
	voiceCallGrace        = 30 * time.Second
	voiceNoDeviceWait     = 10 * time.Second
	voiceTurnTimeout      = 120 * time.Second
	voiceDeviceWriteLimit = 10 * time.Second
	voiceMaxBodyBytes     = 2 << 20
	voiceMaxFrameBytes    = 1 << 20
	voiceFrameQueue       = 64

	voiceBadCallMax    = 20
	voiceBadCallWindow = time.Minute

	voiceFallbackText = "I lost the connection to your app — please hang up and call again."
)

// Close codes on the device leg, mirroring the MCP relay's (see StatusNoPairing
// / StatusPairingReplaced): the browser sees a close code, never an HTTP status.
const (
	voiceStatusUnknownCall websocket.StatusCode = 4404
	voiceStatusReplaced    websocket.StatusCode = 4409
)

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

	// Overridable in tests.
	grace        time.Duration
	noDeviceWait time.Duration
	turnTimeout  time.Duration

	mu    sync.Mutex
	calls map[string]*voiceCall
}

// NewVoiceLLMRelayAPI builds the voice LLM relay handlers.
func NewVoiceLLMRelayAPI(store mcpRelayStore, sessionSecret string) *VoiceLLMRelayAPI {
	return &VoiceLLMRelayAPI{
		store:         store,
		sessionSecret: sessionSecret,
		badCalls:      newRateLimiter(voiceBadCallMax, voiceBadCallWindow),
		grace:         voiceCallGrace,
		noDeviceWait:  voiceNoDeviceWait,
		turnTimeout:   voiceTurnTimeout,
		calls:         make(map[string]*voiceCall),
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
}

func (c *voiceCall) expired(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn == nil && !c.expires.IsZero() && now.After(c.expires)
}

// attach makes conn the live leg, replacing (4409) any previous one and
// failing the requests that were in flight on it.
func (c *voiceCall) attach(conn *websocket.Conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
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
	if c.conn != conn {
		return false
	}
	c.failWaitersLocked(conn)
	c.conn = nil
	c.ready = make(chan struct{})
	c.expires = time.Now().Add(grace)
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
	t := time.NewTimer(d)
	defer t.Stop()
	for {
		c.mu.Lock()
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
		}
	}
}

// register allocates the next id on conn; false if conn was replaced or
// dropped in the meantime.
func (c *voiceCall) register(conn *websocket.Conn) (int64, *voiceWaiter, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn != conn {
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
		if c == nil || c.accountID != accountID || c.expired(time.Now()) {
			return nil
		}
	} else {
		b := make([]byte, voiceCallTokenBytes)
		if _, err := rand.Read(b); err != nil {
			panic("voice llm relay: crypto/rand failed: " + err.Error())
		}
		c = &voiceCall{
			token:     base64.RawURLEncoding.EncodeToString(b),
			accountID: accountID,
			ready:     make(chan struct{}),
			waiters:   make(map[int64]*voiceWaiter),
		}
		a.calls[c.token] = c
	}
	c.attach(conn)
	return c
}

// lookup returns the live (attached or within grace) call for token.
func (a *VoiceLLMRelayAPI) lookup(token string) *voiceCall {
	if token == "" {
		return nil
	}
	a.mu.Lock()
	c := a.calls[token]
	a.mu.Unlock()
	if c == nil || c.expired(time.Now()) {
		return nil
	}
	return c
}

// reap drops c once its grace has run out with no leg re-attached.
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
		if c.conn != nil {
			c.failWaitersLocked(c.conn)
			c.conn.CloseNow() // non-blocking, safe under the locks
			c.conn = nil
			c.ready = make(chan struct{})
		}
		c.mu.Unlock()
	}
}

func (a *VoiceLLMRelayAPI) reap(c *voiceCall) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.calls[c.token] == c && c.expired(time.Now()) {
		delete(a.calls, c.token)
	}
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
	// Detach on every exit path (a failed hello included), so even a call that
	// never got a working leg ages out through the grace + reap.
	defer func() {
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
// provider's answer relayed verbatim, or one fixed spoken fallback sentence
// (also for an unknown call) — and never returns content of its own beyond
// that sentence.
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

	call := a.lookup(extra.Call)
	if call == nil {
		if !a.badCalls.Allow(clientIP(r)) {
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		// A custom-llm agent reaches us on EVERY turn, including calls whose
		// relay leg never came up (elevenlabs-call.js then starts the session
		// without the extra body) and calls orphaned by a restart. ElevenLabs
		// does not cascade a custom LLM to a backup model, so an error status
		// would leave the agent silent; answer with the same spoken fallback a
		// known call gets. It carries no data, and misses still count above.
		slog.Info("voice llm relay: unknown call", "has_token", extra.Call != "")
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		writeVoiceFallback(func(s string) error { _, err := io.WriteString(w, s); return err })
		return
	}
	forward, err := json.Marshal(payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}

	// Lift cmd/cloud's 15s read / 45s write server deadlines for this turn.
	rc := http.NewResponseController(w)
	deadline := time.Now().Add(a.noDeviceWait + a.turnTimeout + 15*time.Second)
	_ = rc.SetReadDeadline(deadline)
	_ = rc.SetWriteDeadline(deadline)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = rc.Flush()

	respBytes := 0
	write := func(s string) error {
		n, err := io.WriteString(w, s)
		respBytes += n
		if err == nil {
			err = rc.Flush()
		}
		return err
	}
	outcome := "error"
	defer func() {
		slog.Info("voice llm relay: turn", "account_id", call.accountID, "call", endpointFingerprint(call.token),
			"request_bytes", len(body), "response_bytes", respBytes,
			"duration_ms", time.Since(start).Milliseconds(), "outcome", outcome)
	}()

	turnCtx, cancelTurn := context.WithTimeout(r.Context(), a.noDeviceWait+a.turnTimeout)
	defer cancelTurn()

	var (
		id     int64
		waiter *voiceWaiter
		conn   *websocket.Conn
	)
	for waiter == nil {
		if conn = call.waitConn(turnCtx, a.noDeviceWait); conn == nil {
			if r.Context().Err() != nil {
				outcome = "cancel"
				return
			}
			outcome = "no_device"
			writeVoiceFallback(write)
			return
		}
		id, waiter, _ = call.register(conn)
	}
	defer call.unregister(id, waiter)

	if err := writeDeviceFrame(r.Context(), conn, voiceFrame{ID: id, Type: "request", Body: forward}); err != nil {
		writeVoiceFallback(write)
		return
	}
	cancel := func() { _ = writeDeviceFrame(r.Context(), conn, voiceFrame{ID: id, Type: "cancel"}) }

	turnCtx, cancelTurn = context.WithTimeout(r.Context(), a.turnTimeout)
	defer cancelTurn()
	sawDone := false
	tail := "\n\n" // last two bytes written: the fallback must start a fresh SSE event
	fallback := func() {
		if tail != "\n\n" {
			_ = write("\n\n")
		}
		writeVoiceFallback(write)
	}
	// handle applies one device frame; true ends the turn.
	handle := func(f voiceFrame) bool {
		switch f.Type {
		case "chunk":
			if err := write(f.Data); err != nil {
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
		select {
		case f := <-waiter.ch:
			if handle(f) {
				return
			}
		case <-waiter.gone:
			// Frames read before the leg dropped (maybe its final chunks and
			// end) are already queued; honour them before calling it a failure.
			for {
				select {
				case f := <-waiter.ch:
					if handle(f) {
						return
					}
				default:
					// Leg dropped or this turn overflowed its queue; in the
					// latter case the device is still streaming, so stop it.
					go cancel()
					fallback()
					return
				}
			}
		case <-turnCtx.Done():
			cancel()
			if r.Context().Err() != nil {
				outcome = "cancel"
				return
			}
			fallback()
			return
		}
	}
}

// writeVoiceFallback speaks the one fixed sentence and ends the stream.
func writeVoiceFallback(write func(string) error) {
	chunk := func(delta any, finish any) string {
		b, _ := json.Marshal(map[string]any{
			"id":      "relay",
			"object":  "chat.completion.chunk",
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		})
		return "data: " + string(b) + "\n\n"
	}
	_ = write(chunk(map[string]string{"role": "assistant", "content": voiceFallbackText}, nil))
	_ = write(chunk(map[string]string{}, "stop"))
	_ = write("data: [DONE]\n\n")
}
