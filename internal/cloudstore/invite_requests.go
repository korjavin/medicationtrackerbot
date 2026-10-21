package cloudstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// Invite requests (bd med-ta2n.14): a person without an invite asks for one,
// either by email from the in-app sheet or by saying "yes" to the manager bot,
// and the admin approves or declines in the manager bot's admin chat.
const (
	InviteRequestEmail = "email"
	InviteRequestTG    = "tg"

	InviteRequestPending  = "pending"
	InviteRequestApproved = "approved"
	InviteRequestDeclined = "declined"

	// inviteRequestRetention: every row, decided or not, is deleted this long
	// after it was created (docs/cloud-operations-security.md §4).
	inviteRequestRetention = 90 * 24 * time.Hour
)

// ErrInviteRequestsFull is the persisted global daily cap on email requests.
var ErrInviteRequestsFull = errors.New("cloudstore: invite request daily cap reached")

// InviteRequest is one row of invite_requests. Email rows carry EmailLC, Note
// and IPHash; Telegram rows carry TGChatID and TGUserID.
type InviteRequest struct {
	ID             int64
	Channel        string
	EmailLC        string
	Note           string
	TGChatID       int64
	TGUserID       int64
	Status         string
	AdminMessageID int64
	CreatedAt      time.Time
}

func sweepInviteRequests(ctx context.Context, tx storedb.TX, now time.Time) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM invite_requests WHERE created_at_unix <= ?`,
		storedb.TimeToUnix(now.Add(-inviteRequestRetention)))
	return err
}

// CreateEmailInviteRequest sweeps rows past retention, then inserts an email
// request unless the same address already has a row created within dedupe
// (created=false, no error: the caller answers exactly as for a new one, so the
// endpoint never reveals state). A new row past dailyCap email rows in the last
// 24h is refused with ErrInviteRequestsFull.
func (r *Repo) CreateEmailInviteRequest(ctx context.Context, emailLC, note, ipHash string, now time.Time, dedupe time.Duration, dailyCap int) (id int64, created bool, err error) {
	err = r.db.WithTx(ctx, func(tx storedb.TX) error {
		if err := sweepInviteRequests(ctx, tx, now); err != nil {
			return err
		}
		var one int
		switch err := tx.QueryRowContext(ctx,
			`SELECT 1 FROM invite_requests WHERE channel = 'email' AND email_lc = ? AND created_at_unix > ? LIMIT 1`,
			emailLC, storedb.TimeToUnix(now.Add(-dedupe))).Scan(&one); {
		case err == nil:
			return nil
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		var count int
		if err := tx.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM invite_requests WHERE channel = 'email' AND created_at_unix > ?`,
			storedb.TimeToUnix(now.Add(-24*time.Hour))).Scan(&count); err != nil {
			return err
		}
		if count >= dailyCap {
			return ErrInviteRequestsFull
		}
		res, err := tx.ExecContext(ctx,
			`INSERT INTO invite_requests (channel, email_lc, note, ip_hash, created_at_unix) VALUES ('email', ?, ?, ?, ?)`,
			emailLC, note, ipHash, storedb.TimeToUnix(now))
		if err != nil {
			return err
		}
		id, err = res.LastInsertId()
		created = err == nil
		return err
	})
	return id, created, err
}

// CreateTGInviteRequest sweeps rows past retention, then inserts a Telegram
// request unless this Telegram user already has a pending one (created=false).
// That pending check is also the update_id dedupe: a Telegram retry of the same
// "yes" finds the row and pings nobody.
func (r *Repo) CreateTGInviteRequest(ctx context.Context, chatID, userID int64, now time.Time) (id int64, created bool, err error) {
	err = r.db.WithTx(ctx, func(tx storedb.TX) error {
		if err := sweepInviteRequests(ctx, tx, now); err != nil {
			return err
		}
		var one int
		switch err := tx.QueryRowContext(ctx,
			`SELECT 1 FROM invite_requests WHERE channel = 'tg' AND tg_user_id = ? AND status = 'pending' LIMIT 1`,
			userID).Scan(&one); {
		case err == nil:
			return nil
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		res, err := tx.ExecContext(ctx,
			`INSERT INTO invite_requests (channel, tg_chat_id, tg_user_id, created_at_unix) VALUES ('tg', ?, ?, ?)`,
			chatID, userID, storedb.TimeToUnix(now))
		if err != nil {
			return err
		}
		id, err = res.LastInsertId()
		created = err == nil
		return err
	})
	return id, created, err
}

// InviteRequestByID returns one row; sql.ErrNoRows when it never existed or
// was swept.
func (r *Repo) InviteRequestByID(ctx context.Context, id int64) (*InviteRequest, error) {
	var (
		req              InviteRequest
		email, note      sql.NullString
		chatID, userID   sql.NullInt64
		createdAt        int64
	)
	err := r.db.QueryRowContext(ctx,
		`SELECT id, channel, email_lc, note, tg_chat_id, tg_user_id, status, admin_message_id, created_at_unix
		 FROM invite_requests WHERE id = ?`, id).
		Scan(&req.ID, &req.Channel, &email, &note, &chatID, &userID, &req.Status, &req.AdminMessageID, &createdAt)
	if err != nil {
		return nil, err
	}
	req.EmailLC, req.Note = email.String, note.String
	req.TGChatID, req.TGUserID = chatID.Int64, userID.Int64
	req.CreatedAt = storedb.UnixToTime(createdAt)
	return &req, nil
}

// SetInviteRequestAdminMessage records the admin-chat message carrying the
// request's buttons; a tap is honoured only from that message.
func (r *Repo) SetInviteRequestAdminMessage(ctx context.Context, id, messageID int64) error {
	_, err := r.db.ExecContext(ctx, `UPDATE invite_requests SET admin_message_id = ? WHERE id = ?`, messageID, id)
	return err
}

// MoveInviteRequest changes a row's status from `from` to `to`, and reports
// whether it did: the conditional UPDATE is the one-decision-per-request guard,
// so of two concurrent taps exactly one sees true. pending → approved|declined
// decides; approved → pending reopens after a failed mint; approved → declined
// records the Telegram live-invite cap found at approve time.
func (r *Repo) MoveInviteRequest(ctx context.Context, id int64, from, to string, now time.Time) (bool, error) {
	decided := sql.NullInt64{Int64: storedb.TimeToUnix(now), Valid: to != InviteRequestPending}
	res, err := r.db.ExecContext(ctx,
		`UPDATE invite_requests SET status = ?, decided_at_unix = ? WHERE id = ? AND status = ?`,
		to, decided, id, from)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}
