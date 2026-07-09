-- +goose Up
-- +goose StatementBegin
-- The account's X25519 inbox PUBLIC key (raw, 32 bytes). Unlike vapid_private_key
-- above, there is deliberately no matching private column: the private half is a
-- vault record that never leaves an unlocked client, so the server can seal to
-- this key but can never open what it sealed.
--
-- NULL until a client publishes one (PUT /api/inbox/key on first unlock). While
-- NULL, inbound Telegram events cannot be sealed and are dropped rather than
-- stored in the clear.
ALTER TABLE accounts ADD COLUMN inbox_public_key BLOB;
-- +goose StatementEnd

-- +goose StatementBegin
-- Sealed inbound mailbox. `ct` is an mt/v1/inbox sealed box (see
-- internal/cloudserver/sealedbox.go) the server appends and cannot read.
--
-- created_at_unix is the SERVER's timestamp for the event, duplicated in the
-- clear so the drain can order events without decrypting them, and sealed
-- inside `ct` so the client can trust it: a Confirm tapped at 09:00 records a
-- taken-at of 09:00 even if the app is not opened until noon.
CREATE TABLE inbox_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at_unix INTEGER NOT NULL,
    ct              BLOB    NOT NULL
);
-- +goose StatementEnd

-- +goose StatementBegin
-- The drain reads one account's queue oldest-first; delete is by (account, id).
CREATE INDEX idx_inbox_events_account ON inbox_events(account_id, id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_inbox_events_account;
-- +goose StatementEnd
-- +goose StatementBegin
DROP TABLE inbox_events;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE accounts DROP COLUMN inbox_public_key;
-- +goose StatementEnd
