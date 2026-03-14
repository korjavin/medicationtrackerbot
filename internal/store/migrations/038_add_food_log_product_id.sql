-- +goose Up
ALTER TABLE food_log ADD COLUMN product_id INTEGER REFERENCES food_products(id);
CREATE INDEX IF NOT EXISTS idx_food_log_product_id ON food_log(product_id);

-- +goose Down
DROP INDEX IF EXISTS idx_food_log_product_id;
ALTER TABLE food_log DROP COLUMN product_id;
