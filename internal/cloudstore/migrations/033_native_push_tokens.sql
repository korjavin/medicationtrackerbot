-- +goose Up
-- +goose StatementBegin
-- bd med-erq1.1: APNs (ios) / FCM (android) device tokens per account — the
-- native-shell twin of push_subscriptions. Keyed by (platform, token): a token
-- re-registered by another account moves to it (upsert replaces account_id).
-- disabled is set by the sender on an invalid-token reply, so a later
-- re-registration upserts cleanly.
CREATE TABLE native_push_tokens (
    account_id      TEXT    NOT NULL,
    platform        TEXT    NOT NULL CHECK (platform IN ('ios', 'android')),
    token           TEXT    NOT NULL,
    created_at_unix INTEGER NOT NULL,
    last_seen_unix  INTEGER NOT NULL,
    disabled        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (platform, token)
);
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_native_push_tokens_account ON native_push_tokens(account_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE native_push_tokens;
-- +goose StatementEnd
