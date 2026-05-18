// Package auth owns the api_tokens and used_login_hashes tables: long-lived
// bearer tokens used by the MCP server's API-token authentication path, and
// the replay-prevention table for one-shot login nonces.
//
// Repo is the per-domain repository. Construct via store.New / store.NewWithDB
// and reach it as r.Auth; new code should depend on *auth.Repo (or a narrow
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
//
// ExpiresAt is unix seconds UTC; nil means the token has no expiry (legacy
// long-lived tokens minted before the elevenlabs voice-session work).
type APIToken struct {
	ID         int64         `json:"id"`
	Name       string        `json:"name"`
	CreatedAt  time.Time     `json:"created_at"`
	LastUsedAt sql.NullTime  `json:"last_used_at"`
	ExpiresAt  sql.NullInt64 `json:"expires_at,omitempty"`
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

// CreateToken inserts a new token row with no expiry and returns its id.
// Thin wrapper over CreateTokenWithExpiry for back-compat with the long-lived
// token path; new callers that need an expiry should use CreateTokenWithExpiry
// directly.
func (r *Repo) CreateToken(ctx context.Context, name, tokenHash string) (int64, error) {
	return r.CreateTokenWithExpiry(ctx, name, tokenHash, nil)
}

// CreateTokenWithExpiry inserts a new token row with an optional expiry and
// returns its id. expiresAt is interpreted as a wall-clock instant; the row
// is persisted as unix seconds UTC (see the dose-time-columns convention in
// internal/store/store.go). Pass nil for no expiry (the long-lived token path).
//
// Sweeps expired rows opportunistically before insert, mirroring the
// used_login_hashes pattern at repo.go:143. The sweep error is intentionally
// ignored: it's a best-effort hygiene step, not a correctness invariant —
// the GetTokenByHash filter is what makes expired tokens unusable.
func (r *Repo) CreateTokenWithExpiry(ctx context.Context, name, tokenHash string, expiresAt *time.Time) (int64, error) {
	_, _ = r.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ?`, r.now().Unix())

	var expiresAtUnix sql.NullInt64
	if expiresAt != nil {
		expiresAtUnix = sql.NullInt64{Int64: expiresAt.UTC().Unix(), Valid: true}
	}
	res, err := r.db.ExecContext(
		ctx,
		`INSERT INTO api_tokens (name, token_hash, expires_at) VALUES (?, ?, ?)`,
		name, tokenHash, expiresAtUnix,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListTokens returns all tokens ordered by id (oldest first). The
// plaintext token and hash are never included.
func (r *Repo) ListTokens(ctx context.Context) ([]APIToken, error) {
	rows, err := r.db.QueryContext(
		ctx,
		`SELECT id, name, created_at, last_used_at, expires_at FROM api_tokens ORDER BY id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []APIToken
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.Name, &t.CreatedAt, &t.LastUsedAt, &t.ExpiresAt); err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tokens, nil
}

// DeleteToken removes a token by id. Returns sql.ErrNoRows when the id is
// not present so callers can map this to a 404.
func (r *Repo) DeleteToken(ctx context.Context, id int64) error {
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

// GetTokenByHash looks up a token by its sha256 hash. Returns (nil, nil) when
// no row matches OR when the row's expires_at is in the past — the caller
// (OAuth middleware) treats both as "no valid token" and falls through. The
// expiry filter is what makes short-lived voice-session tokens stop working
// at their 15-minute boundary without needing an explicit revoke step.
func (r *Repo) GetTokenByHash(ctx context.Context, hash string) (*APIToken, error) {
	var t APIToken
	err := r.db.QueryRowContext(
		ctx,
		`SELECT id, name, created_at, last_used_at, expires_at FROM api_tokens
		 WHERE token_hash = ?
		   AND (expires_at IS NULL OR expires_at > ?)`,
		hash, r.now().Unix(),
	).Scan(&t.ID, &t.Name, &t.CreatedAt, &t.LastUsedAt, &t.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// TouchTokenLastUsed updates last_used_at to the current time. Best-effort
// — callers should log but not block on errors.
func (r *Repo) TouchTokenLastUsed(ctx context.Context, id int64) error {
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
