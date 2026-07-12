package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net"
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
// SSRF via an attacker-chosen relay_url. mcp-pairing.js builds relay_url as
// "<ws|wss>://" + location.host, which equals the request Host header.
//
// The hostname must match the request's (the router already validated that
// this subdomain resolves to a real account under the base domain), and the
// path must be empty/root (the shim appends its own "/api/mcp/relay/shim").
// The port cannot be taken from the request: the Host header is spoofable and
// every "<sub>.<base>:<port>" resolves to this same server under wildcard DNS,
// so trusting it would let an authenticated caller aim the hosted shim's dial
// at any TCP port on the server's own IP (SSRF). Instead we pin the port to
// the values a legitimate browser origin actually uses — none/standard-web, or
// the server's real listen port (listenPort) for direct-port dev/self-hosting.
func relayURLIsSelf(relayURL, reqHost, listenPort string) bool {
	u, err := url.Parse(relayURL)
	if err != nil {
		return false
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return false
	}
	if u.Path != "" && u.Path != "/" {
		return false
	}
	if u.Hostname() != stripPort(reqHost) {
		return false
	}
	switch p := u.Port(); {
	case p == "" || p == "80" || p == "443":
		return true
	case listenPort != "" && p == listenPort:
		return true
	default:
		return false
	}
}

// serverListenPort returns the port the server itself is listening on for this
// request (net/http stashes the listener address under LocalAddrContextKey).
// Empty when unavailable (e.g. httptest.NewRequest, which skips the server
// path) — relayURLIsSelf then only accepts none/standard-web ports.
func serverListenPort(r *http.Request) string {
	la, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok {
		return ""
	}
	if _, port, err := net.SplitHostPort(la.String()); err == nil {
		return port
	}
	return ""
}

// mcpRemoteStore is the subset of *cloudstore.Repo the hosted-remote consent
// endpoints and startup restore need.
type mcpRemoteStore interface {
	CredentialExists(ctx context.Context, accountID string, credentialID []byte) (bool, error)
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

	// lifecycleMu serializes whole enable/disable/legacy-mutation critical
	// sections against each other so a pairing mutation can't interleave with
	// PostRemote's pin→persist→start. It is the outermost lock — mu and the
	// relay's pairing-table lock are only ever taken while holding it (or not at
	// all), never the reverse. Distinct from mu, which guards the byAcc map for
	// short reads/writes.
	lifecycleMu sync.Mutex

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
	a := &MCPRemoteAPI{
		store:         store,
		sessionSecret: sessionSecret,
		relayAPI:      relayAPI,
		byAcc:         make(map[string]*mcpRemoteEntry),
		failLimiter:   newRateLimiter(mcpEndpointFailLimitMax, mcpEndpointFailLimitWindow),
		callLimiter:   newRateLimiter(mcpEndpointCallLimitMax, mcpEndpointCallLimitWindow),
	}
	// The legacy pairing endpoints (CreatePairing/DeletePairing) mutate the
	// account's single relay pairing; wire them to tear down any Tier 2
	// enablement riding on that pairing so they can't strand an enabled-but-
	// broken remote row. See MCPRelayAPI.onLegacyPairingMutation.
	relayAPI.onLegacyPairingMutation = a.coordinateLegacyPairingMutation
	return a
}

// coordinateLegacyPairingMutation runs a legacy pairing mutation (mint/revoke)
// atomically with the Tier 2 teardown it may require, under lifecycleMu. Holding
// the lifecycle lock across BOTH the teardown and `mutate` is what closes the
// enable race: without it, a legacy mutation could land between PostRemote's
// MakePairingPermanent and start() — see an empty registry (teardown no-ops),
// then evict the very pairing PostRemote is about to persist and start, leaving
// remote reported enabled while the hosted shim dials a dead pairing. Because
// PostRemote holds lifecycleMu across its whole pin→persist→start section, the
// mutation is forced fully before it (then MakePairingPermanent rejects the now-
// stale submit with 409) or fully after it (then the teardown sees the live
// entry and disables remote cleanly).
func (a *MCPRemoteAPI) coordinateLegacyPairingMutation(ctx context.Context, accountID string, mutate func()) error {
	a.lifecycleMu.Lock()
	defer a.lifecycleMu.Unlock()
	if err := a.disableForAccount(ctx, accountID); err != nil {
		return err
	}
	mutate()
	return nil
}

// TeardownForAccount tears down the account's hosted-remote (Tier 2) MCP for the
// self-service account-delete path (med-d5t.8): closes the live hosted shim
// client and deletes the persisted mcp_remote row. Best-effort — logged and
// swallowed — since the account delete's transaction removes the row regardless
// and a leftover live client is the thing this actually needs to close.
func (a *MCPRemoteAPI) TeardownForAccount(ctx context.Context, accountID string) {
	a.lifecycleMu.Lock()
	defer a.lifecycleMu.Unlock()
	if err := a.disableForAccount(ctx, accountID); err != nil {
		slog.Warn("account teardown: disable hosted MCP", "account_id", accountID, "error", err)
	}
}

// disableForAccount tears down accountID's Tier 2 enablement — closes the
// hosted shim client and deletes the persisted row — if one exists. Idempotent
// and cheap when remote was never enabled (registry check first, no DB write).
// Wired as the relay's legacy-pairing-mutation hook.
//
// The durable delete comes BEFORE stop() and is fatal: if it fails (DB error or
// a canceled request context) we leave the live client and pairing untouched and
// return the error so the caller aborts its pairing mutation. Stopping the client
// and mutating the pairing anyway would strand the persisted mcp_remote row + its
// live token, which Restore then resurrects on the next restart while the
// in-memory client and pairing are gone.
func (a *MCPRemoteAPI) disableForAccount(ctx context.Context, accountID string) error {
	a.mu.RLock()
	_, enabled := a.byAcc[accountID]
	a.mu.RUnlock()
	if !enabled {
		return nil
	}
	if err := a.store.DeleteMCPRemote(ctx, accountID); err != nil {
		slog.Error("mcp remote: delete on legacy pairing mutation", "account_id", accountID, "error", err)
		return err
	}
	a.stop(accountID)
	return nil
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
		old.client.CloseNow()
	}
}

// stop removes and tears down accountID's live entry, if any.
func (a *MCPRemoteAPI) stop(accountID string) {
	a.mu.Lock()
	entry := a.byAcc[accountID]
	delete(a.byAcc, accountID)
	a.mu.Unlock()
	if entry != nil {
		entry.client.CloseNow()
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
	if !relayURLIsSelf(pc.RelayURL, r.Host, serverListenPort(r)) {
		http.Error(w, "invalid pairing code", http.StatusBadRequest)
		return
	}
	token, err := generateMCPRemoteToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Hold lifecycleMu across the whole pin→persist→start section so no legacy
	// pairing mutation (CreatePairing/DeletePairing) or self-disable can slip
	// between the pin and start() and evict the pairing under us. See
	// coordinateLegacyPairingMutation.
	a.lifecycleMu.Lock()
	defer a.lifecycleMu.Unlock()
	// Pin the submitted pairing permanent BEFORE persisting — and only if it's
	// still the account's live pairing. The browser minted it with the normal
	// 24h TTL; a persisted Tier 2 enablement is set-and-forget, so it must not
	// age out. Pinning by the submitted id (not just the account) atomically
	// rejects a stale submission: a concurrent re-mint (double-click, second
	// tab) could have replaced this pairing, and persisting it anyway would
	// leave remote reported as enabled while the hosted shim redials a revoked
	// pairing and never connects.
	if !a.relayAPI.MakePairingPermanent(session.AccountID, pc.PairingID) {
		http.Error(w, "pairing no longer active — reconnect and try again", http.StatusConflict)
		return
	}
	if err := a.store.UpsertMCPRemote(r.Context(), session.AccountID, token, pc.RelayURL, pc.PairingID, pc.Key, time.Now().UTC()); err != nil {
		// The pin above cleared the pairing's TTL in anticipation of this durable
		// write. With no row persisted there's nothing to keep it alive for, so
		// revoke it rather than leave a never-expiring pairing backing no
		// enablement (the "permanent only while enabled" lifecycle). Still under
		// lifecycleMu, so no concurrent enable observes the pinned-but-unpersisted
		// window.
		a.relayAPI.RevokePairing(session.AccountID)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	a.start(session.AccountID, token, pc)
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
	// Under lifecycleMu for the same reason as PostRemote: this deletes the row
	// and revokes the pairing, so an interleave with a concurrent enable would
	// otherwise leave the account enabled-but-dead.
	a.lifecycleMu.Lock()
	defer a.lifecycleMu.Unlock()
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
	Enabled bool   `json:"enabled"`
	Token   string `json:"token,omitempty"`
}

// GetRemote reports whether Tier 2 is enabled for the caller's account, and if
// so the connector token. The token is the credential, but the caller already
// holds a session cookie for this account's own subdomain — the same authority
// that could mint a fresh one via POST. Withholding it only forced users to
// rotate the connector (disconnect + re-enable) to recover a URL they lost,
// which is strictly worse. Never log it; the connectors page renders it with
// textContent only.
func (a *MCPRemoteAPI) GetRemote(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	a.mu.RLock()
	entry, enabled := a.byAcc[session.AccountID]
	a.mu.RUnlock()
	resp := statusMCPRemoteResponse{Enabled: enabled}
	if enabled {
		resp.Token = entry.token
	}
	writeJSON(w, http.StatusOK, resp)
}
