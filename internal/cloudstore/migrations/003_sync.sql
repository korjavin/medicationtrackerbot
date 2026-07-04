-- +goose Up
-- +goose StatementBegin
CREATE TABLE oplog (
    account_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    device_credential_id BLOB,
    record_type_tag TEXT NOT NULL,
    nonce BLOB NOT NULL,
    ct BLOB NOT NULL,
    created_at_unix INTEGER NOT NULL,
    PRIMARY KEY (account_id, seq)
);

CREATE TABLE snapshots (
    account_id TEXT PRIMARY KEY,
    snapshot_seq INTEGER NOT NULL,
    nonce BLOB NOT NULL,
    ct BLOB NOT NULL,
    created_at_unix INTEGER NOT NULL
);

CREATE TABLE sync_state (
    account_id TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_sync_unix INTEGER
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE sync_state;
DROP TABLE snapshots;
DROP TABLE oplog;
-- +goose StatementEnd
