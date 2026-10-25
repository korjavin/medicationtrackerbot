package cloudstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

// MCPRemote is one account's Tier 2 hosted-relay enablement: the human token
// that authenticates the streamable-HTTP MCP endpoint, plus the pairing the
// hosted mcpshim.Client dials to reach the account's unlocked browser tab.
// One row per account (PK on account_id) — the relay's in-memory pairing
// table already caps an account at a single live pairing, so persisting more
// than one here would never be usable anyway.
type MCPRemote struct {
	AccountID string
	// Token is the legacy plaintext token column. For rows written or converted
	// since migration 037 it holds a random placeholder (IsSealedTokenPlaceholder)
	// and the real token lives sealed in TokenCT/TokenNonce. Any other value is
	// a real plaintext token: a pre-037 row, or one an older binary re-enabled
	// after a rollback (its upsert leaves token_ct stale) — the cloudserver
	// layer trusts it over TokenCT, seals it, and swaps in a placeholder.
	Token      string
	TokenCT    []byte
	TokenNonce []byte
	RelayURL   string
	PairingID string
	// PairingKeyCT/PairingKeyNonce hold the pairing key sealed at rest under the
	// HKDF-derived AES-GCM key (see internal/cloudserver mcp_seal.go), mirroring
	// tg_bots.token_ct/token_nonce. PairingKey is the legacy plaintext column: it
	// is empty for rows written after the sealing migration, and non-empty only
	// for pre-migration rows that the startup reseal (Restore) has not yet
	// converted — the cloudserver layer reads it, seals it, and clears it.
	PairingKeyCT    []byte
	PairingKeyNonce []byte
	PairingKey      []byte
	CreatedAt       time.Time
}

// sealedTokenPrefix marks the token column's placeholder. Real tokens are
// Crockford base32 plus '-', so they can never contain ':'.
const sealedTokenPrefix = "sealed:"

// IsSealedTokenPlaceholder reports whether a token column value is the
// placeholder written alongside a sealed token (not a real plaintext token).
func IsSealedTokenPlaceholder(s string) bool {
	return strings.HasPrefix(s, sealedTokenPrefix)
}

// sealedTokenPlaceholder returns a fresh random value for the NOT NULL legacy
// token column. Random, not empty or constant: an older binary (pre-037) still
// compares the presented token against this column, and "" or a fixed string
// would be a guessable token for it. 128 random bits can't be guessed.
func sealedTokenPlaceholder() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return sealedTokenPrefix + hex.EncodeToString(b), nil
}

// UpsertMCPRemote inserts or replaces accountID's hosted-remote enablement.
// Re-enable (a fresh POST /api/mcp/remote) rotates every field, including the
// token — the only events that change it, per the plan, are this and delete.
// The token and pairing key are stored sealed (tokenCT/tokenNonce,
// pairingKeyCT/pairingKeyNonce); the legacy plaintext columns get a random
// placeholder / an empty blob so neither secret ever lands at rest in clear.
func (r *Repo) UpsertMCPRemote(ctx context.Context, accountID, relayURL, pairingID string, tokenCT, tokenNonce, pairingKeyCT, pairingKeyNonce []byte, now time.Time) error {
	placeholder, err := sealedTokenPlaceholder()
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx,
		`INSERT INTO mcp_remote (account_id, token, token_ct, token_nonce, relay_url, pairing_id, pairing_key, pairing_key_ct, pairing_key_nonce, created_at_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, token_ct = excluded.token_ct, token_nonce = excluded.token_nonce, relay_url = excluded.relay_url, pairing_id = excluded.pairing_id, pairing_key = excluded.pairing_key, pairing_key_ct = excluded.pairing_key_ct, pairing_key_nonce = excluded.pairing_key_nonce, created_at_unix = excluded.created_at_unix`,
		accountID, placeholder, tokenCT, tokenNonce, relayURL, pairingID, []byte{}, pairingKeyCT, pairingKeyNonce, storedb.TimeToUnix(now))
	return err
}

// ResealMCPRemoteToken writes the sealed token for accountID and replaces the
// plaintext token column with a placeholder — the one-time startup conversion
// of rows holding a plaintext token. Guarded on the plaintext it converted
// (WHERE token = plaintext) so it can't clobber a row a concurrent re-enable
// rewrote in between. One UPDATE, so a crash leaves the row either fully
// legacy or fully sealed; re-running on a converted row is a no-op.
// Reports whether the row was converted (false: already converted or rewritten).
func (r *Repo) ResealMCPRemoteToken(ctx context.Context, accountID, plaintext string, tokenCT, tokenNonce []byte) (bool, error) {
	placeholder, err := sealedTokenPlaceholder()
	if err != nil {
		return false, err
	}
	n, err := r.secureDeleteExec(ctx,
		`UPDATE mcp_remote SET token_ct = ?, token_nonce = ?, token = ? WHERE account_id = ? AND token = ?`,
		tokenCT, tokenNonce, placeholder, accountID, plaintext)
	return n > 0, err
}

// ResealMCPRemotePairingKey writes the sealed pairing key for accountID and
// clears the legacy plaintext pairing_key column, used by the one-time startup
// reseal of pre-migration rows. Idempotent: re-running against an already-sealed
// row just rewrites the same sealed bytes and an already-empty plaintext blob.
func (r *Repo) ResealMCPRemotePairingKey(ctx context.Context, accountID string, pairingKeyCT, pairingKeyNonce []byte) error {
	_, err := r.secureDeleteExec(ctx,
		`UPDATE mcp_remote SET pairing_key_ct = ?, pairing_key_nonce = ?, pairing_key = ? WHERE account_id = ?`,
		pairingKeyCT, pairingKeyNonce, []byte{}, accountID)
	return err
}

// secureDeleteExec runs one write with PRAGMA secure_delete=ON on a pinned
// connection, so the cell holding the replaced plaintext is zeroed in the new
// page image instead of lingering as free space. The old image still sits in
// the WAL / main file until CheckpointTruncate copies the new one over it.
func (r *Repo) secureDeleteExec(ctx context.Context, query string, args ...any) (int64, error) {
	conn, err := r.db.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `PRAGMA secure_delete = ON`); err != nil {
		return 0, err
	}
	// Restore the default even if ctx is canceled, so the pooled connection
	// doesn't keep the slower mode for every later write.
	defer func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), `PRAGMA secure_delete = OFF`) }()
	res, err := conn.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// CheckpointTruncate runs PRAGMA wal_checkpoint(TRUNCATE): copies every WAL
// frame into the main file and truncates the WAL to zero bytes, so plaintext
// that a secure-delete write replaced is gone from both files. Returns an
// error when the checkpoint could not complete (busy=1, e.g. a reader such as
// Litestream holds an old snapshot).
func (r *Repo) CheckpointTruncate(ctx context.Context) error {
	var busy, logFrames, checkpointed int
	if err := r.db.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed); err != nil {
		return err
	}
	if busy != 0 {
		return fmt.Errorf("wal checkpoint busy (log=%d checkpointed=%d)", logFrames, checkpointed)
	}
	return nil
}

// DeleteMCPRemote removes accountID's hosted-remote enablement (Disconnect).
func (r *Repo) DeleteMCPRemote(ctx context.Context, accountID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM mcp_remote WHERE account_id = ?`, accountID)
	return err
}

// ListMCPRemote returns every persisted enablement — used at startup to
// rebuild the runtime hosted-shim registry (the relay's pairing table is
// in-memory, so every enablement needs re-registering after a restart).
func (r *Repo) ListMCPRemote(ctx context.Context) ([]MCPRemote, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT account_id, token, token_ct, token_nonce, relay_url, pairing_id, pairing_key, pairing_key_ct, pairing_key_nonce, created_at_unix FROM mcp_remote`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MCPRemote
	for rows.Next() {
		var (
			m           MCPRemote
			createdUnix int64
		)
		if err := rows.Scan(&m.AccountID, &m.Token, &m.TokenCT, &m.TokenNonce, &m.RelayURL, &m.PairingID, &m.PairingKey, &m.PairingKeyCT, &m.PairingKeyNonce, &createdUnix); err != nil {
			return nil, err
		}
		m.CreatedAt = storedb.UnixToTime(createdUnix)
		out = append(out, m)
	}
	return out, rows.Err()
}
