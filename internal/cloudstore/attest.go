package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Anonymous-trial scopes reported by ConsumeAttestRequest when a call is
// refused (bd med-o7zq.15); the global one is TrialScopeGlobal, shared with
// account trials.
const (
	AttestScopeInstall    = "install"     // lifetime quota per bucket
	AttestScopeInstallDay = "install-day" // daily quota per bucket
)

// Install kinds (bd med-nt9p.32.8.3): which proof enrolled the key and so
// which assertion format it signs.
const (
	AttestKindIOS     = "ios"     // App Attest + DeviceCheck
	AttestKindAndroid = "android" // Play Integrity + Android Keystore
)

// ErrAttestCounter means the assertion counter did not move past the stored
// one (a replay, or a concurrent request that won the compare-and-set).
var ErrAttestCounter = errors.New("cloudstore: attest counter not increasing")

// AttestInstall is one App Attest key (one app install) of the anonymous
// trial. Its budgets live on its bucket (bd med-o7zq.26): one device's trial,
// shared by every install that rejoined it with the bucket's trial pass.
type AttestInstall struct {
	KeyID      string
	PublicKey  []byte // PKIX DER of the key enrollment verified
	Kind       string // AttestKindIOS or AttestKindAndroid; "" on insert = ios
	Counter    uint32
	BucketID   string // on insert: "" founds a new bucket (id = KeyID)
	PassHash   []byte // on insert of a new bucket: SHA-256 of its pass secret
	Used       int    // the BUCKET's lifetime request count (read only)
	Env        string
	CreatedAt  time.Time
	LastSeenAt time.Time
}

// AttestSubject is the trial_usage subject of a bucket (a backfilled bucket's
// id is its install's key id), so the global daily SUM covers accounts and
// installs in one budget.
func AttestSubject(bucketID string) string { return "attest:" + bucketID }

// InsertAttestInstall stores a freshly attested key: with in.BucketID "" it
// founds a bucket (id = KeyID, pass hash in.PassHash) in the same
// transaction, else it joins in.BucketID (which must exist). A duplicate key
// id is an error (the caller re-reads the row).
func (r *Repo) InsertAttestInstall(ctx context.Context, in AttestInstall) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		bucket := in.BucketID
		if bucket == "" {
			bucket = in.KeyID
			if _, err := tx.ExecContext(ctx, `INSERT INTO attest_buckets (bucket_id, pass_hash, created_at) VALUES (?, ?, ?)`,
				bucket, in.PassHash, in.CreatedAt.Unix()); err != nil {
				return err
			}
		}
		kind := in.Kind
		if kind == "" {
			kind = AttestKindIOS
		}
		res, err := tx.ExecContext(ctx,
			`INSERT INTO attest_installs (key_id, public_key, counter, used, env, created_at, last_seen_at, bucket_id, kind)
			 SELECT ?, ?, 0, 0, ?, ?, ?, bucket_id, ? FROM attest_buckets WHERE bucket_id = ?`,
			in.KeyID, in.PublicKey, in.Env, in.CreatedAt.Unix(), in.CreatedAt.Unix(), kind, bucket)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return sql.ErrNoRows // no such bucket
		}
		return nil
	})
}

// DeleteAttestInstall removes an install (enrollment rollback when the
// DeviceCheck bit write fails) and the bucket it founded, unless another
// install joined it meanwhile.
func (r *Repo) DeleteAttestInstall(ctx context.Context, keyID string) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM attest_installs WHERE key_id = ?`, keyID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx,
			`DELETE FROM attest_buckets WHERE bucket_id = ? AND NOT EXISTS (SELECT 1 FROM attest_installs WHERE bucket_id = ?)`, keyID, keyID)
		return err
	})
}

// AttestInstall loads an install with its bucket's lifetime count;
// sql.ErrNoRows when unknown.
func (r *Repo) AttestInstall(ctx context.Context, keyID string) (*AttestInstall, error) {
	var in AttestInstall
	var created, seen int64
	err := r.db.QueryRowContext(ctx,
		`SELECT i.key_id, i.public_key, i.counter, i.bucket_id, b.used, i.env, i.created_at, i.last_seen_at, i.kind
		 FROM attest_installs i JOIN attest_buckets b ON b.bucket_id = i.bucket_id WHERE i.key_id = ?`, keyID).
		Scan(&in.KeyID, &in.PublicKey, &in.Counter, &in.BucketID, &in.Used, &in.Env, &created, &seen, &in.Kind)
	if err != nil {
		return nil, err
	}
	in.CreatedAt, in.LastSeenAt = time.Unix(created, 0).UTC(), time.Unix(seen, 0).UTC()
	return &in, nil
}

// AttestBucketPassHash is a bucket's stored pass hash (nil for a backfilled
// bucket); sql.ErrNoRows when unknown.
func (r *Repo) AttestBucketPassHash(ctx context.Context, bucketID string) ([]byte, error) {
	var h []byte
	err := r.db.QueryRowContext(ctx, `SELECT pass_hash FROM attest_buckets WHERE bucket_id = ?`, bucketID).Scan(&h)
	return h, err
}

// advanceAttestCounter is every attested request's first statement: the
// assertion counter compare-and-set (ErrAttestCounter when it does not
// increase). Being a write, it holds the database write lock (BEGIN
// IMMEDIATE) before the bucket is read, so two installs of one bucket never
// spend the same headroom. It returns the install's bucket id.
func advanceAttestCounter(ctx context.Context, tx storedb.TX, keyID string, newCounter uint32, now time.Time) (string, error) {
	res, err := tx.ExecContext(ctx,
		`UPDATE attest_installs SET counter = ?, last_seen_at = ? WHERE key_id = ? AND counter < ?`,
		newCounter, now.Unix(), keyID, newCounter)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", ErrAttestCounter
	}
	var bucket string
	err = tx.QueryRowContext(ctx, `SELECT bucket_id FROM attest_installs WHERE key_id = ?`, keyID).Scan(&bucket)
	return bucket, err
}

// bucketOf is an install's bucket id as a subquery (one key_id argument).
const bucketOf = `(SELECT bucket_id FROM attest_installs WHERE key_id = ?)`

// ConsumeAttestRequest, in ONE transaction: advances the assertion counter
// with a compare-and-set (ErrAttestCounter when it does not increase — the
// counter advance commits even when a quota then refuses, so the assertion
// stays spent), then checks the lifetime quota, the bucket's daily quota
// and the global daily budget (shared with accounts via trial_usage), and
// records the request. remaining is the lifetime requests left after this one.
// A daily/global limit <= 0 disables that scope; lifetime must be positive.
func (r *Repo) ConsumeAttestRequest(ctx context.Context, keyID string, newCounter uint32, now time.Time, lifetime, daily, global int) (allowed bool, scope string, remaining int, err error) {
	err = r.db.WithTx(ctx, func(tx storedb.TX) error {
		bucket, txErr := advanceAttestCounter(ctx, tx, keyID, newCounter, now)
		if txErr != nil {
			return txErr
		}
		var used int
		if txErr := tx.QueryRowContext(ctx, `SELECT used FROM attest_buckets WHERE bucket_id = ?`, bucket).Scan(&used); txErr != nil {
			return txErr
		}
		remaining = max(lifetime-used, 0)
		if used >= lifetime {
			scope = AttestScopeInstall
			return nil
		}
		if scope, txErr = consumeTrialDay(ctx, tx, AttestSubject(bucket), now, daily, global, AttestScopeInstallDay); txErr != nil || scope != "" {
			return txErr
		}
		if _, txErr := tx.ExecContext(ctx, `UPDATE attest_buckets SET used = used + 1 WHERE bucket_id = ?`, bucket); txErr != nil {
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
	_, err := r.db.ExecContext(ctx, `UPDATE attest_buckets SET used = used - 1 WHERE bucket_id = `+bucketOf+` AND used > 0`, keyID)
	return err
}

// AttestFoodSubject is the trial_usage subject of a bucket's food lookups
// (bd med-o7zq.19). The global trial SUM excludes this prefix, so food calls
// never spend the AI budget.
func AttestFoodSubject(bucketID string) string { return attestFoodSubjectPrefix + bucketID }

const attestFoodSubjectPrefix = "attest-food:"

// ConsumeAttestFoodRequest, in ONE transaction: the same assertion-counter
// compare-and-set as ConsumeAttestRequest (ErrAttestCounter; the advance
// commits even when the cap refuses), then the bucket's daily food cap
// (daily <= 0 disables it) and the count. No lifetime, no global, no refund.
func (r *Repo) ConsumeAttestFoodRequest(ctx context.Context, keyID string, newCounter uint32, now time.Time, daily int) (allowed bool, err error) {
	err = r.db.WithTx(ctx, func(tx storedb.TX) error {
		bucket, txErr := advanceAttestCounter(ctx, tx, keyID, newCounter, now)
		if txErr != nil {
			return txErr
		}
		scope, txErr := consumeTrialDay(ctx, tx, AttestFoodSubject(bucket), now, daily, 0, AttestScopeInstallDay)
		allowed = txErr == nil && scope == ""
		return txErr
	})
	return allowed && err == nil, err
}

// Anonymous-trial VOICE scopes (bd med-o7zq.22), reported by
// ReserveAttestVoice when the grant would fall under the floor. The global
// daily voice budget reports TrialScopeGlobal ("global").
const (
	AttestScopeVoice    = "voice"     // lifetime voice seconds per bucket
	AttestScopeVoiceDay = "voice-day" // daily voice seconds per bucket
)

// ReserveAttestVoice, in ONE transaction: the same assertion-counter
// compare-and-set as ConsumeAttestRequest (ErrAttestCounter; the advance
// commits even when the budget refuses), then grant = min(lifetime left,
// daily left, global left, callMax) seconds. grant >= floor is charged UP
// FRONT to the lifetime and bucket's daily counters (the global budget is
// the daily rows' SUM). The caller gives it back with RefundAttestVoice only
// when the call never got a signed URL out. grant < floor charges nothing,
// returns grant 0 and names the binding scope (lifetime first). daily/global <= 0 disable that scope.
// remainingLifetime / remainingDay are the seconds left after the reservation
// (remainingDay never exceeds remainingLifetime).
func (r *Repo) ReserveAttestVoice(ctx context.Context, keyID string, newCounter uint32, now time.Time, lifetime, daily, global, callMax, floor int) (grant int, scope string, remainingLifetime, remainingDay int, err error) {
	day := now.UTC().Format("2006-01-02")
	err = r.db.WithTx(ctx, func(tx storedb.TX) error {
		bucket, txErr := advanceAttestCounter(ctx, tx, keyID, newCounter, now)
		if txErr != nil {
			return txErr
		}
		var used, usedDay, usedGlobal int
		if txErr := tx.QueryRowContext(ctx, `SELECT voice_seconds FROM attest_buckets WHERE bucket_id = ?`, bucket).Scan(&used); txErr != nil {
			return txErr
		}
		if txErr := tx.QueryRowContext(ctx,
			`SELECT COALESCE(SUM(CASE WHEN key_id = ? THEN seconds END), 0), COALESCE(SUM(seconds), 0) FROM attest_voice_usage WHERE day = ?`,
			bucket, day).Scan(&usedDay, &usedGlobal); txErr != nil {
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
		if _, txErr := tx.ExecContext(ctx, `UPDATE attest_buckets SET voice_seconds = voice_seconds + ? WHERE bucket_id = ?`, grant, bucket); txErr != nil {
			return txErr
		}
		if _, txErr := tx.ExecContext(ctx,
			`INSERT INTO attest_voice_usage (day, key_id, seconds) VALUES (?, ?, ?)
			 ON CONFLICT(day, key_id) DO UPDATE SET seconds = seconds + excluded.seconds`, day, bucket, grant); txErr != nil {
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
		if _, err := tx.ExecContext(ctx, `UPDATE attest_buckets SET voice_seconds = MAX(voice_seconds - ?, 0) WHERE bucket_id = `+bucketOf, seconds, keyID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE attest_voice_usage SET seconds = MAX(seconds - ?, 0) WHERE day = ? AND key_id = `+bucketOf,
			seconds, reservedAt.UTC().Format("2006-01-02"), keyID)
		return err
	})
}

// AttestVoiceUsed is the lifetime voice seconds of the install's bucket
// (reservations minus refunds).
func (r *Repo) AttestVoiceUsed(ctx context.Context, keyID string) (int, error) {
	var n int
	err := r.db.QueryRowContext(ctx, `SELECT voice_seconds FROM attest_buckets WHERE bucket_id = `+bucketOf, keyID).Scan(&n)
	return n, err
}

// AttestVoiceUsage is the install's bucket voice seconds used: lifetime, and
// on now's UTC day (the two counters ReserveAttestVoice charges).
func (r *Repo) AttestVoiceUsage(ctx context.Context, keyID string, now time.Time) (lifetime, day int, err error) {
	err = r.db.QueryRowContext(ctx,
		`SELECT b.voice_seconds, COALESCE((SELECT u.seconds FROM attest_voice_usage u WHERE u.day = ? AND u.key_id = b.bucket_id), 0)
		 FROM attest_buckets b WHERE b.bucket_id = `+bucketOf, now.UTC().Format("2006-01-02"), keyID).Scan(&lifetime, &day)
	return lifetime, day, err
}
