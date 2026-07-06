package mcpshim

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/coder/websocket"
)

// Client wraps ShimCore with reconnect-on-drop, the single object cmd/mcpshim's
// stdio server calls into for every tool invocation. The relay closes a
// shim leg whenever its paired device leg drops (internal/cloudserver's
// serveLeg closes both sides symmetrically), so a stale ShimCore's next Call
// would otherwise fail immediately with a raw transport error instead of the
// plan's actionable offline text. Reconnecting first means the call instead
// waits out a fresh CallTimeout with nothing to answer it and returns
// ErrDeviceOffline, exactly like the never-paired case.
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

// Call ensures a live connection to the relay, then runs one JSON-RPC
// round-trip through it. If the cached connection turns out to have died
// between the liveness check and the call itself (isClosed's check is
// inherently racy against the relay closing it out from under us), Call
// redials once and retries — see errConnectionDropped.
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	core, err := c.connected(ctx)
	if err != nil {
		return nil, fmt.Errorf("mcpshim: connect to relay: %w", err)
	}
	result, err := core.Call(ctx, method, params)
	if errors.Is(err, errConnectionDropped) {
		core, err = c.redial(ctx)
		if err != nil {
			return nil, fmt.Errorf("mcpshim: reconnect to relay: %w", err)
		}
		return core.Call(ctx, method, params)
	}
	return result, err
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
