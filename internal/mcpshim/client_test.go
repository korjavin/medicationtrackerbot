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
// recycles it — a proxy timeout, a redeploy, or (before the fix that motivated
// this test) the paired device leg dropping and taking the shim down with it.
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

// A connection that dies mid-call is the relay's business, not the caller's.
// Retry it — and if every attempt dies the same way, say the one thing that is
// actually true and actionable rather than handing the agent a websocket
// close-frame dump (which is what reached a real user: "mcpshim: connection
// dropped: mcpshim: relay connection closed: failed to get reader: received
// close frame: ... reason = \"peer disconnected\"").
func TestClientCall_PersistentDropsRetryThenReportDeviceOffline(t *testing.T) {
	var dials atomic.Int64
	c := NewClientFromPairingWithOptions(newDroppingRelay(t, &dials), nil)

	_, err := c.Call(context.Background(), "mcp_help", map[string]any{})

	if !errors.Is(err, ErrDeviceOffline) {
		t.Fatalf("want ErrDeviceOffline, got %v", err)
	}
	if strings.Contains(err.Error(), "failed to get reader") {
		t.Errorf("raw transport text leaked to the caller: %v", err)
	}
	if got := dials.Load(); got != maxCallAttempts {
		t.Errorf("want %d dial attempts, got %d", maxCallAttempts, got)
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
