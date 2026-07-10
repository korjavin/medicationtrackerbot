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
	TransferSlotStatus(ctx context.Context, slotID, accountID string, now time.Time) (string, error)
	DeleteTransferSlot(ctx context.Context, slotID, accountID string) error
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
	// Session-authed, unlike the claim: these two answer only to the device that
	// opened the slot. Whoever merely holds the QR code learns nothing.
	mux.Handle("GET /api/transfer/{slot_id}", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.GetTransfer)))
	mux.Handle("DELETE /api/transfer/{slot_id}", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.DeleteTransfer)))
}

type transferStatusResponse struct {
	Status string `json:"status"`
}

// GetTransfer reports whether the caller's own slot is still pending or has
// been claimed, so the originating device can stop counting down and show that
// enrollment succeeded (med-tuv). Before this, the screen offered a live
// countdown and a Cancel button long after the new device had enrolled, and the
// user had no way to tell whether it had worked.
//
// Unknown, expired, and other-account slots all 404 alike: a slot id must not
// become a status oracle for whoever photographed the QR.
func (a *TransferAPI) GetTransfer(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	slotID := r.PathValue("slot_id")
	if slotID == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	status, err := a.store.TransferSlotStatus(r.Context(), slotID, session.AccountID, time.Now().UTC())
	if err != nil {
		if errors.Is(err, cloudstore.ErrTransferSlotInvalid) {
			http.Error(w, "transfer slot not found", http.StatusNotFound)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, transferStatusResponse{Status: status})
}

// DeleteTransfer invalidates the caller's own slot immediately.
//
// Cancel must mean cancelled. The button used to clear a local timer and
// navigate away, leaving the slot live and claimable for the rest of its
// 10-minute window — so a user who realised they had shown the QR to the wrong
// person, or left it on a shared screen, pressed Cancel and reasonably believed
// the code was dead. It was not. In an E2EE product that code enrolls a NEW
// DEVICE onto the vault, so the button was teaching a false belief about a
// live credential (med-tuv).
func (a *TransferAPI) DeleteTransfer(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	slotID := r.PathValue("slot_id")
	if slotID == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	if err := a.store.DeleteTransferSlot(r.Context(), slotID, session.AccountID); err != nil {
		if errors.Is(err, cloudstore.ErrTransferSlotInvalid) {
			// Already gone (expired, swept, or never ours). The caller's intent —
			// "this code must not work" — holds either way.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type createTransferRequest struct {
	CT []byte `json:"ct"`
}

type createTransferResponse struct {
	SlotID    string    `json:"slot_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CreateTransfer opens a device-transfer slot for the caller's session
// account: it stores the DEK ciphertext (already encrypted client-side under
// a transfer key the server never sees) and returns a slot id the new device
// claims. The claim (not this call) mints the enrollment token that authorizes
// the new device's registration.
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
	// The slot's real enrollment token is minted at claim time (ClaimTransferSlot
	// rotates enrollment_token_hash and only a fetched=1 slot's token validates).
	// This create-time hash is just a non-null placeholder for the NOT NULL
	// column and is never returned — an old device can't enroll off it.
	_, tokenHash, err := NewClaimToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	expiresAt := now.Add(transferSlotTTL)
	if err := a.store.CreateTransferSlot(r.Context(), slotID, session.AccountID, tokenHash, req.CT, now, expiresAt); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, createTransferResponse{SlotID: slotID, ExpiresAt: expiresAt})
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
