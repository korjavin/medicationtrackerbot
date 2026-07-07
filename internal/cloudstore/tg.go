package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// ErrPendingInvalid is returned by ConsumePendingByUsername when no pending
// provisioning row matches the suggested username (unknown, already consumed,
// or expired). The manager webhook maps this to "drop the update" — an edited
// username or a replayed managed_bot update lands here.
var ErrPendingInvalid = errors.New("cloudstore: no matching pending telegram provisioning")

// TGBot is one account's linked Telegram bot. TokenCT/TokenNonce hold the bot
// token sealed at rest (AES-GCM under an HKDF-derived key — see
// internal/cloudserver); the plaintext never lives in a column. ChatID/LinkedAt
// stay nil until the user opens the bot and taps /start.
type TGBot struct {
	AccountID     string
	BotID         int64
	BotUsername   string
	TokenCT       []byte
	TokenNonce    []byte
	Kind          string // "managed" | "byo"
	ChatID        *int64
	WebhookSecret string
	CreatedAt     time.Time
	LinkedAt      *time.Time
}

// CreatePending inserts a short-lived managed-bot provisioning row keyed by the
// suggested username (whose random suffix is the pairing key). It first sweeps
// expired rows (TTL 1h) so abandoned/repeated provisions don't accumulate — the
// opportunistic cleanup the schema comment promises, no background job needed.
func (r *Repo) CreatePending(ctx context.Context, suggestedUsername, accountID string, createdAt, expiresAt time.Time) error {
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM tg_pending WHERE expires_at_unix <= ?`, storedb.TimeToUnix(createdAt)); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO tg_pending (suggested_username, account_id, created_at_unix, expires_at_unix) VALUES (?, ?, ?, ?)`,
		suggestedUsername, accountID, storedb.TimeToUnix(createdAt), storedb.TimeToUnix(expiresAt))
	return err
}

// ConsumePendingByUsername atomically matches and deletes the pending row for
// suggestedUsername, returning the account that started the flow. Single use:
// enforced by DELETE ... RETURNING so a replayed managed_bot update can't bind
// twice. Returns ErrPendingInvalid for unknown/expired/already-consumed rows.
func (r *Repo) ConsumePendingByUsername(ctx context.Context, suggestedUsername string, now time.Time) (accountID string, err error) {
	err = r.db.QueryRowContext(ctx,
		`DELETE FROM tg_pending WHERE suggested_username = ? AND expires_at_unix > ? RETURNING account_id`,
		suggestedUsername, storedb.TimeToUnix(now)).Scan(&accountID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrPendingInvalid
	}
	if err != nil {
		return "", err
	}
	return accountID, nil
}

// PendingAccountByUsername returns the account that started a managed-bot flow
// for suggestedUsername *without* consuming the row, so the manager webhook can
// run its fallible Telegram work (token fetch, webhook set) first and delete the
// pending row only once everything succeeds — a 500 then lets Telegram retry the
// whole bind instead of stranding the flow. Returns ErrPendingInvalid for
// unknown/expired rows.
func (r *Repo) PendingAccountByUsername(ctx context.Context, suggestedUsername string, now time.Time) (string, error) {
	var accountID string
	err := r.db.QueryRowContext(ctx,
		`SELECT account_id FROM tg_pending WHERE suggested_username = ? AND expires_at_unix > ?`,
		suggestedUsername, storedb.TimeToUnix(now)).Scan(&accountID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrPendingInvalid
	}
	return accountID, err
}

// DeletePendingByAccount clears an account's pending managed-bot provisioning
// row (the "start over" path from the pending page). Idempotent — deleting
// zero rows is success.
func (r *Repo) DeletePendingByAccount(ctx context.Context, accountID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM tg_pending WHERE account_id = ?`, accountID)
	return err
}

// PendingUsernameByAccount returns the suggested username of the account's live
// provisioning row (empty string if none), so the status endpoint can rebuild
// the create-bot deep link — the pending page must keep showing that link,
// including after a reload. sql.ErrNoRows is folded into ("", nil).
func (r *Repo) PendingUsernameByAccount(ctx context.Context, accountID string, now time.Time) (string, error) {
	var suggested string
	err := r.db.QueryRowContext(ctx,
		`SELECT suggested_username FROM tg_pending WHERE account_id = ? AND expires_at_unix > ?`,
		accountID, storedb.TimeToUnix(now)).Scan(&suggested)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return suggested, err
}

// UpsertBot inserts or replaces an account's linked bot. Re-linking (a fresh
// managed provision or BYO token) rotates every field and clears any prior
// chat link — the new bot must be /start'ed again.
func (r *Repo) UpsertBot(ctx context.Context, b TGBot) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO tg_bots (account_id, bot_id, bot_username, token_ct, token_nonce, kind, webhook_secret, created_at_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET bot_id = excluded.bot_id, bot_username = excluded.bot_username,
		   token_ct = excluded.token_ct, token_nonce = excluded.token_nonce, kind = excluded.kind,
		   webhook_secret = excluded.webhook_secret, created_at_unix = excluded.created_at_unix,
		   chat_id = NULL, linked_at_unix = NULL`,
		b.AccountID, b.BotID, b.BotUsername, b.TokenCT, b.TokenNonce, b.Kind, b.WebhookSecret, storedb.TimeToUnix(b.CreatedAt))
	return err
}

// UpsertManagedBotIfPending is the manager-webhook variant of UpsertBot that
// atomically gates the write on the pending row still existing. The single
// INSERT ... SELECT ... WHERE EXISTS is serialized against the "start over"
// DELETE (DeletePendingByAccount) by SQLite's writer, so a reset that lands
// mid-bind either wins (pending gone → no row written, returns false) or loses
// (bot written, and the reset's own status re-fetch then sees bot_created).
// This closes the peek-then-write race a plain UpsertBot would leave open. It
// does NOT consume the pending row — the caller sets the child webhook first and
// only writes the bot row here once that succeeds, so a failed SetWebhook 500s
// with the pending retry anchor still intact; the caller deletes it last.
func (r *Repo) UpsertManagedBotIfPending(ctx context.Context, b TGBot, suggestedUsername string, now time.Time) (bool, error) {
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO tg_bots (account_id, bot_id, bot_username, token_ct, token_nonce, kind, webhook_secret, created_at_unix)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?
		 WHERE EXISTS (SELECT 1 FROM tg_pending WHERE suggested_username = ? AND expires_at_unix > ?)
		 ON CONFLICT(account_id) DO UPDATE SET bot_id = excluded.bot_id, bot_username = excluded.bot_username,
		   token_ct = excluded.token_ct, token_nonce = excluded.token_nonce, kind = excluded.kind,
		   webhook_secret = excluded.webhook_secret, created_at_unix = excluded.created_at_unix,
		   chat_id = NULL, linked_at_unix = NULL`,
		b.AccountID, b.BotID, b.BotUsername, b.TokenCT, b.TokenNonce, b.Kind, b.WebhookSecret, storedb.TimeToUnix(b.CreatedAt),
		suggestedUsername, storedb.TimeToUnix(now))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

const tgBotColumns = `account_id, bot_id, bot_username, token_ct, token_nonce, kind, chat_id, webhook_secret, created_at_unix, linked_at_unix`

func scanTGBot(scan func(dest ...any) error) (*TGBot, error) {
	var (
		b           TGBot
		chatID      sql.NullInt64
		createdUnix int64
		linkedAt    sql.NullInt64
	)
	if err := scan(&b.AccountID, &b.BotID, &b.BotUsername, &b.TokenCT, &b.TokenNonce, &b.Kind, &chatID, &b.WebhookSecret, &createdUnix, &linkedAt); err != nil {
		return nil, err
	}
	if chatID.Valid {
		b.ChatID = &chatID.Int64
	}
	b.CreatedAt = storedb.UnixToTime(createdUnix)
	b.LinkedAt = storedb.NullableUnixToTimePtr(linkedAt)
	return &b, nil
}

// BotByAccount returns an account's linked bot, or sql.ErrNoRows if none.
func (r *Repo) BotByAccount(ctx context.Context, accountID string) (*TGBot, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+tgBotColumns+` FROM tg_bots WHERE account_id = ?`, accountID)
	return scanTGBot(row.Scan)
}

// BotByWebhookRef returns the bot addressed by a child-webhook ref (the
// account id embedded in /tg/bot/<ref>/<secret>). The caller compares the
// path secret against WebhookSecret in memory — the DB never indexes on it.
func (r *Repo) BotByWebhookRef(ctx context.Context, ref string) (*TGBot, error) {
	row := r.db.QueryRowContext(ctx, `SELECT `+tgBotColumns+` FROM tg_bots WHERE account_id = ?`, ref)
	return scanTGBot(row.Scan)
}

// LinkChat records the chat_id the bot was /start'ed from (the end of the
// managed/BYO flow). Returns sql.ErrNoRows if the account has no bot.
func (r *Repo) LinkChat(ctx context.Context, accountID string, chatID int64, linkedAt time.Time) error {
	result, err := r.db.ExecContext(ctx,
		`UPDATE tg_bots SET chat_id = ?, linked_at_unix = ? WHERE account_id = ?`,
		chatID, storedb.TimeToUnix(linkedAt), accountID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// DeleteBot removes an account's linked bot row (the DELETE /api/telegram
// unlink path). No-op if none exists.
func (r *Repo) DeleteBot(ctx context.Context, accountID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM tg_bots WHERE account_id = ?`, accountID)
	return err
}

// SetTGSkipped records that the user skipped Telegram setup so the stateless
// wizard never re-nags.
func (r *Repo) SetTGSkipped(ctx context.Context, accountID string, skippedAt time.Time) error {
	result, err := r.db.ExecContext(ctx, `UPDATE accounts SET tg_skipped_unix = ? WHERE id = ?`, storedb.TimeToUnix(skippedAt), accountID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}
