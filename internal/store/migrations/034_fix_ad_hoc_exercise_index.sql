-- +goose Up
-- This migration fixes the unique index on workout_exercise_logs to allow multiple
-- ad-hoc exercises (exercise_id = 0) per session while still preventing duplicates
-- for predefined exercises (exercise_id > 0).
--
-- Migration 033 created a non-partial unique index that inadvertently blocked
-- multiple ad-hoc custom exercises from being logged in the same session.

-- Drop the old non-partial unique index
DROP INDEX IF EXISTS idx_workout_exercise_logs_session_exercise;

-- Create a partial unique index that only enforces uniqueness for predefined exercises.
-- This allows multiple ad-hoc custom exercises (exercise_id = 0) per session.
CREATE UNIQUE INDEX idx_workout_exercise_logs_session_exercise
    ON workout_exercise_logs(session_id, exercise_id)
    WHERE exercise_id > 0;

-- +goose Down
-- Revert to the old non-partial unique index.
-- NOTE: This will fail if there are multiple ad-hoc exercises (exercise_id = 0)
-- in the same session, which is allowed by the partial index.
-- If rollback is needed, you must first delete or consolidate duplicate ad-hoc
-- exercises, or manually drop the constraint without recreating it.
DROP INDEX IF EXISTS idx_workout_exercise_logs_session_exercise;

-- This will fail if duplicate ad-hoc exercises exist in the same session
-- The database error will indicate which sessions need manual cleanup
CREATE UNIQUE INDEX idx_workout_exercise_logs_session_exercise
    ON workout_exercise_logs(session_id, exercise_id);
