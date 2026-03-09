-- +goose Up
ALTER TABLE food_products ADD COLUMN is_meal BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE food_products ADD COLUMN total_weight_g INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE food_products DROP COLUMN is_meal;
ALTER TABLE food_products DROP COLUMN total_weight_g;
