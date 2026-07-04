package cloudserver

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// Size caps on envelope fields — suite v1 (docs/cloud-crypto.md) wraps a
// 256-bit DEK, so real payloads are tiny; these caps are just sanity limits
// against abuse, not a spec requirement.
const (
	maxEnvelopeBodyBytes = 8 << 10 // 8 KiB request body
	maxNonceLen          = 64
	maxCTLen             = 4096
	maxMACLen            = 64
	maxVerifierLen       = 256
	maxCredentialRefLen  = 1024
)

// envelopeStore is the subset of *cloudstore.Repo the envelope, recovery
// material, and loss-ack endpoints need.
type envelopeStore interface {
	PutEnvelope(ctx context.Context, e cloudstore.Envelope) error
	GetEnvelope(ctx context.Context, accountID, credentialRef string) (*cloudstore.Envelope, error)
	ListEnvelopes(ctx context.Context, accountID string) ([]cloudstore.Envelope, error)
	SetRecoveryMaterial(ctx context.Context, accountID string, env cloudstore.Envelope, verifierHash []byte) error
	SetLossAck(ctx context.Context, accountID string, ackAt time.Time) error
	CredentialExists(ctx context.Context, credentialID []byte) (bool, error)
}

// EnvelopeAPI holds the account-scoped envelope storage + recovery material
// HTTP handlers. Every route requires a valid session (RequireSession).
type EnvelopeAPI struct {
	store         envelopeStore
	sessionSecret string
}

// NewEnvelopeAPI builds the envelope handlers.
func NewEnvelopeAPI(store envelopeStore, sessionSecret string) *EnvelopeAPI {
	return &EnvelopeAPI{store: store, sessionSecret: sessionSecret}
}

// RegisterRoutes adds the envelope + recovery-material routes to mux.
func (a *EnvelopeAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("PUT /api/envelopes/{credential_ref}", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PutEnvelope)))
	mux.Handle("GET /api/envelopes/{credential_ref}", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.GetEnvelope)))
	mux.Handle("GET /api/envelopes", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.ListEnvelopes)))
	mux.Handle("PUT /api/recovery-material", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PutRecoveryMaterial)))
	mux.Handle("POST /api/loss-ack", RequireSession(a.store, a.sessionSecret, http.HandlerFunc(a.PostLossAck)))
}

// envelopeWire is the wire shape of an envelope — nonce/ct/mac are base64
// automatically via encoding/json's []byte handling.
type envelopeWire struct {
	V     int    `json:"v"`
	Nonce []byte `json:"nonce"`
	CT    []byte `json:"ct"`
	MAC   []byte `json:"mac"`
}

// envelopeListItem is one row of GET /api/envelopes — refs + mac only, so
// clients can run the envelope audit (docs/cloud-crypto.md) without
// downloading every ciphertext.
type envelopeListItem struct {
	CredentialRef string `json:"credential_ref"`
	MAC           []byte `json:"mac"`
}

// recoveryVerifierRequest is the {verifier} body shape shared by the recovery
// redemption endpoint (POST /api/recover) — the plaintext verifier the server
// hashes and compares, never persisted.
type recoveryVerifierRequest struct {
	Verifier []byte `json:"verifier"`
}

// recoveryMaterialRequest bundles the recovery envelope + verifier so the
// server writes both in one transaction — the two can never partially apply
// and leave a mismatched recovery pair.
type recoveryMaterialRequest struct {
	Envelope envelopeWire `json:"envelope"`
	Verifier []byte       `json:"verifier"`
}

// validCredentialRef mirrors the plan's contract: a credential_ref is either
// the literal "recovery" or a base64url-encoded credential id.
func validCredentialRef(ref string) bool {
	if ref == "recovery" {
		return true
	}
	if ref == "" || len(ref) > maxCredentialRefLen {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(ref)
	return err == nil
}

// PutEnvelope upserts the encrypted envelope for the caller's session account
// + the path's credential_ref.
func (a *EnvelopeAPI) PutEnvelope(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	ref := r.PathValue("credential_ref")
	if !validCredentialRef(ref) {
		http.Error(w, "invalid credential_ref", http.StatusBadRequest)
		return
	}
	// The recovery envelope and its verifier must move together — a lone
	// envelope write here would pair a new envelope with the stale verifier and
	// silently break recovery. Force recovery material through the atomic
	// /api/recovery-material endpoint (docs/cloud-crypto.md).
	if ref == "recovery" {
		http.Error(w, "use /api/recovery-material for the recovery envelope", http.StatusConflict)
		return
	}

	var req envelopeWire
	if err := json.NewDecoder(io.LimitReader(r.Body, maxEnvelopeBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if len(req.Nonce) == 0 || len(req.Nonce) > maxNonceLen || len(req.CT) == 0 || len(req.CT) > maxCTLen || len(req.MAC) > maxMACLen {
		http.Error(w, "envelope field too large or missing", http.StatusBadRequest)
		return
	}

	if err := a.store.PutEnvelope(r.Context(), cloudstore.Envelope{
		AccountID:     session.AccountID,
		CredentialRef: ref,
		V:             req.V,
		Nonce:         req.Nonce,
		CT:            req.CT,
		MAC:           req.MAC,
	}); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetEnvelope returns one envelope for the caller's session account.
func (a *EnvelopeAPI) GetEnvelope(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	ref := r.PathValue("credential_ref")
	if !validCredentialRef(ref) {
		http.Error(w, "invalid credential_ref", http.StatusBadRequest)
		return
	}

	e, err := a.store.GetEnvelope(r.Context(), session.AccountID, ref)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, envelopeWire{V: e.V, Nonce: e.Nonce, CT: e.CT, MAC: e.MAC})
}

// ListEnvelopes returns every envelope ref + mac stored for the caller's
// session account (never the ciphertext) so clients can run the
// envelope-audit pass.
func (a *EnvelopeAPI) ListEnvelopes(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	envs, err := a.store.ListEnvelopes(r.Context(), session.AccountID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]envelopeListItem, len(envs))
	for i, e := range envs {
		out[i] = envelopeListItem{CredentialRef: e.CredentialRef, MAC: e.MAC}
	}
	writeJSON(w, http.StatusOK, out)
}

// PutRecoveryMaterial stores the recovery envelope and SHA-256(verifier) for
// the caller's session account in one transaction. Emergency Kit rotation
// writes through this instead of separate envelope + verifier PUTs, so a
// partial failure can never leave a new envelope paired with the old verifier
// (which silently breaks recovery and can strand the account past the
// last-credential guard).
func (a *EnvelopeAPI) PutRecoveryMaterial(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req recoveryMaterialRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxEnvelopeBodyBytes)).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	env := req.Envelope
	if len(env.Nonce) == 0 || len(env.Nonce) > maxNonceLen || len(env.CT) == 0 || len(env.CT) > maxCTLen || len(env.MAC) > maxMACLen {
		http.Error(w, "envelope field too large or missing", http.StatusBadRequest)
		return
	}
	if len(req.Verifier) == 0 || len(req.Verifier) > maxVerifierLen {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	hash := sha256.Sum256(req.Verifier)
	if err := a.store.SetRecoveryMaterial(r.Context(), session.AccountID, cloudstore.Envelope{
		AccountID:     session.AccountID,
		CredentialRef: "recovery",
		V:             env.V,
		Nonce:         env.Nonce,
		CT:            env.CT,
		MAC:           env.MAC,
	}, hash[:]); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PostLossAck records that the caller's session account acknowledged the
// "we cannot recover your data" education step (docs/cloud-mode.md
// Onboarding step 3), so the stateless client wizard never re-nags.
func (a *EnvelopeAPI) PostLossAck(w http.ResponseWriter, r *http.Request) {
	session, ok := SessionFromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	if err := a.store.SetLossAck(r.Context(), session.AccountID, time.Now().UTC()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
