-- +goose Up
CREATE TABLE IF NOT EXISTS vitals_heart (
    user_id INTEGER NOT NULL,
    date_time INTEGER NOT NULL,
    tz_offset INTEGER NOT NULL,
    value INTEGER NOT NULL,
    type INTEGER NOT NULL,
    PRIMARY KEY (user_id, date_time)
);

CREATE TABLE IF NOT EXISTS vitals_spo2 (
    user_id INTEGER NOT NULL,
    date_time INTEGER NOT NULL,
    tz_offset INTEGER NOT NULL,
    value INTEGER NOT NULL,
    type INTEGER NOT NULL,
    PRIMARY KEY (user_id, date_time)
);

CREATE TABLE IF NOT EXISTS vitals_stress (
    user_id INTEGER NOT NULL,
    date_time INTEGER NOT NULL,
    tz_offset INTEGER NOT NULL,
    value INTEGER NOT NULL,
    type INTEGER NOT NULL,
    info TEXT,
    PRIMARY KEY (user_id, date_time)
);

-- +goose Down
DROP TABLE IF EXISTS vitals_stress;
DROP TABLE IF EXISTS vitals_spo2;
DROP TABLE IF EXISTS vitals_heart;
