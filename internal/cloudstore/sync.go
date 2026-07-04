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
