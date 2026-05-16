-- +goose Up
-- +goose StatementBegin
-- Track D Task 13: pre-materialized step intake_log rows replaced this table.
-- The scheduler reads PENDING source='tz_step' rows from intake_log directly
-- (Task 11), the forecast endpoints union them in (Task 12), and approve-time
-- materialize now reads from tz_transition_plans.steps_json instead of from
-- here.  No code path still queries tz_transition_steps after migration 069.
DROP TABLE IF EXISTS tz_transition_steps;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Forward-only checkpoint. The down step recreates the empty schema so the
-- migration round-trip suite stays green, but it cannot restore row data:
-- pre-Task-13 plans relied on this table for their step lifecycle; post-Task-13
-- those plans live entirely as intake_log rows.  Production rollback past
-- migration 069 must restore the database from a Litestream / snapshot backup
-- rather than running `goose down`.
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
