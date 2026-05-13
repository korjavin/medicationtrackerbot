// Package auth owns the api_tokens and used_login_hashes tables: long-lived
// bearer tokens used by the MCP server's API-token authentication path, and
// the replay-prevention table for one-shot login nonces.
//
// Repo is the per-domain repository. The legacy *store.Store still exposes
// one-line forwarders (CreateAPIToken / ListAPITokens / DeleteAPIToken /
// FindAPITokenByHash / TouchAPITokenLastUsed / TryUseLoginHash) so old
// callers keep compiling; new code should depend on *auth.Repo (or a narrow
// interface satisfied by it) directly.
package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// APIToken represents a long-lived bearer token used by the MCP server's
// API-token authentication path. The plaintext token is never stored — only
// its sha256 hash. The plaintext is returned to the caller exactly once when
// the token is created.
type APIToken struct {
	ID         int64        `json:"id"`
	Name       string       `json:"name"`
	CreatedAt  time.Time    `json:"created_at"`
	LastUsedAt sql.NullTime `json:"last_used_at"`
}

// Repo is the api_tokens + used_login_hashes repository. Construct with New;
// share one *Repo per process — the underlying *db.DB owns its own
// connection pool.
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

// SetClock overrides the time source used by TryUseLoginHash for pruning.
// Tests use it to inject a deterministic timestamp; production code should
// never call it.
func (r *Repo) SetClock(now func() time.Time) {
	r.now = now
}

// CreateAPIToken inserts a new token row and returns its id.
func (r *Repo) CreateAPIToken(ctx context.Context, name, tokenHash string) (int64, error) {
	res, err := r.db.ExecContext(
		ctx,
		`INSERT INTO api_tokens (name, token_hash) VALUES (?, ?)`,
		name, tokenHash,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListAPITokens returns all tokens ordered by id (oldest first). The
// plaintext token and hash are never included.
func (r *Repo) ListAPITokens(ctx context.Context) ([]APIToken, error) {
	rows, err := r.db.QueryContext(
		ctx,
		`SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []APIToken
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.Name, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tokens, nil
}

// DeleteAPIToken removes a token by id. Returns sql.ErrNoRows when the id is
// not present so callers can map this to a 404.
func (r *Repo) DeleteAPIToken(ctx context.Context, id int64) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// FindAPITokenByHash looks up a token by its sha256 hash. Returns (nil, nil)
// when no row matches so the OAuth middleware can cleanly fall through.
func (r *Repo) FindAPITokenByHash(ctx context.Context, hash string) (*APIToken, error) {
	var t APIToken
	err := r.db.QueryRowContext(
		ctx,
		`SELECT id, name, created_at, last_used_at FROM api_tokens WHERE token_hash = ?`,
		hash,
	).Scan(&t.ID, &t.Name, &t.CreatedAt, &t.LastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// TouchAPITokenLastUsed updates last_used_at to the current time. Best-effort
// — callers should log but not block on errors.
func (r *Repo) TouchAPITokenLastUsed(ctx context.Context, id int64) error {
	_, err := r.db.ExecContext(
		ctx,
		`UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`,
		id,
	)
	return err
}

// TryUseLoginHash atomically checks whether a login hash has been used and
// marks it used if not. Returns true if the hash is fresh (first use), false
// if it was already consumed (replay). Uses INSERT OR IGNORE for atomicity —
// no SELECT+INSERT race under concurrent access. Also prunes expired entries
// lazily.
func (r *Repo) TryUseLoginHash(hash string, expiresAt time.Time) (bool, error) {
	_, _ = r.db.Exec(`DELETE FROM used_login_hashes WHERE expires_at < ?`, r.now().Unix())

	result, err := r.db.Exec(`INSERT OR IGNORE INTO used_login_hashes (hash, expires_at) VALUES (?, ?)`, hash, expiresAt.Unix())
	if err != nil {
		return false, err
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return false, err
	}

	return rows > 0, nil
}
