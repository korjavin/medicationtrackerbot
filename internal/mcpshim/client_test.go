package mcpshim

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
)

// newDroppingRelay stands in for a relay that accepts a shim leg and then
// recycles it — a proxy timeout, a redeploy, or the relay restarting. The
// close lands after the client has already put its request on the wire.
func newDroppingRelay(t *testing.T, dials *atomic.Int64) *PairingCode {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dials.Add(1)
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.CloseNow()
	}))
	t.Cleanup(srv.Close)
	return &PairingCode{
		RelayURL:  "ws://" + srv.Listener.Addr().String(),
		PairingID: "pairing-under-test",
		Key:       make([]byte, pairingKeyBytes),
	}
}

// The safety property: once a request frame is on the wire, a lost connection
// means "unknown", not "failed". Retrying reseals the request under a fresh
// GCM nonce, which the responder's replay ring cannot recognise as a duplicate,
// so an automatic retry could log the same medication dose twice. The call must
// stop after one attempt and say so.
func TestClientCall_DropAfterSendIsNotRetried(t *testing.T) {
	var dials atomic.Int64
	c := NewClientFromPairingWithOptions(newDroppingRelay(t, &dials), nil)

	_, err := c.Call(context.Background(), "mcp_call", map[string]any{"operation_id": "health.bp.create"})

	if !errors.Is(err, ErrCallIndeterminate) {
		t.Fatalf("want ErrCallIndeterminate, got %v", err)
	}
	if got := dials.Load(); got != 1 {
		t.Errorf("a request already on the wire must not be re-sent: %d dials, want 1", got)
	}
	// Both sentinels are relayed verbatim to a model and shown to a user.
	if strings.Contains(err.Error(), "failed to get reader") || strings.Contains(err.Error(), "close frame") {
		t.Errorf("raw transport text leaked to the caller: %v", err)
	}
}

// The complementary case: a request that never left this process has no side
// effect to duplicate, so it is retried on a fresh connection rather than
// becoming the caller's error. Driven directly through ShimCore because the
// only way to reach it is a connection that is already dead when Call writes.
func TestClientCall_UnsentFrameIsRetried(t *testing.T) {
	var dials atomic.Int64
	pc := newDroppingRelay(t, &dials)
	c := NewClientFromPairingWithOptions(pc, nil)

	// Seed the Client with a connection that is already torn down, so the first
	// attempt's Write fails outright (errFrameNotSent) instead of racing it.
	dead, err := DialPairingWithOptions(context.Background(), pc, nil)
	if err != nil {
		t.Fatalf("seed dial: %v", err)
	}
	dead.CloseNow()
	c.core = dead
	seeded := dials.Load()

	_, err = c.Call(context.Background(), "mcp_help", map[string]any{})

	// This relay drops every connection, so the call cannot succeed — what is
	// under test is that the unsent first attempt bought a fresh connection
	// instead of becoming the caller's error.
	if got := dials.Load() - seeded; got == 0 {
		t.Fatalf("want a redial after an unsent frame, got none (err: %v)", err)
	}
}

// The offline message is relayed verbatim to a model and shown to a user, so it
// must not contain the unfilled "https://<sub>.<base>" template the plan's
// locked text carried.
func TestErrDeviceOfflineHasNoURLPlaceholder(t *testing.T) {
	if strings.Contains(ErrDeviceOffline.Error(), "<") {
		t.Fatalf("offline message still carries a placeholder: %q", ErrDeviceOffline.Error())
	}
}
