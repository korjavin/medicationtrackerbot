-- +goose Up
-- Code review of Track D pre-materialization: migration 067 created the
-- partial unique index over (tz_plan_id, tz_step_number), but the planner
-- (tzreschedule.GeneratePlan in internal/domain/tzreschedule/engine.go)
-- numbers steps per-medication starting at 1. A plan that touches N
-- medications produces step pairs (1,1)..(1,K) for the first med, (1,1)..(1,K)
-- for the second med, etc — duplicates on (tz_plan_id, tz_step_number).
--
-- Materialize (INSERT OR IGNORE in MaterializePlanStepsAsIntakesTx) and the
-- one-shot backfill (068) would then silently drop every step beyond the
-- first medication's, leaving doses unfired with no error surfaced to the
-- operator. Recreate the index with medication_id included so each med has
-- its own step-number namespace inside a plan.
DROP INDEX IF EXISTS idx_intake_log_tz_plan_step_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_log_tz_plan_step_unique
    ON intake_log(tz_plan_id, medication_id, tz_step_number)
    WHERE tz_plan_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_intake_log_tz_plan_step_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_log_tz_plan_step_unique
    ON intake_log(tz_plan_id, tz_step_number)
    WHERE tz_plan_id IS NOT NULL;
