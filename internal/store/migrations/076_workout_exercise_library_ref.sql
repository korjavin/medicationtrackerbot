-- +goose Up
-- Add a reference from each plan exercise to its exercise_library row so the
-- library becomes the single source of truth for exercise names. Nullable and
-- additive: exercise_name stays as a denormalized cache; reads COALESCE the
-- library name over it (see workout/repo.go).
ALTER TABLE workout_exercises ADD COLUMN exercise_library_id INTEGER REFERENCES exercise_library(id);

-- Legacy library rows (migration 028 and the pre-trim write path) stored the
-- untrimmed exercise_name, e.g. " Bench ". The trimmed INSERT below would not
-- conflict with such a row and would mint a duplicate "Bench" beside it,
-- orphaning the original. Fold untrimmed rows into their trimmed form first —
-- keep the lowest id per (user_id, trimmed name), drop the rest, then trim the
-- survivors — so the backfill links to one canonical row. The FK column was just
-- added (all NULL), so no plan exercise references these rows yet. Idempotent:
-- an already-trimmed library leaves every row as its own group min and no-ops.
DELETE FROM exercise_library
WHERE id NOT IN (
    SELECT MIN(id) FROM exercise_library
    GROUP BY user_id, TRIM(name, char(9,10,11,12,13,32))
);
UPDATE exercise_library
SET name = TRIM(name, char(9,10,11,12,13,32))
WHERE name <> TRIM(name, char(9,10,11,12,13,32));

-- Ensure a library row exists for every owner+name currently in plans. Trim the
-- name and skip blank/whitespace-only rows so this matches the runtime write
-- path (CreateExerciseInVariant trims) and the cloud backfill (cloud-boot.js
-- filters blanks and its JS writers trim) — otherwise a legacy " Bench " row
-- would seed a padded library entry in server mode but a "Bench" one in cloud.
-- Bare SQLite TRIM() strips only U+0020, but Go strings.TrimSpace and JS .trim()
-- also strip tab/newline/CR/VT/FF, so pass the full ASCII-whitespace char set
-- (char(9,10,11,12,13,32)) to keep a legacy "\tBench\t" row in parity too.
INSERT INTO exercise_library (user_id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg)
SELECT wg.user_id, TRIM(we.exercise_name, char(9,10,11,12,13,32)), we.target_sets, we.target_reps_min, we.target_reps_max, we.target_weight_kg
FROM workout_exercises we
JOIN workout_variants wv ON we.variant_id = wv.id
JOIN workout_groups wg ON wv.group_id = wg.id
WHERE TRIM(we.exercise_name, char(9,10,11,12,13,32)) <> ''
ON CONFLICT(user_id, name) DO NOTHING;

-- Backfill the FK by resolving owner (variant -> group.user_id) + trimmed name.
-- Blank-name rows keep a null FK (reads fall back to the cached exercise_name),
-- mirroring cloud where blanks are left unlinked.
UPDATE workout_exercises
SET exercise_library_id = (
    SELECT el.id
    FROM exercise_library el
    JOIN workout_variants wv ON wv.id = workout_exercises.variant_id
    JOIN workout_groups wg ON wg.id = wv.group_id
    WHERE el.user_id = wg.user_id AND el.name = TRIM(workout_exercises.exercise_name, char(9,10,11,12,13,32))
)
WHERE TRIM(exercise_name, char(9,10,11,12,13,32)) <> '';

-- +goose Down
ALTER TABLE workout_exercises DROP COLUMN exercise_library_id;
