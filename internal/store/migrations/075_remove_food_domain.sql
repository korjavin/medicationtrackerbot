-- +goose Up
-- Remove the unused food_domain column from the settings table.

ALTER TABLE settings DROP COLUMN food_domain;

-- +goose Down
ALTER TABLE settings ADD COLUMN food_domain TEXT NOT NULL DEFAULT '';
