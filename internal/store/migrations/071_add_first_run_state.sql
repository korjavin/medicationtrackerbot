-- +goose Up
-- Track whether the user has been through the first-run flow. The default
-- (0) means "not complete" so a brand-new install surfaces needs_first_run=true
-- on the very first /api/bootstrap call. Existing installs — anything that
-- already has user data of ANY kind — get backfilled to 1 by the UPDATE
-- below so server installs and already-onboarded mobile installs never see
-- the onboarding overlay. The presence check covers every primary
-- user-data path (medications, BP, weight, food, intake history, workouts,
-- sleep, vitals, diary) because not all users track medications first —
-- a BP-only or weight-only existing user must not get punted into the
-- first-run flow on upgrade. The UPDATE fires the trg_change_settings_upd
-- trigger once per migration run; that one-shot change_events row is
-- harmless on fresh installs (no subscribers) and on existing installs
-- (a single event during an upgrade window).
ALTER TABLE settings ADD COLUMN first_run_complete INTEGER NOT NULL DEFAULT 0;
UPDATE settings SET first_run_complete = 1
WHERE id = 1 AND (
    EXISTS (SELECT 1 FROM medications LIMIT 1)
    OR EXISTS (SELECT 1 FROM blood_pressure_readings LIMIT 1)
    OR EXISTS (SELECT 1 FROM weight_logs LIMIT 1)
    OR EXISTS (SELECT 1 FROM food_log LIMIT 1)
    OR EXISTS (SELECT 1 FROM intake_log LIMIT 1)
    OR EXISTS (SELECT 1 FROM workout_sessions LIMIT 1)
    OR EXISTS (SELECT 1 FROM sleep_logs LIMIT 1)
    OR EXISTS (SELECT 1 FROM diary_notes LIMIT 1)
    OR EXISTS (SELECT 1 FROM vitals_heart LIMIT 1)
    OR EXISTS (SELECT 1 FROM vitals_spo2 LIMIT 1)
    OR EXISTS (SELECT 1 FROM vitals_stress LIMIT 1)
    OR EXISTS (SELECT 1 FROM miband_workouts LIMIT 1)
);

-- +goose Down
ALTER TABLE settings DROP COLUMN first_run_complete;
