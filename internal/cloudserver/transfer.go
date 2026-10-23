package cloudserver

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// transferSlotTTL is the QR/typed-code hand-off window (docs/cloud-crypto.md
// "Path B — QR hand-off"): long enough to scan, compare the match code and
// complete the ceremony, short enough that a leaked slot id + TK stops being
// useful quickly.
const transferSlotTTL = 10 * time.Minute

// Wire sizes of the protocol-v2 values. The server validates sizes only — it
// holds no TK and no ECDH secret, so it can check none of the MACs (the
// devices do) and never derives the match code.
const (
	transferCommitLen = 32 // SHA-256(o_pub)
	transferPubLen    = 33 // compressed P-256 point
	transferMACLen    = 32 // HMAC-SHA256
)

// transferTokenHeader carries the claim token on the new device's polls: only
// the device that claimed the slot receives the ciphertext and the enrollment
// token once the slot is approved. It is poller identification, not the
// security boundary: ct is decryptable only with the claimant's n_priv.
const transferTokenHeader = "X-Transfer-Token"

// transferUpgradeMessage is what an older (protocol v1) client gets instead
// of a silent failure: v1 created slots with {ct} and claimed with an empty
// body.
const transferUpgradeMessage = "This version of the app can't add devices any more. Update the app or reload the page, then try again."

var transferPlatforms = map[string]bool{"web": true, "android": true, "ios": true}

// transferStore is the subset of *cloudstore.Repo the device-transfer
// endpoints need.
type transferStore interface {
	CreateTransferSlot(ctx context.Context, id, accountID string, enrollmentTokenHash, commit, approvingCredentialID []byte, createdAt, expiresAt time.Time) error
	GetTransferSlot(ctx context.Context, slotID, accountID string, now time.Time) (*cloudstore.TransferSlot, error)
	ClaimTransferSlot(ctx context.Context, slotID, accountID string, claimTokenHash, nPub, macN []byte, platform string, now time.Time) error
	RevealTransferSlot(ctx context.Context, slotID, accountID string, oPub, macO []byte, now time.Time) error
	ApproveTransferSlot(ctx context.Context, slotID, accountID string, ct, approvingCredentialID []byte, now time.Time) error
	DeleteTransferSlot(ctx context.Context, slotID, accountID string) error
	SweepExpiredTransferSlots(ctx context.Context, now time.Time) (int, error)
	CredentialExists(ctx context.Context, accountID string, credentialID []byte) (bool, error)
}

// TransferAPI holds the device-transfer HTTP handlers (protocol v2,
// docs/cloud-crypto.md "Path B"): the origin device opens a slot, the new
// device claims it, the origin reveals its key, the owner compares the match
// code on both screens and approves, and only then is the receiver-bound DEK
// ciphertext released to the device that claimed.
type TransferAPI struct {
	store         transferStore
	sessionSecret string
	limiter       *rateLimiter
}

// NewTransferAPI builds the transfer-slot handlers.
func NewTransferAPI(store transferStore, sessionSecret string) *TransferAPI {
	return &TransferAPI{
		store:         store,
		sessionSecret: sessionSecret,
		limiter:       newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow),
	}
}

// RegisterRoutes adds the transfer-slot routes to mux.
func (a *TransferAPI) RegisterRoutes(mux *http.ServeMux) {
	session := func(h http.HandlerFunc) http.Handler { return RequireSession(a.store, a.sessionSecret, h) }
	mux.Handle("POST /api/transfer", session(a.CreateTransfer))
	// Unauthenticated (whoever holds the QR can attempt a claim): per-IP
	// rate-limit. Callers are real client browsers with distinct IPs, so this
	// is the right primitive (unlike webhooks — see sentinel.md).
	mux.HandleFunc("POST /api/transfer/{slot_id}/claim", limitByIP(a.limiter, a.ClaimTransfer))
	mux.Handle("POST /api/transfer/{slot_id}/reveal", session(a.RevealTransfer))
	mux.Handle("POST /api/transfer/{slot_id}/approve", session(a.ApproveTransfer))
	// Answers both sides: the origin session sees the claim fields, the new
	// device polls unauthenticated (it has no session yet). Not rate-limited:
	// both sides poll every 2 s and the slot id is 132 bits of SHA-256 over a
	// 128-bit random TK.
	mux.HandleFunc("GET /api/transfer/{slot_id}", a.GetTransfer)
	mux.Handle("DELETE /api/transfer/{slot_id}", session(a.DeleteTransfer))
}

func writeTransferUpgrade(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, map[string]string{"error": "upgrade_required", "message": transferUpgradeMessage})
}

type createTransferRequest struct {
	// SlotID is derived by the origin: base64url(SHA-256(TK))[:22]. The typed
	// fallback code carries only TK, and the new device re-derives the id; the
	// server stores the id and never sees TK.
	SlotID string `json:"slot_id"`
	Commit []byte `json:"commit"`
}

// transferSlotIDLen is the derived slot id's length: 22 base64url characters
// (132 bits of SHA-256(TK)).
const transferSlotIDLen = 22

func validTransferSlotID(id string) bool {
	// Non-strict decoding accepts the truncated tail's leftover bits, so this
	// is exactly an alphabet check.
	_, err := base64.RawURLEncoding.DecodeString(id)
	return len(id) == transferSlotIDLen && err == nil
}

type createTransferResponse struct {
	SlotID    string    `json:"slot_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CreateTransfer opens a pending slot for the caller's session account. It
// stores only commit = SHA-256(o_pub): the origin's public key itself is
// posted at reveal, after the new device has committed to its own, so a relay
// can never choose one key after seeing the other.
func (a *TransferAPI) CreateTransfer(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req createTransferRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.Commit) == 0 {
		// A v1 origin posts {ct}.
		writeTransferUpgrade(w)
		return
	}
	if len(req.Commit) != transferCommitLen || !validTransferSlotID(req.SlotID) {
		http.Error(w, "invalid commit or slot_id", http.StatusBadRequest)
		return
	}
	slotID := req.SlotID

	now := time.Now().UTC()
	if _, err := a.store.SweepExpiredTransferSlots(r.Context(), now); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	// Non-null placeholder for the NOT NULL column, never returned; the claim
	// replaces it with the claimant's token hash.
	_, tokenHash, err := NewClaimToken()
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	expiresAt := now.Add(transferSlotTTL)
	if err := a.store.CreateTransferSlot(r.Context(), slotID, session.AccountID, tokenHash, req.Commit, session.CredentialID, now, expiresAt); err != nil {
		if errors.Is(err, cloudstore.ErrSourceCredentialRevoked) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if errors.Is(err, cloudstore.ErrTransferSlotExists) {
			// Only a reused transfer key gets here; the client must mint a new one.
			http.Error(w, "slot_id already in use — generate a new code", http.StatusConflict)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, createTransferResponse{SlotID: slotID, ExpiresAt: expiresAt})
}

type claimTransferRequest struct {
	NPub     []byte `json:"n_pub"`
	Platform string `json:"platform"`
	MacN     []byte `json:"mac_n"`
}

type claimTransferResponse struct {
	Status string `json:"status"`
	// ClaimToken identifies this device's polls (X-Transfer-Token). It is
	// the slot's enrollment token, inert until the owner approves: the
	// approved poll hands it back as enrollment_token.
	ClaimToken string `json:"claim_token"`
}

// ClaimTransfer moves a pending slot to claimed with the new device's
// ephemeral public key, platform label and TK-keyed MAC — immutable from here
// on: a second claim is 409, so the receiver can never be swapped on this
// slot (a different receiver needs a fresh pairing). Nothing secret is
// returned. Unknown, expired and deleted slots are 410.
func (a *TransferAPI) ClaimTransfer(w http.ResponseWriter, r *http.Request) {
	slotID := r.PathValue("slot_id")
	account, ok := AccountFromContext(r.Context())
	if slotID == "" || !ok {
		http.Error(w, "transfer slot invalid or expired", http.StatusGone)
		return
	}

	var req claimTransferRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeBodyBytes)
	err := json.NewDecoder(r.Body).Decode(&req)
	if errors.Is(err, io.EOF) || (err == nil && len(req.NPub) == 0) {
		// A v1 new device claims with an empty body.
		writeTransferUpgrade(w)
		return
	}
	if err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.NPub) != transferPubLen || len(req.MacN) != transferMACLen || !transferPlatforms[req.Platform] {
		http.Error(w, "invalid claim", http.StatusBadRequest)
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

	switch err := a.store.ClaimTransferSlot(r.Context(), slotID, account.ID, tokenHash, req.NPub, req.MacN, req.Platform, now); {
	case errors.Is(err, cloudstore.ErrTransferSlotInvalid):
		http.Error(w, "transfer slot invalid or expired", http.StatusGone)
	case errors.Is(err, cloudstore.ErrTransferSlotState):
		http.Error(w, "this code was already used on another device", http.StatusConflict)
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
	default:
		writeJSON(w, http.StatusOK, claimTransferResponse{Status: cloudstore.TransferSlotClaimed, ClaimToken: token})
	}
}

type revealTransferRequest struct {
	OPub []byte `json:"o_pub"`
	MacO []byte `json:"mac_o"`
}

// RevealTransfer (origin session, only from claimed) stores the origin's
// ephemeral public key + TK-keyed MAC so both devices can show the match
// code. It carries no ciphertext and no enrollment token.
func (a *TransferAPI) RevealTransfer(w http.ResponseWriter, r *http.Request) {
	session, _ := SessionFromContext(r.Context())
	var req revealTransferRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		len(req.OPub) != transferPubLen || len(req.MacO) != transferMACLen {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	writeTransition(w, a.store.RevealTransferSlot(r.Context(), r.PathValue("slot_id"), session.AccountID, req.OPub, req.MacO, time.Now().UTC()))
}

type approveTransferRequest struct {
	CT []byte `json:"ct"`
	// ApprovingCredentialID (base64url, optional) names the passkey whose fresh
	// assertion unwrapped the DEK; defaults to the session's credential.
	// Revoking it kills the slot until enrollment.
	ApprovingCredentialID string `json:"approving_credential_id,omitempty"`
}

// ApproveTransfer (origin session, only from revealed — the owner has seen
// the match code) stores the DEK ciphertext, wrapped under a key only the
// claimed receiver can derive and bound to the transcript as AAD.
func (a *TransferAPI) ApproveTransfer(w http.ResponseWriter, r *http.Request) {
	session, _ := SessionFromContext(r.Context())
	var req approveTransferRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.CT) == 0 || len(req.CT) > maxCTLen {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	credID := session.CredentialID
	if req.ApprovingCredentialID != "" {
		id, err := base64.RawURLEncoding.DecodeString(req.ApprovingCredentialID)
		if err != nil || len(id) == 0 {
			http.Error(w, "invalid approving_credential_id", http.StatusBadRequest)
			return
		}
		exists, err := a.store.CredentialExists(r.Context(), session.AccountID, id)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !exists {
			http.Error(w, "invalid approving_credential_id", http.StatusBadRequest)
			return
		}
		credID = id
	}
	writeTransition(w, a.store.ApproveTransferSlot(r.Context(), r.PathValue("slot_id"), session.AccountID, req.CT, credID, time.Now().UTC()))
}

// writeTransition maps an origin-side transition result: the origin owns the
// slot, so a missing one is 404 and a slot in any other state is 409.
func writeTransition(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, cloudstore.ErrTransferSlotInvalid):
		http.Error(w, "transfer slot not found", http.StatusNotFound)
	case errors.Is(err, cloudstore.ErrTransferSlotState):
		http.Error(w, "transfer slot is not in the required state", http.StatusConflict)
	case errors.Is(err, cloudstore.ErrSourceCredentialRevoked):
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// transferOriginView is what the origin session polls: the claim fields it
// verifies (mac_n under TK) and freezes, and conf_n once enrolled.
type transferOriginView struct {
	Status    string    `json:"status"`
	ExpiresAt time.Time `json:"expires_at"`
	Platform  string    `json:"platform,omitempty"`
	NPub      []byte    `json:"n_pub,omitempty"`
	MacN      []byte    `json:"mac_n,omitempty"`
	OPub      []byte    `json:"o_pub,omitempty"`
	MacO      []byte    `json:"mac_o,omitempty"`
	ConfN     []byte    `json:"conf_n,omitempty"`
}

// transferPollView is what the new device polls: commit while pending /
// claimed, o_pub + mac_o once revealed, and ct + enrollment token only once
// approved and only to the claimant (X-Transfer-Token).
type transferPollView struct {
	Status          string    `json:"status"`
	ExpiresAt       time.Time `json:"expires_at"`
	Commit          []byte    `json:"commit,omitempty"`
	OPub            []byte    `json:"o_pub,omitempty"`
	MacO            []byte    `json:"mac_o,omitempty"`
	CT              []byte    `json:"ct,omitempty"`
	EnrollmentToken string    `json:"enrollment_token,omitempty"`
	AccountID       string    `json:"account_id,omitempty"`
}

// GetTransfer serves both sides of the hand-off. A request without
// X-Transfer-Token from a live session of the slot's account is the origin
// (unknown/expired/other-account slots 404 alike — no status oracle);
// anything else is the new device's poll (a gone slot is 410).
func (a *TransferAPI) GetTransfer(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.NotFound(w, r)
		return
	}
	slot, err := a.store.GetTransferSlot(r.Context(), r.PathValue("slot_id"), account.ID, time.Now().UTC())
	if err != nil && !errors.Is(err, cloudstore.ErrTransferSlotInvalid) {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	token := r.Header.Get(transferTokenHeader)

	if token == "" {
		if isOrigin, err := a.liveSession(r, account.ID); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		} else if isOrigin {
			if slot == nil {
				http.Error(w, "transfer slot not found", http.StatusNotFound)
				return
			}
			writeJSON(w, http.StatusOK, transferOriginView{
				Status: slot.State, ExpiresAt: slot.ExpiresAt, Platform: slot.Platform,
				NPub: slot.NPub, MacN: slot.MacN, OPub: slot.OPub, MacO: slot.MacO, ConfN: slot.ConfN,
			})
			return
		}
	}

	if slot == nil {
		http.Error(w, "transfer slot invalid or expired", http.StatusGone)
		return
	}
	view := transferPollView{Status: slot.State, ExpiresAt: slot.ExpiresAt, Commit: slot.Commit}
	if slot.State == cloudstore.TransferSlotRevealed || slot.State == cloudstore.TransferSlotApproved {
		view.OPub, view.MacO = slot.OPub, slot.MacO
	}
	if slot.State == cloudstore.TransferSlotApproved && token != "" {
		if hash, ok := hashHexToken(token); ok && subtle.ConstantTimeCompare(hash, slot.EnrollmentTokenHash) == 1 {
			view.CT, view.EnrollmentToken, view.AccountID = slot.CT, token, account.ID
		}
	}
	writeJSON(w, http.StatusOK, view)
}

// liveSession reports whether r carries a session for accountID whose
// credential has not been revoked (RequireSession's checks, without
// requiring a session).
func (a *TransferAPI) liveSession(r *http.Request, accountID string) (bool, error) {
	session, ok := sessionForAccount(r, a.sessionSecret, accountID)
	if !ok {
		return false, nil
	}
	return a.store.CredentialExists(r.Context(), accountID, session.CredentialID)
}

// DeleteTransfer invalidates the caller's own slot immediately, from every
// state: Deny, Cancel, and the origin leaving the screen all land here.
//
// Cancel must mean cancelled (med-tuv): the button once cleared a local timer
// and left the slot live for the rest of its window, teaching a false belief
// about a code that can enroll a new device onto the vault. Before approve
// nothing has been released, so this is complete; after approve it drops the
// stored ciphertext and kills the enrollment token, so register/finish fails.
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
