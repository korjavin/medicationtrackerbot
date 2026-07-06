-- +goose Up
-- +goose StatementBegin
CREATE TABLE mcp_remote (
    account_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    pairing_id TEXT NOT NULL,
    pairing_key BLOB NOT NULL,
    created_at_unix INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_mcp_remote_token ON mcp_remote(token);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE mcp_remote;
-- +goose StatementEnd
