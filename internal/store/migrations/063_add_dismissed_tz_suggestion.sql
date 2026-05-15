-- +goose Up
ALTER TABLE settings ADD COLUMN dismissed_tz_suggestion TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE settings DROP COLUMN dismissed_tz_suggestion;
