package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

const (
	maxInboxKeyBodyBytes = 1 << 10
	// One drain pulls at most this many events. A drain that finds a full page
	// simply runs again on the next open; the cap bounds a single response.
	maxInboxDrainBatch = 200
	// A single response never exceeds this many bytes of sealed ciphertext,
	// regardless of the count cap. A backlog of huge sealed .nxk vitals seals
	// (each up to ~MBs) would otherwise return a ~160MB body per poll and brick
	// the account (med-eas.51). Mirrors sync's ≤1 MiB FLUSH_MAX_BODY_BYTES batch:
	// always emit at least one event so the drain still makes progress.
	maxInboxDrainBytes = 1 << 20
)

// inboxStore is the narrow slice of cloudstore the inbox API needs. sessionStore
// methods come along because RequireSession needs them.
type inboxStore interface {
	sessionStore
	SetAccountInboxPublicKey(ctx context.Context, accountID string, pub []byte) error
	AccountInboxPublicKey(ctx context.Context, accountID string) ([]byte, error)
	ListInboxEvents(ctx context.Context, accountID string, limit int) ([]cloudstore.InboxEvent, error)
	DeleteInboxEvent(ctx context.Context, accountID string, id int64) error
	ClearInboxEvents(ctx context.Context, accountID string) (int64, error)
}

// InboxAPI serves the sealed inbound mailbox: clients publish the public key
// the server seals to, drain the pending queue, and ack each event individually
// after its effects are durably synced (see docs/cloud-mode.md, drain protocol).
type InboxAPI struct {
	store         inboxStore
	sessionSecret string
}

func NewInboxAPI(store inboxStore, sessionSecret string) *InboxAPI {
	return &InboxAPI{store: store, sessionSecret: sessionSecret}
}

func (a *InboxAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("PUT /api/inbox/key", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PutInboxKey)))
	mux.Handle("GET /api/inbox", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.ListInbox)))
	mux.Handle("DELETE /api/inbox/{id}", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.AckInboxEvent)))
	mux.Handle("DELETE /api/inbox", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.ClearInbox)))
}

type putInboxKeyRequest struct {
	PublicKey []byte `json:"public_key"`
}

// PutInboxKey publishes the caller's X25519 inbox public key. The server keeps
// only the public half — the private key is a vault record — so this endpoint
// grants the server the ability to seal events it can never read.
//
// Last-write-wins on purpose: a client that regenerates its keypair strands any
// event still sealed to the old key, so clients persist the private key to the
// vault BEFORE publishing, and only generate one when the vault has none.
func (a *InboxAPI) PutInboxKey(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req putInboxKeyRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxInboxKeyBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	// Reject a malformed key here rather than at seal time, where it would
	// silently strand every inbound event for this account.
	if !validInboxPublicKey(req.PublicKey) {
		http.Error(w, "invalid inbox public key", http.StatusBadRequest)
		return
	}
	if err := a.store.SetAccountInboxPublicKey(r.Context(), session.AccountID, req.PublicKey); err != nil {
		slog.Error("inbox: publish key", "accountID", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type inboxEventWire struct {
	ID            int64  `json:"id"`
	CreatedAtUnix int64  `json:"created_at_unix"`
	CT            []byte `json:"ct"`
}

type listInboxResponse struct {
	Events []inboxEventWire `json:"events"`
}

// ListInbox returns the caller's pending sealed events, oldest first. The server
// cannot read any of them; `created_at_unix` is exposed in the clear only so a
// client can order a drain without decrypting first (the same instant is sealed
// inside each payload, which is what the client actually trusts).
func (a *InboxAPI) ListInbox(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	events, err := a.store.ListInboxEvents(r.Context(), session.AccountID, maxInboxDrainBatch)
	if err != nil {
		slog.Error("inbox: list", "accountID", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	wire := make([]inboxEventWire, 0, len(events))
	var bodyBytes int
	for _, e := range events {
		// Always include the first event even if it alone exceeds the budget,
		// then stop before the budget is breached. Trims from the tail only, so
		// ORDER BY id is preserved and the client pages the rest on re-drain.
		if len(wire) > 0 && bodyBytes+len(e.CT) > maxInboxDrainBytes {
			break
		}
		wire = append(wire, inboxEventWire{ID: e.ID, CreatedAtUnix: e.CreatedAt.Unix(), CT: e.CT})
		bodyBytes += len(e.CT)
	}
	// Metadata only, and only when there was something to serve: this is what
	// distinguishes "the client never polled" (a wedged drain, a dead poller —
	// med-2yl) from "the client polled and something went wrong after". An empty
	// mailbox is NOT logged; that would be one line per device per 5s.
	if len(wire) > 0 {
		slog.Info("inbox: served", "accountID", session.AccountID, "count", len(wire))
	}
	writeJSON(w, http.StatusOK, listInboxResponse{Events: wire})
}

// AckInboxEvent deletes one event. Idempotent: several unlocked devices may
// drain concurrently, so the first ack wins and a second delete of the same id
// is a no-op rather than an error. Scoped to the session's account, so an id
// belonging to another account is a silent no-op too — never a leak of whether
// that id exists.
func (a *InboxAPI) AckInboxEvent(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid event id", http.StatusBadRequest)
		return
	}
	if err := a.store.DeleteInboxEvent(r.Context(), session.AccountID, id); err != nil {
		slog.Error("inbox: ack", "accountID", session.AccountID, "id", id, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	// Pairs with "inbox: served" above: together they show a drain completing,
	// which is the only server-visible evidence that a client applied an event.
	slog.Info("inbox: acked", "accountID", session.AccountID, "id", id)
	w.WriteHeader(http.StatusNoContent)
}

type clearInboxResponse struct {
	Cleared int64 `json:"cleared"`
}

// ClearInbox drops every pending event for the caller's account and returns the
// count. This is the recovery escape hatch (med-eas.51): a permanently
// un-appliable sealed event wedges sync forever, and the drain then never acks
// anything, so the only way out is to discard the poison backlog. It DISCARDS
// any un-applied sealed events — the same "throw away un-synced work to recover"
// trade resetLocalSync already makes — so the client only calls it from the
// reset path. Session-scoped: an account can only clear its own mailbox.
func (a *InboxAPI) ClearInbox(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	cleared, err := a.store.ClearInboxEvents(r.Context(), session.AccountID)
	if err != nil {
		slog.Error("inbox: clear", "accountID", session.AccountID, "error", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	slog.Info("inbox: cleared", "accountID", session.AccountID, "cleared", cleared)
	writeJSON(w, http.StatusOK, clearInboxResponse{Cleared: cleared})
}

// ErrNoInboxKey means the account has never unlocked a client, so no key exists
// to seal to. Callers MUST drop the event — storing it in the clear would put
// exactly the plaintext this design exists to withhold into the database.
var ErrNoInboxKey = errors.New("cloudserver: account has no published inbox key")

// InboxQueue is the write side of the mailbox, used by the inbound Telegram
// webhook (med-76c.2, part 2).
type InboxQueue interface {
	AccountInboxPublicKey(ctx context.Context, accountID string) ([]byte, error)
	AppendInboxEvent(ctx context.Context, accountID string, ct []byte, now time.Time) error
}

// SealAndQueue is the server's only write path into a mailbox: seal `plaintext`
// to the account's published inbox key and append it.
//
// `now` is the server's timestamp; the caller embeds it in plaintext (so the
// client can trust it) and it is stored alongside in the clear so a drain can
// order events without decrypting them first.
func SealAndQueue(ctx context.Context, store InboxQueue, accountID string, plaintext []byte, now time.Time) error {
	pub, err := store.AccountInboxPublicKey(ctx, accountID)
	if err != nil {
		return err
	}
	if len(pub) == 0 {
		return ErrNoInboxKey
	}
	sealed, err := sealInbox(rand.Reader, pub, accountID, plaintext)
	if err != nil {
		return err
	}
	return store.AppendInboxEvent(ctx, accountID, sealed, now)
}
