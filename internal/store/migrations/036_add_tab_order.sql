-- +goose Up
ALTER TABLE settings ADD COLUMN tab_order TEXT DEFAULT NULL;

-- +goose Down
ALTER TABLE settings DROP COLUMN tab_order;