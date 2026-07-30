-- +goose Up
-- +goose StatementBegin
-- POC (bd med-eas.2.1): a credential's key mode is now EXPLICIT, never inferred
-- from whether an envelope row happens to exist. 'prf' is every credential that
-- exists today and every credential the default signup path creates; the POC
-- 'local_only' mode means the credential authenticates to the server but has no
-- server-side envelope at all — its DEK copy lives only in this browser's LDK
-- cache plus the recovery envelope. See docs/cloud-crypto.md "Local-only
-- passkey (POC)".
ALTER TABLE credentials ADD COLUMN key_mode TEXT NOT NULL DEFAULT 'prf';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE credentials DROP COLUMN key_mode;
-- +goose StatementEnd
