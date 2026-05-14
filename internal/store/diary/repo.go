// Package diary owns the diary_notes table: short free-text entries (with an
// optional tag from a curated enum) that the user records via the Telegram
// /note command or the web "Notes" screen.
//
// Repo is the per-domain repository for this table. Construct via store.New /
// store.NewWithDB and reach it as r.Diary; new code should depend on *diary.Repo
// (or a narrow interface satisfied by it) directly.
package diary

import (
	"context"
	"database/sql"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// DiaryNote is one row in the diary_notes table. The Tag pointer is nil when
// the row has a NULL tag (i.e. the user did not classify the note).
type DiaryNote struct {
	ID        int64     `json:"id"`
	UserID    int64     `json:"-"`
	Content   string    `json:"content"`
	Tag       *string   `json:"tag,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Repo is the diary_notes repository. Construct with New; share one *Repo per
// process — the underlying *db.DB owns its own connection pool.
type Repo struct {
	db  *storedb.DB
	now func() time.Time
}

// New returns a Repo bound to the shared *db.DB. The composition root passes
// in the same *db.DB it gives every other repo so all reads/writes go through
// one connection pool.
func New(d *storedb.DB) *Repo {
	return &Repo{db: d, now: time.Now}
}

// SetClock overrides the time source used by Create. Tests use it to inject a
// deterministic timestamp; production code should never call it.
func (r *Repo) SetClock(now func() time.Time) {
	r.now = now
}

// Create inserts a new diary note for the user. tag may be nil for an untagged note.
func (r *Repo) Create(ctx context.Context, userID int64, content string, tag *string) (*DiaryNote, error) {
	query := `INSERT INTO diary_notes (user_id, content, tag, created_at) VALUES (?, ?, ?, ?) RETURNING id, user_id, content, tag, created_at`
	var note DiaryNote
	var tagArg interface{}
	if tag != nil {
		tagArg = *tag
	}
	var tagOut sql.NullString
	err := r.db.QueryRowContext(ctx, query, userID, content, tagArg, r.now()).Scan(&note.ID, &note.UserID, &note.Content, &tagOut, &note.CreatedAt)
	if err != nil {
		return nil, err
	}
	if tagOut.Valid {
		v := tagOut.String
		note.Tag = &v
	}
	return &note, nil
}

// List returns diary notes for a user, newest first.
// If since is non-zero, only notes created at or after that time are returned.
// If until is non-zero, only notes created at or before that time are returned.
// limit <= 0 means no limit (up to 1000).
// beforeID, when > 0, acts as a keyset cursor: only notes with id < beforeID are returned,
// enabling stable pagination even when notes are added or deleted between pages.
func (r *Repo) List(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]DiaryNote, error) {
	query := `SELECT id, user_id, content, tag, created_at FROM diary_notes WHERE user_id = ?`
	args := []interface{}{userID}
	if !since.IsZero() {
		query += " AND created_at >= ?"
		args = append(args, since)
	}
	if !until.IsZero() {
		query += " AND created_at <= ?"
		args = append(args, until)
	}
	if beforeID > 0 {
		query += " AND id < ?"
		args = append(args, beforeID)
	}
	query += " ORDER BY id DESC LIMIT ?"
	if limit > 0 {
		args = append(args, limit)
	} else {
		args = append(args, 1000)
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var notes []DiaryNote
	for rows.Next() {
		var n DiaryNote
		var tag sql.NullString
		if err := rows.Scan(&n.ID, &n.UserID, &n.Content, &tag, &n.CreatedAt); err != nil {
			return nil, err
		}
		if tag.Valid {
			v := tag.String
			n.Tag = &v
		}
		notes = append(notes, n)
	}
	return notes, rows.Err()
}

// Delete removes a diary note by ID, scoped to the user. Returns sql.ErrNoRows
// if no row matches (either missing or owned by a different user).
func (r *Repo) Delete(ctx context.Context, userID, noteID int64) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM diary_notes WHERE id = ? AND user_id = ?`, noteID, userID)
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
