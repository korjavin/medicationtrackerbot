-- +goose Up
-- +goose StatementBegin
-- Explicit credential mode for the local-only passkey POC (med-eas.2.1, see
-- docs/2026-07-13-cloud-prf-compatibility-research.md): 'prf' credentials wrap
-- the DEK in a PRF-derived envelope; 'local_only' credentials authenticate API
-- access only and never hold an envelope — the device-local LDK wraps the DEK
-- instead. This column is a type label only: it carries no key share, no
-- decrypting material, and no low-entropy verifier (R5 unchanged). Existing
-- rows default to 'prf', preserving the current production promise.
ALTER TABLE credentials ADD COLUMN mode TEXT NOT NULL DEFAULT 'prf';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE credentials DROP COLUMN mode;
-- +goose StatementEnd
