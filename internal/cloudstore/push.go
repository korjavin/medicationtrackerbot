package cloudstore

import (
	"context"
	"database/sql"
	"errors"
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

// GetByEndpoint returns accountID's enabled subscription for endpoint, or nil
// if it doesn't exist, belongs to another account, or is disabled — the
// lookup the test-push handler uses to resolve "the calling device's own
// subscription" without ever touching another account's rows.
func (r *Repo) GetByEndpoint(ctx context.Context, accountID, endpoint string) (*PushSubscription, error) {
	var (
		s           PushSubscription
		createdUnix int64
		disabled    int
	)
	err := r.db.QueryRowContext(ctx,
		`SELECT account_id, endpoint, p256dh, auth, created_at_unix, disabled FROM push_subscriptions WHERE account_id = ? AND endpoint = ? AND disabled = 0`,
		accountID, endpoint).Scan(&s.AccountID, &s.Endpoint, &s.P256dh, &s.Auth, &createdUnix, &disabled)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	s.CreatedAt = storedb.UnixToTime(createdUnix)
	s.Disabled = disabled != 0
	return &s, nil
}

// Disable marks a subscription inactive (called by the relay sender on HTTP
// 410) without deleting it, so a later re-subscribe on the same endpoint
// upserts cleanly via UpsertPushSubscription.
func (r *Repo) Disable(ctx context.Context, endpoint string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE push_subscriptions SET disabled = 1 WHERE endpoint = ?`, endpoint)
	return err
}

// Delivery channels for a scheduled push. DeliveryWebPush is the zero-value
// behavior (and the column default), so pre-C3b rows and older clients keep
// firing over web push only.
const (
	DeliveryWebPush  = "webpush"
	DeliveryTelegram = "telegram"
	DeliveryBoth     = "both"
)

// ValidDelivery reports whether s is a known delivery channel.
func ValidDelivery(s string) bool {
	return s == DeliveryWebPush || s == DeliveryTelegram || s == DeliveryBoth
}

// ScheduledPush is one row in the scheduled_pushes table — a client-scheduled
// blind push (fire_at, ct) the relay sender fires without ever decrypting.
// SentAt is nil until the relay has attempted delivery.
//
// TGText is the one field the relay CAN read: for Telegram deliveries the
// client composes the message itself, at its chosen verbosity, and hands the
// relay the exact bytes to forward. CT stays opaque either way.
type ScheduledPush struct {
	ID        int64
	AccountID string
	FireAt    time.Time
	CT        []byte
	SentAt    *time.Time
	Delivery  string
	TGText    string
}

// ScheduledPushInput is one entry of a PUT /api/push/schedule replace-all
// batch, before insertion. An empty Delivery is stored as DeliveryWebPush.
type ScheduledPushInput struct {
	FireAt   time.Time
	CT       []byte
	Delivery string
	TGText   string
}

// ReplaceSchedule replaces accountID's unsent schedule with entries in one
// transaction (delete-then-insert), mirroring the Capacitor Reminders loop's
// replace-all semantics. Already-sent entries are left untouched so the
// relay's send history survives a client re-schedule.
func (r *Repo) ReplaceSchedule(ctx context.Context, accountID string, entries []ScheduledPushInput, now time.Time) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM scheduled_pushes WHERE account_id = ? AND sent_at_unix IS NULL`, accountID); err != nil {
			return err
		}
		for _, e := range entries {
			delivery := e.Delivery
			if delivery == "" {
				delivery = DeliveryWebPush
			}
			// ct is NOT NULL, and a telegram-only entry has no ciphertext: a nil
			// []byte binds as NULL, an empty one as a zero-length blob.
			ct := e.CT
			if ct == nil {
				ct = []byte{}
			}
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO scheduled_pushes (account_id, fire_at_unix, ct, delivery, tg_text) VALUES (?, ?, ?, ?, ?)`,
				accountID, storedb.TimeToUnix(e.FireAt), ct, delivery, e.TGText); err != nil {
				return err
			}
		}
		return nil
	})
}

// DueScheduledPushes returns unsent entries across every account whose
// fire_at has passed — the relay sender's per-tick query.
func (r *Repo) DueScheduledPushes(ctx context.Context, now time.Time) ([]ScheduledPush, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, account_id, fire_at_unix, ct, delivery, tg_text FROM scheduled_pushes WHERE sent_at_unix IS NULL AND fire_at_unix <= ? ORDER BY fire_at_unix`,
		storedb.TimeToUnix(now))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var due []ScheduledPush
	for rows.Next() {
		var (
			p        ScheduledPush
			fireUnix int64
		)
		if err := rows.Scan(&p.ID, &p.AccountID, &fireUnix, &p.CT, &p.Delivery, &p.TGText); err != nil {
			return nil, err
		}
		p.FireAt = storedb.UnixToTime(fireUnix)
		due = append(due, p)
	}
	return due, rows.Err()
}

// MarkPushSent marks a scheduled push as sent so later ticks skip it.
func (r *Repo) MarkPushSent(ctx context.Context, id int64, sentAt time.Time) error {
	_, err := r.db.ExecContext(ctx, `UPDATE scheduled_pushes SET sent_at_unix = ? WHERE id = ?`, storedb.TimeToUnix(sentAt), id)
	return err
}
