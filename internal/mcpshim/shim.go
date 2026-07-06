package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
)

// CallTimeout bounds how long Call waits for a correlated response. There is
// exactly one reason a call never returns on this transport: no unlocked
// device is on the other end of the relay (the relay itself only drops or
// delays frames — docs/cloud-mode.md's trust recap — it never fabricates a
// response), so the timeout maps directly to ErrDeviceOffline.
const CallTimeout = 30 * time.Second

// ErrDeviceOffline is Call's error when no response arrives within
// CallTimeout. Text matches the plan's locked "offline-device UX" decision
// verbatim so cmd/mcpshim (Task 5) can surface it as the MCP tool error
// without rewrapping.
//nolint:staticcheck // ST1005: this is a terminal, user-facing sentence relayed verbatim to the model (the plan's locked offline-device UX text), not a wrapped Go error.
var ErrDeviceOffline = errors.New("No unlocked Med Tracker device is online. Open your app at https://<sub>.<base> and unlock it, then retry — this connector talks to your device, not to a server, because your data is end-to-end encrypted.")

// errConnectionDropped marks a Call failure caused by this ShimCore's own
// relay connection already having died (most often because the relay closed
// the shim leg in lockstep with its paired device leg dropping — serveLeg's
// symmetric close). Client matches this with errors.Is to redial and retry
// once, so the caller sees a real CallTimeout wait against a fresh
// connection (and thus ErrDeviceOffline) instead of this raw transport
// error.
var errConnectionDropped = errors.New("mcpshim: connection dropped")

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

// Dial parses code (the MEDTRACKER_MCP_CODE value) and connects to its
// relay's shim leg.
func Dial(ctx context.Context, code string) (*ShimCore, error) {
	pc, err := ParsePairingCode(code)
	if err != nil {
		return nil, err
	}
	return DialPairing(ctx, pc)
}

// DialPairing connects using an already-parsed pairing code — the seam Task
// 5's integration test uses to dial a local httptest relay directly.
func DialPairing(ctx context.Context, pc *PairingCode) (*ShimCore, error) {
	return DialPairingWithOptions(ctx, pc, nil)
}

// DialPairingWithOptions is DialPairing with the underlying
// coder/websocket.DialOptions exposed, so a test can force the socket
// through an httptest.Server's real listener address while still sending
// the pairing's real relay host (cloudserver's subdomain router resolves
// the account from the Host header even for the shim leg) — the same
// dial-address override internal/cloudserver's own tests use.
func DialPairingWithOptions(ctx context.Context, pc *PairingCode, opts *websocket.DialOptions) (*ShimCore, error) {
	conn, _, err := websocket.Dial(ctx, pc.RelayURL+"/api/mcp/relay/shim?pairing="+pc.PairingID, opts)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: dial relay: %w", err)
	}
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
		return nil, fmt.Errorf("%w: write frame: %v", errConnectionDropped, err)
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
		return nil, fmt.Errorf("%w: %v", errConnectionDropped, s.closeErr)
	}
}

// Close tears down the relay connection.
func (s *ShimCore) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "shim closing")
}

// isClosed reports whether readLoop has already torn this connection down
// (relay dropped it — most commonly because the paired device went
// offline, per serveLeg's symmetric close). Client uses this to decide
// whether a call needs a fresh Dial before it can proceed.
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
