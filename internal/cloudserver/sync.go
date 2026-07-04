package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Size/count caps on a sync batch. ct can carry the client's largest oplog
// entry (a toy note today, domain records in C1); 64KiB is generous headroom
// over that without letting a single op exhaust an account's quota.
const (
	maxSyncOpsBodyBytes = 1 << 20 // 1 MiB request body (a full batch of ops)
	maxOpsPerBatch      = 500
	maxOpNonceLen       = 64
	maxOpCTLen          = 64 << 10
	maxRecordTypeTagLen = 128
	defaultOpsPageLimit = 200
	maxOpsPageLimit     = 1000
)

// syncStore is the subset of *cloudstore.Repo the sync (oplog) endpoints
// need.
type syncStore interface {
	AppendOps(ctx context.Context, accountID string, ops []cloudstore.OpInput, quotaBytes int64, now time.Time) ([]int64, error)
	ListOps(ctx context.Context, accountID string, since int64, limit int, now time.Time) ([]cloudstore.Op, error)
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// SyncAPI holds the account-scoped oplog append/list HTTP handlers. Every
// route requires a valid session (RequireSession).
type SyncAPI struct {
	store         syncStore
	sessionSecret string
	quotaBytes    int64
}

// NewSyncAPI builds the sync handlers. quotaBytes <= 0 disables the
// per-account storage quota.
func NewSyncAPI(store syncStore, sessionSecret string, quotaBytes int64) *SyncAPI {
	return &SyncAPI{store: store, sessionSecret: sessionSecret, quotaBytes: quotaBytes}
}

// RegisterRoutes adds the sync routes to mux.
func (a *SyncAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/sync/ops", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PostOps)))
	mux.Handle("GET /api/sync/ops", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.GetOps)))
}

// opWire is the wire shape of one op in a POST /api/sync/ops batch.
type opWire struct {
	RecordTypeTag string `json:"record_type_tag"`
	Nonce         []byte `json:"nonce"`
	CT            []byte `json:"ct"`
}

type postOpsRequest struct {
	Ops []opWire `json:"ops"`
}

type postOpsResponse struct {
	Assigned []int64 `json:"assigned"`
}

// PostOps appends a batch of encrypted ops for the caller's session account,
// tagging each with the session's own credential id (so device attribution
// survives without the server ever seeing plaintext).
func (a *SyncAPI) PostOps(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req postOpsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxSyncOpsBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.Ops) == 0 || len(req.Ops) > maxOpsPerBatch {
		http.Error(w, "batch size out of range", http.StatusBadRequest)
		return
	}
	ops := make([]cloudstore.OpInput, len(req.Ops))
	for i, op := range req.Ops {
		if op.RecordTypeTag == "" || len(op.RecordTypeTag) > maxRecordTypeTagLen ||
			len(op.Nonce) == 0 || len(op.Nonce) > maxOpNonceLen ||
			len(op.CT) == 0 || len(op.CT) > maxOpCTLen {
			http.Error(w, "op field too large or missing", http.StatusBadRequest)
			return
		}
		ops[i] = cloudstore.OpInput{
			DeviceCredentialID: session.CredentialID,
			RecordTypeTag:      op.RecordTypeTag,
			Nonce:              op.Nonce,
			CT:                 op.CT,
		}
	}

	assigned, err := a.store.AppendOps(r.Context(), session.AccountID, ops, a.quotaBytes, time.Now().UTC())
	if err != nil {
		if errors.Is(err, cloudstore.ErrQuotaExceeded) {
			http.Error(w, "account storage quota exceeded", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, postOpsResponse{Assigned: assigned})
}

// opListItem is one op in a GET /api/sync/ops page — device_credential_id is
// omitted; clients don't need it to apply the op, only the server-assigned
// seq the AAD binds against.
type opListItem struct {
	Seq           int64  `json:"seq"`
	RecordTypeTag string `json:"record_type_tag"`
	Nonce         []byte `json:"nonce"`
	CT            []byte `json:"ct"`
}

type getOpsResponse struct {
	Ops  []opListItem `json:"ops"`
	Next *int64       `json:"next"`
}

// GetOps returns an ordered page of the caller's session account's oplog
// after ?since (default 0), capped at ?limit (default/max
// defaultOpsPageLimit/maxOpsPageLimit). Next is set to the last returned seq
// when the page is full (more may follow), nil once caught up.
func (a *SyncAPI) GetOps(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	since := int64(0)
	if s := r.URL.Query().Get("since"); s != "" {
		v, err := strconv.ParseInt(s, 10, 64)
		if err != nil || v < 0 {
			http.Error(w, "invalid since", http.StatusBadRequest)
			return
		}
		since = v
	}
	limit := defaultOpsPageLimit
	if l := r.URL.Query().Get("limit"); l != "" {
		v, err := strconv.Atoi(l)
		if err != nil || v <= 0 || v > maxOpsPageLimit {
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		limit = v
	}

	ops, err := a.store.ListOps(r.Context(), session.AccountID, since, limit, time.Now().UTC())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]opListItem, len(ops))
	for i, o := range ops {
		out[i] = opListItem{Seq: o.Seq, RecordTypeTag: o.RecordTypeTag, Nonce: o.Nonce, CT: o.CT}
	}
	var next *int64
	if len(ops) == limit {
		n := ops[len(ops)-1].Seq
		next = &n
	}
	writeJSON(w, http.StatusOK, getOpsResponse{Ops: out, Next: next})
}
