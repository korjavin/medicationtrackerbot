-- +goose Up
-- +goose StatementBegin
-- Drop the legacy DATETIME columns from tz_transition_plans now that all
-- readers/writers use *_unix (Task 7 of the May 8 plan). Same SQLite
-- table-rebuild pattern as migrations 058/060/062.
--
--   1. CREATE tz_transition_plans_new with the new shape — INTEGER unix
--      columns for created_at_unix (NOT NULL), notified_at_unix (NULL),
--      approved_at_unix (NULL). created_at_unix defaults to
--      strftime('%s','now') so any future INSERT that omits the column keeps
--      the migration-time behaviour of CURRENT_TIMESTAMP.
--   2. INSERT … SELECT to copy every surviving column, preserving id values.
--   3. DROP TABLE tz_transition_plans (drops associated indexes).
--   4. RENAME tz_transition_plans_new TO tz_transition_plans.
--   5. Recreate idx_tz_plans_hash_active (partial unique index from
--      migration 050) and idx_tz_plans_created_at_unix.
--
-- Foreign keys: PRAGMA foreign_keys defaults to OFF in this codebase, so the
-- rebuild does not need to disable enforcement. The tz_transition_steps.plan_id
-- references tz_transition_plans(id) and is preserved by copying ids verbatim.
--
-- Down-step caveat: reconstructs the DATETIME columns from the unix values
-- via datetime(N,'unixepoch') (UTC text, no zone name). This is lossy — the
-- original `+0200 CEST`-style strings written by the modernc.org/sqlite driver
-- cannot be recovered. Production rollback past this migration should restore
-- from a Litestream backup, not run goose down.

CREATE TABLE tz_transition_plans_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    old_tz           TEXT NOT NULL,
    new_tz           TEXT NOT NULL,
    created_at_unix  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    status           TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    steps_json       TEXT NOT NULL DEFAULT '[]',
    inputs_json      TEXT NOT NULL DEFAULT '{}',
    plan_hash        TEXT NOT NULL DEFAULT '',
    approved_at_unix INTEGER,
    user_action      TEXT,
    notified_at_unix INTEGER
);

INSERT INTO tz_transition_plans_new (id, old_tz, new_tz, created_at_unix, status, steps_json, inputs_json, plan_hash, approved_at_unix, user_action, notified_at_unix)
SELECT id, old_tz, new_tz, created_at_unix, status, steps_json, inputs_json, plan_hash, approved_at_unix, user_action, notified_at_unix
FROM tz_transition_plans;

DROP TABLE tz_transition_plans;
ALTER TABLE tz_transition_plans_new RENAME TO tz_transition_plans;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tz_plans_hash_active
ON tz_transition_plans(plan_hash)
WHERE status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED');

CREATE INDEX IF NOT EXISTS idx_tz_plans_created_at_unix ON tz_transition_plans(created_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Best-effort rollback: re-adds the DATETIME columns and backfills via
-- datetime(N,'unixepoch') in UTC. Lossy — original TZ-named strings cannot be
-- reconstructed. AUTOINCREMENT id values are preserved.
CREATE TABLE tz_transition_plans_old (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    old_tz           TEXT NOT NULL,
    new_tz           TEXT NOT NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status           TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    steps_json       TEXT NOT NULL DEFAULT '[]',
    inputs_json      TEXT NOT NULL DEFAULT '{}',
    plan_hash        TEXT NOT NULL DEFAULT '',
    approved_at      DATETIME,
    user_action      TEXT,
    notified_at      DATETIME,
    created_at_unix  INTEGER,
    approved_at_unix INTEGER,
    notified_at_unix INTEGER
);

INSERT INTO tz_transition_plans_old (id, old_tz, new_tz, created_at, status, steps_json, inputs_json, plan_hash, approved_at, user_action, notified_at, created_at_unix, approved_at_unix, notified_at_unix)
SELECT id,
       old_tz,
       new_tz,
       datetime(created_at_unix, 'unixepoch'),
       status,
       steps_json,
       inputs_json,
       plan_hash,
       CASE WHEN approved_at_unix IS NULL THEN NULL ELSE datetime(approved_at_unix, 'unixepoch') END,
       user_action,
       CASE WHEN notified_at_unix IS NULL THEN NULL ELSE datetime(notified_at_unix, 'unixepoch') END,
       created_at_unix,
       approved_at_unix,
       notified_at_unix
FROM tz_transition_plans;

DROP TABLE tz_transition_plans;
ALTER TABLE tz_transition_plans_old RENAME TO tz_transition_plans;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tz_plans_hash_active
ON tz_transition_plans(plan_hash)
WHERE status NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED');

CREATE INDEX IF NOT EXISTS idx_tz_plans_created_at_unix ON tz_transition_plans(created_at_unix);
-- +goose StatementEnd
