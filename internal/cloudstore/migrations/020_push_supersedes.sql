-- +goose Up
-- +goose StatementBegin
-- med-eas.79: a relay re-fire should DELETE the prior message in its chain so the
-- chat shows exactly one live reminder per slot/session. supersedes_message_id
-- holds the Telegram message_id the send should delete (0 = nothing to delete).
-- It is a TG artifact the relay already holds — NEVER vault/ct data — so this stays
-- inside the zero-knowledge boundary. DEFAULT 0 covers all pre-existing rows and the
-- untouched ReplaceSchedule/InsertRelayRefire INSERTs.
ALTER TABLE scheduled_pushes ADD COLUMN supersedes_message_id INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE scheduled_pushes DROP COLUMN supersedes_message_id;
-- +goose StatementEnd
