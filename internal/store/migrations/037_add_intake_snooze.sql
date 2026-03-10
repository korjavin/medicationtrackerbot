-- +goose Up
ALTER TABLE intake_log ADD COLUMN snoozed_until DATETIME;

-- +goose Down
ALTER TABLE intake_log DROP COLUMN snoozed_until;
