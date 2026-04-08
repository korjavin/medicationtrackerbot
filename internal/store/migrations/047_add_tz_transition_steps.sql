-- +goose Up
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS tz_transition_steps (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id       INTEGER NOT NULL REFERENCES tz_transition_plans(id),
    medication_id INTEGER NOT NULL,
    step_number   INTEGER NOT NULL,
    scheduled_at  DATETIME NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    consumed_at   DATETIME
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS tz_transition_steps;
-- +goose StatementEnd
