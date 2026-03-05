-- +goose Up
ALTER TABLE medications ADD COLUMN supplement BOOLEAN DEFAULT 0;

-- +goose Down
ALTER TABLE medications DROP COLUMN supplement;
