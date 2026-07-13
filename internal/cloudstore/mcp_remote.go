package cloudstore

import (
	"context"
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
	Token     string
	RelayURL  string
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

// UpsertMCPRemote inserts or replaces accountID's hosted-remote enablement.
// Re-enable (a fresh POST /api/mcp/remote) rotates every field, including the
// token — the only events that change it, per the plan, are this and delete.
// The pairing key is stored sealed (pairingKeyCT/pairingKeyNonce); the legacy
// plaintext pairing_key column is written empty so no plaintext key ever lands
// at rest.
func (r *Repo) UpsertMCPRemote(ctx context.Context, accountID, token, relayURL, pairingID string, pairingKeyCT, pairingKeyNonce []byte, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO mcp_remote (account_id, token, relay_url, pairing_id, pairing_key, pairing_key_ct, pairing_key_nonce, created_at_unix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, relay_url = excluded.relay_url, pairing_id = excluded.pairing_id, pairing_key = excluded.pairing_key, pairing_key_ct = excluded.pairing_key_ct, pairing_key_nonce = excluded.pairing_key_nonce, created_at_unix = excluded.created_at_unix`,
		accountID, token, relayURL, pairingID, []byte{}, pairingKeyCT, pairingKeyNonce, storedb.TimeToUnix(now))
	return err
}

// ResealMCPRemotePairingKey writes the sealed pairing key for accountID and
// clears the legacy plaintext pairing_key column, used by the one-time startup
// reseal of pre-migration rows. Idempotent: re-running against an already-sealed
// row just rewrites the same sealed bytes and an already-empty plaintext blob.
func (r *Repo) ResealMCPRemotePairingKey(ctx context.Context, accountID string, pairingKeyCT, pairingKeyNonce []byte) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE mcp_remote SET pairing_key_ct = ?, pairing_key_nonce = ?, pairing_key = ? WHERE account_id = ?`,
		pairingKeyCT, pairingKeyNonce, []byte{}, accountID)
	return err
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
	rows, err := r.db.QueryContext(ctx, `SELECT account_id, token, relay_url, pairing_id, pairing_key, pairing_key_ct, pairing_key_nonce, created_at_unix FROM mcp_remote`)
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
		if err := rows.Scan(&m.AccountID, &m.Token, &m.RelayURL, &m.PairingID, &m.PairingKey, &m.PairingKeyCT, &m.PairingKeyNonce, &createdUnix); err != nil {
			return nil, err
		}
		m.CreatedAt = storedb.UnixToTime(createdUnix)
		out = append(out, m)
	}
	return out, rows.Err()
}
