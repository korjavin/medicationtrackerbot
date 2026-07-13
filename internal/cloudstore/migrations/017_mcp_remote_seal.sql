-- +goose Up
-- +goose StatementBegin
-- Seal mcp_remote.pairing_key at rest, mirroring tg_bots' token_ct/token_nonce
-- (009_telegram.sql): the pairing key is sealed under the same HKDF-derived
-- AES-GCM key. This migration only adds the columns — SQL cannot run the
-- HKDF/AES-GCM, so the read-encrypt-write reseal of existing plaintext rows
-- happens once at startup in MCPRemoteAPI.Restore, which also zeroes the legacy
-- pairing_key blob after sealing. New rows never write plaintext (Upsert stores
-- an empty pairing_key). The legacy pairing_key column is kept (still NOT NULL,
-- written empty) rather than dropped, so a partial deploy that hasn't run the
-- startup reseal yet still reads valid rows.
ALTER TABLE mcp_remote ADD COLUMN pairing_key_ct BLOB;
ALTER TABLE mcp_remote ADD COLUMN pairing_key_nonce BLOB;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE mcp_remote DROP COLUMN pairing_key_nonce;
ALTER TABLE mcp_remote DROP COLUMN pairing_key_ct;
-- +goose StatementEnd
