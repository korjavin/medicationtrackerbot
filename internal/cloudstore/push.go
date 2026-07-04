package cloudstore

import (
	"context"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// PushSubscription is one row in the push_subscriptions table — a web-push
// endpoint the blind relay (Task 5) fans out to for an account. Disabled
// rows are kept (not deleted) so a re-subscribe on the same endpoint upserts
// cleanly, mirroring internal/store/push's enabled-flag convention.
type PushSubscription struct {
	AccountID string
	Endpoint  string
	P256dh    string
	Auth      string
	CreatedAt time.Time
	Disabled  bool
}

// UpsertPushSubscription inserts a subscription, or refreshes its keys and
// re-enables it if the endpoint was previously disabled (HTTP 410).
func (r *Repo) UpsertPushSubscription(ctx context.Context, accountID, endpoint, p256dh, auth string, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth, created_at_unix, disabled) VALUES (?, ?, ?, ?, ?, 0)
		 ON CONFLICT(endpoint) DO UPDATE SET account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth, disabled = 0`,
		accountID, endpoint, p256dh, auth, storedb.TimeToUnix(now))
	return err
}

// DeletePushSubscription hard-removes a subscription, scoped to accountID so
// a session can only delete its own account's endpoints.
func (r *Repo) DeletePushSubscription(ctx context.Context, accountID, endpoint string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?`, accountID, endpoint)
	return err
}

// List returns accountID's enabled push subscriptions — the account-keyed
// shape the relay sender (Task 5) fans out to, mirroring
// internal/webpush.SubscriptionStore's List/Disable pair without literally
// implementing it (that interface is keyed by the bot's int64 user id).
func (r *Repo) List(ctx context.Context, accountID string) ([]PushSubscription, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT account_id, endpoint, p256dh, auth, created_at_unix, disabled FROM push_subscriptions WHERE account_id = ? AND disabled = 0`,
		accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []PushSubscription
	for rows.Next() {
		var (
			s           PushSubscription
			createdUnix int64
			disabled    int
		)
		if err := rows.Scan(&s.AccountID, &s.Endpoint, &s.P256dh, &s.Auth, &createdUnix, &disabled); err != nil {
			return nil, err
		}
		s.CreatedAt = storedb.UnixToTime(createdUnix)
		s.Disabled = disabled != 0
		subs = append(subs, s)
	}
	return subs, rows.Err()
}

// Disable marks a subscription inactive (called by the relay sender on HTTP
// 410) without deleting it, so a later re-subscribe on the same endpoint
// upserts cleanly via UpsertPushSubscription.
func (r *Repo) Disable(ctx context.Context, endpoint string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE push_subscriptions SET disabled = 1 WHERE endpoint = ?`, endpoint)
	return err
}
