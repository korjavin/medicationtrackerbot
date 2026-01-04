-- +goose Up
ALTER TABLE medications ADD COLUMN start_date DATETIME;
ALTER TABLE medications ADD COLUMN end_date DATETIME;

-- +goose Down
ALTER TABLE medications DROP COLUMN start_date;
ALTER TABLE medications DROP COLUMN end_date;
