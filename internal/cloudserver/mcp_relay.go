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
	// relayWriteTimeout bounds a single pipe write: without it, a peer that
	// keeps its socket open but stops reading wedges the other leg's goroutine
	// in Write forever (r.Context() has no deadline and only cancels when the
	// writer's own conn closes — which it can't, because it's stuck writing).
	relayWriteTimeout = 30 * time.Second

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

	// onLegacyPairingMutation, if set, wraps a legacy pairing mutation
	// (CreatePairing/DeletePairing minting or revoking an account's single
	// relay pairing). The hosted-remote registry wires it (in NewMCPRemoteAPI)
	// to run `mutate` under its lifecycle lock, after tearing down any persisted
	// Tier 2 enablement for that account — teardown and the pairing mutation
	// happen atomically so neither can interleave with PostRemote's enable
	// critical section. Destroying or replacing the pairing without this would
	// otherwise strand an "enabled" remote row and a still-valid token whose
	// hosted shim relays to a pairing that no longer exists. Only the legacy
	// HTTP handlers call this — remote's own pairing management
	// (RestorePairing/MakePairingPermanent/RevokePairing) does not, so there's
	// no re-entrancy back into the remote registry. When unset, callers run
	// `mutate` directly. Returns an error if the Tier 2 teardown fails durably —
	// the caller then aborts its pairing mutation so a failed teardown can't
	// strand a persisted remote row against an evicted/revoked pairing.
	onLegacyPairingMutation func(ctx context.Context, accountID string, mutate func()) error
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
	// Minting a fresh pairing replaces whatever the account had — including a
	// pairing a persisted Tier 2 enablement depends on. Tear that enablement
	// down first so we never leave a remote row pointing at the pairing this
	// mint is about to evict, and run the mint under the remote registry's
	// lifecycle lock so it can't slip between PostRemote's pin and start().
	// (During the remote-enable flow the browser mints then immediately POSTs
	// /api/mcp/remote, so the teardown is a no-op there; it only bites a stale
	// local-shim mint against an already-remote account.)
	var id string
	mutate := func() { id = a.pairings.mint(session.AccountID) }
	if a.onLegacyPairingMutation != nil {
		if err := a.onLegacyPairingMutation(r.Context(), session.AccountID, mutate); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	} else {
		mutate()
	}
	writeJSON(w, http.StatusOK, createPairingResponse{PairingID: id})
}

// RestorePairing re-registers a persisted pairing (cloudstore's mcp_remote
// row) into the in-memory pairing table under its already-known id — called
// once per row by the hosted-remote registry's startup Restore, since a
// process restart otherwise drops every pairing (see the ponytail note atop
// this file). Restored pairings never expire: Tier 2 enablement is persisted
// and set-and-forget, so its pairing must outlive the 24h TTL that ages out
// Tier 1's re-mintable local-shim pairings.
func (a *MCPRelayAPI) RestorePairing(pairingID, accountID string) {
	a.pairings.restore(pairingID, accountID)
}

// MakePairingPermanent clears the expiry on accountID's live pairing so a
// freshly-enabled Tier 2 connector (whose pairing the browser minted with the
// normal 24h TTL) survives past that TTL without a restart — the persisted
// enablement is meant to be permanent until Disconnect. It pins by the
// submitted pairingID (not merely by account): if a concurrent re-mint
// (double-click, second tab, stale UI) already replaced the account's pairing,
// pairingID no longer matches the live one and this returns false, so the
// caller rejects the enable instead of persisting a pairing the hosted shim
// can never dial. Returns false (no-op) if the account has no pairing or its
// current pairing id differs from pairingID.
func (a *MCPRelayAPI) MakePairingPermanent(accountID, pairingID string) bool {
	return a.pairings.makePermanent(accountID, pairingID)
}

// RevokePairing drops accountID's pairing and closes both legs — the server
// side of Disconnect, so a torn-down Tier 2 enablement leaves no permanent
// pairing lingering in the in-memory table.
func (a *MCPRelayAPI) RevokePairing(accountID string) {
	a.pairings.revoke(accountID)
}

// DeletePairing revokes the caller's account's pairing (if any) and drops
// both of its connected legs.
func (a *MCPRelayAPI) DeletePairing(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Revoking the pairing out from under a persisted Tier 2 enablement would
	// leave the remote row + token enabled but relaying to nothing. Tear the
	// enablement down as part of the same mutation, under the remote registry's
	// lifecycle lock, so state stays consistent whether the user disconnects via
	// the new /api/mcp/remote path or this legacy endpoint (a stale tab, or a
	// local-mode client) — and so the revoke can't interleave with PostRemote.
	mutate := func() { a.pairings.revoke(session.AccountID) }
	if a.onLegacyPairingMutation != nil {
		if err := a.onLegacyPairingMutation(r.Context(), session.AccountID, mutate); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	} else {
		mutate()
	}
	w.WriteHeader(http.StatusNoContent)
}

// StatusNoPairing tells the browser responder that this account has no live
// pairing, so it must stop reconnecting and drop its stale vault record.
//
// It has to be a WebSocket close code rather than an HTTP status: the browser
// WebSocket API exposes no handshake status, so rejecting the upgrade with a
// 404 is indistinguishable from a network drop and the responder retries
// forever (the pairing table is in-memory — every redeploy strands one).
// Close codes ARE visible, in onclose's `code`. 4404 is in the 4000-4999
// application range reserved by RFC 6455 §7.4.2.
const StatusNoPairing websocket.StatusCode = 4404

// StatusPairingReplaced tells the browser responder that this account DOES have
// a live pairing — just not the one this tab presented. The two codes must stay
// distinct because the responder reacts to them in opposite ways:
//
//   - 4404 (no pairing at all): the vault record is a tombstone pointing at
//     nothing, so the responder purges it.
//   - 4409 (replaced): the vault record already names the *replacement* pairing
//     (or will, once this device syncs). Purging it would delete the pairing
//     every other device is happily using — account-wide. So the responder
//     stops, and steps aside without purging.
//
// Accept-then-close, like 4404: a browser WebSocket cannot observe a handshake
// HTTP status, so a 409 reject would be indistinguishable from a network drop
// and the tab would reconnect forever.
const StatusPairingReplaced websocket.StatusCode = 4409

// DeviceSocket is the browser-tab leg: the unlocked PWA connects here to
// answer relayed tool calls. Requires the account to already have an active
// pairing (minted via CreatePairing) — there's nothing to bridge otherwise —
// and the tab must present that pairing's id, so a tab still holding a
// pre-re-pair pairing cannot squat the current pairing's device slot (join is
// last-writer-wins and would evict the tab that actually holds the key).
//
// The pairing id is a selector, not a second authenticator: the session cookie
// still authenticates the leg. It only says *which* pairing this tab believes
// it holds.
func (a *MCPRelayAPI) DeviceSocket(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	record, ok := a.pairings.byAccountID(session.AccountID)
	if !ok {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.Close(StatusNoPairing, "no active pairing for this account")
		return
	}
	// A leg that presents no pairing id (an old responder from a previous
	// deploy) cannot prove which pairing it holds, so it gets the same
	// treatment as one presenting a stale id: stop, don't purge. Admitting it
	// on the session alone is exactly the unauthenticated squat this checks for.
	if r.URL.Query().Get("pairing") != record.id {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conn.Close(StatusPairingReplaced, "pairing replaced")
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
	select {
	case <-peerCh: // presence signal; the live peer conn is re-read each write below.
	case <-waitTimer.C:
		conn.Close(websocket.StatusPolicyViolation, "no peer connected in time")
		return
	case <-ctx.Done():
		return
	}

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			// Only tear down the peer if this conn is still the pairing's
			// registered leg. If a newer connection evicted us (join replaced
			// this slot), the replacement now owns the bridge — closing the
			// peer here would kill the live bridge, not just our dead half.
			if record.current(isDevice, conn) {
				if peer := record.peerConn(isDevice); peer != nil {
					peer.Close(websocket.StatusNormalClosure, "peer disconnected")
				}
			}
			return
		}
		if !a.limiter.Allow(record.id) {
			conn.Close(websocket.StatusPolicyViolation, "rate limit exceeded")
			if peer := record.peerConn(isDevice); peer != nil {
				peer.Close(websocket.StatusPolicyViolation, "peer rate limited")
			}
			return
		}
		// Re-read the peer conn each frame rather than caching it: when the
		// peer leg reconnects, join swaps in a fresh conn on its slot, and a
		// cached pointer would keep writing the evicted (dead) conn — breaking
		// the bridge one-way until a full teardown. See join.
		peer := record.peerConn(isDevice)
		if peer == nil {
			// Peer dropped mid-stream; drop this frame and keep serving so a
			// reconnecting peer re-bridges without tearing our leg down. A
			// genuinely-gone peer's own read-error path (above) closes us.
			continue
		}
		wctx, cancel := context.WithTimeout(ctx, relayWriteTimeout)
		err = peer.Write(wctx, typ, data)
		cancel()
		if err != nil {
			// The peer conn we wrote to is dead — but it may be an evicted conn
			// mid-replacement. Drop the frame and keep serving; the next frame
			// re-reads the current peer (possibly a reconnect).
			continue
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
// shim + single device per pairing, per the plan). A zero expiresAt means the
// pairing never expires — used for persisted Tier 2 enablements (see
// pairingTable.restore / makePermanent).
type pairingRecord struct {
	id        string
	accountID string
	expiresAt time.Time

	mu     sync.Mutex
	device *legSlot
	shim   *legSlot
}

// isExpired reports whether the pairing has aged out. A zero expiresAt (a
// persisted Tier 2 pairing) never expires.
func (p *pairingRecord) isExpired(now time.Time) bool {
	return !p.expiresAt.IsZero() && now.After(p.expiresAt)
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
	// leg's serveLeg observes the read error and returns; its record.current
	// check keeps it from closing the peer, which this replacement now bridges
	// to (serveLeg re-reads the live peer via peerConn each frame).
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
		// Both directions signal presence: our own serveLeg unblocks on
		// slot.peerCh, and a peer still waiting in its initial select unblocks
		// on peer.peerCh. A peer already piping ignores the send (buffered, or
		// the default) — it re-reads the swapped-in conn via peerConn.
		slot.peerCh <- peer.conn
		select {
		case peer.peerCh <- conn:
		default:
		}
	}
	return slot.peerCh
}

// peerConn returns the opposite leg's current live conn (nil if that leg
// isn't connected). Called per-frame by serveLeg so a peer reconnect (which
// swaps join's slot) is picked up transparently instead of writing a cached,
// evicted conn.
func (p *pairingRecord) peerConn(isDevice bool) *websocket.Conn {
	p.mu.Lock()
	defer p.mu.Unlock()
	peer := p.shim
	if !isDevice {
		peer = p.device
	}
	if peer == nil {
		return nil
	}
	return peer.conn
}

// current reports whether conn is still this pairing's registered leg — i.e.
// it hasn't been evicted and replaced by a newer connection on the same leg.
func (p *pairingRecord) current(isDevice bool, conn *websocket.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if isDevice {
		return p.device != nil && p.device.conn == conn
	}
	return p.shim != nil && p.shim.conn == conn
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
		if rec.isExpired(now) {
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
	t.register(id, accountID, false)
	return id
}

// restore re-registers a pairing under its already-known id, instead of
// generating a fresh one — used to rebuild this in-memory table from
// cloudstore's persisted mcp_remote rows after a process restart (Task 1's
// hosted-remote registry). A fresh id here would strand the pairing id the
// hosted mcpshim.Client (and, for the remote-enabled account, no separate
// local shim config) still holds. Restored pairings never expire (permanent),
// matching the persisted enablement's set-and-forget lifetime.
func (t *pairingTable) restore(id, accountID string) {
	t.register(id, accountID, true)
}

// makePermanent clears the expiry on accountID's live pairing so a Tier 2
// enablement whose pairing was minted with the normal TTL survives past it.
// The check that the account's current pairing id equals pairingID and the
// pin happen under one lock hold, so a concurrent mint can't slip a different
// pairing in between validate and pin. Returns false if the account has no
// pairing or its live pairing id differs from pairingID (a stale submission).
func (t *pairingTable) makePermanent(accountID, pairingID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.byAcc[accountID]
	if !ok || rec.id != pairingID {
		return false
	}
	rec.expiresAt = time.Time{}
	return true
}

// register installs a pairing record under id, revoking any pairing the
// account already held — the shared body behind mint (fresh id) and restore
// (known id). permanent leaves expiresAt zero so the pairing never ages out.
func (t *pairingTable) register(id, accountID string, permanent bool) {
	rec := &pairingRecord{id: id, accountID: accountID}
	if !permanent {
		rec.expiresAt = time.Now().Add(t.ttl)
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	if old, ok := t.byAcc[accountID]; ok {
		delete(t.byID, old.id)
		old.closeLegs()
	}
	t.byID[id] = rec
	t.byAcc[accountID] = rec
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
	if !ok || rec.isExpired(time.Now()) {
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
	if !ok || rec.isExpired(time.Now()) {
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
