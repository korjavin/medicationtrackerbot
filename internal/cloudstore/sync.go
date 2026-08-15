package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// ErrQuotaExceeded is returned by AppendOps when appending the batch would
// push the account's total oplog+snapshot storage past its quota.
var ErrQuotaExceeded = errors.New("cloudstore: account storage quota exceeded")

// ErrSnapshotSeqAhead is returned by PutSnapshot when snapshot_seq is greater
// than the account's last assigned oplog seq — the client would be
// compacting ops the server never assigned, which can only mean a stale or
// corrupt client view.
var ErrSnapshotSeqAhead = errors.New("cloudstore: snapshot_seq is ahead of last_seq")

// Snapshot is an account's latest compacted state: all oplog rows with
// seq <= SnapshotSeq have been folded into it and deleted.
type Snapshot struct {
	AccountID   string
	SnapshotSeq int64
	Nonce       []byte
	CT          []byte
	CreatedAt   time.Time
}

// Op is one row of an account's encrypted oplog. seq is assigned by the
// server (contiguous, per account) — record_type_tag/nonce/ct are opaque
// ciphertext the server never inspects.
type Op struct {
	AccountID          string
	Seq                int64
	DeviceCredentialID []byte
	RecordTypeTag      string
	Nonce              []byte
	CT                 []byte
	CreatedAt          time.Time
}

// OpInput is one op in a POST /api/sync/ops batch, before seq assignment.
type OpInput struct {
	DeviceCredentialID []byte
	RecordTypeTag      string
	Nonce              []byte
	CT                 []byte
}

// AppendOps assigns contiguous seq values to ops — continuing from the
// account's last_seq — and inserts them in a single transaction, so two
// concurrent batches (e.g. from two devices) can never be assigned
// overlapping seqs: SQLite's single-writer transaction serializes the
// read-then-bump of sync_state.last_seq. quotaBytes <= 0 disables the quota
// check; otherwise the batch is rejected with ErrQuotaExceeded (no partial
// write) if it would push the account's total oplog+snapshot ciphertext past
// quotaBytes.
func (r *Repo) AppendOps(ctx context.Context, accountID string, ops []OpInput, quotaBytes int64, now time.Time) ([]int64, error) {
	seqs := make([]int64, len(ops))
	err := r.db.WithTx(ctx, func(tx storedb.TX) error {
		var lastSeq int64
		err := tx.QueryRowContext(ctx, `SELECT last_seq FROM sync_state WHERE account_id = ?`, accountID).Scan(&lastSeq)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		if quotaBytes > 0 {
			var used int64
			if err := tx.QueryRowContext(ctx,
				`SELECT COALESCE((SELECT SUM(LENGTH(nonce)+LENGTH(ct)) FROM oplog WHERE account_id = ?), 0)
				      + COALESCE((SELECT SUM(LENGTH(nonce)+LENGTH(ct)) FROM snapshots WHERE account_id = ?), 0)`,
				accountID, accountID).Scan(&used); err != nil {
				return err
			}
			var incoming int64
			for _, op := range ops {
				incoming += int64(len(op.Nonce) + len(op.CT))
			}
			if used+incoming > quotaBytes {
				return ErrQuotaExceeded
			}
		}

		for i, op := range ops {
			lastSeq++
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO oplog (account_id, seq, device_credential_id, record_type_tag, nonce, ct, created_at_unix) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				accountID, lastSeq, op.DeviceCredentialID, op.RecordTypeTag, op.Nonce, op.CT, storedb.TimeToUnix(now)); err != nil {
				return err
			}
			seqs[i] = lastSeq
		}

		_, err = tx.ExecContext(ctx,
			`INSERT INTO sync_state (account_id, last_seq, last_sync_unix) VALUES (?, ?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET last_seq = excluded.last_seq, last_sync_unix = excluded.last_sync_unix`,
			accountID, lastSeq, storedb.TimeToUnix(now))
		return err
	})
	if err != nil {
		return nil, err
	}
	return seqs, nil
}

// ListOps returns oplog rows for accountID with seq > since, ordered by seq
// and capped at limit, and touches sync_state.last_sync_unix — every sync API
// call (read or write) refreshes it, so Task 7's stale-sync warning sees an
// accurate last-successful-sync timestamp even for read-only clients.
func (r *Repo) ListOps(ctx context.Context, accountID string, since int64, limit int, now time.Time) ([]Op, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT account_id, seq, device_credential_id, record_type_tag, nonce, ct, created_at_unix
		 FROM oplog WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
		accountID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ops []Op
	for rows.Next() {
		var (
			o           Op
			createdUnix int64
		)
		if err := rows.Scan(&o.AccountID, &o.Seq, &o.DeviceCredentialID, &o.RecordTypeTag, &o.Nonce, &o.CT, &createdUnix); err != nil {
			return nil, err
		}
		o.CreatedAt = storedb.UnixToTime(createdUnix)
		ops = append(ops, o)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO sync_state (account_id, last_seq, last_sync_unix) VALUES (?, 0, ?)
		 ON CONFLICT(account_id) DO UPDATE SET last_sync_unix = excluded.last_sync_unix`,
		accountID, storedb.TimeToUnix(now)); err != nil {
		return nil, err
	}
	return ops, nil
}

// CompactionFloor returns the account's current snapshot seq — every oplog row
// with seq <= it has been compacted away — or 0 when no snapshot exists. A
// client whose sync cursor sits below the floor was compacted past (another
// device snapshotted while it was away) and must re-bootstrap from the snapshot
// instead of an incremental tail that would silently skip the folded ops.
func (r *Repo) CompactionFloor(ctx context.Context, accountID string) (int64, error) {
	var floor int64
	err := r.db.QueryRowContext(ctx,
		`SELECT COALESCE((SELECT snapshot_seq FROM snapshots WHERE account_id = ?), 0)`, accountID).Scan(&floor)
	return floor, err
}

// PutSnapshot upserts the account's compaction snapshot and deletes every
// oplog row it now supersedes (seq <= snapshotSeq), in one transaction so a
// concurrent ListOps/AppendOps never observes the snapshot without the
// matching compaction or vice versa. Rejects snapshotSeq > last_seq with
// ErrSnapshotSeqAhead — the client can only compact ops the server actually
// assigned.
func (r *Repo) PutSnapshot(ctx context.Context, accountID string, snapshotSeq int64, nonce, ct []byte, now time.Time) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		var lastSeq int64
		err := tx.QueryRowContext(ctx, `SELECT last_seq FROM sync_state WHERE account_id = ?`, accountID).Scan(&lastSeq)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if snapshotSeq > lastSeq {
			return ErrSnapshotSeqAhead
		}

		// The compaction floor must be monotonic. Two devices that both cross
		// the snapshot threshold near-simultaneously can upload snapshots at
		// different seqs; if a lower one overwrites a higher one, the DELETE
		// below has already dropped the oplog rows the lower snapshot doesn't
		// cover, permanently losing those records. Ignore a snapshot at or
		// below the current floor — it's already superseded.
		var existing sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT snapshot_seq FROM snapshots WHERE account_id = ?`, accountID).Scan(&existing); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if existing.Valid && snapshotSeq <= existing.Int64 {
			return nil
		}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO snapshots (account_id, snapshot_seq, nonce, ct, created_at_unix) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET snapshot_seq = excluded.snapshot_seq, nonce = excluded.nonce, ct = excluded.ct, created_at_unix = excluded.created_at_unix`,
			accountID, snapshotSeq, nonce, ct, storedb.TimeToUnix(now)); err != nil {
			return err
		}

		if _, err := tx.ExecContext(ctx, `DELETE FROM oplog WHERE account_id = ? AND seq <= ?`, accountID, snapshotSeq); err != nil {
			return err
		}

		_, err = tx.ExecContext(ctx,
			`INSERT INTO sync_state (account_id, last_seq, last_sync_unix) VALUES (?, ?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET last_sync_unix = excluded.last_sync_unix`,
			accountID, lastSeq, storedb.TimeToUnix(now))
		return err
	})
}

// AccountsNeedingStaleSyncWarning returns account IDs whose scheduled-push
// queue has run dry, or is about to: the latest UNSENT entry fires within
// dryQueueWithin of now, and an account with no unsent entries at all collapses
// to 0, which always qualifies (Task 7's dry-queue safety net —
// docs/cloud-mode.md "Dry-queue safety net").
//
// That fully-empty case is the one that matters most — reminders have already
// stopped — and it is exactly the one the original query could never report (bd
// med-2lx). It INNER JOINed a subquery over unsent rows, so an account with zero
// unsent rows produced no subquery row and was dropped from the join: the
// warning only fired in the narrow band where the queue was nearly-but-not-yet
// dry, and went silent the moment it actually ran out. Hence LEFT JOIN +
// COALESCE(..., 0).
//
// Deliberately NOT gated on sync recency any more. Every inbox drain flushes ops
// through the sync API, which touches last_sync_unix (see AppendOps/ListOps/
// PutSnapshot/GetSnapshot), so an account alive enough to tap Telegram Confirm
// buttons always looked "freshly synced" while its reminder horizon rotted. The
// signal is horizon exhaustion, not user absence.
//
// The two EXISTS clauses are the anti-spam guard that dropping the sync gate
// makes necessary: every account that never set up reminders has an empty queue
// too. To be warned, an account must
//
//  1. have at least one ENABLED push subscription — the warning is itself a web
//     push, so this is also a precondition for it being deliverable at all; and
//  2. have had at least one scheduled push at some point. MarkPushSent blanks a
//     row's payload but never deletes it, so a queue that fired for months and
//     then went dry still satisfies this, while an account that never armed
//     reminders never does.
//
// last_warned_unix keeps it to one warning per warnCooldown. The sweep is keyed
// off sync_state because that is where last_warned_unix lives (MarkStaleSyncWarned
// UPDATEs it) — an account with no sync_state row could never be marked and would
// be re-warned every hour. Any browser that could have computed a horizon has
// necessarily read the vault through the sync API, so the row always exists.
func (r *Repo) AccountsNeedingStaleSyncWarning(ctx context.Context, now time.Time, dryQueueWithin, warnCooldown time.Duration) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT ss.account_id
		 FROM sync_state ss
		 LEFT JOIN (SELECT account_id, MAX(fire_at_unix) AS latest_fire FROM scheduled_pushes WHERE sent_at_unix IS NULL GROUP BY account_id) sp
		   ON sp.account_id = ss.account_id
		 WHERE COALESCE(sp.latest_fire, 0) <= ?
		   AND (ss.last_warned_unix IS NULL OR ss.last_warned_unix <= ?)
		   AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.account_id = ss.account_id AND ps.disabled = 0)
		   AND EXISTS (SELECT 1 FROM scheduled_pushes ap WHERE ap.account_id = ss.account_id)`,
		storedb.TimeToUnix(now.Add(dryQueueWithin)),
		storedb.TimeToUnix(now.Add(-warnCooldown)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accountIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		accountIDs = append(accountIDs, id)
	}
	return accountIDs, rows.Err()
}

// MarkStaleSyncWarned records that accountID was just sent the dry-queue
// warning push, so AccountsNeedingStaleSyncWarning skips it until warnCooldown
// elapses.
func (r *Repo) MarkStaleSyncWarned(ctx context.Context, accountID string, now time.Time) error {
	_, err := r.db.ExecContext(ctx, `UPDATE sync_state SET last_warned_unix = ? WHERE account_id = ?`, storedb.TimeToUnix(now), accountID)
	return err
}

// GetSnapshot returns the account's latest snapshot, or (nil, nil) when none
// has been uploaded yet, and touches sync_state.last_sync_unix like the other
// sync endpoints.
func (r *Repo) GetSnapshot(ctx context.Context, accountID string, now time.Time) (*Snapshot, error) {
	var (
		s           Snapshot
		createdUnix int64
	)
	s.AccountID = accountID
	err := r.db.QueryRowContext(ctx,
		`SELECT snapshot_seq, nonce, ct, created_at_unix FROM snapshots WHERE account_id = ?`, accountID).
		Scan(&s.SnapshotSeq, &s.Nonce, &s.CT, &createdUnix)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s.CreatedAt = storedb.UnixToTime(createdUnix)

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO sync_state (account_id, last_seq, last_sync_unix) VALUES (?, 0, ?)
		 ON CONFLICT(account_id) DO UPDATE SET last_sync_unix = excluded.last_sync_unix`,
		accountID, storedb.TimeToUnix(now)); err != nil {
		return nil, err
	}
	return &s, nil
}
