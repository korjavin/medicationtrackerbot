-- +goose Up
-- Track whether the user has been through the first-run flow. The default
-- (1) opts every existing settings row out — server installs with an
-- already-active user must never see the firstrun overlay. The mobile
-- bootstrap separately gates on user-row existence to detect a fresh install,
-- so the flag is a defensive secondary signal rather than the sole trigger.
-- Picking the default at ADD COLUMN time avoids a follow-up UPDATE statement
-- that would otherwise fire the trg_change_settings_upd trigger and emit a
-- spurious change_events row on every fresh migration run.
ALTER TABLE settings ADD COLUMN first_run_complete INTEGER NOT NULL DEFAULT 1;

-- +goose Down
ALTER TABLE settings DROP COLUMN first_run_complete;
