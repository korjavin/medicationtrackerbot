package cloudstore

import (
	"context"
	"database/sql"
	"errors"
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
	AccountID  string
	Token      string
	RelayURL   string
	PairingID  string
	PairingKey []byte
	CreatedAt  time.Time
}

// UpsertMCPRemote inserts or replaces accountID's hosted-remote enablement.
// Re-enable (a fresh POST /api/mcp/remote) rotates every field, including the
// token — the only events that change it, per the plan, are this and delete.
func (r *Repo) UpsertMCPRemote(ctx context.Context, accountID, token, relayURL, pairingID string, pairingKey []byte, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO mcp_remote (account_id, token, relay_url, pairing_id, pairing_key, created_at_unix) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET token = excluded.token, relay_url = excluded.relay_url, pairing_id = excluded.pairing_id, pairing_key = excluded.pairing_key, created_at_unix = excluded.created_at_unix`,
		accountID, token, relayURL, pairingID, pairingKey, storedb.TimeToUnix(now))
	return err
}

// GetMCPRemote returns accountID's hosted-remote enablement, or nil if it has
// none.
func (r *Repo) GetMCPRemote(ctx context.Context, accountID string) (*MCPRemote, error) {
	m := MCPRemote{AccountID: accountID}
	var createdUnix int64
	err := r.db.QueryRowContext(ctx,
		`SELECT token, relay_url, pairing_id, pairing_key, created_at_unix FROM mcp_remote WHERE account_id = ?`,
		accountID).Scan(&m.Token, &m.RelayURL, &m.PairingID, &m.PairingKey, &createdUnix)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	m.CreatedAt = storedb.UnixToTime(createdUnix)
	return &m, nil
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
	rows, err := r.db.QueryContext(ctx, `SELECT account_id, token, relay_url, pairing_id, pairing_key, created_at_unix FROM mcp_remote`)
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
		if err := rows.Scan(&m.AccountID, &m.Token, &m.RelayURL, &m.PairingID, &m.PairingKey, &createdUnix); err != nil {
			return nil, err
		}
		m.CreatedAt = storedb.UnixToTime(createdUnix)
		out = append(out, m)
	}
	return out, rows.Err()
}
