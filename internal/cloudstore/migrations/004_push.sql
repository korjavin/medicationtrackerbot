-- +goose Up
-- +goose StatementBegin
CREATE TABLE push_subscriptions (
    account_id TEXT NOT NULL,
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at_unix INTEGER NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_push_subscriptions_account ON push_subscriptions(account_id);

CREATE TABLE scheduled_pushes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    fire_at_unix INTEGER NOT NULL,
    ct BLOB NOT NULL,
    sent_at_unix INTEGER
);

CREATE INDEX idx_scheduled_pushes_due ON scheduled_pushes(sent_at_unix, fire_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE scheduled_pushes;
DROP TABLE push_subscriptions;
-- +goose StatementEnd
