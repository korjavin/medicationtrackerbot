-- +goose Up
-- +goose StatementBegin
-- Seal mcp_remote.token at rest, like 017 sealed pairing_key: AES-GCM under an
-- HKDF key derived from SESSION_SECRET (own info label). Sealed, not hashed,
-- because GET /api/mcp/remote hands the connector URL back to the account
-- holder after a restart, so the server must be able to recover the token.
-- SQL cannot run the AES-GCM, so existing plaintext rows are converted once at
-- startup in MCPRemoteAPI.Restore. The legacy token column stays (NOT NULL):
-- converted and new rows hold a random "sealed:<hex>" placeholder there, never
-- the real token and never empty, so an older binary reading the row can't
-- match an empty or guessable token.
ALTER TABLE mcp_remote ADD COLUMN token_ct BLOB;
ALTER TABLE mcp_remote ADD COLUMN token_nonce BLOB;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- WARNING: after the startup conversion the real token lives ONLY in token_ct.
-- Dropping it makes every hosted MCP connector unrecoverable (the token column
-- holds a random placeholder): every user must disconnect and re-enable.
-- Same trade-off as 017's Down for pairing keys.
ALTER TABLE mcp_remote DROP COLUMN token_nonce;
ALTER TABLE mcp_remote DROP COLUMN token_ct;
-- +goose StatementEnd
