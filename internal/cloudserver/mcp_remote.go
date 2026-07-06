package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
	"github.com/korjavin/medicationtrackerbot/internal/mcpshim"
)

// Tier 2 "hosted-relay convenience mode" (docs/cloud-mode.md): an
// internet-accessible streamable-HTTP MCP endpoint (Task 2) that hosted
// clients (claude.ai, ChatGPT) talk to directly, with the server itself
// running the shim and relaying to the account's unlocked browser tab. This
// file is the consent endpoints (enable/disable/status) plus the runtime
// registry of live hosted mcpshim.Client instances, one per enabled account.
// Relay, responder, crypto, and cmd/mcpshim are untouched — this is
// additive.

// maxMCPRemoteBodyBytes bounds the enable request body: a pairing code is a
// base64url-encoded JSON object carrying a URL, an id, and a 32-byte key —
// comfortably under 1KiB even with a long relay URL.
const maxMCPRemoteBodyBytes = 4 << 10

// mcpRemoteTokenAlphabet is Crockford base32, lowercase: 32 symbols (5 bits
// each), excluding the characters (i, l, o, u) that are easy to confuse with
// 1/1/0/v when a user re-types the connector URL by hand.
const mcpRemoteTokenAlphabet = "0123456789abcdefghjkmnpqrstvwxyz"

// generateMCPRemoteToken mints a 6-symbol (~30 bit) token rendered "xxx-xxx".
// Per the plan, the throttle at the MCP endpoint (Task 2) is the actual
// security boundary — this token is deliberately short enough to type across
// devices into claude.ai/ChatGPT.
func generateMCPRemoteToken() (string, error) {
	var sb strings.Builder
	for i := 0; i < 6; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(mcpRemoteTokenAlphabet))))
		if err != nil {
			return "", err
		}
		sb.WriteByte(mcpRemoteTokenAlphabet[n.Int64()])
	}
	s := sb.String()
	return s[:3] + "-" + s[3:], nil
}

// relayURLIsSelf reports whether relayURL points at reqHost over a WebSocket
// scheme — the hosted shim only ever dials the account's own origin, so this
// binds a submitted pairing code's relay_url to the request host and blocks
// SSRF via an attacker-chosen relay_url.
func relayURLIsSelf(relayURL, reqHost string) bool {
	u, err := url.Parse(relayURL)
	if err != nil {
		return false
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return false
	}
	return stripPort(u.Host) == stripPort(reqHost)
}

// mcpRemoteStore is the subset of *cloudstore.Repo the hosted-remote consent
// endpoints and startup restore need.
type mcpRemoteStore interface {
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
	UpsertMCPRemote(ctx context.Context, accountID, token, relayURL, pairingID string, pairingKey []byte, now time.Time) error
	DeleteMCPRemote(ctx context.Context, accountID string) error
	ListMCPRemote(ctx context.Context) ([]cloudstore.MCPRemote, error)
}

// mcpRemoteEntry is one enabled account's live hosted shim: the human token
// that will authenticate the streamable-HTTP endpoint (Task 2) and the
// mcpshim.Client dialing the relay on the account's behalf.
type mcpRemoteEntry struct {
	token  string
	client *mcpshim.Client
}

// MCPRemoteAPI holds the enable/disable/status endpoints and the runtime
// registry of hosted shim clients. RestorePairing on relayAPI re-registers a
// pairing into the relay's in-memory table on startup — the relay itself is
// untouched, this is the only seam the two need.
type MCPRemoteAPI struct {
	store         mcpRemoteStore
	sessionSecret string
	relayAPI      *MCPRelayAPI

	mu    sync.RWMutex
	byAcc map[string]*mcpRemoteEntry

	// failLimiter and callLimiter back the Task 2 streamable-HTTP endpoint
	// (mcp_endpoint.go): failLimiter caps wrong-token guesses per account
	// (the plan's "the throttle IS the security"), callLimiter caps
	// successful-auth tool calls per token (retry-storm protection).
	failLimiter *rateLimiter
	callLimiter *rateLimiter

	// dialOpts overrides the hosted shim client's websocket dial options —
	// nil in production (a real dial to the pairing code's relay URL). Tests
	// set this directly (same package) to force every hosted client's dial
	// through an httptest.Server's real listener address while the pairing
	// code's RelayURL still carries the account's virtual "<sub>.localhost"
	// host, mirroring internal/cloudserver/mcp_shim_integration_test.go's
	// shimRelayHarness.
	dialOpts *websocket.DialOptions
}

// NewMCPRemoteAPI builds the handlers with an empty registry. Call Restore
// once at startup to hydrate it from persisted enablements.
func NewMCPRemoteAPI(store mcpRemoteStore, relayAPI *MCPRelayAPI, sessionSecret string) *MCPRemoteAPI {
	return &MCPRemoteAPI{
		store:         store,
		sessionSecret: sessionSecret,
		relayAPI:      relayAPI,
		byAcc:         make(map[string]*mcpRemoteEntry),
		failLimiter:   newRateLimiter(mcpEndpointFailLimitMax, mcpEndpointFailLimitWindow),
		callLimiter:   newRateLimiter(mcpEndpointCallLimitMax, mcpEndpointCallLimitWindow),
	}
}

// RegisterRoutes adds the consent routes to mux.
func (a *MCPRemoteAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/mcp/remote", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PostRemote)))
	mux.Handle("DELETE /api/mcp/remote", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeleteRemote)))
	mux.Handle("GET /api/mcp/remote", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.GetRemote)))
}

// Restore rebuilds the registry from every persisted enablement — called
// once at process startup. The relay's pairing table is in-memory, so each
// row's pairing is re-registered there too. A single row's failure is logged
// and skipped; it must never block boot.
func (a *MCPRemoteAPI) Restore(ctx context.Context) {
	rows, err := a.store.ListMCPRemote(ctx)
	if err != nil {
		slog.Error("mcp remote: list persisted enablements", "error", err)
		return
	}
	for _, row := range rows {
		a.relayAPI.RestorePairing(row.PairingID, row.AccountID)
		a.start(row.AccountID, row.Token, &mcpshim.PairingCode{RelayURL: row.RelayURL, PairingID: row.PairingID, Key: row.PairingKey})
		slog.Info("mcp remote: restored hosted shim", "account_id", row.AccountID)
	}
}

// start installs accountID's live entry, closing out and replacing any prior
// one (re-enable, or a restore over an already-started registry).
func (a *MCPRemoteAPI) start(accountID, token string, pc *mcpshim.PairingCode) {
	entry := &mcpRemoteEntry{token: token, client: mcpshim.NewClientFromPairingWithOptions(pc, a.dialOpts)}
	a.mu.Lock()
	old := a.byAcc[accountID]
	a.byAcc[accountID] = entry
	a.mu.Unlock()
	if old != nil {
		_ = old.client.Close()
	}
}

// stop removes and tears down accountID's live entry, if any.
func (a *MCPRemoteAPI) stop(accountID string) {
	a.mu.Lock()
	entry := a.byAcc[accountID]
	delete(a.byAcc, accountID)
	a.mu.Unlock()
	if entry != nil {
		_ = entry.client.Close()
	}
}

type enableMCPRemoteRequest struct {
	PairingCode string `json:"pairing_code"`
}

type enableMCPRemoteResponse struct {
	Token string `json:"token"`
}

// PostRemote enables (or re-enables) Tier 2 for the caller's account: parses
// the pairing code the client minted via the existing mcp-pairing.js flow,
// mints a fresh human token, persists the enablement, and starts the hosted
// shim client. Re-enable replaces the row and rotates the token.
func (a *MCPRemoteAPI) PostRemote(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req enableMCPRemoteRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxMCPRemoteBodyBytes)).Decode(&req); err != nil || req.PairingCode == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	pc, err := mcpshim.ParsePairingCode(req.PairingCode)
	if err != nil {
		http.Error(w, "invalid pairing code", http.StatusBadRequest)
		return
	}
	// The hosted shim always dials the server's own relay — mcp-pairing.js
	// sets relay_url to wss://<this host>. Reject any code whose relay_url
	// points elsewhere: without this, an authenticated account holder could
	// submit an arbitrary relay_url and make the server dial an internal or
	// attacker-chosen host (SSRF), triggered by hitting their own /mcp endpoint.
	if !relayURLIsSelf(pc.RelayURL, r.Host) {
		http.Error(w, "invalid pairing code", http.StatusBadRequest)
		return
	}
	token, err := generateMCPRemoteToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := a.store.UpsertMCPRemote(r.Context(), session.AccountID, token, pc.RelayURL, pc.PairingID, pc.Key, time.Now().UTC()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	a.start(session.AccountID, token, pc)
	// The browser minted this pairing with the normal 24h TTL; a persisted
	// Tier 2 enablement is set-and-forget, so pin it permanent now (a restart
	// would restore it permanent anyway via Restore).
	a.relayAPI.MakePairingPermanent(session.AccountID)
	writeJSON(w, http.StatusOK, enableMCPRemoteResponse{Token: token})
}

// DeleteRemote disables Tier 2 for the caller's account: tears down the live
// client, deletes the persisted row, and invalidates the token immediately.
func (a *MCPRemoteAPI) DeleteRemote(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := a.store.DeleteMCPRemote(r.Context(), session.AccountID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	a.stop(session.AccountID)
	// Also drop the (now-permanent) relay pairing, else disabling remote mode
	// would leave a never-expiring pairing lingering in the in-memory table.
	a.relayAPI.RevokePairing(session.AccountID)
	w.WriteHeader(http.StatusNoContent)
}

type statusMCPRemoteResponse struct {
	Enabled bool `json:"enabled"`
}

// GetRemote reports whether Tier 2 is enabled for the caller's account. It
// never returns the token again — the devices page shows it once, at enable
// time, and relies on this endpoint only for on/off UI state.
func (a *MCPRemoteAPI) GetRemote(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	a.mu.RLock()
	_, enabled := a.byAcc[session.AccountID]
	a.mu.RUnlock()
	writeJSON(w, http.StatusOK, statusMCPRemoteResponse{Enabled: enabled})
}
