-- +goose Up
-- Add INTEGER unix-seconds-UTC `expires_at` column to api_tokens. NULL = no
-- expiry (legacy long-lived tokens). Non-NULL = unix seconds at which the
-- OAuth middleware must reject the token.
--
-- INTEGER (not DATETIME) per the dose-time-columns convention in
-- internal/store/store.go: the OAuth middleware compares this column to the
-- current unix timestamp via SQL equality/inequality, so storing it as
-- INTEGER avoids the TZ-name round-trip bug class.
ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_api_tokens_expires_at ON api_tokens(expires_at);

-- +goose Down
DROP INDEX IF EXISTS idx_api_tokens_expires_at;
ALTER TABLE api_tokens DROP COLUMN expires_at;
