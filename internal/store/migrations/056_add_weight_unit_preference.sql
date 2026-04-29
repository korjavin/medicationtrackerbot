-- +goose Up
ALTER TABLE settings ADD COLUMN weight_unit_preference TEXT NOT NULL DEFAULT 'kg' CHECK (weight_unit_preference IN ('kg','lb'));

-- +goose Down
ALTER TABLE settings DROP COLUMN weight_unit_preference;
