package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/coder/websocket"
)

// Client wraps ShimCore with reconnect-on-drop, the single object cmd/mcpshim's
// stdio server calls into for every tool invocation. A relay leg outlives many
// calls but not forever — a proxy recycles it, the service redeploys — and a
// stale ShimCore's next Call would otherwise fail with a raw transport error
// instead of an answer. Reconnecting and retrying means a recycled connection
// costs a redial, not the call.
type Client struct {
	pc   *PairingCode
	opts *websocket.DialOptions

	mu   sync.Mutex
	core *ShimCore
}

// NewClient parses code (MEDTRACKER_MCP_CODE) and returns a Client that
// dials lazily on the first Call.
func NewClient(code string) (*Client, error) {
	pc, err := ParsePairingCode(code)
	if err != nil {
		return nil, err
	}
	return &Client{pc: pc}, nil
}

// NewClientFromPairingWithOptions builds a Client from an already-parsed
// pairing code with the underlying coder/websocket.DialOptions exposed,
// mirroring DialPairingWithOptions — the seam the Go integration test uses to
// force every (re)dial through an httptest.Server's real listener address.
func NewClientFromPairingWithOptions(pc *PairingCode, opts *websocket.DialOptions) *Client {
	return &Client{pc: pc, opts: opts}
}

// maxCallAttempts bounds how many connections one Call will burn through
// before giving up. Only a request that never left this process is retried
// (errFrameNotSent), and that fails immediately, so this does not multiply
// CallTimeout: an attempt that gets its frame out and then waits returns
// ErrDeviceOffline or ErrCallIndeterminate, both of which exit the loop.
const maxCallAttempts = 3

// Call ensures a live connection to the relay, then runs one JSON-RPC
// round-trip through it. A connection that dies mid-call is redialed and the
// call retried — the relay recycles a leg for reasons that have nothing to do
// with the request (a proxy timeout, a redeploy), and one of those must not
// become the caller's error.
//
// Only a request that never left this process is retried. Once the frame is
// out we cannot know whether the device applied it, and re-sending would reseal
// it under a fresh nonce that the responder's replay ring cannot match — so
// that case returns ErrCallIndeterminate and stops here rather than risking a
// duplicate write.
//
// Whatever happens, a transport failure never reaches the caller verbatim.
// "relay connection closed: failed to get reader: received close frame" tells
// an agent nothing it can act on; the sentinels tell it (and the user) exactly
// what is true and what to do.
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	var lastErr error
	for attempt := 0; attempt < maxCallAttempts; attempt++ {
		// The first attempt may reuse a cached connection; every retry forces a
		// fresh one, since the reason we are retrying is that the last one died.
		dial := c.connected
		if attempt > 0 {
			dial = c.redial
		}
		core, err := dial(ctx)
		if err != nil {
			// The relay is unreachable or the pairing is gone — neither is a
			// dead device, so say what actually happened.
			return nil, fmt.Errorf("mcpshim: connect to relay: %w", err)
		}
		result, err := core.Call(ctx, method, params)
		if !errors.Is(err, errFrameNotSent) {
			return result, err
		}
		lastErr = err
	}
	// The detail goes to the operator's logs, never into the returned error:
	// this string is relayed verbatim to a model and shown to a user, and a
	// websocket close-frame dump is noise to both.
	slog.Warn("mcpshim: call exhausted its connection attempts",
		"method", method, "attempts", maxCallAttempts, "error", lastErr)
	return nil, ErrDeviceOffline
}

func (c *Client) connected(ctx context.Context) (*ShimCore, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.core != nil && !c.core.isClosed() {
		return c.core, nil
	}
	return c.redialLocked(ctx)
}

func (c *Client) redial(ctx context.Context) (*ShimCore, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.redialLocked(ctx)
}

func (c *Client) redialLocked(ctx context.Context) (*ShimCore, error) {
	core, err := DialPairingWithOptions(ctx, c.pc, c.opts)
	if err != nil {
		return nil, err
	}
	c.core = core
	return core, nil
}

// Close tears down the underlying relay connection, if one was ever dialed
// (Call connects lazily, so a Client that never made a call has nothing to
// close). Used by the cloudserver hosted-shim registry to release a Client
// on Disconnect/re-enable/restore-replace.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.core == nil {
		return nil
	}
	return c.core.Close()
}

// CloseNow tears down the underlying relay connection immediately, without the
// graceful close handshake — the non-blocking teardown the cloudserver
// hosted-shim registry uses while holding its lifecycle lock, where a blocking
// close against an unresponsive peer would stall every account. See
// ShimCore.CloseNow.
func (c *Client) CloseNow() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.core == nil {
		return
	}
	c.core.CloseNow()
}
