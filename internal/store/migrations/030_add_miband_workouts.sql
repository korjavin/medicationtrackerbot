-- +goose Up
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS miband_workouts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    source_start_ms INTEGER NOT NULL,
    source_end_ms   INTEGER NOT NULL,
    activity_type   INTEGER NOT NULL,
    activity_name   TEXT    NOT NULL,
    duration_sec    INTEGER NOT NULL DEFAULT 0,
    distance_m      REAL    NOT NULL DEFAULT 0,
    steps           INTEGER NOT NULL DEFAULT 0,
    calories        INTEGER NOT NULL DEFAULT 0,
    heart_rate_avg  INTEGER NOT NULL DEFAULT 0,
    spo2_avg        INTEGER NOT NULL DEFAULT 0,
    pause_ms        INTEGER NOT NULL DEFAULT 0,
    tz_offset       INTEGER NOT NULL DEFAULT 0,
    imported_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, source_start_ms)
);

CREATE INDEX IF NOT EXISTS idx_miband_workouts_user_date
    ON miband_workouts(user_id, source_start_ms DESC);

CREATE TABLE IF NOT EXISTS miband_gps_tracks (
    workout_id  INTEGER NOT NULL REFERENCES miband_workouts(id) ON DELETE CASCADE,
    point_index INTEGER NOT NULL,
    ts_ms       INTEGER NOT NULL,
    latitude    REAL    NOT NULL,
    longitude   REAL    NOT NULL,
    altitude    REAL    NOT NULL,
    is_pause    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workout_id, point_index)
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS miband_gps_tracks;
DROP TABLE IF EXISTS miband_workouts;
-- +goose StatementEnd
