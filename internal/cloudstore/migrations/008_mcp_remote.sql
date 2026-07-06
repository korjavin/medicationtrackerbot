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
-- No index on token: it's never looked up by the DB (the endpoint resolves the
-- account first, then compares the token in memory; startup does a full scan).
-- A UNIQUE index would only add a rare cross-account collision 500 with no
-- benefit, since token uniqueness is never required.
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE mcp_remote;
-- +goose StatementEnd
