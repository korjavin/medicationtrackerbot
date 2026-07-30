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
	"github.com/korjavin/medicationtrackerbot/internal/mcpshim"
)

// relayTestDeadline is a hang safety-net for the relay ws handshakes, not a
// timing SLA. 5s was tight enough to trip on loaded CI runners (med-tc1.7);
// these tests complete in ~0.3s locally, so a generous bound removes the flake
// without hiding a real hang.
const relayTestDeadline = 30 * time.Second

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

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	deviceConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+pairingID, &websocket.DialOptions{
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

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	deviceConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+pairingID, &websocket.DialOptions{
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

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
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

func TestMCPRelay_DeviceDropLeavesShimLegOpen(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	pairingID := mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	deviceConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+pairingID, &websocket.DialOptions{
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

	// The device drop must NOT reach the shim. A phone drops its leg on any tab
	// freeze, network handoff or battery-saver kick, and it used to take the
	// caller's live connection with it — surfacing mid-call as a raw
	// `relay connection closed: ... "peer disconnected"` instead of an answer.
	readErr := make(chan error, 1)
	go func() {
		_, _, err := shimConn.Read(ctx)
		readErr <- err
	}()
	select {
	case err := <-readErr:
		t.Fatalf("shim leg closed after the device dropped: %v", err)
	case <-time.After(2 * time.Second):
	}
}

// TestMCPRelay_FrameWaitsForADeviceThatIsNotThereYet is the payoff of the
// keep-the-leg-alive design: a call issued while the phone is away (tab thaw,
// wifi handoff, battery-saver kick, or simply the hosted shim dialing before
// the tab has attached) is delivered when the device shows up, instead of being
// dropped for having no peer and waiting out a 30s "device offline" while the
// device was one second behind.
//
// The device is absent rather than mid-drop deliberately: a leg that has closed
// but whose teardown the relay has not yet observed is a millisecond-wide race
// with no observable edge to synchronise on, and a write into a
// not-yet-reaped socket cannot be confirmed at this layer anyway (see
// relayPingEvery). This pins the part that is actually guaranteed.
func TestMCPRelay_FrameWaitsForADeviceThatIsNotThereYet(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	pairingID := mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	// Shim first, no device anywhere.
	shimConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing="+pairingID, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial shim: %v", err)
	}
	defer shimConn.CloseNow()

	want := []byte("call-issued-before-the-device-attached")
	if err := shimConn.Write(ctx, websocket.MessageBinary, want); err != nil {
		t.Fatalf("shim write with no device attached: %v", err)
	}

	// The phone shows up and must find the frame waiting.
	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	device, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+pairingID, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: deviceHeader,
	})
	if err != nil {
		t.Fatalf("dial device: %v", err)
	}
	defer device.CloseNow()

	_, got, err := device.Read(ctx)
	if err != nil {
		t.Fatalf("late device read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("late device got %q, want %q", got, want)
	}
}

// TestRelayFrameBudgetFitsInsideCallTimeout pins the contract that lets the
// relay hold a frame at all: it must give up before the caller has been told
// the device is offline. Past that point the agent may have retried under a
// fresh nonce — which the responder's replay ring cannot catch — so a late
// delivery would apply the write twice.
func TestRelayFrameBudgetFitsInsideCallTimeout(t *testing.T) {
	if relayFrameBudget >= mcpshim.CallTimeout {
		t.Fatalf("relayFrameBudget (%s) must stay under mcpshim.CallTimeout (%s)",
			relayFrameBudget, mcpshim.CallTimeout)
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

// TestMCPRelay_DeviceWithoutPairingClosesWith4404 pins the fix for the
// infinite reconnect loop (med-253): with no pairing the relay must ACCEPT
// the upgrade and close with StatusNoPairing, not reject the handshake with
// a 404. A browser cannot read a handshake status — only a close code — so a
// 404 is indistinguishable from a network drop and the responder retries
// forever. The pairing table is in-memory, so every redeploy strands a tab.
func TestMCPRelay_DeviceWithoutPairingClosesWith4404(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	// Deliberately no mintPairing: this account has never paired.

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)
	conn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device", &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: deviceHeader,
	})
	if err != nil {
		t.Fatalf("dial device: handshake must succeed so the close code is visible: %v", err)
	}
	defer conn.CloseNow()

	_, _, err = conn.Read(ctx)
	if got := websocket.CloseStatus(err); got != StatusNoPairing {
		t.Fatalf("close status = %d, want %d (err %v)", got, StatusNoPairing, err)
	}
}

// TestMCPRelay_EvictedDeviceLegClosesWith4409 pins the other half of the
// step-aside contract. Two legitimate devices (phone + laptop) both hold the
// account's current pairing, so both pass DeviceSocket's id check and join
// evicts the older leg. That eviction used to CloseNow, which reaches the
// browser as 1006 — a transient drop the responder retries. The retry presents
// the same still-current id, is admitted, and evicts its replacement: the two
// devices evict each other forever. 4409 tells the loser to stop instead.
func TestMCPRelay_EvictedDeviceLegClosesWith4409(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	pairingID := mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)

	dialDevice := func() *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+pairingID, &websocket.DialOptions{
			HTTPClient: client,
			HTTPHeader: deviceHeader,
		})
		if err != nil {
			t.Fatalf("dial device: %v", err)
		}
		return conn
	}

	first := dialDevice()
	defer first.CloseNow()

	// Pin the eviction ordering deterministically. websocket.Dial returns once
	// the client handshake completes, but the server's serveLeg->join — which
	// registers this conn as the pairing's device leg — runs asynchronously in
	// the handler goroutine. If we dialled `second` right away, its join could
	// beat `first`'s join under a loaded runner; `first` would then be the
	// survivor and this test's `first.Read` would block until the deadline
	// waiting for a 4409 that went to `second` instead. That inversion was the
	// med-tc1.7 flake (a bigger deadline just made the wrong-path hang longer).
	// Priming one frame first->shim proves `first` already occupies p.device
	// before we dial `second`, so the eviction target is never ambiguous.
	shimConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing="+pairingID, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial shim: %v", err)
	}
	defer shimConn.CloseNow()
	if err := first.Write(ctx, websocket.MessageBinary, []byte("prime")); err != nil {
		t.Fatalf("prime device write: %v", err)
	}
	if _, _, err := shimConn.Read(ctx); err != nil {
		t.Fatalf("prime shim read: %v", err)
	}

	second := dialDevice() // now deterministically evicts `first`
	defer second.CloseNow()

	if _, _, err := first.Read(ctx); websocket.CloseStatus(err) != StatusPairingReplaced {
		t.Fatalf("evicted device close status = %d, want %d (err %v)", websocket.CloseStatus(err), StatusPairingReplaced, err)
	}

	// The replacement still owns the slot, and still bridges the shim's frames.
	want := []byte("frame-for-the-live-leg")
	if err := shimConn.Write(ctx, websocket.MessageBinary, want); err != nil {
		t.Fatalf("shim write: %v", err)
	}
	_, got, err := second.Read(ctx)
	if err != nil {
		t.Fatalf("surviving device read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("surviving device got %q, want %q", got, want)
	}
}

// TestMCPRelay_StaleDevicePairingCannotSquatCurrentSlot is the regression for
// the squat: the device leg used to resolve its pairing by account
// (byAccountID) without checking which pairing the connecting tab actually
// held, so a tab still holding the pre-re-pair id P1 was admitted into P2's
// device slot, evicted the tab holding P2, and then received frames sealed
// with a key it did not have (which it silently dropped).
func TestMCPRelay_StaleDevicePairingCannotSquatCurrentSlot(t *testing.T) {
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	stalePairingID := mintPairing(t, h, host, session) // P1
	currentPairingID := mintPairing(t, h, host, session)
	if stalePairingID == currentPairingID {
		t.Fatalf("re-pair did not mint a new id")
	}

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	ctx, cancel := context.WithTimeout(t.Context(), relayTestDeadline)
	defer cancel()

	deviceHeader := http.Header{}
	deviceHeader.Set("Cookie", session.Name+"="+session.Value)

	// The shim is paired on P2 and seals with P2's key.
	shimConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/shim?pairing="+currentPairingID, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial shim: %v", err)
	}
	defer shimConn.CloseNow()

	// Tab B holds P2 — the legitimate device leg.
	freshConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+currentPairingID, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: deviceHeader,
	})
	if err != nil {
		t.Fatalf("dial fresh device: %v", err)
	}
	defer freshConn.CloseNow()

	// Tab A still holds P1 and reconnects. The handshake succeeds (so the close
	// code is visible to a browser WebSocket) but the leg is closed at once.
	staleConn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+stalePairingID, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: deviceHeader,
	})
	if err != nil {
		t.Fatalf("dial stale device: %v", err)
	}
	defer staleConn.CloseNow()

	if _, _, err = staleConn.Read(ctx); websocket.CloseStatus(err) != StatusPairingReplaced {
		t.Fatalf("stale device close status = %d, want %d (err %v)", websocket.CloseStatus(err), StatusPairingReplaced, err)
	}

	// Tab B was never evicted, and still bridges P2's frames.
	want := []byte("sealed-with-P2-key")
	if err := shimConn.Write(ctx, websocket.MessageBinary, want); err != nil {
		t.Fatalf("shim write: %v", err)
	}
	_, got, err := freshConn.Read(ctx)
	if err != nil {
		t.Fatalf("fresh device read: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("fresh device got %q, want %q", got, want)
	}
}
