package cloudserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// transferSlotTTL is the QR/typed-code hand-off window (docs/cloud-crypto.md
// "Path B — QR hand-off"): long enough to scan and complete the ceremony,
// short enough that a leaked slot id + TK stops being useful quickly.
const transferSlotTTL = 10 * time.Minute

// transferStore is the subset of *cloudstore.Repo the device-transfer
// endpoints need.
type transferStore interface {
	CreateTransferSlot(ctx context.Context, id, accountID string, enrollmentTokenHash, ct []byte, createdAt, expiresAt time.Time) error
	ClaimTransferSlot(ctx context.Context, slotID string, newTokenHash []byte, now time.Time) (accountID string, ct []byte, err error)
	SweepExpiredTransferSlots(ctx context.Context, now time.Time) (int, error)
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// TransferAPI holds the device-transfer HTTP handlers: an unlocked device
// opens a slot (session auth), a new device claims it (unauthenticated —
// the transfer key that actually protects the DEK never touches the server).
type TransferAPI struct {
	store         transferStore
	sessionSecret string
}

// NewTransferAPI builds the transfer-slot handlers.
func NewTransferAPI(store transferStore, sessionSecret string) *TransferAPI {
	return &TransferAPI{store: store, sessionSecret: sessionSecret}
}

// RegisterRoutes adds the transfer-slot routes to mux.
func (a *TransferAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("POST /api/transfer", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.CreateTransfer)))
	mux.HandleFunc("POST /api/transfer/{slot_id}/claim", a.ClaimTransfer)
}

type createTransferRequest struct {
	CT []byte `json:"ct"`
}

type createTransferResponse struct {
	SlotID          string    `json:"slot_id"`
	EnrollmentToken string    `json:"enrollment_token"`
	ExpiresAt       time.Time `json:"expires_at"`
}

// CreateTransfer opens a device-transfer slot for the caller's session
// account: it stores the DEK ciphertext (already encrypted client-side under
// a transfer key the server never sees) and mints a slot id + one-time
// enrollment token for the eventual claim.
func (a *TransferAPI) CreateTransfer(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req createTransferRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxEnvelopeBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.CT) == 0 || len(req.CT) > maxCTLen {
		http.Error(w, "ct field too large or missing", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	if _, err := a.store.SweepExpiredTransferSlots(r.Context(), now); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	slotID, err := randomToken(16)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	token, tokenHash, err := NewClaimToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	expiresAt := now.Add(transferSlotTTL)
	if err := a.store.CreateTransferSlot(r.Context(), slotID, session.AccountID, tokenHash, req.CT, now, expiresAt); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, createTransferResponse{SlotID: slotID, EnrollmentToken: token, ExpiresAt: expiresAt})
}

type claimTransferResponse struct {
	CT              []byte `json:"ct"`
	EnrollmentToken string `json:"enrollment_token"`
	AccountID       string `json:"account_id"`
}

// ClaimTransfer fetches a transfer slot exactly once: it atomically marks the
// slot fetched, rotates its enrollment token, and hands the new device the
// DEK ciphertext, the account id (needed as the transfer AEAD's AAD — see
// docs/cloud-crypto.md "Path B"), plus the (freshly-minted) token that
// authorizes its passkey registration (see the register/begin|finish gate). A
// slot that is unknown, already fetched, or expired responds 410 Gone in all
// cases — the caller must not be able to distinguish which.
func (a *TransferAPI) ClaimTransfer(w http.ResponseWriter, r *http.Request) {
	slotID := r.PathValue("slot_id")
	if slotID == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	if _, err := a.store.SweepExpiredTransferSlots(r.Context(), now); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	token, tokenHash, err := NewClaimToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	accountID, ct, err := a.store.ClaimTransferSlot(r.Context(), slotID, tokenHash, now)
	if err != nil {
		if errors.Is(err, cloudstore.ErrTransferSlotInvalid) {
			http.Error(w, "transfer slot invalid or expired", http.StatusGone)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, claimTransferResponse{CT: ct, EnrollmentToken: token, AccountID: accountID})
}
