-- +goose Up
ALTER TABLE settings ADD COLUMN health_enabled BOOLEAN DEFAULT 1;

-- +goose Down
-- SQLite does not support DROP COLUMN until version 3.35.0+, so we rely on table recreation if strictly needed.
-- But since it's just a boolean flag, leaving it as a no-op or just ignoring it for downgrade is safest.
-- If someone really wants to down-migrate, they can recreate the table.
