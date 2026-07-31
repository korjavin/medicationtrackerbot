package cloudserver

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/cloudstore"
)

// recoveryEnrollmentTTL is the window in which a redeemed recovery code must
// finish enrolling its new passkey — mirrors transferSlotTTL's rationale.
const recoveryEnrollmentTTL = 10 * time.Minute

// recoveryStore is the subset of *cloudstore.Repo the recovery-redemption
// endpoint needs.
type recoveryStore interface {
	VerifyRecoveryAttempt(ctx context.Context, accountID string, verifierHash []byte, now time.Time) error
	GetEnvelope(ctx context.Context, accountID, credentialRef string) (*cloudstore.Envelope, error)
	CreateClaimedTransferSlot(ctx context.Context, id, accountID string, enrollmentTokenHash []byte, createdAt, expiresAt time.Time) error
	SweepExpiredTransferSlots(ctx context.Context, now time.Time) (int, error)
}

// RecoveryAPI holds the recovery-redemption HTTP handler: unauthenticated
// but subdomain-scoped, gated on the Emergency Kit verifier rather than a
// session.
type RecoveryAPI struct {
	store recoveryStore
	// limiter throttles this unauthenticated endpoint per client IP, on top of
	// the per-account DB throttle in VerifyRecoveryAttempt (the IP limit is
	// additive — it caps an attacker spraying many accounts from one IP).
	limiter *rateLimiter
}

// NewRecoveryAPI builds the recovery-redemption handler.
func NewRecoveryAPI(store recoveryStore) *RecoveryAPI {
	return &RecoveryAPI{
		store:   store,
		limiter: newRateLimiter(ceremonyRateLimitMax, ceremonyRateLimitWindow),
	}
}

// RegisterRoutes adds the recovery route to mux.
func (a *RecoveryAPI) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/recover", limitByIP(a.limiter, a.Recover))
}

type recoverResponse struct {
	Envelope        envelopeWire `json:"envelope"`
	EnrollmentToken string       `json:"enrollment_token"`
}

// Recover redeems an Emergency Kit recovery code: it rate-limit-checks and
// constant-time-compares the client-derived verifier against the account
// resolved from the subdomain host, then — on success — hands back the
// "recovery" DEK envelope plus a fresh one-time enrollment token that gates
// the follow-up passkey registration (the same ceremony device-transfer
// claims use). It never resets the rate-limit counter itself; the client is
// expected to immediately force a rotation (new code, new verifier, new
// envelope), which is what actually burns this code.
func (a *RecoveryAPI) Recover(w http.ResponseWriter, r *http.Request) {
	account, ok := AccountFromContext(r.Context())
	if !ok {
		http.Error(w, "account not resolved", http.StatusInternalServerError)
		return
	}

	var req recoveryVerifierRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxEnvelopeBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		len(req.Verifier) == 0 || len(req.Verifier) > maxVerifierLen {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	hash := sha256.Sum256(req.Verifier)
	if err := a.store.VerifyRecoveryAttempt(r.Context(), account.ID, hash[:], now); err != nil {
		switch {
		case errors.Is(err, cloudstore.ErrRecoveryRateLimited):
			http.Error(w, "too many recovery attempts — try again later", http.StatusTooManyRequests)
		case errors.Is(err, cloudstore.ErrRecoveryInvalid):
			http.Error(w, "invalid recovery code", http.StatusForbidden)
		default:
			http.Error(w, "server error", http.StatusInternalServerError)
		}
		return
	}

	env, err := a.store.GetEnvelope(r.Context(), account.ID, "recovery")
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

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
	if err := a.store.CreateClaimedTransferSlot(r.Context(), slotID, account.ID, tokenHash, now, now.Add(recoveryEnrollmentTTL)); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, recoverResponse{
		Envelope:        envelopeWire{V: env.V, Nonce: env.Nonce, CT: env.CT, MAC: env.MAC},
		EnrollmentToken: token,
	})
}
