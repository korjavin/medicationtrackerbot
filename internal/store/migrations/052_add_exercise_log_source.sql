-- +goose Up
-- Track whether an exercise log entry came from a scheduled exercise (workout_exercises)
-- or was added from the exercise library. This prevents cross-table ID collisions
-- from corrupting scheduled exercise definitions during weight/reps propagation.
ALTER TABLE workout_exercise_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'schedule';

-- Backfill: logs whose exercise_id does not exist in workout_exercises were added
-- from the exercise library (or reference a deleted scheduled exercise). Mark them
-- as 'library' so the propagation guard correctly skips them.
UPDATE workout_exercise_logs SET source = 'library'
WHERE exercise_id NOT IN (SELECT id FROM workout_exercises);

-- Recreate the unique index to include source, so that a scheduled exercise
-- (workout_exercises.id) and a library exercise (exercise_library.id) with the
-- same numeric ID can coexist in the same session without violating uniqueness.
DROP INDEX IF EXISTS idx_workout_exercise_logs_session_exercise;
CREATE UNIQUE INDEX idx_workout_exercise_logs_session_exercise
    ON workout_exercise_logs(session_id, exercise_id, source)
    WHERE exercise_id > 0;

-- +goose Down
-- Remove library-sourced duplicates that would violate the old unique index.
-- Keep the schedule-sourced row when both exist for the same (session_id, exercise_id).
DELETE FROM workout_exercise_logs
WHERE source = 'library'
  AND exercise_id > 0
  AND EXISTS (
    SELECT 1 FROM workout_exercise_logs AS other
    WHERE other.session_id = workout_exercise_logs.session_id
      AND other.exercise_id = workout_exercise_logs.exercise_id
      AND other.source = 'schedule'
  );
DROP INDEX IF EXISTS idx_workout_exercise_logs_session_exercise;
CREATE UNIQUE INDEX idx_workout_exercise_logs_session_exercise
    ON workout_exercise_logs(session_id, exercise_id)
    WHERE exercise_id > 0;
ALTER TABLE workout_exercise_logs DROP COLUMN source;
