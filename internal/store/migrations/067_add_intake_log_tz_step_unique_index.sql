-- +goose Up
-- Track D Task 10: make pre-materialized tz_step row inserts idempotent.
--
-- The atomic ApproveAndMaterialize path and the Task 10 backfill migration
-- both write `intake_log` rows with source='tz_step'. A retried approve
-- (operator clicks twice, server crash between insert and tx commit, etc.)
-- and the backfill running alongside a freshly approved plan must not
-- duplicate the per-step row. The unique index lets both paths use
-- INSERT OR IGNORE against (tz_plan_id, tz_step_number).
--
-- Partial WHERE-clause: source='schedule' rows always have tz_plan_id NULL,
-- so the index covers only the materialized step rows and never blocks a
-- normal intake.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_log_tz_plan_step_unique
    ON intake_log(tz_plan_id, tz_step_number)
    WHERE tz_plan_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_intake_log_tz_plan_step_unique;
