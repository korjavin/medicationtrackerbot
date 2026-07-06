package cloudserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/mcpshim"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

// newTestMCPEndpointHandler wires WebAuthn + the relay + the hosted-remote
// consent routes + the Task 2 streamable-HTTP MCP endpoint onto one router,
// mirroring cmd/cloud/main.go's wiring. Returns remoteAPI too, so tests can
// point its hosted clients' dials at the httptest server they build from the
// returned handler (see enableHostedRemote).
func newTestMCPEndpointHandler(t *testing.T) (h http.Handler, remoteAPI *MCPRemoteAPI, account *cloudstore.Account, claimToken string) {
	t.Helper()
	store := setupStore(t)
	account, claimToken = setupInvite(t, store)

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	relayAPI := NewMCPRelayAPI(store, "test-session-secret-at-least-32-bytes-long")
	remoteAPI = NewMCPRemoteAPI(store, relayAPI, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	relayAPI.RegisterRoutes(mux)
	remoteAPI.RegisterRoutes(mux)

	router := New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, "")
	router.SetMCPHandler(remoteAPI.Endpoint())
	return router, remoteAPI, account, claimToken
}

// enableHostedRemote drives the full Task 1 consent flow (mint a pairing,
// dial a fake device standing in for the browser tab, enable Tier 2) and
// returns the connector token plus the still-live fake device so the test
// can answer whatever tool calls it drives next. It points remoteAPI's
// hosted client dial at client's real address (an httptest.Server's real
// listener) while keeping the pairing code's RelayURL as the account's
// virtual "<sub>.localhost" host — the same override
// mcp_shim_integration_test.go's shimRelayHarness uses.
func enableHostedRemote(t *testing.T, h http.Handler, remoteAPI *MCPRemoteAPI, host string, client *http.Client, session *http.Cookie) (token string, device *fakeDevice) {
	t.Helper()
	remoteAPI.dialOpts = &websocket.DialOptions{HTTPClient: client}

	pairingID := mintPairing(t, h, host, session)

	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	device = dialFakeDevice(t, client, host, session, key, pairingID)
	t.Cleanup(device.close)

	code, err := mcpshim.FormatPairingCode(&mcpshim.PairingCode{RelayURL: "ws://" + host, PairingID: pairingID, Key: key})
	if err != nil {
		t.Fatalf("format pairing code: %v", err)
	}
	rec := postMCPRemote(t, h, host, session, code)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/mcp/remote status = %d, body %q", rec.Code, rec.Body.String())
	}
	var resp enableMCPRemoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode enable response: %v", err)
	}
	return resp.Token, device
}

// mcpClientFor connects a real sdkmcp.Client to h's streamable-HTTP endpoint
// at "/mcp/<token>" over httpClient (a wsClientFor-style dialer already
// pointed at the httptest server's real listener address).
func mcpClientFor(t *testing.T, host, token string, httpClient *http.Client) (*sdkmcp.ClientSession, error) {
	t.Helper()
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "test-client", Version: "0.0.1"}, nil)
	transport := &sdkmcp.StreamableClientTransport{
		Endpoint:   "http://" + host + "/mcp/" + token,
		HTTPClient: httpClient,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return client.Connect(ctx, transport, nil)
}

func TestMCPEndpoint_HelpAndCallRoundTripThroughHostedShim(t *testing.T) {
	h, remoteAPI, account, claimToken := newTestMCPEndpointHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	token, device := enableHostedRemote(t, h, remoteAPI, host, client, session)

	sess, err := mcpClientFor(t, host, token, client)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer sess.Close()

	tools, err := sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	if !contains(names, "mcp_help") || !contains(names, "mcp_call") {
		t.Fatalf("tools/list = %v, want mcp_help and mcp_call", names)
	}

	helpDone := make(chan struct{})
	go func() {
		defer close(helpDone)
		device.serveOnce(t)
	}()
	helpResult, err := sess.CallTool(context.Background(), &sdkmcp.CallToolParams{Name: "mcp_help"})
	<-helpDone
	if err != nil {
		t.Fatalf("mcp_help call: %v", err)
	}
	if helpResult.IsError {
		t.Fatalf("mcp_help call returned isError, content: %+v", helpResult.Content)
	}

	callDone := make(chan struct{})
	go func() {
		defer close(callDone)
		device.serveOnce(t)
	}()
	callResult, err := sess.CallTool(context.Background(), &sdkmcp.CallToolParams{
		Name:      "mcp_call",
		Arguments: map[string]any{"op": "bp.create", "params": map[string]any{"systolic": 120}},
	})
	<-callDone
	if err != nil {
		t.Fatalf("mcp_call call: %v", err)
	}
	if callResult.IsError {
		t.Fatalf("mcp_call call returned isError, content: %+v", callResult.Content)
	}
}

func TestMCPEndpoint_WrongTokenIs404(t *testing.T) {
	h, remoteAPI, account, claimToken := newTestMCPEndpointHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	_, _ = enableHostedRemote(t, h, remoteAPI, host, client, session)

	if _, err := mcpClientFor(t, host, "aaa-aaa", client); err == nil {
		t.Fatalf("connect with wrong token: expected error, got none")
	}
}

func TestMCPEndpoint_UnknownAccountEnabledIs404(t *testing.T) {
	h, _, account, _ := newTestMCPEndpointHandler(t)
	host := account.Subdomain + ".localhost"

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	// Remote was never enabled for this account — any token 404s the same
	// way a wrong one does.
	if _, err := mcpClientFor(t, host, "aaa-aaa", client); err == nil {
		t.Fatalf("connect against a never-enabled account: expected error, got none")
	}
}

// TestMCPEndpoint_TokenIsHyphenAndCaseInsensitive guards the plan's "hyphen
// stripped on check" — a client that pastes the token without its separating
// hyphen, or upper-cases it, must still authenticate.
func TestMCPEndpoint_TokenIsHyphenAndCaseInsensitive(t *testing.T) {
	h, remoteAPI, account, claimToken := newTestMCPEndpointHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	token, _ := enableHostedRemote(t, h, remoteAPI, host, client, session)
	noHyphenUpper := strings.ToUpper(strings.ReplaceAll(token, "-", ""))

	sess, err := mcpClientFor(t, host, noHyphenUpper, client)
	if err != nil {
		t.Fatalf("connect with hyphen-stripped upper-cased token: %v", err)
	}
	sess.Close()
}

// TestMCPEndpoint_FailedAttemptThrottle guards the "throttle IS the
// security" design: once an account's failed-token budget is exhausted,
// further wrong-token attempts 429 instead of 404 — but a subsequent
// valid-token connect must still succeed, proving success never draws down
// the same budget.
func TestMCPEndpoint_FailedAttemptThrottle(t *testing.T) {
	h, remoteAPI, account, claimToken := newTestMCPEndpointHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	token, _ := enableHostedRemote(t, h, remoteAPI, host, client, session)

	var last *http.Response
	for i := 0; i < mcpEndpointFailLimitMax+5; i++ {
		req := httptest.NewRequest(http.MethodPost, "/mcp/wrong-token", strings.NewReader("{}"))
		req.Host = host
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		last = rec.Result()
	}
	if last.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("after %d failed attempts, status = %d, want %d", mcpEndpointFailLimitMax+5, last.StatusCode, http.StatusTooManyRequests)
	}

	// A valid-token connect right after must still work — success traffic
	// never consumes the failed-attempt budget.
	sess, err := mcpClientFor(t, host, token, client)
	if err != nil {
		t.Fatalf("connect with valid token after throttling wrong-token attempts: %v", err)
	}
	sess.Close()
}

// TestMCPEndpoint_DeviceOfflineIsToolError guards "shim errors (incl.
// offline-device) map to MCP tool errors, not 5xx": with the fake device
// closed right after enabling, a tool call must come back as an MCP-level
// error carrying the offline text, not an HTTP 5xx or a hang past
// mcpshim.CallTimeout.
func TestMCPEndpoint_DeviceOfflineIsToolError(t *testing.T) {
	h, remoteAPI, account, claimToken := newTestMCPEndpointHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	srv := httptest.NewServer(h)
	defer srv.Close()
	client := wsClientFor(srv.Listener.Addr().String())

	token, device := enableHostedRemote(t, h, remoteAPI, host, client, session)
	device.close()

	sess, err := mcpClientFor(t, host, token, client)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer sess.Close()

	ctx, cancel := context.WithTimeout(context.Background(), mcpshim.CallTimeout+5*time.Second)
	defer cancel()
	result, err := sess.CallTool(ctx, &sdkmcp.CallToolParams{Name: "mcp_help"})
	if err != nil {
		t.Fatalf("mcp_help call transport error: %v (want a tool-level error result, not a transport failure)", err)
	}
	if !result.IsError {
		t.Fatalf("mcp_help call with no device online: IsError = false, want true")
	}
	var text string
	for _, c := range result.Content {
		if tc, ok := c.(*sdkmcp.TextContent); ok {
			text += tc.Text
		}
	}
	if !strings.Contains(text, "No unlocked Med Tracker device is online") {
		t.Fatalf("offline error text = %q, want it to contain the locked offline-device UX text", text)
	}
}

func contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}
