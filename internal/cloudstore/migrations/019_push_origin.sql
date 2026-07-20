-- +goose Up
-- +goose StatementBegin
-- med-eas.70: a workout snooze tap makes the blind relay INSERT its own re-fire
-- row so the snooze reminder arrives ~1h/2h later even if the PWA never reopens.
-- `origin` splits row ownership: 'client' rows are the ones ReplaceSchedule
-- wipes-and-replaces on every client re-upload; 'relay_refire' rows are inserted
-- by the relay and MUST survive that wipe (else the next sync erases the pending
-- snooze). The relay copies only already-cleartext fields (tg_text/tg_callback/
-- fire_at) into a refire row — it never reads or produces `ct`.
ALTER TABLE scheduled_pushes ADD COLUMN origin TEXT NOT NULL DEFAULT 'client';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE scheduled_pushes DROP COLUMN origin;
-- +goose StatementEnd
