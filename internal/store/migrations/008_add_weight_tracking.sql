-- +goose Up
-- +goose StatementBegin

CREATE TABLE IF NOT EXISTS weight_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    measured_at DATETIME NOT NULL,
    weight REAL NOT NULL,
    weight_trend REAL,
    body_fat REAL,
    body_fat_trend REAL,
    muscle_mass REAL,
    muscle_mass_trend REAL,
    notes TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_weight_measured_at ON weight_logs(measured_at);
CREATE INDEX IF NOT EXISTS idx_weight_user_id ON weight_logs(user_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP INDEX IF EXISTS idx_weight_user_id;
DROP INDEX IF EXISTS idx_weight_measured_at;
DROP TABLE IF EXISTS weight_logs;

-- +goose StatementEnd
