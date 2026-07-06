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

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, ""), host, claimToken
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
