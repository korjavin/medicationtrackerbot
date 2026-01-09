-- +goose Up
ALTER TABLE settings ADD COLUMN weight_goal REAL;
ALTER TABLE settings ADD COLUMN weight_goal_date TEXT;

-- +goose Down
-- SQLite doesn't support DROP COLUMN in older versions, leaving as is
