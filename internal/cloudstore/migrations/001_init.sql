-- +goose Up
-- +goose StatementBegin
CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    subdomain TEXT UNIQUE NOT NULL,
    created_at_unix INTEGER NOT NULL,
    claim_token_hash BLOB,
    claim_expires_unix INTEGER,
    loss_ack_unix INTEGER
);

CREATE TABLE credentials (
    id BLOB PRIMARY KEY,
    account_id TEXT NOT NULL,
    public_key BLOB NOT NULL,
    transports TEXT,
    sign_count INTEGER,
    created_at_unix INTEGER NOT NULL,
    last_asserted_at_unix INTEGER
);

CREATE INDEX idx_credentials_account_id ON credentials(account_id);

CREATE TABLE envelopes (
    account_id TEXT NOT NULL,
    credential_ref TEXT NOT NULL,
    v INTEGER NOT NULL,
    nonce BLOB NOT NULL,
    ct BLOB NOT NULL,
    mac BLOB,
    PRIMARY KEY (account_id, credential_ref)
);

CREATE TABLE recovery_auth (
    account_id TEXT PRIMARY KEY,
    verifier_hash BLOB NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    window_start_unix INTEGER
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE recovery_auth;
DROP TABLE envelopes;
DROP TABLE credentials;
DROP TABLE accounts;
-- +goose StatementEnd
