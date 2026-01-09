-- +goose Up
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_download DATETIME,
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT OR IGNORE INTO settings (id) VALUES (1);

-- +goose Down
DROP TABLE settings;
