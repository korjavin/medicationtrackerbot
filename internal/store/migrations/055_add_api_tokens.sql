-- +goose Up
CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME
);

CREATE INDEX idx_api_tokens_token_hash ON api_tokens(token_hash);

-- +goose Down
DROP INDEX IF EXISTS idx_api_tokens_token_hash;
DROP TABLE IF EXISTS api_tokens;
