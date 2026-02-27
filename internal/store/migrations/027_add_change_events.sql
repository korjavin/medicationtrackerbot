-- +goose Up
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS change_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_change_events_tag_id ON change_events(tag, id);

-- medications
CREATE TRIGGER IF NOT EXISTS trg_change_medications_ins AFTER INSERT ON medications BEGIN
    INSERT INTO change_events(tag) VALUES ('medications');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_medications_upd AFTER UPDATE ON medications BEGIN
    INSERT INTO change_events(tag) VALUES ('medications');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_medications_del AFTER DELETE ON medications BEGIN
    INSERT INTO change_events(tag) VALUES ('medications');
END;

-- intake history
CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_ins AFTER INSERT ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_upd AFTER UPDATE ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_del AFTER DELETE ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;

-- blood pressure
CREATE TRIGGER IF NOT EXISTS trg_change_bp_readings_ins AFTER INSERT ON blood_pressure_readings BEGIN
    INSERT INTO change_events(tag) VALUES ('bp');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_bp_readings_upd AFTER UPDATE ON blood_pressure_readings BEGIN
    INSERT INTO change_events(tag) VALUES ('bp');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_bp_readings_del AFTER DELETE ON blood_pressure_readings BEGIN
    INSERT INTO change_events(tag) VALUES ('bp');
END;

-- weight
CREATE TRIGGER IF NOT EXISTS trg_change_weight_logs_ins AFTER INSERT ON weight_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('weight');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_weight_logs_upd AFTER UPDATE ON weight_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('weight');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_weight_logs_del AFTER DELETE ON weight_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('weight');
END;

-- reminders/settings
CREATE TRIGGER IF NOT EXISTS trg_change_bp_reminder_state_ins AFTER INSERT ON bp_reminder_state BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_bp_reminder_state_upd AFTER UPDATE ON bp_reminder_state BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_bp_reminder_state_del AFTER DELETE ON bp_reminder_state BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_weight_reminder_state_ins AFTER INSERT ON weight_reminder_state BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_weight_reminder_state_upd AFTER UPDATE ON weight_reminder_state BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_weight_reminder_state_del AFTER DELETE ON weight_reminder_state BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_settings_upd AFTER UPDATE ON settings BEGIN
    INSERT INTO change_events(tag) VALUES ('settings');
END;

-- workout
CREATE TRIGGER IF NOT EXISTS trg_change_workout_groups_ins AFTER INSERT ON workout_groups BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_groups_upd AFTER UPDATE ON workout_groups BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_groups_del AFTER DELETE ON workout_groups BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_workout_variants_ins AFTER INSERT ON workout_variants BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_variants_upd AFTER UPDATE ON workout_variants BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_variants_del AFTER DELETE ON workout_variants BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_workout_exercises_ins AFTER INSERT ON workout_exercises BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_exercises_upd AFTER UPDATE ON workout_exercises BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_exercises_del AFTER DELETE ON workout_exercises BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_workout_sessions_ins AFTER INSERT ON workout_sessions BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_sessions_upd AFTER UPDATE ON workout_sessions BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_sessions_del AFTER DELETE ON workout_sessions BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_workout_logs_ins AFTER INSERT ON workout_exercise_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_logs_upd AFTER UPDATE ON workout_exercise_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_logs_del AFTER DELETE ON workout_exercise_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_workout_rotation_state_ins AFTER INSERT ON workout_rotation_state BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_rotation_state_upd AFTER UPDATE ON workout_rotation_state BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_workout_rotation_state_del AFTER DELETE ON workout_rotation_state BEGIN
    INSERT INTO change_events(tag) VALUES ('workout');
END;

-- food
CREATE TRIGGER IF NOT EXISTS trg_change_food_log_ins AFTER INSERT ON food_log BEGIN
    INSERT INTO change_events(tag) VALUES ('food');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_food_log_upd AFTER UPDATE ON food_log BEGIN
    INSERT INTO change_events(tag) VALUES ('food');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_food_log_del AFTER DELETE ON food_log BEGIN
    INSERT INTO change_events(tag) VALUES ('food');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_food_products_ins AFTER INSERT ON food_products BEGIN
    INSERT INTO change_events(tag) VALUES ('food');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_food_products_upd AFTER UPDATE ON food_products BEGIN
    INSERT INTO change_events(tag) VALUES ('food');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_food_products_del AFTER DELETE ON food_products BEGIN
    INSERT INTO change_events(tag) VALUES ('food');
END;

-- health (imports/background)
CREATE TRIGGER IF NOT EXISTS trg_change_sleep_logs_ins AFTER INSERT ON sleep_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_sleep_logs_upd AFTER UPDATE ON sleep_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_sleep_logs_del AFTER DELETE ON sleep_logs BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_day_stats_ins AFTER INSERT ON day_stats BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_day_stats_upd AFTER UPDATE ON day_stats BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_day_stats_del AFTER DELETE ON day_stats BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_vitals_heart_ins AFTER INSERT ON vitals_heart BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_vitals_heart_upd AFTER UPDATE ON vitals_heart BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_vitals_heart_del AFTER DELETE ON vitals_heart BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_vitals_spo2_ins AFTER INSERT ON vitals_spo2 BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_vitals_spo2_upd AFTER UPDATE ON vitals_spo2 BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_vitals_spo2_del AFTER DELETE ON vitals_spo2 BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;

CREATE TRIGGER IF NOT EXISTS trg_change_vitals_stress_ins AFTER INSERT ON vitals_stress BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_vitals_stress_upd AFTER UPDATE ON vitals_stress BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_vitals_stress_del AFTER DELETE ON vitals_stress BEGIN
    INSERT INTO change_events(tag) VALUES ('health');
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_vitals_stress_del;
DROP TRIGGER IF EXISTS trg_change_vitals_stress_upd;
DROP TRIGGER IF EXISTS trg_change_vitals_stress_ins;
DROP TRIGGER IF EXISTS trg_change_vitals_spo2_del;
DROP TRIGGER IF EXISTS trg_change_vitals_spo2_upd;
DROP TRIGGER IF EXISTS trg_change_vitals_spo2_ins;
DROP TRIGGER IF EXISTS trg_change_vitals_heart_del;
DROP TRIGGER IF EXISTS trg_change_vitals_heart_upd;
DROP TRIGGER IF EXISTS trg_change_vitals_heart_ins;
DROP TRIGGER IF EXISTS trg_change_day_stats_del;
DROP TRIGGER IF EXISTS trg_change_day_stats_upd;
DROP TRIGGER IF EXISTS trg_change_day_stats_ins;
DROP TRIGGER IF EXISTS trg_change_sleep_logs_del;
DROP TRIGGER IF EXISTS trg_change_sleep_logs_upd;
DROP TRIGGER IF EXISTS trg_change_sleep_logs_ins;
DROP TRIGGER IF EXISTS trg_change_food_products_del;
DROP TRIGGER IF EXISTS trg_change_food_products_upd;
DROP TRIGGER IF EXISTS trg_change_food_products_ins;
DROP TRIGGER IF EXISTS trg_change_food_log_del;
DROP TRIGGER IF EXISTS trg_change_food_log_upd;
DROP TRIGGER IF EXISTS trg_change_food_log_ins;
DROP TRIGGER IF EXISTS trg_change_workout_rotation_state_del;
DROP TRIGGER IF EXISTS trg_change_workout_rotation_state_upd;
DROP TRIGGER IF EXISTS trg_change_workout_rotation_state_ins;
DROP TRIGGER IF EXISTS trg_change_workout_logs_del;
DROP TRIGGER IF EXISTS trg_change_workout_logs_upd;
DROP TRIGGER IF EXISTS trg_change_workout_logs_ins;
DROP TRIGGER IF EXISTS trg_change_workout_sessions_del;
DROP TRIGGER IF EXISTS trg_change_workout_sessions_upd;
DROP TRIGGER IF EXISTS trg_change_workout_sessions_ins;
DROP TRIGGER IF EXISTS trg_change_workout_exercises_del;
DROP TRIGGER IF EXISTS trg_change_workout_exercises_upd;
DROP TRIGGER IF EXISTS trg_change_workout_exercises_ins;
DROP TRIGGER IF EXISTS trg_change_workout_variants_del;
DROP TRIGGER IF EXISTS trg_change_workout_variants_upd;
DROP TRIGGER IF EXISTS trg_change_workout_variants_ins;
DROP TRIGGER IF EXISTS trg_change_workout_groups_del;
DROP TRIGGER IF EXISTS trg_change_workout_groups_upd;
DROP TRIGGER IF EXISTS trg_change_workout_groups_ins;
DROP TRIGGER IF EXISTS trg_change_settings_upd;
DROP TRIGGER IF EXISTS trg_change_weight_reminder_state_del;
DROP TRIGGER IF EXISTS trg_change_weight_reminder_state_upd;
DROP TRIGGER IF EXISTS trg_change_weight_reminder_state_ins;
DROP TRIGGER IF EXISTS trg_change_bp_reminder_state_del;
DROP TRIGGER IF EXISTS trg_change_bp_reminder_state_upd;
DROP TRIGGER IF EXISTS trg_change_bp_reminder_state_ins;
DROP TRIGGER IF EXISTS trg_change_weight_logs_del;
DROP TRIGGER IF EXISTS trg_change_weight_logs_upd;
DROP TRIGGER IF EXISTS trg_change_weight_logs_ins;
DROP TRIGGER IF EXISTS trg_change_bp_readings_del;
DROP TRIGGER IF EXISTS trg_change_bp_readings_upd;
DROP TRIGGER IF EXISTS trg_change_bp_readings_ins;
DROP TRIGGER IF EXISTS trg_change_intake_log_del;
DROP TRIGGER IF EXISTS trg_change_intake_log_upd;
DROP TRIGGER IF EXISTS trg_change_intake_log_ins;
DROP TRIGGER IF EXISTS trg_change_medications_del;
DROP TRIGGER IF EXISTS trg_change_medications_upd;
DROP TRIGGER IF EXISTS trg_change_medications_ins;
DROP INDEX IF EXISTS idx_change_events_tag_id;
DROP TABLE IF EXISTS change_events;
-- +goose StatementEnd
