-- +goose Up
CREATE TABLE IF NOT EXISTS food_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    barcode TEXT,
    carbs_100g REAL NOT NULL,
    protein_100g REAL NOT NULL,
    fat_100g REAL NOT NULL,
    energy_kcal_100g REAL NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_food_products_user ON food_products(user_id);
CREATE INDEX IF NOT EXISTS idx_food_products_usage ON food_products(user_id, usage_count DESC, last_used_at DESC);
