-- +goose Up
-- Add a reference from each plan exercise to its exercise_library row so the
-- library becomes the single source of truth for exercise names. Nullable and
-- additive: exercise_name stays as a denormalized cache; reads COALESCE the
-- library name over it (see workout/repo.go).
ALTER TABLE workout_exercises ADD COLUMN exercise_library_id INTEGER REFERENCES exercise_library(id);

-- Ensure a library row exists for every owner+name currently in plans.
INSERT INTO exercise_library (user_id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg)
SELECT wg.user_id, we.exercise_name, we.target_sets, we.target_reps_min, we.target_reps_max, we.target_weight_kg
FROM workout_exercises we
JOIN workout_variants wv ON we.variant_id = wv.id
JOIN workout_groups wg ON wv.group_id = wg.id
WHERE true
ON CONFLICT(user_id, name) DO NOTHING;

-- Backfill the FK by resolving owner (variant -> group.user_id) + name.
UPDATE workout_exercises
SET exercise_library_id = (
    SELECT el.id
    FROM exercise_library el
    JOIN workout_variants wv ON wv.id = workout_exercises.variant_id
    JOIN workout_groups wg ON wg.id = wv.group_id
    WHERE el.user_id = wg.user_id AND el.name = workout_exercises.exercise_name
);

-- +goose Down
ALTER TABLE workout_exercises DROP COLUMN exercise_library_id;
