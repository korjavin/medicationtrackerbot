-- +goose Up
-- +goose StatementBegin
-- Drop the legacy intake_log.snoozed_until DATETIME column now that the writer
-- and reader have been cut over to snoozed_until_unix (Task 6 of the May 10
-- fix plan). Same SQLite table-rebuild pattern as migrations 058 and 060.
--
--   1. CREATE intake_log_new with the new shape (no snoozed_until column).
--   2. INSERT … SELECT to copy every surviving column, preserving id values
--      so the intake_reminders.intake_id FK continues to match.
--   3. DROP TABLE intake_log (this also drops associated indexes + triggers).
--   4. RENAME intake_log_new TO intake_log.
--   5. Recreate idx_intake_log_status, idx_intake_log_scheduled_at_unix, and
--      idx_intake_log_taken_at_unix.
--   6. Recreate the three trg_change_intake_log_* triggers (from migration
--      027) verbatim.
--
-- Foreign keys: PRAGMA foreign_keys defaults to OFF in this codebase (see
-- store.New — we do not turn it on), so the rebuild does not need to disable
-- enforcement. The intake_reminders → intake_log(id) FK is preserved by
-- copying id values verbatim.
--
-- Down-step caveat. The down step recreates the prior shape via the same
-- rebuild pattern and reconstructs snoozed_until as datetime(unix,'unixepoch')
-- — UTC text with no original timezone name. This is a lossy reconstruction:
-- the legacy `+0200 CEST`-style strings the driver originally wrote (plus any
-- monotonic-clock residue) are gone. Production rollback past this migration
-- must restore from a Litestream backup, not run goose down.

CREATE TABLE intake_log_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medication_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    scheduled_at_unix INTEGER,
    taken_at_unix INTEGER,
    status TEXT DEFAULT 'PENDING',
    snoozed_until_unix INTEGER,
    FOREIGN KEY(medication_id) REFERENCES medications(id)
);

INSERT INTO intake_log_new (id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix)
SELECT id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until_unix
FROM intake_log;

DROP TABLE intake_log;
ALTER TABLE intake_log_new RENAME TO intake_log;

CREATE INDEX IF NOT EXISTS idx_intake_log_status ON intake_log(status);
CREATE INDEX IF NOT EXISTS idx_intake_log_scheduled_at_unix ON intake_log(scheduled_at_unix);
CREATE INDEX IF NOT EXISTS idx_intake_log_taken_at_unix ON intake_log(taken_at_unix);

CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_ins AFTER INSERT ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_upd AFTER UPDATE ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_del AFTER DELETE ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Best-effort rollback: re-adds the snoozed_until DATETIME column and backfills
-- it via datetime(snoozed_until_unix, 'unixepoch') in UTC. This is lossy — the
-- original TZ-named string cannot be reconstructed. AUTOINCREMENT id values
-- are preserved.
CREATE TABLE intake_log_old (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medication_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    scheduled_at_unix INTEGER,
    taken_at_unix INTEGER,
    status TEXT DEFAULT 'PENDING',
    snoozed_until DATETIME,
    snoozed_until_unix INTEGER,
    FOREIGN KEY(medication_id) REFERENCES medications(id)
);

INSERT INTO intake_log_old (id, medication_id, user_id, scheduled_at_unix, taken_at_unix, status, snoozed_until, snoozed_until_unix)
SELECT id,
       medication_id,
       user_id,
       scheduled_at_unix,
       taken_at_unix,
       status,
       CASE WHEN snoozed_until_unix IS NULL THEN NULL ELSE datetime(snoozed_until_unix, 'unixepoch') END,
       snoozed_until_unix
FROM intake_log;

DROP TABLE intake_log;
ALTER TABLE intake_log_old RENAME TO intake_log;

CREATE INDEX IF NOT EXISTS idx_intake_log_status ON intake_log(status);
CREATE INDEX IF NOT EXISTS idx_intake_log_scheduled_at_unix ON intake_log(scheduled_at_unix);
CREATE INDEX IF NOT EXISTS idx_intake_log_taken_at_unix ON intake_log(taken_at_unix);

CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_ins AFTER INSERT ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_upd AFTER UPDATE ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
CREATE TRIGGER IF NOT EXISTS trg_change_intake_log_del AFTER DELETE ON intake_log BEGIN
    INSERT INTO change_events(tag) VALUES ('history');
END;
-- +goose StatementEnd
