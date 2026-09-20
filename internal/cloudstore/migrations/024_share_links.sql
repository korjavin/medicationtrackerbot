-- +goose Up
-- +goose StatementBegin
-- med-1yi5: blind workout-share short links. The server stores only
-- client-encrypted ciphertext (AES-GCM under a key that never reaches the
-- server) keyed by a short capability id; reads are unauthenticated.
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  ct BLOB NOT NULL,
  created_at_unix INTEGER NOT NULL,
  expires_at_unix INTEGER NOT NULL
);
CREATE INDEX idx_share_links_account_id ON share_links (account_id);
CREATE INDEX idx_share_links_expires ON share_links (expires_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE share_links;
-- +goose StatementEnd
