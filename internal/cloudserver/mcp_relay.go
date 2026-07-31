package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log/slog"
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

	// maxRelayFrameBytes caps one sealed frame. It is enforced with
	// conn.SetReadLimit, and coder/websocket does not skip an oversized frame —
	// it CLOSES the connection. So a single too-big response does not fail just
	// that call: it kills the device leg, and every call after it reports "no
	// unlocked device is online" until the tab redials, straight back into the
	// same oversized answer.
	//
	// 64 KiB was exactly that trap in production — any mcp_call listing real
	// health data (a few weeks of vitals, a food log, a session history) clears
	// it easily, and the relay logged `message too big: read limited at 65537
	// bytes` on a loop with the app open and unlocked the whole time. 1 MiB fits
	// every list the domain layer can currently produce, and the responder
	// refuses to send anything larger rather than re-entering that loop
	// (web/cloud/js/mcp-responder.js's sendFrame).
	//
	// ponytail: worst-case memory is this times deferredFrameBuffer per waiting
	// leg (~32 MiB). Fine for a self-hosted box; shrink the queue first if a
	// hosted deployment ever runs many accounts hot.
	maxRelayFrameBytes = 1 << 20

	// relayPingEvery/-Timeout keep each leg alive and, more importantly, make a
	// dead one observable. Neither end of this relay speaks between tool calls,
	// and an idle WebSocket is exactly what a reverse proxy, a mobile carrier
	// NAT, or a phone suspending a backgrounded tab silently drops. Without a
	// ping the relay keeps a half-open socket registered as the live device leg
	// and writes frames into it forever; the shim then waits out its 30s
	// CallTimeout and reports "No unlocked Med Tracker device is online" while
	// the user is staring at an unlocked app. A failed ping closes the leg
	// instead, so the browser responder's onclose fires and it redials.
	//
	// The interval is short relative to mcpshim.CallTimeout on purpose. A leg
	// that dies silently (a frozen tab sends no FIN) still accepts writes into
	// the kernel buffer, so frames sent to it in the meantime are simply lost —
	// nothing at this layer can confirm delivery. The ping is the only thing
	// that ends that window, and evicting the corpse within ~15s is what lets
	// the NEXT call find no peer and wait for the reconnect (which delivers)
	// instead of writing into a black hole (which does not).
	relayPingEvery   = 10 * time.Second
	relayPingTimeout = 5 * time.Second

	// relayFrameBudget is how long the relay will spend placing ONE frame on the
	// opposite leg — waiting for that leg to attach, and writing to it, across
	// every attempt combined. relayPeerPoll is how often a waiting frame
	// re-checks. It doubles as the write timeout: without a bound, a peer that
	// holds its socket open but stops reading would wedge a writer forever.
	//
	// The budget starts when the frame is READ, not when a retry begins, and
	// stays under mcpshim.CallTimeout, so the relay can never deliver a frame
	// after the caller has been told the device is offline. That matters most
	// for writes: past the timeout the agent may already have retried under a
	// fresh nonce, which the responder's replay ring cannot catch, so a late
	// delivery would be a duplicate side effect nobody asked for.
	relayFrameBudget = 25 * time.Second
	relayPeerPoll    = time.Second

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
	CredentialExists(ctx context.Context, accountID string, credentialID []byte) (bool, error)
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
// a live pairing, but this leg is not the one serving it — either the tab
// presented a stale pairing id (DeviceSocket) or a newer leg took over the
// device slot (pairingRecord.join). Either way the responder must stop rather
// than retry: reconnecting re-runs the same losing race.
//
// The two codes must stay distinct because the responder reacts to them in
// opposite ways:
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
	// Accept the upgrade before any check: a browser WebSocket cannot observe a
	// handshake status, so every rejection has to be an application close code.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	record, ok := a.pairings.byAccountID(session.AccountID)
	if !ok {
		slog.Warn("mcp relay: device leg refused, no pairing for account", "account_id", session.AccountID)
		conn.Close(StatusNoPairing, "no active pairing for this account")
		return
	}
	// A leg that presents no pairing id (an old responder from a previous
	// deploy) cannot prove which pairing it holds, so it gets the same
	// treatment as one presenting a stale id: stop, don't purge. Admitting it
	// on the session alone is exactly the unauthenticated squat this checks for.
	if r.URL.Query().Get("pairing") != record.id {
		slog.Warn("mcp relay: device leg refused, stale pairing id", "account_id", session.AccountID,
			"presented", endpointFingerprint(r.URL.Query().Get("pairing")), "current", endpointFingerprint(record.id))
		conn.Close(StatusPairingReplaced, "pairing replaced")
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
		slog.Warn("mcp relay: shim leg refused, unknown or expired pairing",
			"pairing", endpointFingerprint(r.URL.Query().Get("pairing")))
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

	leg := "shim"
	if isDevice {
		leg = "device"
	}
	slog.Info("mcp relay: leg connected", "leg", leg, "account_id", record.accountID, "pairing", endpointFingerprint(record.id))

	peerCh := record.join(isDevice, conn)
	defer record.clear(isDevice, conn)

	// legCtx dies when this leg does — either ctx is cancelled or the keepalive
	// finds the socket dead. Everything below selects on it so nothing parks
	// forever on a connection that is already gone.
	legCtx, cancelLeg := context.WithCancel(ctx)
	defer cancelLeg()
	go func() {
		defer cancelLeg()
		keepalive(legCtx, conn, leg, record.accountID)
	}()

	// Frames that cannot go out immediately queue here and are delivered by one
	// worker, in order. A goroutine per frame would be simpler but would let two
	// frames queued during the same reconnect window race each other onto the
	// wire — and WebSocket delivery is ordered, so nothing downstream expects to
	// have to re-order.
	deferred := make(chan deferredFrame, deferredFrameBuffer)
	go deliverDeferred(legCtx, deferred, record, isDevice, peerCh, leg)

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			slog.Info("mcp relay: leg disconnected", "leg", leg, "account_id", record.accountID,
				"pairing", endpointFingerprint(record.id), "error", err)
			// A leg drop is NOT propagated to its peer, in either direction.
			//
			// It used to be, device→shim, so the shim would notice and redial.
			// But a phone drops its leg constantly — tab freeze, wifi↔cellular
			// handoff, battery saver — and each drop tore down the caller's
			// live connection mid-call, surfacing as a raw
			// `relay connection closed: ... "peer disconnected"` instead of an
			// answer. The device is usually back within seconds, and the
			// deferred queue holds the in-flight frame long enough to be
			// answered when it is;
			// killing the shim guarantees the failure the wait would have
			// avoided.
			//
			// Nothing is lost by leaving the peer up. Both legs are pinged, so a
			// genuinely dead one is reaped on its own; peerConn is re-read per
			// frame, so a reconnecting leg re-bridges transparently; and a call
			// with no device to answer it still ends in mcpshim's honest
			// ErrDeviceOffline rather than a transport error the agent cannot
			// act on.
			return
		}
		if !a.limiter.Allow(record.id) {
			slog.Warn("mcp relay: rate limit exceeded", "leg", leg, "account_id", record.accountID,
				"pairing", endpointFingerprint(record.id))
			conn.Close(websocket.StatusPolicyViolation, "rate limit exceeded")
			if peer := record.peerConn(isDevice); peer != nil {
				peer.Close(websocket.StatusPolicyViolation, "peer rate limited")
			}
			return
		}
		// One budget per frame, started here at read time and shared by the
		// inline write and every deferred retry, so a slow write cannot buy the
		// frame a fresh window past the caller's own timeout.
		deadline := time.Now().Add(relayFrameBudget)

		// Re-read the peer conn each frame rather than caching it: when the
		// peer leg reconnects, join swaps in a fresh conn on its slot, and a
		// cached pointer would keep writing the evicted (dead) conn — breaking
		// the bridge one-way until a full teardown. See join.
		if peer := record.peerConn(isDevice); peer != nil {
			wctx, cancel := context.WithDeadline(ctx, deadline)
			err = peer.Write(wctx, typ, data)
			cancel()
			if err == nil {
				continue
			}
		}
		// No peer, or the conn we had is dead / mid-eviction — most often a
		// phone that is already reconnecting. Hand the frame to the worker and
		// keep reading: see deliverDeferred for why this must not block here.
		select {
		case deferred <- deferredFrame{deadline: deadline, typ: typ, data: data}:
		default:
			slog.Warn("mcp relay: frame dropped, deferred queue full", "leg", leg,
				"account_id", record.accountID, "pairing", endpointFingerprint(record.id))
		}
	}
}

// deferredFrameBuffer caps how many frames may be waiting on a reconnecting
// peer at once. A leg is rate-limited to 120 frames per 10s and each waiting
// frame expires within relayFrameBudget, so this only fills under a burst far
// beyond interactive use — and dropping there is the same outcome as expiry:
// one call reporting the device offline.
const deferredFrameBuffer = 32

// deferredFrame is one frame waiting for the opposite leg, carrying the
// deadline it was read at so time spent queued cannot extend its budget.
type deferredFrame struct {
	deadline time.Time
	typ      websocket.MessageType
	data     []byte
}

// deliverDeferred writes queued frames to the opposite leg as soon as that leg
// can take them, in queue order, giving up on any whose budget has run out.
//
// Waiting is what keeps the shim's opening request — written the instant it
// dials, often before the browser tab has attached — and any frame caught
// mid-reconnect from being dropped into a 30s CallTimeout that blames the
// device for being a second late.
//
// This runs OFF the read loop, deliberately. The read loop is what processes
// its leg's keepalive pongs (coder/websocket dispatches control frames inside
// conn.Read), so a leg that waited there would stop answering its own pings and
// be reaped as dead while perfectly healthy — on precisely the path this whole
// design exists to survive.
func deliverDeferred(legCtx context.Context, queue <-chan deferredFrame, record *pairingRecord,
	isDevice bool, peerCh chan *websocket.Conn, leg string,
) {
	for {
		select {
		case <-legCtx.Done():
			return
		case frame := <-queue:
			if !deliverWhenPeerAttaches(legCtx, frame, record, isDevice, peerCh) {
				slog.Warn("mcp relay: frame dropped, peer never attached", "leg", leg,
					"account_id", record.accountID, "pairing", endpointFingerprint(record.id))
			}
		}
	}
}

// deliverWhenPeerAttaches places one frame, retrying until its deadline, and
// reports whether it went out. It retries rather than waiting once because the
// peer slot can hold a conn that is already dead but not yet cleared: a phone
// drops its leg and reconnects, and both the nil window and the dead-conn
// window have to be ridden out.
//
// A frame delivered twice (a Write reported an error after the peer had already
// taken it) is harmless: the responder's nonce ring refuses a repeated write
// frame, and a repeated read is idempotent.
func deliverWhenPeerAttaches(legCtx context.Context, frame deferredFrame, record *pairingRecord,
	isDevice bool, peerCh chan *websocket.Conn,
) bool {
	expiry := time.NewTimer(time.Until(frame.deadline))
	defer expiry.Stop()
	// peerCh is a one-shot hint from join, so it can miss a peer that attached,
	// left, and came back while we were waiting. Poll as the backstop; the
	// channel is only there to make the common case immediate.
	poll := time.NewTicker(relayPeerPoll)
	defer poll.Stop()
	for {
		if peer := record.peerConn(isDevice); peer != nil {
			wctx, cancel := context.WithDeadline(legCtx, frame.deadline)
			err := peer.Write(wctx, frame.typ, frame.data)
			cancel()
			if err == nil {
				return true
			}
		}
		select {
		case <-peerCh:
		case <-poll.C:
		case <-expiry.C:
			return false
		case <-legCtx.Done():
			return true // shutting down, not a delivery failure worth logging
		}
	}
}

// keepalive pings conn until legCtx dies or the peer stops answering. The pong
// is read by serveLeg's own concurrent conn.Read (coder/websocket dispatches
// control frames there), and Ping serializes with the pipe's writes on the
// library's write mutex, so no extra locking is needed here.
//
// A failed ping is the only way this relay ever learns that a leg died without
// closing cleanly — the common case on mobile, where the OS freezes a
// backgrounded tab and the socket is half-open until something writes to it.
func keepalive(legCtx context.Context, conn *websocket.Conn, leg, accountID string) {
	ticker := time.NewTicker(relayPingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-legCtx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(legCtx, relayPingTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				// CloseNow, not Close: the peer is already unresponsive, so the
				// graceful handshake would just wait out its own timeout. This
				// also unblocks serveLeg's Read.
				conn.CloseNow()
				slog.Info("mcp relay: leg failed keepalive", "leg", leg, "account_id", accountID, "error", err)
				return
			}
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

	// The evicted leg's serveLeg observes the read error and returns; its
	// record.current check keeps it from closing the peer, which this
	// replacement now bridges to (serveLeg re-reads the live peer via peerConn
	// each frame).
	//
	// The device eviction closes in a goroutine, never inline: a graceful Close
	// blocks on the WebSocket close handshake (~5s against an unresponsive peer)
	// and this runs while p.mu is held — closing inline would stall the pairing
	// under reconnect churn. coder/websocket's Close is safe to call while the
	// evicted leg's own serveLeg sits in Read: it writes the close frame, then
	// waits for that reader to observe the peer's reply.
	slot := &legSlot{conn: conn, peerCh: make(chan *websocket.Conn, 1)}
	var peer *legSlot
	if isDevice {
		if p.device != nil {
			// 4409, not an abrupt CloseNow: an aborted socket reaches the browser
			// as 1006, which the responder treats as a transient drop and retries.
			// The retry presents the same (still-current) pairing id, passes
			// DeviceSocket's check, and evicts whoever replaced it — two unlocked
			// devices on one pairing then evict each other forever. 4409 tells the
			// loser to step aside instead (mcp-responder.js's onclose).
			// Logged because this is the one failure mode the leg-connected /
			// -disconnected pair above cannot be told apart from a network drop:
			// two unlocked devices on one account take turns owning the single
			// device slot, and the loser steps aside permanently. Repeated lines
			// here mean "the app is open in more than one place", not "flaky
			// network".
			slog.Info("mcp relay: device leg evicted by a newer one", "account_id", p.accountID,
				"pairing", endpointFingerprint(p.id))
			go p.device.conn.Close(StatusPairingReplaced, "replaced by a newer device leg")
		}
		p.device = slot
		peer = p.shim
	} else {
		// The shim leg keeps the abrupt close: mcpshim is independently versioned
		// and 4409 is not in its wire contract. CloseNow does not block, so it is
		// safe to call under p.mu.
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
