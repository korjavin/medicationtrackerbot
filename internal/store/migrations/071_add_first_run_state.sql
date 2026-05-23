-- +goose Up
-- Track whether the user has been through the first-run flow. The default
-- (0) means "not complete" so a brand-new install surfaces needs_first_run=true
-- on the very first /api/bootstrap call. Existing installs — anything that
-- already has medication data — get backfilled to 1 by the UPDATE below so
-- server installs and already-onboarded mobile installs never see the
-- onboarding overlay. The medications presence check is the canonical "this
-- app is in use" signal: every other data path (BP, weight, food, workouts)
-- is unlocked from the medication-first onboarding model. The UPDATE fires
-- the trg_change_settings_upd trigger once per migration run; that one-shot
-- change_events row is harmless on fresh installs (no subscribers) and on
-- existing installs (a single event during an upgrade window).
ALTER TABLE settings ADD COLUMN first_run_complete INTEGER NOT NULL DEFAULT 0;
UPDATE settings SET first_run_complete = 1
WHERE id = 1 AND EXISTS (SELECT 1 FROM medications LIMIT 1);

-- +goose Down
ALTER TABLE settings DROP COLUMN first_run_complete;
