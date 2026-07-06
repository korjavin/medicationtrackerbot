package cloudserver

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/mcpshim"
)

// newTestMCPRemoteHandler wires WebAuthn + the relay + the hosted-remote
// consent routes onto one mux, mirroring cmd/cloud/main.go's wiring, and
// returns the handler plus the store/account so tests can drive
// restore/lifecycle directly.
func newTestMCPRemoteHandler(t *testing.T) (h http.Handler, store *cloudstore.Repo, account *cloudstore.Account, claimToken string) {
	t.Helper()
	store = setupStore(t)
	account, claimToken = setupInvite(t, store)

	webauthnAPI := NewWebAuthnAPI(store, "test-session-secret-at-least-32-bytes-long")
	relayAPI := NewMCPRelayAPI(store, "test-session-secret-at-least-32-bytes-long")
	remoteAPI := NewMCPRemoteAPI(store, relayAPI, "test-session-secret-at-least-32-bytes-long")
	mux := http.NewServeMux()
	webauthnAPI.RegisterRoutes(mux)
	relayAPI.RegisterRoutes(mux)
	remoteAPI.RegisterRoutes(mux)

	return New("localhost", store, testFS(), testAppFS(), testDomainFS(), mux, ""), store, account, claimToken
}

// testPairingCode builds a real-shaped "mtmcp1...." pairing code for
// pairingID, mirroring what mcp-pairing.js mints client-side: relay_url is the
// account's own origin (wss://<host>), which PostRemote validates.
func testPairingCode(t *testing.T, host, pairingID string) string {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate pairing key: %v", err)
	}
	code, err := mcpshim.FormatPairingCode(&mcpshim.PairingCode{RelayURL: "ws://" + host, PairingID: pairingID, Key: key})
	if err != nil {
		t.Fatalf("format pairing code: %v", err)
	}
	return code
}

func postMCPRemote(t *testing.T, h http.Handler, host string, session *http.Cookie, pairingCode string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(enableMCPRemoteRequest{PairingCode: pairingCode})
	r := httptest.NewRequest(http.MethodPost, "/api/mcp/remote", bytes.NewReader(body))
	r.Host = host
	if session != nil {
		r.AddCookie(session)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func getMCPRemoteStatus(t *testing.T, h http.Handler, host string, session *http.Cookie) statusMCPRemoteResponse {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/mcp/remote", nil)
	r.Host = host
	r.AddCookie(session)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/mcp/remote status = %d, body %q", rec.Code, rec.Body.String())
	}
	var resp statusMCPRemoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode status response: %v", err)
	}
	return resp
}

// TestMCPRemote_RequiresSession guards every consent route: no session
// cookie must 401, never leaking whether the account has Tier 2 enabled.
func TestMCPRemote_RequiresSession(t *testing.T) {
	h, _, account, _ := newTestMCPRemoteHandler(t)
	host := account.Subdomain + ".localhost"

	if rec := postMCPRemote(t, h, host, nil, "irrelevant"); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST without session status = %d, want 401", rec.Code)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/mcp/remote", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("DELETE without session status = %d, want 401", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/mcp/remote", nil)
	req.Host = host
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("GET without session status = %d, want 401", rec.Code)
	}
}

// TestMCPRemote_EnableDisableStatusLifecycle drives the full consent
// lifecycle: disabled by default, enable mints a token and flips status,
// disable tears it down and flips status back.
func TestMCPRemote_EnableDisableStatusLifecycle(t *testing.T) {
	h, _, account, claimToken := newTestMCPRemoteHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	if resp := getMCPRemoteStatus(t, h, host, session); resp.Enabled {
		t.Fatalf("status before enable = enabled, want disabled")
	}

	pairingID := mintPairing(t, h, host, session)
	rec := postMCPRemote(t, h, host, session, testPairingCode(t, host, pairingID))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /api/mcp/remote status = %d, body %q", rec.Code, rec.Body.String())
	}
	var enableResp enableMCPRemoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &enableResp); err != nil {
		t.Fatalf("decode enable response: %v", err)
	}
	if enableResp.Token == "" {
		t.Fatalf("empty token on enable")
	}

	if resp := getMCPRemoteStatus(t, h, host, session); !resp.Enabled {
		t.Fatalf("status after enable = disabled, want enabled")
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/mcp/remote", nil)
	req.Host = host
	req.AddCookie(session)
	recDel := httptest.NewRecorder()
	h.ServeHTTP(recDel, req)
	if recDel.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/mcp/remote status = %d, body %q", recDel.Code, recDel.Body.String())
	}

	if resp := getMCPRemoteStatus(t, h, host, session); resp.Enabled {
		t.Fatalf("status after disable = enabled, want disabled")
	}
}

// TestMCPRemote_RejectsForeignRelayURL guards the SSRF boundary: a pairing
// code whose relay_url points at any host other than the account's own origin
// must be rejected, so an authenticated caller can't make the server dial an
// arbitrary internal/attacker host.
func TestMCPRemote_RejectsForeignRelayURL(t *testing.T) {
	h, _, account, claimToken := newTestMCPRemoteHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	pairingID := mintPairing(t, h, host, session)
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate pairing key: %v", err)
	}
	code, err := mcpshim.FormatPairingCode(&mcpshim.PairingCode{RelayURL: "wss://169.254.169.254", PairingID: pairingID, Key: key})
	if err != nil {
		t.Fatalf("format pairing code: %v", err)
	}
	if rec := postMCPRemote(t, h, host, session, code); rec.Code != http.StatusBadRequest {
		t.Fatalf("enable with foreign relay_url status = %d, want 400", rec.Code)
	}
	if resp := getMCPRemoteStatus(t, h, host, session); resp.Enabled {
		t.Fatalf("foreign relay_url enabled Tier 2, want it rejected")
	}
}

// TestMCPRemote_ReEnableRotatesToken guards the plan's locked invariant: only
// re-enable and delete may change the token — a fresh POST while already
// enabled must mint a brand new one, never reuse the old.
func TestMCPRemote_ReEnableRotatesToken(t *testing.T) {
	h, _, account, claimToken := newTestMCPRemoteHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	pairingID := mintPairing(t, h, host, session)
	first := postMCPRemote(t, h, host, session, testPairingCode(t, host, pairingID))
	if first.Code != http.StatusOK {
		t.Fatalf("first enable status = %d, body %q", first.Code, first.Body.String())
	}
	var firstResp enableMCPRemoteResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstResp); err != nil {
		t.Fatalf("decode first enable response: %v", err)
	}

	second := postMCPRemote(t, h, host, session, testPairingCode(t, host, pairingID))
	if second.Code != http.StatusOK {
		t.Fatalf("re-enable status = %d, body %q", second.Code, second.Body.String())
	}
	var secondResp enableMCPRemoteResponse
	if err := json.Unmarshal(second.Body.Bytes(), &secondResp); err != nil {
		t.Fatalf("decode re-enable response: %v", err)
	}

	if firstResp.Token == secondResp.Token {
		t.Fatalf("re-enable did not rotate the token, both were %q", firstResp.Token)
	}
}

// TestMCPRemote_RestartRestore guards the "set-up-once-and-forget" design:
// a brand new MCPRemoteAPI (standing in for a fresh process) built against
// the same store must, after Restore, hold the same token for the account —
// no re-enable required to survive a restart.
func TestMCPRemote_RestartRestore(t *testing.T) {
	h, store, account, claimToken := newTestMCPRemoteHandler(t)
	host := account.Subdomain + ".localhost"
	session := registerAndGetSession(t, h, host, claimToken)

	pairingID := mintPairing(t, h, host, session)
	rec := postMCPRemote(t, h, host, session, testPairingCode(t, host, pairingID))
	if rec.Code != http.StatusOK {
		t.Fatalf("enable status = %d, body %q", rec.Code, rec.Body.String())
	}
	var enableResp enableMCPRemoteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &enableResp); err != nil {
		t.Fatalf("decode enable response: %v", err)
	}

	// A brand new MCPRelayAPI/MCPRemoteAPI pair against the same store stands
	// in for a fresh process: the relay's pairing table starts empty, and the
	// only source of truth is what's persisted in cloudstore.
	freshRelayAPI := NewMCPRelayAPI(store, "test-session-secret-at-least-32-bytes-long")
	freshRemoteAPI := NewMCPRemoteAPI(store, freshRelayAPI, "test-session-secret-at-least-32-bytes-long")
	freshRemoteAPI.Restore(t.Context())

	freshRemoteAPI.mu.RLock()
	entry, ok := freshRemoteAPI.byAcc[account.ID]
	freshRemoteAPI.mu.RUnlock()
	if !ok {
		t.Fatalf("restored registry has no entry for account %q", account.ID)
	}
	if entry.token != enableResp.Token {
		t.Fatalf("restored token = %q, want %q (the same token must still authenticate after restart)", entry.token, enableResp.Token)
	}
}
