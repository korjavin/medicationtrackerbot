-- +goose Up
CREATE TABLE exercise_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    default_sets INTEGER,
    default_reps_min INTEGER,
    default_reps_max INTEGER,
    default_weight_kg DECIMAL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_exercise_library_user_name ON exercise_library(user_id, name);

-- Populate from existing unique exercises
INSERT INTO exercise_library (user_id, name, default_sets, default_reps_min, default_reps_max, default_weight_kg)
SELECT wg.user_id, we.exercise_name, we.target_sets, we.target_reps_min, we.target_reps_max, we.target_weight_kg
FROM workout_exercises we
JOIN workout_variants wv ON we.variant_id = wv.id
JOIN workout_groups wg ON wv.group_id = wg.id
WHERE we.id IN (
    SELECT MAX(we2.id)
    FROM workout_exercises we2
    JOIN workout_variants wv2 ON we2.variant_id = wv2.id
    JOIN workout_groups wg2 ON wv2.group_id = wg2.id
    GROUP BY wg2.user_id, we2.exercise_name
);

-- Change event triggers
CREATE TRIGGER exercise_library_insert AFTER INSERT ON exercise_library
BEGIN INSERT INTO change_events(user_id, tag) VALUES (NEW.user_id, 'exercise_library'); END;

CREATE TRIGGER exercise_library_update AFTER UPDATE ON exercise_library
BEGIN INSERT INTO change_events(user_id, tag) VALUES (NEW.user_id, 'exercise_library'); END;

CREATE TRIGGER exercise_library_delete AFTER DELETE ON exercise_library
BEGIN INSERT INTO change_events(user_id, tag) VALUES (OLD.user_id, 'exercise_library'); END;

-- +goose Down
DROP TRIGGER IF EXISTS exercise_library_delete;
DROP TRIGGER IF EXISTS exercise_library_update;
DROP TRIGGER IF EXISTS exercise_library_insert;
DROP INDEX IF EXISTS idx_exercise_library_user_name;
DROP TABLE IF EXISTS exercise_library;
