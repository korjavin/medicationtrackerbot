package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Blind MCP relay (docs/cloud-mode.md "MCP", Tier 1): pipes opaque encrypted
// frames between a paired shim process (Claude Desktop/Code, off-device) and
// the account's unlocked browser tab (the device). The relay never decrypts
// or inspects a frame — it only ever sees ciphertext sizes and timing. See
// internal/mcpshim for the frame format (nonce ‖ AES-GCM ciphertext) and
// web/cloud/js/mcp-responder.js for the browser-side responder.
//
// ponytail: in-memory pairing table — a process restart drops every pairing
// and the user re-pairs. Persisting pairings (and multi-pairing per account)
// is full-C4 scope.

const (
	pairingTTL          = 24 * time.Hour
	pairingCleanupEvery = time.Hour
	pairingIDBytes      = 16

	maxRelayFrameBytes   = 64 << 10
	relayPeerWaitTimeout = 60 * time.Second

	// mcpRelayRateLimitMax/-Window bound how many frames one pairing may push
	// through the relay per window — generous for interactive tool calls
	// (request+response are two frames each) while capping a runaway/abusive
	// shim or tab. Mirrors internal/mcp/rate_limit.go's limiter, duplicated
	// here (not shared) because cloudserver must not import internal/mcp
	// (bot-mode package) any more than it may import internal/server.
	mcpRelayRateLimitMax    = 120
	mcpRelayRateLimitWindow = 10 * time.Second
)

// mcpRelayStore is the subset of *cloudstore.Repo the pairing endpoints
// need — RequireSession's revocation check only; pairings themselves live in
// memory, not in the store.
type mcpRelayStore interface {
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// MCPRelayAPI holds the pairing-mint/-revoke endpoints and the two WebSocket
// relay legs (device, shim).
type MCPRelayAPI struct {
	store         mcpRelayStore
	sessionSecret string
	pairings      *pairingTable
	limiter       *rateLimiter
}

// NewMCPRelayAPI builds the MCP relay handlers.
func NewMCPRelayAPI(store mcpRelayStore, sessionSecret string) *MCPRelayAPI {
	return &MCPRelayAPI{
		store:         store,
		sessionSecret: sessionSecret,
		pairings:      newPairingTable(pairingTTL),
		limiter:       newRateLimiter(mcpRelayRateLimitMax, mcpRelayRateLimitWindow),
	}
}

// RegisterRoutes adds the pairing + relay routes to mux. The device leg is
// session-authed like every other account-scoped route; the shim leg has no
// cookie jar (it's a local Go process, not a browser) so it authenticates
// with possession of the pairing id alone — the pairing key, which the
// relay never sees, is the actual secret (see docs/cloud-mode.md's trust
// recap).
func (a *MCPRelayAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/mcp/pairings", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.CreatePairing)))
	mux.Handle("DELETE /api/mcp/pairings", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeletePairing)))
	mux.Handle("GET /api/mcp/relay/device", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeviceSocket)))
	mux.HandleFunc("GET /api/mcp/relay/shim", a.ShimSocket)
}

type createPairingResponse struct {
	PairingID string `json:"pairing_id"`
}

// CreatePairing mints a new pairing id for the caller's account, replacing
// any pairing the account already had (ponytail: single pairing per
// account — Task 4's UI names the upgrade path). The pairing key itself
// never reaches this endpoint: it's generated client-side and folded into
// the one-time code the user pastes into the shim's config (Task 2/4).
func (a *MCPRelayAPI) CreatePairing(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := a.pairings.mint(session.AccountID)
	writeJSON(w, http.StatusOK, createPairingResponse{PairingID: id})
}

// DeletePairing revokes the caller's account's pairing (if any) and drops
// both of its connected legs.
func (a *MCPRelayAPI) DeletePairing(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	a.pairings.revoke(session.AccountID)
	w.WriteHeader(http.StatusNoContent)
}

// DeviceSocket is the browser-tab leg: the unlocked PWA connects here to
// answer relayed tool calls. Requires the account to already have an active
// pairing (minted via CreatePairing) — there's nothing to bridge otherwise.
func (a *MCPRelayAPI) DeviceSocket(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	record, ok := a.pairings.byAccountID(session.AccountID)
	if !ok {
		http.Error(w, "no active pairing for this account", http.StatusNotFound)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	a.serveLeg(r.Context(), conn, record, true)
}

// ShimSocket is the local mcpshim leg: authenticated by possession of the
// pairing id alone (no session cookie — the shim is a separate process, not
// a browser). Single-use in the sense of docs/cloud-mode.md: one pairing id
// binds to exactly one account and, via pairingRecord.join, at most one live
// shim connection at a time — but the id itself is reusable across the
// shim's own reconnects (Task 5) until revoked or it expires.
func (a *MCPRelayAPI) ShimSocket(w http.ResponseWriter, r *http.Request) {
	record, ok := a.pairings.byPairingID(r.URL.Query().Get("pairing"))
	if !ok {
		http.Error(w, "unknown or expired pairing", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	a.serveLeg(r.Context(), conn, record, false)
}

// serveLeg pipes conn's incoming frames to its peer, opaque, until either
// side errors or drops — then closes both ends. Each of the two legs (device,
// shim) runs its own serveLeg call in its own request goroutine, so full
// duplex piping falls out of the two directions running concurrently: no
// buffering beyond the one in-flight frame each Read/Write pair carries
// (PoC — see the plan's Task 1).
func (a *MCPRelayAPI) serveLeg(ctx context.Context, conn *websocket.Conn, record *pairingRecord, isDevice bool) {
	defer conn.CloseNow()
	conn.SetReadLimit(maxRelayFrameBytes)

	peerCh := record.join(isDevice, conn)
	defer record.clear(isDevice, conn)

	// NewTimer+Stop, not time.After: on the common path the peer arrives
	// immediately and an un-stopped time.After timer would linger the full
	// relayPeerWaitTimeout, accumulating under reconnect churn.
	waitTimer := time.NewTimer(relayPeerWaitTimeout)
	defer waitTimer.Stop()
	var peer *websocket.Conn
	select {
	case peer = <-peerCh:
	case <-waitTimer.C:
		conn.Close(websocket.StatusPolicyViolation, "no peer connected in time")
		return
	case <-ctx.Done():
		return
	}

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			peer.Close(websocket.StatusNormalClosure, "peer disconnected")
			return
		}
		if !a.limiter.Allow(record.id) {
			conn.Close(websocket.StatusPolicyViolation, "rate limit exceeded")
			peer.Close(websocket.StatusPolicyViolation, "peer rate limited")
			return
		}
		if err := peer.Write(ctx, typ, data); err != nil {
			conn.Close(websocket.StatusNormalClosure, "peer write failed")
			return
		}
	}
}

// legSlot is one leg's live connection plus the channel its peer (or the
// join call that discovers it already connected) delivers the other leg's
// conn to, once both are present.
type legSlot struct {
	conn   *websocket.Conn
	peerCh chan *websocket.Conn
}

// pairingRecord is one account's pairing: an id, the account that minted it,
// an expiry, and at most one live device leg + one live shim leg (single
// shim + single device per pairing, per the plan).
type pairingRecord struct {
	id        string
	accountID string
	expiresAt time.Time

	mu     sync.Mutex
	device *legSlot
	shim   *legSlot
}

// join registers conn as this pairing's device or shim leg, closing out any
// previous connection already occupying that leg, and returns a channel
// that yields the peer leg's conn as soon as both are present (immediately,
// if the peer already is).
func (p *pairingRecord) join(isDevice bool, conn *websocket.Conn) chan *websocket.Conn {
	p.mu.Lock()
	defer p.mu.Unlock()

	// CloseNow (not the graceful Close) on every eviction below: Close blocks up
	// to ~10s on the WebSocket close handshake against an unresponsive peer, and
	// these run while p.mu / the pairing table's mu is held — a graceful close
	// here would stall every account's pairing/relay endpoints. The evicted
	// leg's serveLeg observes the read error and tears its half down cleanly.
	slot := &legSlot{conn: conn, peerCh: make(chan *websocket.Conn, 1)}
	var peer *legSlot
	if isDevice {
		if p.device != nil {
			p.device.conn.CloseNow()
		}
		p.device = slot
		peer = p.shim
	} else {
		if p.shim != nil {
			p.shim.conn.CloseNow()
		}
		p.shim = slot
		peer = p.device
	}
	if peer != nil {
		slot.peerCh <- peer.conn
		select {
		case peer.peerCh <- conn:
		default: // peer is already piping against an earlier peerCh send; nothing to wake.
		}
	}
	return slot.peerCh
}

// clear drops conn from whichever leg it occupies, provided it hasn't
// already been replaced by a newer connection on that leg.
func (p *pairingRecord) clear(isDevice bool, conn *websocket.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if isDevice && p.device != nil && p.device.conn == conn {
		p.device = nil
	}
	if !isDevice && p.shim != nil && p.shim.conn == conn {
		p.shim = nil
	}
}

// closeLegs drops both live connections (pairing revoked or expired).
func (p *pairingRecord) closeLegs() {
	p.mu.Lock()
	defer p.mu.Unlock()
	// CloseNow, not Close: this runs under the pairing table's mu (revoke/mint/
	// cleanup) — a graceful close's ~10s handshake wait against a dead peer would
	// stall every account's pairing/relay endpoints.
	if p.device != nil {
		p.device.conn.CloseNow()
		p.device = nil
	}
	if p.shim != nil {
		p.shim.conn.CloseNow()
		p.shim = nil
	}
}

// pairingTable is the process-lifetime pairing store: one active pairing per
// account (ponytail: per-device pairings are full-C4 scope).
type pairingTable struct {
	ttl time.Duration

	mu    sync.Mutex
	byID  map[string]*pairingRecord
	byAcc map[string]*pairingRecord
}

func newPairingTable(ttl time.Duration) *pairingTable {
	t := &pairingTable{
		ttl:   ttl,
		byID:  make(map[string]*pairingRecord),
		byAcc: make(map[string]*pairingRecord),
	}
	t.startCleanup()
	return t
}

// startCleanup runs a background sweep evicting expired pairings, mirroring
// internal/mcp/rate_limit.go's rateLimiter.startCleanup — without it a
// long-lived process accumulates one dead entry per pairing ever minted.
func (t *pairingTable) startCleanup() {
	ticker := time.NewTicker(pairingCleanupEvery)
	go func() {
		for range ticker.C {
			t.cleanup()
		}
	}()
}

func (t *pairingTable) cleanup() {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, rec := range t.byID {
		if now.After(rec.expiresAt) {
			delete(t.byID, id)
			delete(t.byAcc, rec.accountID)
			rec.closeLegs()
		}
	}
}

// mint creates a fresh pairing for accountID, revoking any pairing the
// account already held.
func (t *pairingTable) mint(accountID string) string {
	id := generatePairingID()
	rec := &pairingRecord{id: id, accountID: accountID, expiresAt: time.Now().Add(t.ttl)}

	t.mu.Lock()
	defer t.mu.Unlock()
	if old, ok := t.byAcc[accountID]; ok {
		delete(t.byID, old.id)
		old.closeLegs()
	}
	t.byID[id] = rec
	t.byAcc[accountID] = rec
	return id
}

// revoke drops accountID's pairing, if any, closing both of its legs.
func (t *pairingTable) revoke(accountID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.byAcc[accountID]
	if !ok {
		return
	}
	delete(t.byAcc, accountID)
	delete(t.byID, rec.id)
	rec.closeLegs()
}

// byPairingID looks up a pairing by id — the shim leg's only credential.
func (t *pairingTable) byPairingID(id string) (*pairingRecord, bool) {
	if id == "" {
		return nil, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.byID[id]
	if !ok || time.Now().After(rec.expiresAt) {
		return nil, false
	}
	return rec, true
}

// byAccountID looks up the caller's account's pairing — the device leg's
// entry point, reached via its session (not the pairing id).
func (t *pairingTable) byAccountID(accountID string) (*pairingRecord, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.byAcc[accountID]
	if !ok || time.Now().After(rec.expiresAt) {
		return nil, false
	}
	return rec, true
}

func generatePairingID() string {
	b := make([]byte, pairingIDBytes)
	if _, err := rand.Read(b); err != nil {
		panic("mcp relay: crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
