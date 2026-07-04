-- +goose Up
-- +goose StatementBegin
CREATE TABLE transfer_slots (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    enrollment_token_hash BLOB NOT NULL,
    ct BLOB NOT NULL,
    created_at_unix INTEGER NOT NULL,
    expires_at_unix INTEGER NOT NULL,
    fetched INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_transfer_slots_account_id ON transfer_slots(account_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE transfer_slots;
-- +goose StatementEnd
