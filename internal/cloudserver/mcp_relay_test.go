package cloudserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// newTestMCPRelayHandler wires WebAuthn + the MCP relay routes onto one mux,
// mirroring cmd/cloud/main.go's wiring.
func newTestMCPRelayHandler(t *testing.T) (http.Handler, string, string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken := setupInvite(t, store)
	host := account.Subdomain + ".localhost"

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	relayAPI := NewMCPRelayAPI(store, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	relayAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "", false, false), host, claimToken
}

// mintPairing drives POST /api/mcp/pairings through h directly (no real
// socket needed for a plain JSON request) and returns the pairing id.
func mintPairing(t *testing.T, h http.Handler, host string, session *http.Cookie) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/pairings", nil)
	req.Host = host
	req.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/mcp/pairings status = %d, body %q", rec.Code, rec.Body.String())
	}
	var resp createPairingResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal pairing response: %v", err)
	}
	if resp.PairingID == "" {
		t.Fatalf("empty pairing id")
	}
	return resp.PairingID
}

// wsClientFor returns an http.Client whose Transport dials addr regardless
// of the URL's authority, so tests can address the relay by its real
// account-subdomain Host header ("<sub>.localhost") while actually talking
// to httptest.NewServer's loopback listener.
func wsClientFor(addr string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, network, addr)
			},
		},
	}
}

func TestMCPRelay_FramesPassOpaqueBothWays(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	pairingID := mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	deviceConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device", &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: deviceHeader,
	})
	if err != nil {
		t.Fatalf("dial device: %v", err)
	}
	defer deviceConn.CloseNow()

	shimConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing="+pairingID, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial shim: %v", err)
	}
	defer shimConn.CloseNow()

	// shim -> device: an opaque ciphertext frame, relayed verbatim.
	want := []byte("opaque-ciphertext-shim-to-device")
	if err := shimConn.Write(ctx, websocket.MessageBinary, want); err != nil {
		t.Fatalf("shim write: %v", err)
	}
	_, got, err := deviceConn.Read(ctx)
	if err != nil {
		t.Fatalf("device read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("device got %q, want %q", got, want)
	}

	// device -> shim: the response frame, also relayed verbatim.
	want = []byte("opaque-ciphertext-device-to-shim")
	if err := deviceConn.Write(ctx, websocket.MessageBinary, want); err != nil {
		t.Fatalf("device write: %v", err)
	}
	_, got, err = shimConn.Read(ctx)
	if err != nil {
		t.Fatalf("shim read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("shim got %q, want %q", got, want)
	}
}

func TestMCPRelay_ShimReconnectRebridgesBothWays(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	pairingID := mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	deviceConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device", &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: deviceHeader,
	})
	if err != nil {
		t.Fatalf("dial device: %v", err)
	}
	defer deviceConn.CloseNow()

	shimConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing="+pairingID, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial shim: %v", err)
	}

	// Bridge the two legs with one frame so both serveLegs are past their
	// initial peer-wait select and into the read/write loop (where the old
	// code cached its peer).
	if err := shimConn.Write(ctx, websocket.MessageBinary, []byte("prime")); err != nil {
		t.Fatalf("shim write (prime): %v", err)
	}
	if _, _, err := deviceConn.Read(ctx); err != nil {
		t.Fatalf("device read (prime): %v", err)
	}

	// Shim reconnects (new conn on the same pairing) — join evicts the old
	// shim leg while the device leg stays bridged.
	shimConn2, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing="+pairingID, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial shim (reconnect): %v", err)
	}
	defer shimConn2.CloseNow()

	// websocket.Dial returning only means the client handshake finished — the
	// server-side join (which evicts the old shim leg and registers shimConn2 as
	// the device's peer) may not have run yet. join CloseNow()s the old shim
	// under p.mu *before* swapping in the new slot, so the old conn's read
	// erroring is the happens-before signal that shimConn2 now owns the leg.
	// Without this wait, the device write below races the join and can be
	// delivered to the not-yet-evicted old shim, so shimConn2 never sees it and
	// the read times out (the med-5m8 CI flake).
	if _, _, err := shimConn.Read(ctx); err == nil {
		t.Fatalf("expected the old shim conn to be evicted after reconnect, but its read succeeded")
	}

	// device -> new shim: the direction the stale-peer bug broke — the device
	// leg must now write to the reconnected shim, not the evicted conn.
	want := []byte("device-to-reconnected-shim")
	if err := deviceConn.Write(ctx, websocket.MessageBinary, want); err != nil {
		t.Fatalf("device write after shim reconnect: %v", err)
	}
	_, got, err := shimConn2.Read(ctx)
	if err != nil {
		t.Fatalf("reconnected shim read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("reconnected shim got %q, want %q", got, want)
	}

	// new shim -> device: the other direction still bridges too.
	want = []byte("reconnected-shim-to-device")
	if err := shimConn2.Write(ctx, websocket.MessageBinary, want); err != nil {
		t.Fatalf("reconnected shim write: %v", err)
	}
	_, got, err = deviceConn.Read(ctx)
	if err != nil {
		t.Fatalf("device read after shim reconnect: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("device got %q, want %q", got, want)
	}
}

func TestMCPRelay_CrossPairingAccessRejected(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	_ = mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing=not-a-real-pairing-id", &websocket.DialOptions{HTTPClient: client})
	if err == nil {
		t.Fatalf("dial shim with unknown pairing id: expected error, got none")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		status := -1
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial shim with unknown pairing id: status = %d, want %d", status, http.StatusUnauthorized)
	}
}

func TestMCPRelay_DeadPeerClosePropagates(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	pairingID := mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	deviceConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device", &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: deviceHeader,
	})
	if err != nil {
		t.Fatalf("dial device: %v", err)
	}

	shimConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing="+pairingID, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial shim: %v", err)
	}
	defer shimConn.CloseNow()

	// Prime the rendezvous: without at least one relayed frame there's no
	// guarantee the shim's Read below observes anything but a plain EOF race
	// against the device's teardown, so send one opaque frame through first.
	if err := deviceConn.Write(ctx, websocket.MessageBinary, []byte("hello")); err != nil {
		t.Fatalf("device write: %v", err)
	}
	if _, _, err := shimConn.Read(ctx); err != nil {
		t.Fatalf("shim read (priming): %v", err)
	}

	if err := deviceConn.CloseNow(); err != nil {
		t.Fatalf("close device: %v", err)
	}

	if _, _, err := shimConn.Read(ctx); err == nil {
		t.Fatalf("shim read after device dropped: expected error (propagated close), got none")
	}
}

// TestPairingTable_PermanentPairingSurvivesTTL locks in the Tier 2 fix: a
// persisted (restored / made-permanent) pairing has a zero expiry and is never
// swept by cleanup or rejected by the lookups, whereas a minted (Tier 1)
// pairing ages out on its TTL.
func TestPairingTable_PermanentPairingSurvivesTTL(t *testing.T) {
	tbl := newPairingTable(time.Hour)

	// Tier 1: minted → has a future expiry, ages out.
	mintedID := tbl.mint("acct-minted")
	if rec, ok := tbl.byID[mintedID]; !ok || rec.expiresAt.IsZero() {
		t.Fatalf("minted pairing should carry a non-zero expiry")
	}
	if !tbl.byID[mintedID].isExpired(time.Now().Add(2 * time.Hour)) {
		t.Fatalf("minted pairing should be expired 2h past a 1h TTL")
	}

	// Tier 2 via restore: permanent from the start.
	tbl.restore("pair-restored", "acct-restored")
	if !tbl.byID["pair-restored"].expiresAt.IsZero() {
		t.Fatalf("restored pairing should never expire (zero expiresAt)")
	}
	if tbl.byID["pair-restored"].isExpired(time.Now().Add(100 * 365 * 24 * time.Hour)) {
		t.Fatalf("restored pairing must not expire even a century out")
	}

	// Tier 2 via enable: minted with a TTL, then pinned permanent.
	enabledID := tbl.mint("acct-enabled")
	if tbl.byID[enabledID].expiresAt.IsZero() {
		t.Fatalf("precondition: freshly minted pairing should have a TTL")
	}
	if !tbl.makePermanent("acct-enabled", enabledID) {
		t.Fatalf("makePermanent should pin the account's current pairing")
	}
	if !tbl.byID[enabledID].expiresAt.IsZero() {
		t.Fatalf("makePermanent should clear the expiry")
	}
	// A stale pairing id (already replaced by a concurrent re-mint) must be
	// rejected rather than silently pinning whatever the account holds now.
	if tbl.makePermanent("acct-enabled", "some-other-id") {
		t.Fatalf("makePermanent must reject a pairing id that isn't the account's current one")
	}

	// cleanup evicts only the expired (minted) one, leaving both permanents.
	tbl.byID[mintedID].expiresAt = time.Now().Add(-time.Minute) // force-expire
	tbl.cleanup()
	if _, ok := tbl.byAccountID("acct-minted"); ok {
		t.Fatalf("expired minted pairing should have been swept")
	}
	if _, ok := tbl.byAccountID("acct-restored"); !ok {
		t.Fatalf("permanent restored pairing should survive cleanup")
	}
	if _, ok := tbl.byAccountID("acct-enabled"); !ok {
		t.Fatalf("permanent enabled pairing should survive cleanup")
	}
}

// The browser responder can only see WebSocket close codes, so a device leg
// with no pairing (relay restart / TTL expiry) must be upgraded and then
// closed with StatusNoPairing — otherwise it reconnects forever against a
// pairing that will never come back. Mirrors the STATUS_NO_PAIRING branch in
// web/cloud/js/mcp-responder.js.
func TestMCPRelay_DeviceWithoutPairingClosesNoPairing(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	// deliberately no mintPairing

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	header := http.Header{}
	header.Set("Cookie", session.Name+"="+session.Value)
	conn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device", &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: header,
	})
	if err != nil {
		t.Fatalf("dial device: %v", err)
	}
	defer conn.CloseNow()

	_, _, err = conn.Read(ctx)
	if got := websocket.CloseStatus(err); got != StatusNoPairing {
		t.Fatalf("close status = %v (err %v), want %v", got, err, StatusNoPairing)
	}
}

// A tab holding a pairing that a re-pair (mint) has since replaced must not be
// bridged onto the fresh pairing's device leg: its key is dead, so it would sit
// in the device slot dropping every frame while the real responder is evicted.
// The device leg carries its pairing id for exactly this check.
func TestMCPRelay_DeviceWithStalePairingIDClosesReplaced(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	stale := mintPairing(t, h, host, session)
	fresh := mintPairing(t, h, host, session) // re-pair: evicts `stale`
	if stale == fresh {
		t.Fatalf("re-mint returned the same pairing id %q", fresh)
	}

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	header := http.Header{}
	header.Set("Cookie", session.Name+"="+session.Value)
	dial := func(pairingID string) error {
		conn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+pairingID, &websocket.DialOptions{
			HTTPClient: client,
			HTTPHeader: header,
		})
		if err != nil {
			t.Fatalf("dial device: %v", err)
		}
		defer conn.CloseNow()
		_, _, err = conn.Read(ctx)
		return err
	}

	if got := websocket.CloseStatus(dial(stale)); got != StatusPairingReplaced {
		t.Fatalf("stale pairing close status = %v, want %v", got, StatusPairingReplaced)
	}
	// The fresh id is accepted: it waits for its shim peer, then times out —
	// never StatusPairingReplaced.
	freshCtx, freshCancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer freshCancel()
	conn, _, err := websocket.Dial(freshCtx, "ws://"+host+"/api/mcp/relay/device?pairing="+fresh, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: header,
	})
	if err != nil {
		t.Fatalf("dial device (fresh): %v", err)
	}
	defer conn.CloseNow()
	if _, _, err := conn.Read(freshCtx); websocket.CloseStatus(err) == StatusPairingReplaced {
		t.Fatalf("fresh pairing was rejected as replaced")
	}
}
