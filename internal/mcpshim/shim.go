package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
)

// MaxFrameBytes matches the relay's per-frame cap (cloudserver's
// maxRelayFrameBytes). coder/websocket defaults to a 32 KiB read limit, so
// without this the shim would drop the connection on any larger response the
// relay itself passed fine — and since an exceeded read limit CLOSES the
// connection rather than skipping the frame, that surfaces as a spurious
// ErrDeviceOffline on this call and every one after it.
//
// Must never be smaller than the relay's cap; exported so the relay's own test
// can pin the pair (TestRelayFrameCapMatchesShim). Kept in lockstep by hand —
// ponytail: no shared package to import it from, and cloudserver is the wrong
// dependency direction for the shim.
const MaxFrameBytes = 5 << 20

// CallTimeout bounds how long Call waits for a correlated response. There is
// exactly one reason a call never returns on this transport: no unlocked
// device is on the other end of the relay (the relay itself only drops or
// delays frames — docs/cloud-mode.md's trust recap — it never fabricates a
// response), so the timeout maps directly to ErrDeviceOffline.
const CallTimeout = 30 * time.Second

// ErrDeviceOffline is Call's error when no response arrives within
// CallTimeout. It is surfaced by cmd/mcpshim (Task 5) as the MCP tool error
// without rewrapping, so it is written as a terminal user-facing sentence.
//
// The plan's locked text named the app URL as "https://<sub>.<base>", which is
// a template that nothing ever filled in — it reached real users as those
// literal angle brackets. Nobody needs to be told their own address, so the
// sentence just says what to do.
//
//nolint:staticcheck // ST1005: this is a terminal, user-facing sentence relayed verbatim to the model (the plan's offline-device UX text), not a wrapped Go error.
var ErrDeviceOffline = errors.New("No unlocked Med Tracker device is online. Open the Med Tracker app on any device and unlock it, then retry — this connector talks to your device, not to a server, because your data is end-to-end encrypted.")

// errFrameNotSent marks a Call that failed BEFORE its request frame left this
// process — the cached connection was already dead when we tried to write. No
// side effect can have happened, so Client retries it on a fresh connection;
// this is the only error it retries.
var errFrameNotSent = errors.New("mcpshim: request frame not sent")

// ErrCallIndeterminate is Call's error when the connection dropped AFTER the
// request frame went out. The device may or may not have applied it, and we
// cannot find out: the response that would have told us is what got lost.
//
// This must never be retried automatically. The responder's replay ring keys on
// the frame's GCM nonce, which is drawn fresh per attempt, so a re-sent request
// is indistinguishable to it from a new one — an auto-retry here would silently
// log a medication dose twice. Handing the ambiguity to the caller is the only
// honest option, so the sentence says plainly what to do about it.
//
//nolint:staticcheck // ST1005: terminal, user-facing sentence relayed verbatim to the model, not a wrapped Go error.
var ErrCallIndeterminate = errors.New("The connection to your Med Tracker device dropped after this request was sent, so it may or may not have been applied. Check the current state before retrying — a blind retry could apply the same change twice.")

// ShimCore holds one live connection to the relay's shim leg: the pairing
// key, the socket, and the table correlating outstanding requests to their
// responses by JSON-RPC id.
type ShimCore struct {
	conn      *websocket.Conn
	key       []byte
	pairingID string

	nextID atomic.Int64

	mu       sync.Mutex
	pending  map[string]chan *jsonrpc.Response
	closed   chan struct{}
	closeErr error
}

// DialPairingWithOptions connects using an already-parsed pairing code, with
// the underlying coder/websocket.DialOptions exposed, so a test can force the
// socket
// through an httptest.Server's real listener address while still sending
// the pairing's real relay host (cloudserver's subdomain router resolves
// the account from the Host header even for the shim leg) — the same
// dial-address override internal/cloudserver's own tests use.
func DialPairingWithOptions(ctx context.Context, pc *PairingCode, opts *websocket.DialOptions) (*ShimCore, error) {
	conn, _, err := websocket.Dial(ctx, pc.RelayURL+"/api/mcp/relay/shim?pairing="+pc.PairingID, opts)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: dial relay: %w", err)
	}
	conn.SetReadLimit(MaxFrameBytes)
	s := &ShimCore{
		conn:      conn,
		key:       pc.Key,
		pairingID: pc.PairingID,
		pending:   make(map[string]chan *jsonrpc.Response),
		closed:    make(chan struct{}),
	}
	go s.readLoop()
	return s, nil
}

// Call sends method/params as a JSON-RPC request and waits up to
// CallTimeout for the correlated response.
func (s *ShimCore) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, err := jsonrpc.MakeID(float64(s.nextID.Add(1)))
	if err != nil {
		return nil, err
	}
	rawParams, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: marshal params: %w", err)
	}
	payload, err := jsonrpc.EncodeMessage(&jsonrpc.Request{ID: id, Method: method, Params: rawParams})
	if err != nil {
		return nil, fmt.Errorf("mcpshim: encode request: %w", err)
	}
	frame, err := sealFrame(s.key, s.pairingID, payload)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: seal frame: %w", err)
	}

	key := fmt.Sprint(id.Raw())
	respCh := make(chan *jsonrpc.Response, 1)
	s.mu.Lock()
	s.pending[key] = respCh
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, key)
		s.mu.Unlock()
	}()

	if err := s.conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
		return nil, fmt.Errorf("%w: %w", errFrameNotSent, err)
	}

	timer := time.NewTimer(CallTimeout)
	defer timer.Stop()
	select {
	case resp := <-respCh:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-timer.C:
		return nil, ErrDeviceOffline
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.closed:
		// The detail is for the operator; the caller gets the sentence it can
		// act on (see ErrCallIndeterminate).
		slog.Warn("mcpshim: connection dropped after the request was sent",
			"method", method, "error", s.closeErr)
		return nil, ErrCallIndeterminate
	}
}

// Close tears down the relay connection.
func (s *ShimCore) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "shim closing")
}

// CloseNow tears down the relay connection immediately, skipping the graceful
// close handshake. The cloudserver hosted-shim registry uses this under its
// process-wide lifecycleMu, where the graceful Close's ~10s handshake against
// an unresponsive relay peer would head-of-line-block every account's
// enable/disable/pairing endpoints — the same reason the relay's serveLeg
// evictions use CloseNow.
func (s *ShimCore) CloseNow() {
	s.conn.CloseNow()
}

// isClosed reports whether readLoop has already torn this connection down.
// Client uses this to decide whether a call needs a fresh Dial before it can
// proceed.
func (s *ShimCore) isClosed() bool {
	select {
	case <-s.closed:
		return true
	default:
		return false
	}
}

// readLoop decrypts and decodes incoming frames, delivering each Response to
// its correlated Call. Malformed/undecryptable frames are dropped (ponytail:
// PoC — full C4 may log/alert on decrypt failures as a possible attack
// signal); a read error ends the connection and fails every outstanding Call
// with ErrDeviceOffline-shaped context via the closed channel.
func (s *ShimCore) readLoop() {
	ctx := context.Background()
	for {
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			s.failAll(fmt.Errorf("mcpshim: relay connection closed: %w", err))
			return
		}
		payload, err := openFrame(s.key, s.pairingID, data)
		if err != nil {
			continue
		}
		msg, err := jsonrpc.DecodeMessage(payload)
		if err != nil {
			continue
		}
		resp, ok := msg.(*jsonrpc.Response)
		if !ok {
			continue
		}
		key := fmt.Sprint(resp.ID.Raw())
		s.mu.Lock()
		ch, ok := s.pending[key]
		delete(s.pending, key)
		s.mu.Unlock()
		if ok {
			ch <- resp
		}
	}
}

func (s *ShimCore) failAll(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.closed:
	default:
		s.closeErr = err
		close(s.closed)
	}
}
