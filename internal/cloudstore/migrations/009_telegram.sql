-- +goose Up
-- +goose StatementBegin
-- One linked Telegram bot per account (managed via the cloud's manager bot, or
-- a BYO token). token_ct/token_nonce hold the bot token sealed at rest under an
-- HKDF-derived AES-GCM key (see internal/cloudserver token seal/open); the
-- plaintext token never lands in a column, log, or API response. chat_id and
-- linked_at_unix stay NULL until the user opens the bot and taps /start.
CREATE TABLE tg_bots (
    account_id TEXT PRIMARY KEY,
    bot_id INTEGER NOT NULL,
    bot_username TEXT NOT NULL,
    token_ct BLOB NOT NULL,
    token_nonce BLOB NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('managed','byo')),
    chat_id INTEGER,
    webhook_secret TEXT NOT NULL,
    created_at_unix INTEGER NOT NULL,
    linked_at_unix INTEGER
);

-- Short-lived pending managed-bot provisioning: the random suffix in
-- suggested_username is the pairing key that ties an incoming managed_bot
-- update back to the account that started the flow. Expired rows are swept
-- opportunistically (TTL 1h).
CREATE TABLE tg_pending (
    suggested_username TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at_unix INTEGER NOT NULL,
    expires_at_unix INTEGER NOT NULL
);

-- Ack flag: the user explicitly skipped Telegram setup, so the stateless
-- wizard step never re-nags (same shape as accounts.loss_ack_unix).
ALTER TABLE accounts ADD COLUMN tg_skipped_unix INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE accounts DROP COLUMN tg_skipped_unix;
DROP TABLE tg_pending;
DROP TABLE tg_bots;
-- +goose StatementEnd
