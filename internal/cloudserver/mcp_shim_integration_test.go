package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/korjavin/medicationtrackerbot/internal/mcpshim"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeDevice stands in for web/cloud/js/mcp-responder.js: it dials the
// device leg, decrypts each inbound frame with the same wire primitives the
// shim uses (internal/mcpshim.DecryptFrame/EncryptFrame), answers a canned
// mcp_help/mcp_call response, and re-encrypts it.
type fakeDevice struct {
	conn      *websocket.Conn
	key       []byte
	pairingID string
}

func dialFakeDevice(t *testing.T, client *http.Client, host string, session *http.Cookie, key []byte, pairingID string) *fakeDevice {
	t.Helper()
	header := http.Header{}
	header.Set("Cookie", session.Name+"="+session.Value)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws://"+host+"/api/mcp/relay/device?pairing="+pairingID, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: header,
	})
	if err != nil {
		t.Fatalf("dial fake device: %v", err)
	}
	return &fakeDevice{conn: conn, key: key, pairingID: pairingID}
}

// serveOnce reads exactly one request frame and answers it, mirroring
// mcp-responder.js's handleRequest for the two methods this test exercises.
func (d *fakeDevice) serveOnce(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, frame, err := d.conn.Read(ctx)
	if err != nil {
		t.Errorf("fake device read: %v", err)
		return
	}
	payload, err := mcpshim.DecryptFrame(d.key, d.pairingID, frame)
	if err != nil {
		t.Errorf("fake device decrypt: %v", err)
		return
	}
	msg, err := jsonrpc.DecodeMessage(payload)
	if err != nil {
		t.Errorf("fake device decode: %v", err)
		return
	}
	req, ok := msg.(*jsonrpc.Request)
	if !ok {
		t.Errorf("fake device: expected a request, got %T", msg)
		return
	}

	var result any
	switch req.Method {
	case "mcp_help":
		result = map[string]any{"catalog": []string{"bp.list", "bp.create"}, "usage_protocol": "discover then call"}
	case "mcp_call":
		var params struct {
			OperationID string         `json:"operation_id"`
			Op          string         `json:"op"`
			Params      map[string]any `json:"params"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			t.Errorf("fake device: unmarshal mcp_call params: %v", err)
			return
		}
		if params.OperationID != "" {
			params.Op = params.OperationID
		}
		result = map[string]any{"op": params.Op, "echo": params.Params}
	default:
		t.Errorf("fake device: unexpected method %q", req.Method)
		return
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		t.Errorf("fake device: marshal result: %v", err)
		return
	}
	respPayload, err := jsonrpc.EncodeMessage(&jsonrpc.Response{ID: req.ID, Result: resultJSON})
	if err != nil {
		t.Errorf("fake device: encode response: %v", err)
		return
	}
	respFrame, err := mcpshim.EncryptFrame(d.key, d.pairingID, respPayload)
	if err != nil {
		t.Errorf("fake device: encrypt response: %v", err)
		return
	}
	if err := d.conn.Write(ctx, websocket.MessageBinary, respFrame); err != nil {
		t.Errorf("fake device write: %v", err)
	}
}

// This launches the exact release-style executable through the SDK stdio
// transport, not a second implementation of the shim or a bare ShimCore.
// CI supplies its downloaded native artifact; local runs build a stamped one.
func TestMCPShim_PackagedProcess(t *testing.T) {
	binary := os.Getenv("MEDTRACKER_PACKAGED_SHIM_TEST_BINARY")
	expectedVersion := os.Getenv("MEDTRACKER_PACKAGED_SHIM_TEST_VERSION")
	if binary == "" {
		expectedVersion = "0.1.0+fixture"
		binary = filepath.Join(t.TempDir(), "mcpshim")
		if runtime.GOOS == "windows" {
			binary += ".exe"
		}
		build := exec.Command("go", "build", "-trimpath", "-ldflags=-X main.version=0.1.0 -X main.commit=fixture", "-o", binary, "../../cmd/mcpshim")
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build packaged helper: %v: %s", err, out)
		}
	}
	if expectedVersion == "" {
		t.Fatal("packaged artifact proof requires the independently expected version and source commit")
	}
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "MEDTRACKER_MCP_CODE=") {
			env = append(env, entry)
		}
	}
	versionCmd := exec.Command(binary, "--version")
	versionCmd.Env = env
	versionBytes, err := versionCmd.Output()
	if err != nil {
		t.Fatal("packaged --version failed without pairing key")
	}
	version := strings.TrimPrefix(strings.TrimSpace(string(versionBytes)), "mcpshim ")
	if version != expectedVersion {
		t.Fatalf("packaged version %q does not match expected source version %q", version, expectedVersion)
	}

	h, host, claim := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claim)
	pairingID := mintPairing(t, h, host, session)
	// The fixture proxy supplies the account host used by the real subdomain
	// router, allowing the unmodified executable to use a loopback relay URL.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { r.Host = host; h.ServeHTTP(w, r) }))
	t.Cleanup(srv.Close)
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	device := dialFakeDevice(t, wsClientFor(srv.Listener.Addr().String()), host, session, key, pairingID)
	t.Cleanup(device.close)
	pc := &mcpshim.PairingCode{RelayURL: "ws://" + srv.Listener.Addr().String(), PairingID: pairingID, Key: key}
	code, err := mcpshim.FormatPairingCode(pc)
	if err != nil {
		t.Fatal("format fixture pairing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.Command(binary)
	command.Env = append(env, "MEDTRACKER_MCP_CODE="+code)
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "packaged-smoke", Version: "1"}, nil)
	cs, err := client.Connect(ctx, &sdkmcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatal("initialize packaged stdio helper failed")
	}
	defer cs.Close()
	if cs.InitializeResult().ServerInfo.Version != version {
		t.Fatal("--version and MCP initialize differ")
	}
	for _, call := range []struct {
		name, want string
		args       map[string]any
	}{
		{"mcp_help", "bp.list", map[string]any{}},
		{"mcp_call", "bp.list", map[string]any{"operation_id": "bp.list", "params": map[string]any{"limit": 1}}},
	} {
		done := make(chan struct{})
		go func() { defer close(done); device.serveOnce(t) }()
		result, err := cs.CallTool(ctx, &sdkmcp.CallToolParams{Name: call.name, Arguments: call.args})
		<-done
		if err != nil || result.IsError {
			t.Fatalf("packaged %s round trip failed", call.name)
		}
		encoded, _ := json.Marshal(result)
		if !strings.Contains(string(encoded), call.want) {
			t.Fatalf("packaged %s missing expected response", call.name)
		}
	}
	device.close()
	start := time.Now()
	result, err := cs.CallTool(ctx, &sdkmcp.CallToolParams{Name: "mcp_help", Arguments: map[string]any{}})
	if err != nil || !result.IsError {
		t.Fatal("absent device must return an MCP tool error")
	}
	// Client-side results carry the tool error as protocol content; GetError
	// only reports an in-process server error and is always nil on clients.
	offlineResult, _ := json.Marshal(result)
	if !strings.Contains(string(offlineResult), "through a blind cloud relay") || strings.Contains(string(offlineResult), "not to a server") {
		t.Fatal("packaged offline error must describe the factual relay boundary")
	}
	if time.Since(start) > mcpshim.CallTimeout+2*time.Second {
		t.Fatal("absent device exceeded bounded wait")
	}
}

func (d *fakeDevice) close() {
	d.conn.CloseNow()
}

// shimRelayHarness spins up the real relay handler (Task 1) plus a paired
// fake device (Task 3's stand-in) and returns a mcpshim.PairingCode plus the
// dial options a shim needs to reach it — the same three-party shape the
// plan's Task 5 integration test asks for: relay + fake device + shim core.
//
// Every "/api/*" route — including the shim leg, which otherwise has no
// session of its own — is routed by cloudserver's subdomain host resolver
// (router.go's ServeHTTP) before it ever reaches the relay handler, so the
// shim's dial must present the account's real "<sub>.localhost" Host header
// while actually connecting to the httptest server's loopback port. That's
// the same override newTestMCPRelayHandler's own tests use via wsClientFor.
func shimRelayHarness(t *testing.T) (*mcpshim.PairingCode, *websocket.DialOptions, *fakeDevice) {
	t.Helper()
	h, host, claimToken := newTestMCPRelayHandler(t)
	session := registerAndGetSession(t, h, host, claimToken)
	pairingID := mintPairing(t, h, host, session)

	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	client := wsClientFor(srv.Listener.Addr().String())

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}

	device := dialFakeDevice(t, client, host, session, key, pairingID)
	t.Cleanup(device.close)

	pc := &mcpshim.PairingCode{
		RelayURL:  "ws://" + host,
		PairingID: pairingID,
		Key:       key,
	}
	opts := &websocket.DialOptions{HTTPClient: client}
	return pc, opts, device
}

func TestMCPShim_HelpAndCallRoundTripThroughRelay(t *testing.T) {
	pc, opts, device := shimRelayHarness(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	core, err := mcpshim.DialPairingWithOptions(ctx, pc, opts)
	if err != nil {
		t.Fatalf("dial shim: %v", err)
	}
	defer core.Close()

	helpDone := make(chan struct{})
	go func() {
		defer close(helpDone)
		device.serveOnce(t)
	}()
	helpResult, err := core.Call(ctx, "mcp_help", struct{}{})
	<-helpDone
	if err != nil {
		t.Fatalf("mcp_help call: %v", err)
	}
	if !strings.Contains(string(helpResult), "bp.list") {
		t.Fatalf("mcp_help result = %s, want catalog containing bp.list", helpResult)
	}

	callDone := make(chan struct{})
	go func() {
		defer close(callDone)
		device.serveOnce(t)
	}()
	callResult, err := core.Call(ctx, "mcp_call", map[string]any{"op": "bp.create", "params": map[string]any{"systolic": 120}})
	<-callDone
	if err != nil {
		t.Fatalf("mcp_call call: %v", err)
	}
	if !strings.Contains(string(callResult), "bp.create") {
		t.Fatalf("mcp_call result = %s, want echo of op bp.create", callResult)
	}
}

// TestMCPShim_DeviceOfflineReturnsActionableError drives Task 5's other
// required assertion: kill the fake device, then the next call must return
// mcpshim.ErrDeviceOffline within roughly CallTimeout — not hang, and not
// surface the raw "relay connection closed" transport error a stale
// ShimCore would otherwise return immediately. That means the call must go
// through mcpshim.Client (not a bare ShimCore), since only Client redials
// the dropped connection before waiting out a fresh timeout.
func TestMCPShim_DeviceOfflineReturnsActionableError(t *testing.T) {
	pc, opts, device := shimRelayHarness(t)
	client := mcpshim.NewClientFromPairingWithOptions(pc, opts)

	// One successful round trip while the device is online, proving the
	// connection was actually live before we pull it out from under the
	// shim.
	helpDone := make(chan struct{})
	go func() {
		defer close(helpDone)
		device.serveOnce(t)
	}()
	if _, err := client.Call(context.Background(), "mcp_help", struct{}{}); err != nil {
		t.Fatalf("mcp_help call: %v", err)
	}
	<-helpDone

	device.close()

	start := time.Now()
	_, err := client.Call(context.Background(), "mcp_call", map[string]any{"op": "bp.list"})
	elapsed := time.Since(start)

	if !errors.Is(err, mcpshim.ErrDeviceOffline) {
		t.Fatalf("Call after device offline: err = %v, want ErrDeviceOffline", err)
	}
	if elapsed > mcpshim.CallTimeout+2*time.Second {
		t.Fatalf("Call after device offline took %v, want ~%v", elapsed, mcpshim.CallTimeout)
	}
}
