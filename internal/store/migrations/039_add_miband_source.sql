-- +goose Up
-- +goose StatementBegin
ALTER TABLE miband_workouts ADD COLUMN source TEXT NOT NULL DEFAULT 'device';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- SQLite does not support DROP COLUMN in older versions; migration is intentionally left as no-op for down.
SELECT 1;
-- +goose StatementEnd
