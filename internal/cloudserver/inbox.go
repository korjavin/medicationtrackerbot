package cloudserver

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
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
)

// inboxStore is the narrow slice of cloudstore the inbox API needs. sessionStore
// methods come along because RequireSession needs them.
type inboxStore interface {
	sessionStore
	SetAccountInboxPublicKey(ctx context.Context, accountID string, pub []byte) error
	AccountInboxPublicKey(ctx context.Context, accountID string) ([]byte, error)
	ListInboxEvents(ctx context.Context, accountID string, limit int) ([]cloudstore.InboxEvent, error)
	DeleteInboxEvent(ctx context.Context, accountID string, id int64) error
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
	if err := json.NewDecoder(io.LimitReader(r.Body, maxInboxKeyBodyBytes)).Decode(&req); err != nil {
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
	for _, e := range events {
		wire = append(wire, inboxEventWire{ID: e.ID, CreatedAtUnix: e.CreatedAt.Unix(), CT: e.CT})
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
	w.WriteHeader(http.StatusNoContent)
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
