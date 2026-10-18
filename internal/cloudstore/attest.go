package cloudstore

import (
	"context"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Anonymous-trial scopes reported by ConsumeAttestRequest when a call is
// refused (bd med-o7zq.15); the global one is TrialScopeGlobal, shared with
// account trials.
const (
	AttestScopeInstall    = "install"     // lifetime per-install quota
	AttestScopeInstallDay = "install-day" // per-install daily quota
)

// ErrAttestCounter means the assertion counter did not move past the stored
// one (a replay, or a concurrent request that won the compare-and-set).
var ErrAttestCounter = errors.New("cloudstore: attest counter not increasing")

// AttestInstall is one App Attest key (one app install) of the anonymous trial.
type AttestInstall struct {
	KeyID      string
	PublicKey  []byte // PKIX DER of the key appattest.VerifyAttestation returned
	Counter    uint32
	Used       int
	Env        string
	CreatedAt  time.Time
	LastSeenAt time.Time
}

// AttestSubject is the trial_usage subject of an install, so the global daily
// SUM covers accounts and installs in one budget.
func AttestSubject(keyID string) string { return "attest:" + keyID }

// InsertAttestInstall stores a freshly attested key. A duplicate key id is an
// error (the caller re-reads the row).
func (r *Repo) InsertAttestInstall(ctx context.Context, in AttestInstall) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO attest_installs (key_id, public_key, counter, used, env, created_at, last_seen_at) VALUES (?, ?, 0, 0, ?, ?, ?)`,
		in.KeyID, in.PublicKey, in.Env, in.CreatedAt.Unix(), in.CreatedAt.Unix())
	return err
}

// DeleteAttestInstall removes an install (enrollment rollback when the
// DeviceCheck bit write fails).
func (r *Repo) DeleteAttestInstall(ctx context.Context, keyID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM attest_installs WHERE key_id = ?`, keyID)
	return err
}

// AttestInstall loads an install; sql.ErrNoRows when unknown.
func (r *Repo) AttestInstall(ctx context.Context, keyID string) (*AttestInstall, error) {
	var in AttestInstall
	var created, seen int64
	err := r.db.QueryRowContext(ctx,
		`SELECT key_id, public_key, counter, used, env, created_at, last_seen_at FROM attest_installs WHERE key_id = ?`, keyID).
		Scan(&in.KeyID, &in.PublicKey, &in.Counter, &in.Used, &in.Env, &created, &seen)
	if err != nil {
		return nil, err
	}
	in.CreatedAt, in.LastSeenAt = time.Unix(created, 0).UTC(), time.Unix(seen, 0).UTC()
	return &in, nil
}

// ConsumeAttestRequest, in ONE transaction: advances the assertion counter
// with a compare-and-set (ErrAttestCounter when it does not increase — the
// counter advance commits even when a quota then refuses, so the assertion
// stays spent), then checks the lifetime quota, the per-install daily quota
// and the global daily budget (shared with accounts via trial_usage), and
// records the request. remaining is the lifetime requests left after this one.
// A daily/global limit <= 0 disables that scope; lifetime must be positive.
func (r *Repo) ConsumeAttestRequest(ctx context.Context, keyID string, newCounter uint32, now time.Time, lifetime, daily, global int) (allowed bool, scope string, remaining int, err error) {
	err = r.db.WithTx(ctx, func(tx storedb.TX) error {
		res, txErr := tx.ExecContext(ctx,
			`UPDATE attest_installs SET counter = ?, last_seen_at = ? WHERE key_id = ? AND counter < ?`,
			newCounter, now.Unix(), keyID, newCounter)
		if txErr != nil {
			return txErr
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return ErrAttestCounter
		}
		var used int
		if txErr := tx.QueryRowContext(ctx, `SELECT used FROM attest_installs WHERE key_id = ?`, keyID).Scan(&used); txErr != nil {
			return txErr
		}
		remaining = max(lifetime-used, 0)
		if used >= lifetime {
			scope = AttestScopeInstall
			return nil
		}
		if scope, txErr = consumeTrialDay(ctx, tx, AttestSubject(keyID), now, daily, global, AttestScopeInstallDay); txErr != nil || scope != "" {
			return txErr
		}
		if _, txErr := tx.ExecContext(ctx, `UPDATE attest_installs SET used = used + 1 WHERE key_id = ?`, keyID); txErr != nil {
			return txErr
		}
		remaining--
		allowed = true
		return nil
	})
	if err != nil {
		return false, "", 0, err
	}
	return allowed, scope, remaining, nil
}

// RefundAttestRequest gives back one lifetime request after an upstream
// failure. The daily counters are not refunded (same as account trials).
func (r *Repo) RefundAttestRequest(ctx context.Context, keyID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE attest_installs SET used = used - 1 WHERE key_id = ? AND used > 0`, keyID)
	return err
}
