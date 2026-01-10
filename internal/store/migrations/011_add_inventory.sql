-- +goose Up
-- Inventory tracking for medications

-- Add inventory columns to medications table
-- NULL inventory_count means medication is not being tracked for inventory
ALTER TABLE medications ADD COLUMN inventory_count INTEGER DEFAULT NULL;

-- Create restock history table
CREATE TABLE IF NOT EXISTS medication_restocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medication_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    note TEXT,
    restocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(medication_id) REFERENCES medications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_medication_restocks_med_id ON medication_restocks(medication_id);

-- +goose Down
DROP INDEX IF EXISTS idx_medication_restocks_med_id;
DROP TABLE IF EXISTS medication_restocks;

-- SQLite doesn't support DROP COLUMN directly, but goose down is rarely used in practice
