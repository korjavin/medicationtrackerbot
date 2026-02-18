-- +goose Up
CREATE TABLE IF NOT EXISTS food_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    eaten_at DATETIME NOT NULL,
    weight INTEGER NOT NULL, -- grams
    carbs INTEGER NOT NULL, -- total grams
    protein INTEGER NOT NULL, -- total grams
    fat INTEGER NOT NULL, -- total grams
    calories INTEGER NOT NULL, -- total kcal
    name TEXT
);

CREATE INDEX IF NOT EXISTS idx_food_log_user_date ON food_log(user_id, eaten_at);

ALTER TABLE settings ADD COLUMN food_intake_enabled BOOLEAN DEFAULT 0;

-- +goose Down
ALTER TABLE settings DROP COLUMN food_intake_enabled;
DROP TABLE food_log;
