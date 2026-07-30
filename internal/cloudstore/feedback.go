package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// ErrFeedbackQueueFull is returned by AppendFeedback when the account already has
// feedbackPerAccountCap undrained items. The sync storage quota (AppendOps) does
// not cover feedback_queue, so this is the only bound stopping an authenticated
// account from growing the blind queue without limit; a re-POST of an already
// queued client_id still succeeds (idempotent), only genuinely new rows are
// rejected past the cap.
var ErrFeedbackQueueFull = errors.New("cloudstore: feedback queue full for account")

// feedbackPerAccountCap bounds undrained feedback rows per account. Generous for
// real use — a user files a handful of reports and the operator drains via the
// med-dni.4 CLI. ponytail: fixed row cap, not a byte quota (the 5MB handler body
// cap already bounds each row); switch to SUM(length(ciphertext)) if per-row size
// abuse ever shows up.
const feedbackPerAccountCap = 100

// FeedbackItem is one queued feedback submission (bd med-dni.1). Ciphertext is an
// opaque client-age-encrypted blob this process stores and cannot read — the age
// private key lives with the developer (med-dni.4). Kind and AppVersion are
// non-PII metadata; CreatedAt is the server's receive timestamp used for the
// drain order.
type FeedbackItem struct {
	ID         int64
	AccountID  string
	ClientID   string
	Kind       string
	AppVersion string
	Ciphertext []byte
	CreatedAt  time.Time
}

// AppendFeedback queues one blind feedback blob. Idempotent per (account_id,
// client_id) via ON CONFLICT DO NOTHING, so the reliable-retry client
// (med-dni.3) can re-POST the same item over a flaky connection without
// duplicating rows — and one account's client_id never collides with another's.
//
// queued reports whether this call actually inserted, so a caller can tell a new
// submission from a retry that changed nothing (the admin relay pings only on the
// former — bd med-orj). It is false whenever err is non-nil.
func (r *Repo) AppendFeedback(ctx context.Context, accountID, clientID, kind, appVersion string, ciphertext []byte, now time.Time) (queued bool, err error) {
	// A retry of an already-queued client_id must always succeed (idempotent),
	// even once the account is at the cap — so check for the existing row first.
	var one int
	switch err := r.db.QueryRowContext(ctx,
		`SELECT 1 FROM feedback_queue WHERE account_id = ? AND client_id = ?`,
		accountID, clientID).Scan(&one); {
	case err == nil:
		return false, nil // already queued; the client's retry is a no-op
	case !errors.Is(err, sql.ErrNoRows):
		return false, err
	}
	// Genuinely new submission: bound the per-account backlog before inserting.
	// ponytail: the count+insert isn't atomic, so two concurrent new client_ids
	// can each pass the check and push one over the cap — fine for a safety limit.
	var count int
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM feedback_queue WHERE account_id = ?`, accountID).Scan(&count); err != nil {
		return false, err
	}
	if count >= feedbackPerAccountCap {
		return false, ErrFeedbackQueueFull
	}
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO feedback_queue (account_id, client_id, kind, app_version, ciphertext, created_at_unix)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id, client_id) DO NOTHING`,
		accountID, clientID, kind, appVersion, ciphertext, storedb.TimeToUnix(now))
	if err != nil {
		return false, err
	}
	// DO NOTHING affects 0 rows when a concurrent request won the race above.
	n, err := res.RowsAffected()
	return n > 0, err
}

// ListFeedback returns queued items oldest-first, bounded by limit — the drain
// order for the med-dni.4 developer CLI.
func (r *Repo) ListFeedback(ctx context.Context, limit int) ([]FeedbackItem, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, account_id, client_id, kind, app_version, ciphertext, created_at_unix
		 FROM feedback_queue ORDER BY created_at_unix ASC, id ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []FeedbackItem
	for rows.Next() {
		var (
			it        FeedbackItem
			createdAt int64
		)
		if err := rows.Scan(&it.ID, &it.AccountID, &it.ClientID, &it.Kind, &it.AppVersion, &it.Ciphertext, &createdAt); err != nil {
			return nil, err
		}
		it.CreatedAt = storedb.UnixToTime(createdAt)
		items = append(items, it)
	}
	return items, rows.Err()
}

// DeleteFeedback acks one drained item by id. A no-op when the row is already
// gone.
func (r *Repo) DeleteFeedback(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM feedback_queue WHERE id = ?`, id)
	return err
}
