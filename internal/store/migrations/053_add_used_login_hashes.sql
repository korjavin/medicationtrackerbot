-- +goose Up
CREATE TABLE IF NOT EXISTS used_login_hashes (
    hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE INDEX idx_used_login_hashes_expires ON used_login_hashes(expires_at);

-- +goose Down
DROP TABLE IF EXISTS used_login_hashes;
