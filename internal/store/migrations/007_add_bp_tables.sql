-- +goose Up
-- +goose StatementBegin

CREATE TABLE IF NOT EXISTS blood_pressure_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    measured_at DATETIME NOT NULL,
    systolic INTEGER NOT NULL,
    diastolic INTEGER NOT NULL,
    pulse INTEGER,
    site TEXT,
    position TEXT,
    category TEXT,
    ignore_calc BOOLEAN DEFAULT 0,
    notes TEXT,
    tag TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bp_measured_at ON blood_pressure_readings(measured_at);
CREATE INDEX IF NOT EXISTS idx_bp_user_id ON blood_pressure_readings(user_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP INDEX IF EXISTS idx_bp_user_id;
DROP INDEX IF EXISTS idx_bp_measured_at;
DROP TABLE IF EXISTS blood_pressure_readings;

-- +goose StatementEnd
