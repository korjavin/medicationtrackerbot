-- +goose Up
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS tz_transition_plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    old_tz      TEXT NOT NULL,
    new_tz      TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status      TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    steps_json  TEXT NOT NULL DEFAULT '[]',
    inputs_json TEXT NOT NULL DEFAULT '{}',
    plan_hash   TEXT NOT NULL DEFAULT '',
    approved_at DATETIME,
    user_action TEXT
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS tz_transition_plans;
-- +goose StatementEnd
