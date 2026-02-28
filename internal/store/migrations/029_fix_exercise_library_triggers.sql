-- +goose Up
-- Fix triggers that incorrectly referenced non-existent user_id column
DROP TRIGGER IF EXISTS exercise_library_insert;
DROP TRIGGER IF EXISTS exercise_library_update;
DROP TRIGGER IF EXISTS exercise_library_delete;

CREATE TRIGGER exercise_library_insert AFTER INSERT ON exercise_library
BEGIN INSERT INTO change_events(tag) VALUES ('exercise_library'); END;

CREATE TRIGGER exercise_library_update AFTER UPDATE ON exercise_library
BEGIN INSERT INTO change_events(tag) VALUES ('exercise_library'); END;

CREATE TRIGGER exercise_library_delete AFTER DELETE ON exercise_library
BEGIN INSERT INTO change_events(tag) VALUES ('exercise_library'); END;

-- +goose Down
DROP TRIGGER IF EXISTS exercise_library_delete;
DROP TRIGGER IF EXISTS exercise_library_update;
DROP TRIGGER IF EXISTS exercise_library_insert;

CREATE TRIGGER exercise_library_insert AFTER INSERT ON exercise_library
BEGIN INSERT INTO change_events(user_id, tag) VALUES (NEW.user_id, 'exercise_library'); END;

CREATE TRIGGER exercise_library_update AFTER UPDATE ON exercise_library
BEGIN INSERT INTO change_events(user_id, tag) VALUES (NEW.user_id, 'exercise_library'); END;

CREATE TRIGGER exercise_library_delete AFTER DELETE ON exercise_library
BEGIN INSERT INTO change_events(user_id, tag) VALUES (OLD.user_id, 'exercise_library'); END;
