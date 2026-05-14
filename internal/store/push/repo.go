// Package push owns the push_subscriptions table: the per-user Web Push
// endpoints (with VAPID auth/p256dh keys) that the notifier and bot use to
// deliver background notifications to clients.
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.Push; new code should depend on *push.Repo (or a narrow
// interface satisfied by it) directly.
package push

import (
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// PushSubscription is one row in the push_subscriptions table. A row in the
// "disabled" state (Enabled=false) represents an endpoint the server has
// observed as gone (HTTP 410) and stopped sending to; rows are kept rather
// than deleted so re-subscription on the same endpoint via the upsert path
// re-enables them in place.
type PushSubscription struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"user_id"`
	Endpoint  string    `json:"endpoint"`
	Auth      string    `json:"auth"`
	P256dh    string    `json:"p256dh"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Repo is the push_subscriptions repository. Construct with New; share one
// *Repo per process — the underlying *db.DB owns its own connection pool.
type Repo struct {
	db *storedb.DB
}

// New returns a Repo bound to the shared *db.DB. The composition root passes
// in the same *db.DB it gives every other repo so all reads/writes go through
// one connection pool.
func New(d *storedb.DB) *Repo {
	return &Repo{db: d}
}

// Create inserts (or upserts) a push subscription for a user. If the endpoint
// already exists, its keys, owning user, and enabled flag are refreshed —
// re-subscription re-activates a previously disabled (HTTP 410) endpoint.
func (r *Repo) Create(userID int64, endpoint, auth, p256dh string) error {
	query := `
		INSERT INTO push_subscriptions (user_id, endpoint, auth, p256dh, enabled, updated_at)
		VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
		ON CONFLICT(endpoint) DO UPDATE SET
			user_id = excluded.user_id,
			auth = excluded.auth,
			p256dh = excluded.p256dh,
			enabled = 1,
			updated_at = CURRENT_TIMESTAMP
	`
	_, err := r.db.Exec(query, userID, endpoint, auth, p256dh)
	return err
}

// List returns the user's enabled subscriptions. Disabled rows (endpoints
// that previously returned HTTP 410 and were marked via Disable) are filtered
// out so the caller can iterate without a per-row check.
func (r *Repo) List(userID int64) ([]PushSubscription, error) {
	query := `SELECT id, user_id, endpoint, auth, p256dh, enabled, created_at, updated_at
	          FROM push_subscriptions
	          WHERE user_id = ? AND enabled = 1`

	rows, err := r.db.Query(query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []PushSubscription
	for rows.Next() {
		var sub PushSubscription
		if err := rows.Scan(&sub.ID, &sub.UserID, &sub.Endpoint, &sub.Auth, &sub.P256dh, &sub.Enabled, &sub.CreatedAt, &sub.UpdatedAt); err != nil {
			return nil, err
		}
		subs = append(subs, sub)
	}
	return subs, nil
}

// Delete hard-removes the subscription row for the endpoint. Used when the
// user explicitly unsubscribes from the client; for server-observed staleness
// (HTTP 410), prefer Disable so re-subscription on the same endpoint upserts
// cleanly.
func (r *Repo) Delete(endpoint string) error {
	_, err := r.db.Exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint)
	return err
}

// Disable marks the subscription as inactive without deleting the row, so a
// later re-subscribe (via Create's upsert) re-enables it in place. Called by
// the notifier when a push send returns HTTP 410 (subscription gone).
func (r *Repo) Disable(endpoint string) error {
	_, err := r.db.Exec("UPDATE push_subscriptions SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE endpoint = ?", endpoint)
	return err
}
