-- +goose Up
CREATE TABLE IF NOT EXISTS sleep_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    timezone_offset INTEGER NOT NULL,
    day DATE NOT NULL,
    light_minutes INTEGER,
    deep_minutes INTEGER,
    rem_minutes INTEGER,
    awake_minutes INTEGER,
    total_minutes INTEGER,
    turn_over_count INTEGER,
    heart_rate_avg INTEGER,
    spo2_avg INTEGER,
    user_modified BOOLEAN DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, start_time)
);

CREATE INDEX idx_sleep_start_time ON sleep_logs(start_time);
CREATE INDEX idx_sleep_user_id ON sleep_logs(user_id);
CREATE INDEX idx_sleep_day ON sleep_logs(day);

-- +goose Down
DROP INDEX IF EXISTS idx_sleep_day;
DROP INDEX IF EXISTS idx_sleep_user_id;
DROP INDEX IF EXISTS idx_sleep_start_time;
DROP TABLE IF EXISTS sleep_logs;
