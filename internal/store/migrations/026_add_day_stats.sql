-- +goose Up
CREATE TABLE day_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    steps INTEGER NOT NULL DEFAULT 0,
    calories INTEGER NOT NULL DEFAULT 0,
    distance INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, day)
);

CREATE INDEX idx_day_stats_user_date ON day_stats(user_id, day);

-- +goose Down
DROP TABLE IF EXISTS day_stats;
