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

// Row ownership for scheduled_pushes (med-eas.70). Client-uploaded rows are
// wiped-and-replaced by ReplaceSchedule; relay-inserted workout snooze re-fires
// (PushOriginRelayRefire) survive that wipe so a pending snooze isn't erased by
// the next client sync.
const (
	PushOriginClient      = "client"
	PushOriginRelayRefire = "relay_refire"
)

// ScheduledPush is one row in the scheduled_pushes table — a client-scheduled
// blind push (fire_at, ct) the relay sender fires without ever decrypting.
// SentAt is nil until the relay has attempted delivery.
//
// TGText is the one field the relay CAN read: for Telegram deliveries the
// client composes the message itself, at its chosen verbosity, and hands the
// relay the exact bytes to forward. CT stays opaque either way.
type ScheduledPush struct {
	ID         int64
	AccountID  string
	FireAt     time.Time
	CT         []byte
	SentAt     *time.Time
	Delivery   string
	TGText     string
	TGCallback string
	// TGMedIDs is the comma-separated list of medication record ids the client
	// named in this reminder's text ("" on non-med rows). Cleartext to the relay
	// like TGText — and strictly less than TGText already carries at 'detailed'
	// verbosity (the names) — so a Telegram Confirm tap can seal the identity of
	// the doses it confirms instead of the browser guessing them from a time band
	// (med-kbpf). CT stays opaque.
	TGMedIDs string
	// SupersedesMessageID is the prior Telegram message_id this send should delete
	// (0 = nothing to delete). A TG artifact, never vault/ct data (med-eas.79).
	SupersedesMessageID int64
}

// ScheduledPushInput is one entry of a PUT /api/push/schedule replace-all
// batch, before insertion. An empty Delivery is stored as DeliveryWebPush.
type ScheduledPushInput struct {
	FireAt     time.Time
	CT         []byte
	Delivery   string
	TGText     string
	TGCallback string
	TGMedIDs   string
}

// ReplaceSchedule replaces accountID's unsent schedule with entries in one
// transaction (delete-then-insert), matching the client scheduler's
// replace-all semantics. Already-sent entries are left untouched so the
// relay's send history survives a client re-schedule.
func (r *Repo) ReplaceSchedule(ctx context.Context, accountID string, entries []ScheduledPushInput, now time.Time) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		// Only wipe the account's own client rows: relay-inserted workout snooze
		// re-fires (origin = 'relay_refire') must survive a client re-upload so a
		// pending snooze isn't erased by the next sync.
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM scheduled_pushes WHERE account_id = ? AND sent_at_unix IS NULL AND origin = ?`, accountID, PushOriginClient); err != nil {
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
				`INSERT INTO scheduled_pushes (account_id, fire_at_unix, ct, delivery, tg_text, tg_callback, tg_med_ids) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				accountID, storedb.TimeToUnix(e.FireAt), ct, delivery, e.TGText, e.TGCallback, e.TGMedIDs); err != nil {
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
		`SELECT id, account_id, fire_at_unix, ct, delivery, tg_text, tg_callback, tg_med_ids, supersedes_message_id FROM scheduled_pushes WHERE sent_at_unix IS NULL AND fire_at_unix <= ? ORDER BY fire_at_unix`,
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
		if err := rows.Scan(&p.ID, &p.AccountID, &fireUnix, &p.CT, &p.Delivery, &p.TGText, &p.TGCallback, &p.TGMedIDs, &p.SupersedesMessageID); err != nil {
			return nil, err
		}
		p.FireAt = storedb.UnixToTime(fireUnix)
		due = append(due, p)
	}
	return due, rows.Err()
}

// MarkPushSent marks a scheduled push as sent so later ticks skip it, and clears
// the CONTENT in the same UPDATE so fired Telegram plaintext (med name + dose in
// tg_text) and the NK ciphertext don't accumulate at rest (bd med-yor.13).
//
// tg_callback and tg_med_ids deliberately SURVIVE the send: they are the tap's
// addressing, not its content — the callback is the slot instant already stored
// in fire_at_unix, and the med ids are opaque numbers. A Confirm tapped on
// yesterday evening's message this morning is answered from this sent row
// (MedIDsForCallback), long after the re-fire chain ended; without them that tap
// would resolve to nothing (med-kbpf). ScrubSentPushIdentity drops them once
// they are too old to be tapped. ct/tg_text are NOT NULL, so they clear to empty
// rather than SQL NULL.
func (r *Repo) MarkPushSent(ctx context.Context, id int64, sentAt time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE scheduled_pushes SET sent_at_unix = ?, ct = X'', tg_text = '' WHERE id = ?`,
		storedb.TimeToUnix(sentAt), id)
	return err
}

// ScrubSentPushIdentity drops the tap addressing (tg_callback/tg_med_ids) from
// rows sent before `before` — the hourly sweep's retention pass for what
// MarkPushSent leaves behind. Returns rows affected.
func (r *Repo) ScrubSentPushIdentity(ctx context.Context, before time.Time) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE scheduled_pushes SET tg_callback = '', tg_med_ids = '' WHERE sent_at_unix IS NOT NULL AND sent_at_unix < ?`,
		storedb.TimeToUnix(before))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// InsertRelayRefire schedules one relay-owned Telegram re-fire (med-eas.70): a
// workout snooze tap re-delivers the reminder ~1h/2h later even if the PWA never
// reopens. It copies ONLY already-cleartext fields the relay could see when it
// handled the tap (tg_text/tg_callback at a new fire_at) — ct is empty and the
// relay never reads or produces it, preserving the zero-knowledge invariant.
func (r *Repo) InsertRelayRefire(ctx context.Context, accountID string, fireAt time.Time, tgText, tgCallback string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO scheduled_pushes (account_id, fire_at_unix, ct, delivery, tg_text, tg_callback, origin) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		accountID, storedb.TimeToUnix(fireAt), []byte{}, DeliveryTelegram, tgText, tgCallback, PushOriginRelayRefire)
	return err
}

// RescheduleRelayRefire atomically supersedes any pending relay re-fire for
// (accountID, tgCallback) with a fresh one: the cancel + insert run in a single
// transaction so two concurrent workout snooze taps for the same session can't
// both delete-then-insert and leave duplicate pending re-fire rows (med-eas.70).
// Copies only already-cleartext fields (empty ct), preserving zero-knowledge.
// supersedesMessageID is the prior TG message_id this re-fire should delete when it
// sends (0 = none) — a TG artifact, not vault data (med-eas.79). tgMedIDs carries
// the med identity of the reminder down the chain ("" for non-med re-fires), so a
// tap on the LAST re-fire still knows which doses it confirms (med-kbpf).
//
// The supersedes id never regresses: a delayed snooze tap from an older message
// (its callback processed after the relay already queued a newer re-fire) must
// not overwrite a higher pending supersedes id with a lower one, which would
// delete an already-gone message and leave the newer reminder live (violating
// one-live-reminder-per-chain). TG message ids are monotonic per chat, so we
// keep max(existing pending, new) inside the transaction. This compare is only
// sound because pending re-fires never outlive their chat: ClearRelayRefires
// wipes them on every bot relink / new /start, so both ids here always come from
// the same chat's id-space (med-eas.79).
func (r *Repo) RescheduleRelayRefire(ctx context.Context, accountID string, fireAt time.Time, tgText, tgCallback, tgMedIDs string, supersedesMessageID int64) error {
	return r.db.WithTx(ctx, func(tx storedb.TX) error {
		var pending sql.NullInt64
		if err := tx.QueryRowContext(ctx,
			`SELECT MAX(supersedes_message_id) FROM scheduled_pushes WHERE account_id = ? AND origin = ? AND tg_callback = ? AND sent_at_unix IS NULL`,
			accountID, PushOriginRelayRefire, tgCallback).Scan(&pending); err != nil {
			return err
		}
		if pending.Valid && pending.Int64 > supersedesMessageID {
			supersedesMessageID = pending.Int64
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM scheduled_pushes WHERE account_id = ? AND origin = ? AND tg_callback = ? AND sent_at_unix IS NULL`,
			accountID, PushOriginRelayRefire, tgCallback); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx,
			`INSERT INTO scheduled_pushes (account_id, fire_at_unix, ct, delivery, tg_text, tg_callback, tg_med_ids, origin, supersedes_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			accountID, storedb.TimeToUnix(fireAt), []byte{}, DeliveryTelegram, tgText, tgCallback, tgMedIDs, PushOriginRelayRefire, supersedesMessageID)
		return err
	})
}

// MedIDsForCallback returns the comma-separated medication ids stored on the most
// recent row for (accountID, tgCallback) — the reminder the user is tapping. That
// is the pending re-fire the relay armed after the send while the chain is alive,
// and the sent row itself once it has ended: MarkPushSent keeps the addressing,
// and ScrubSentPushIdentity only drops it past the retention window. Empty string
// (no error) when nothing is on file (med-kbpf).
func (r *Repo) MedIDsForCallback(ctx context.Context, accountID, tgCallback string) (string, error) {
	var ids string
	err := r.db.QueryRowContext(ctx,
		`SELECT tg_med_ids FROM scheduled_pushes WHERE account_id = ? AND tg_callback = ? AND tg_med_ids <> '' ORDER BY id DESC LIMIT 1`,
		accountID, tgCallback).Scan(&ids)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return ids, err
}

// ClearRelayRefires drops ALL pending (unsent) relay re-fires for accountID.
// Called when the account's chat linkage changes (bot relink / new /start): a
// pending re-fire's supersedes_message_id and tg_text belong to the OLD chat's
// message id-space, which is meaningless in a new chat. Clearing them keeps the
// max-preserve compare in RescheduleRelayRefire strictly same-chat (Telegram
// message ids are only monotonic per chat), so a stale high id can never win the
// max() against a fresh low id and make the delete target the wrong message
// (med-eas.79).
func (r *Repo) ClearRelayRefires(ctx context.Context, accountID string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM scheduled_pushes WHERE account_id = ? AND origin = ? AND sent_at_unix IS NULL`,
		accountID, PushOriginRelayRefire)
	return err
}

// CancelRelayRefire drops any pending (unsent) relay re-fire for accountID whose
// callback stem matches tgCallback — used when a workout skip tap should stop a
// scheduled snooze re-fire. Returns rows affected.
func (r *Repo) CancelRelayRefire(ctx context.Context, accountID, tgCallback string) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`DELETE FROM scheduled_pushes WHERE account_id = ? AND origin = ? AND tg_callback = ? AND sent_at_unix IS NULL`,
		accountID, PushOriginRelayRefire, tgCallback)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
