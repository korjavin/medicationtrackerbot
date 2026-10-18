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

// AttestFoodSubject is the trial_usage subject of an install's food lookups
// (bd med-o7zq.19). The global trial SUM excludes this prefix, so food calls
// never spend the AI budget.
func AttestFoodSubject(keyID string) string { return attestFoodSubjectPrefix + keyID }

const attestFoodSubjectPrefix = "attest-food:"

// ConsumeAttestFoodRequest, in ONE transaction: the same assertion-counter
// compare-and-set as ConsumeAttestRequest (ErrAttestCounter; the advance
// commits even when the cap refuses), then the per-install daily food cap
// (daily <= 0 disables it) and the count. No lifetime, no global, no refund.
func (r *Repo) ConsumeAttestFoodRequest(ctx context.Context, keyID string, newCounter uint32, now time.Time, daily int) (allowed bool, err error) {
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
		scope, txErr := consumeTrialDay(ctx, tx, AttestFoodSubject(keyID), now, daily, 0, AttestScopeInstallDay)
		allowed = txErr == nil && scope == ""
		return txErr
	})
	return allowed && err == nil, err
}

// Anonymous-trial VOICE scopes (bd med-o7zq.22), reported by
// ReserveAttestVoice when the grant would fall under the floor. The global
// daily voice budget reports TrialScopeGlobal ("global").
const (
	AttestScopeVoice    = "voice"     // lifetime voice seconds per install
	AttestScopeVoiceDay = "voice-day" // per-install daily voice seconds
)

// ReserveAttestVoice, in ONE transaction: the same assertion-counter
// compare-and-set as ConsumeAttestRequest (ErrAttestCounter; the advance
// commits even when the budget refuses), then grant = min(lifetime left,
// daily left, global left, callMax) seconds. grant >= floor is charged UP
// FRONT to the lifetime and per-install daily counters (the global budget is
// the daily rows' SUM). The caller gives it back with RefundAttestVoice only
// when the call never got a signed URL out. grant < floor charges nothing,
// returns grant 0 and names the binding scope (lifetime first). daily/global <= 0 disable that scope.
// remainingLifetime / remainingDay are the seconds left after the reservation
// (remainingDay never exceeds remainingLifetime).
func (r *Repo) ReserveAttestVoice(ctx context.Context, keyID string, newCounter uint32, now time.Time, lifetime, daily, global, callMax, floor int) (grant int, scope string, remainingLifetime, remainingDay int, err error) {
	day := now.UTC().Format("2006-01-02")
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
		var used, usedDay, usedGlobal int
		if txErr := tx.QueryRowContext(ctx, `SELECT voice_seconds FROM attest_installs WHERE key_id = ?`, keyID).Scan(&used); txErr != nil {
			return txErr
		}
		if txErr := tx.QueryRowContext(ctx,
			`SELECT COALESCE(SUM(CASE WHEN key_id = ? THEN seconds END), 0), COALESCE(SUM(seconds), 0) FROM attest_voice_usage WHERE day = ?`,
			keyID, day).Scan(&usedDay, &usedGlobal); txErr != nil {
			return txErr
		}
		lifeLeft := max(lifetime-used, 0)
		dayLeft := lifeLeft
		if daily > 0 {
			dayLeft = min(max(daily-usedDay, 0), lifeLeft)
		}
		globalLeft := callMax
		if global > 0 {
			globalLeft = max(global-usedGlobal, 0)
		}
		grant = min(dayLeft, globalLeft, callMax)
		remainingLifetime, remainingDay = lifeLeft, dayLeft
		if grant < floor {
			switch {
			case lifeLeft < floor:
				scope = AttestScopeVoice
			case dayLeft < floor:
				scope = AttestScopeVoiceDay
			default:
				scope = TrialScopeGlobal
			}
			grant = 0
			return nil
		}
		if _, txErr := tx.ExecContext(ctx, `UPDATE attest_installs SET voice_seconds = voice_seconds + ? WHERE key_id = ?`, grant, keyID); txErr != nil {
			return txErr
		}
		if _, txErr := tx.ExecContext(ctx,
			`INSERT INTO attest_voice_usage (day, key_id, seconds) VALUES (?, ?, ?)
			 ON CONFLICT(day, key_id) DO UPDATE SET seconds = seconds + excluded.seconds`, day, keyID, grant); txErr != nil {
			return txErr
		}
		remainingLifetime -= grant
		remainingDay -= grant
		return nil
	})
	if err != nil {
		return 0, "", 0, 0, err
	}
	return grant, scope, remainingLifetime, remainingDay, nil
}

// RefundAttestVoice gives back seconds of a reservation made at reservedAt
// (its UTC day, so a call across midnight refunds the day it was charged to)
// to the lifetime and daily counters — the global budget is their SUM.
// Never below zero.
func (r *Repo) RefundAttestVoice(ctx context.Context, keyID string, reservedAt time.Time, seconds int) error {
	if seconds <= 0 {
		return nil
	}
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		if _, err := tx.ExecContext(ctx, `UPDATE attest_installs SET voice_seconds = MAX(voice_seconds - ?, 0) WHERE key_id = ?`, seconds, keyID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE attest_voice_usage SET seconds = MAX(seconds - ?, 0) WHERE day = ? AND key_id = ?`,
			seconds, reservedAt.UTC().Format("2006-01-02"), keyID)
		return err
	})
}

// AttestVoiceUsed is the install's lifetime voice seconds (reservations minus refunds).
func (r *Repo) AttestVoiceUsed(ctx context.Context, keyID string) (int, error) {
	var n int
	err := r.db.QueryRowContext(ctx, `SELECT voice_seconds FROM attest_installs WHERE key_id = ?`, keyID).Scan(&n)
	return n, err
}
