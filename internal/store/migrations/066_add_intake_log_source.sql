-- +goose Up
-- Open the slot on intake_log for Track D's pre-materialized transition steps.
-- See docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md
-- Task 9. The materialize path arrives in Task 10 — until then, source is
-- always 'schedule' in practice and tz_plan_id/tz_step_number stay NULL.
--
-- The tz_plan_id ON DELETE SET NULL clause documents intent only. This
-- project runs with PRAGMA foreign_keys=OFF on the modernc.org/sqlite
-- connection (see the comment in internal/store/miband_workouts.go). With
-- FKs off, deleting a plan row leaves dangling tz_plan_id values; there is
-- no plan GC code today so this is not an active risk. The follow-up
-- lifecycle plan is responsible for either (a) turning FKs on globally or
-- (b) doing an explicit UPDATE intake_log SET tz_plan_id = NULL WHERE
-- tz_plan_id = ? in the deletion path.
ALTER TABLE intake_log ADD COLUMN source TEXT NOT NULL DEFAULT 'schedule';
ALTER TABLE intake_log ADD COLUMN tz_plan_id INTEGER REFERENCES tz_transition_plans(id) ON DELETE SET NULL;
ALTER TABLE intake_log ADD COLUMN tz_step_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_intake_log_tz_plan_id ON intake_log(tz_plan_id);

-- +goose Down
DROP INDEX IF EXISTS idx_intake_log_tz_plan_id;
ALTER TABLE intake_log DROP COLUMN tz_step_number;
ALTER TABLE intake_log DROP COLUMN tz_plan_id;
ALTER TABLE intake_log DROP COLUMN source;
