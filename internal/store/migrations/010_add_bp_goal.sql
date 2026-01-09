-- +goose Up
ALTER TABLE settings ADD COLUMN bp_target_systolic INTEGER;
ALTER TABLE settings ADD COLUMN bp_target_diastolic INTEGER;

-- +goose Down
-- SQLite doesn't support DROP COLUMN in older versions
