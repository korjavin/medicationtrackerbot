-- +goose Up
CREATE TABLE IF NOT EXISTS open_food_facts (
    barcode TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    carbs_100g REAL,
    protein_100g REAL,
    fat_100g REAL,
    energy_kcal_100g REAL
);

-- Index for fast searching by name, since barcode is already primary key (indexed)
CREATE INDEX IF NOT EXISTS idx_open_food_facts_name ON open_food_facts(name);
