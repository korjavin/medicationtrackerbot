-- +goose Up
-- +goose StatementBegin
ALTER TABLE medications ADD COLUMN tz_shift_policy TEXT NOT NULL DEFAULT 'flexible';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- SQLite does not support DROP COLUMN in older versions; mark as no-op.
SELECT 1;
-- +goose StatementEnd
