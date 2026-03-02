-- +goose Up
DELETE FROM food_products;

-- +goose Down
-- cannot restore deleted products
