-- +goose Up
-- +goose StatementBegin
-- Blind feedback queue (bd med-dni.1). `ciphertext` is a client-age-encrypted
-- blob the server never has the key for — same zero-knowledge posture as
-- inbox_events above. The only content column is ciphertext; `kind` and
-- `app_version` are non-PII routing/diagnostic metadata.
--
-- client_id is a client-generated per-submission id: the reliable-retry submit
-- client (med-dni.3) POSTs the same item until it sees a 2xx, and
-- ON CONFLICT(account_id, client_id) DO NOTHING makes those retries free of
-- duplicates. The uniqueness is scoped PER ACCOUNT — a global UNIQUE(client_id)
-- would let one account's client_id silently drop another account's submission
-- (accepted-but-never-stored data loss / suppression) since retries return 204.
--
-- created_at_unix is the SERVER's receive timestamp, used only to drain
-- oldest-first (med-dni.4 CLI).
CREATE TABLE feedback_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client_id       TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT '',
    app_version     TEXT    NOT NULL DEFAULT '',
    ciphertext      BLOB    NOT NULL,
    created_at_unix INTEGER NOT NULL,
    UNIQUE(account_id, client_id)
);
-- +goose StatementEnd

-- +goose StatementBegin
-- The drain reads the whole queue oldest-first.
CREATE INDEX idx_feedback_queue_created ON feedback_queue(created_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_feedback_queue_created;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE feedback_queue;
-- +goose StatementEnd
