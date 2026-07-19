package cloudstore

import (
	"context"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

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
func (r *Repo) AppendFeedback(ctx context.Context, accountID, clientID, kind, appVersion string, ciphertext []byte, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO feedback_queue (account_id, client_id, kind, app_version, ciphertext, created_at_unix)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id, client_id) DO NOTHING`,
		accountID, clientID, kind, appVersion, ciphertext, storedb.TimeToUnix(now))
	return err
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
