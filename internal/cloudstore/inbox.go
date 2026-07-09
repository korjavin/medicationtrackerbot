package cloudstore

import (
	"context"
	"database/sql"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// InboxEvent is one sealed inbound event awaiting a client drain. CT is an
// mt/v1/inbox sealed box (internal/cloudserver/sealedbox.go) that this process
// wrote and cannot read back — the account's inbox private key lives in the
// vault. CreatedAt is the server's own timestamp, duplicated in the clear here
// so a drain can order events without decrypting them.
type InboxEvent struct {
	ID        int64
	CreatedAt time.Time
	CT        []byte
}

// SetAccountInboxPublicKey publishes the account's X25519 inbox public key.
// Idempotent and last-write-wins: re-running key generation on a fresh device
// would strand events sealed to the previous key, so clients must only publish
// a key they persisted to the vault first.
func (r *Repo) SetAccountInboxPublicKey(ctx context.Context, accountID string, pub []byte) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE accounts SET inbox_public_key = ? WHERE id = ?`, pub, accountID)
	return err
}

// AccountInboxPublicKey returns the published key, or nil when the account has
// never unlocked a client. A nil key means inbound events cannot be sealed.
func (r *Repo) AccountInboxPublicKey(ctx context.Context, accountID string) ([]byte, error) {
	var pub []byte
	err := r.db.QueryRowContext(ctx,
		`SELECT inbox_public_key FROM accounts WHERE id = ?`, accountID).Scan(&pub)
	if err == sql.ErrNoRows {
		return nil, err
	}
	return pub, err
}

// AppendInboxEvent queues one sealed event for the account.
func (r *Repo) AppendInboxEvent(ctx context.Context, accountID string, ct []byte, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO inbox_events (account_id, created_at_unix, ct) VALUES (?, ?, ?)`,
		accountID, storedb.TimeToUnix(now), ct)
	return err
}

// ListInboxEvents returns the account's pending events oldest-first, bounded by
// limit. Ordering by id (monotonic) rather than created_at_unix keeps two events
// stamped in the same second in their arrival order.
func (r *Repo) ListInboxEvents(ctx context.Context, accountID string, limit int) ([]InboxEvent, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, created_at_unix, ct FROM inbox_events WHERE account_id = ? ORDER BY id LIMIT ?`,
		accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []InboxEvent
	for rows.Next() {
		var (
			e         InboxEvent
			createdAt int64
		)
		if err := rows.Scan(&e.ID, &createdAt, &e.CT); err != nil {
			return nil, err
		}
		e.CreatedAt = storedb.UnixToTime(createdAt)
		events = append(events, e)
	}
	return events, rows.Err()
}

// DeleteInboxEvent acks one event. Scoped to the account so one account can
// never ack another's event, and a no-op when the row is already gone —
// concurrent drainers on several devices are expected, and the first ack wins.
func (r *Repo) DeleteInboxEvent(ctx context.Context, accountID string, id int64) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM inbox_events WHERE account_id = ? AND id = ?`, accountID, id)
	return err
}
