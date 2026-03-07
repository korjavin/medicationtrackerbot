-- +goose Up
-- Remove any duplicate (session_id, exercise_id) rows keeping the latest one,
-- then enforce the constraint so concurrent callbacks cannot insert duplicates.
DELETE FROM workout_exercise_logs
WHERE id NOT IN (
    SELECT MAX(id) FROM workout_exercise_logs GROUP BY session_id, exercise_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workout_exercise_logs_session_exercise
    ON workout_exercise_logs(session_id, exercise_id);

-- +goose Down
DROP INDEX IF EXISTS idx_workout_exercise_logs_session_exercise;
