-- +goose Up
-- +goose StatementBegin
-- bd med-ta2n.19: local-mode installs post feedback through the attested
-- POST /api/attest/feedback and are stored as account_id = 'attest:' || key_id,
-- with no accounts row, so feedback_queue.account_id drops its FOREIGN KEY.
-- SQLite cannot drop a constraint in place: recreate, copy, swap. NOT NULL,
-- UNIQUE(account_id, client_id) and the drain index are kept; every existing
-- row and its id are copied unchanged. Account deletion never relied on the
-- cascade: DeleteAccountByID deletes feedback_queue rows explicitly
-- (accountKeyedTables).
CREATE TABLE feedback_queue_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT    NOT NULL,
    client_id       TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT '',
    app_version     TEXT    NOT NULL DEFAULT '',
    ciphertext      BLOB    NOT NULL,
    created_at_unix INTEGER NOT NULL,
    UNIQUE(account_id, client_id)
);
INSERT INTO feedback_queue_new (id, account_id, client_id, kind, app_version, ciphertext, created_at_unix)
    SELECT id, account_id, client_id, kind, app_version, ciphertext, created_at_unix FROM feedback_queue;
-- Keep the AUTOINCREMENT high-water mark: drained (deleted) ids are never
-- reissued, same as before the swap.
DELETE FROM sqlite_sequence WHERE name = 'feedback_queue_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'feedback_queue_new', seq FROM sqlite_sequence WHERE name = 'feedback_queue';
DROP TABLE feedback_queue;
ALTER TABLE feedback_queue_new RENAME TO feedback_queue;
CREATE INDEX idx_feedback_queue_created ON feedback_queue(created_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Restores the FK. Install ('attest:…') rows have no accounts row and cannot
-- satisfy it, so a rollback drops them (undrained local-mode feedback is lost).
CREATE TABLE feedback_queue_old (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    client_id       TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT '',
    app_version     TEXT    NOT NULL DEFAULT '',
    ciphertext      BLOB    NOT NULL,
    created_at_unix INTEGER NOT NULL,
    UNIQUE(account_id, client_id)
);
INSERT INTO feedback_queue_old (id, account_id, client_id, kind, app_version, ciphertext, created_at_unix)
    SELECT id, account_id, client_id, kind, app_version, ciphertext, created_at_unix FROM feedback_queue
    WHERE account_id IN (SELECT id FROM accounts);
DELETE FROM sqlite_sequence WHERE name = 'feedback_queue_old';
INSERT INTO sqlite_sequence (name, seq) SELECT 'feedback_queue_old', seq FROM sqlite_sequence WHERE name = 'feedback_queue';
DROP TABLE feedback_queue;
ALTER TABLE feedback_queue_old RENAME TO feedback_queue;
CREATE INDEX idx_feedback_queue_created ON feedback_queue(created_at_unix);
-- +goose StatementEnd
