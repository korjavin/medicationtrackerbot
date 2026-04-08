-- +goose Up
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS timezone_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timezone TEXT NOT NULL,
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS timezone_history;
-- +goose StatementEnd
