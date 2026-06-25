-- +goose Up
-- +goose StatementBegin
-- Gamification backend core (Plan 1 of 3). Three new tables back the
-- HealthPoints / Rings / levels / streaks engine described in
-- docs/gamification.md and implemented by internal/domain/gamification.
--
--   gamification_targets — per-user overrides ONLY. The code (scoring.Config)
--     holds the recommended guideline defaults (BP, sleep, steps, activity,
--     calories, protein); a row here exists only for a metric the user changed.
--     mode distinguishes range vs one-sided targets; low_val/high_val/falloff
--     parameterize the trapezoid range-membership curve.
--
--   gamification_ledger — append/replace HP awards, the source of truth for
--     recompute. The UNIQUE (user_id, day_unix, ring, source_metric, kind)
--     constraint is what makes the 365-day backfill / daily rescore idempotent:
--     re-scoring a day is an INSERT OR REPLACE that overwrites the same row
--     instead of accumulating duplicates. day_unix is UTC-midnight unix-seconds
--     (INTEGER) so the dedupe equality is TZ-safe — see store.go package comment
--     and TestDoseTimeColumnsAreInteger.
--
--   gamification_state — cached level / streak / insight-tier per user for fast
--     reads. Recomputed from the ledger; never the only copy of anything.
--
-- The settings.gamification_enabled flag defaults to 1 (default-ON per design).
CREATE TABLE gamification_targets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    metric_key      TEXT    NOT NULL,
    low_val         REAL,
    high_val        REAL,
    falloff         REAL,
    mode            TEXT,
    updated_at_unix INTEGER NOT NULL,
    UNIQUE(user_id, metric_key)
);

CREATE TABLE gamification_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    day_unix        INTEGER NOT NULL,
    ring            TEXT    NOT NULL,
    source_metric   TEXT    NOT NULL,
    kind            TEXT    NOT NULL,
    hp              INTEGER NOT NULL,
    detail          TEXT,
    created_at_unix INTEGER NOT NULL,
    UNIQUE(user_id, day_unix, ring, source_metric, kind)
);

CREATE TABLE gamification_state (
    user_id             INTEGER PRIMARY KEY,
    lifetime_hp         INTEGER NOT NULL DEFAULT 0,
    level               INTEGER NOT NULL DEFAULT 1,
    current_streak      INTEGER NOT NULL DEFAULT 0,
    longest_streak      INTEGER NOT NULL DEFAULT 0,
    freezes             INTEGER NOT NULL DEFAULT 0,
    insight_tier        INTEGER NOT NULL DEFAULT 1,
    last_scored_day_unix INTEGER,
    -- Set once, when the 365-day historical backfill finishes the whole window.
    -- This is a dedicated "backfill complete" latch, distinct from
    -- last_scored_day_unix (which advances on the FIRST backfilled day and on
    -- every ordinary daily score). EnsureBackfilled keys off this so a mid-run
    -- failure or an unrelated live score never looks like a finished backfill.
    backfilled_at_unix  INTEGER,
    updated_at_unix     INTEGER NOT NULL
);

-- default-ON: a freshly migrated settings row reports gamification enabled.
ALTER TABLE settings ADD COLUMN gamification_enabled INTEGER DEFAULT 1;

-- Lookup indexes for range reads (ledger by user+day) and target resolution.
CREATE INDEX idx_gam_ledger_user_day ON gamification_ledger(user_id, day_unix);
CREATE INDEX idx_gam_targets_user ON gamification_targets(user_id);

-- Cross-channel change propagation under the 'gamification' tag (mirror
-- migration 027/072): bot/MCP/web writes reach SSE/poll subscribers uniformly.
CREATE TRIGGER trg_change_gam_targets_ins AFTER INSERT ON gamification_targets BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;
CREATE TRIGGER trg_change_gam_targets_upd AFTER UPDATE ON gamification_targets BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;
CREATE TRIGGER trg_change_gam_targets_del AFTER DELETE ON gamification_targets BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;

CREATE TRIGGER trg_change_gam_ledger_ins AFTER INSERT ON gamification_ledger BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;
CREATE TRIGGER trg_change_gam_ledger_upd AFTER UPDATE ON gamification_ledger BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;
CREATE TRIGGER trg_change_gam_ledger_del AFTER DELETE ON gamification_ledger BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;

CREATE TRIGGER trg_change_gam_state_ins AFTER INSERT ON gamification_state BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;
CREATE TRIGGER trg_change_gam_state_upd AFTER UPDATE ON gamification_state BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;
CREATE TRIGGER trg_change_gam_state_del AFTER DELETE ON gamification_state BEGIN
    INSERT INTO change_events(tag) VALUES ('gamification');
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS trg_change_gam_state_del;
DROP TRIGGER IF EXISTS trg_change_gam_state_upd;
DROP TRIGGER IF EXISTS trg_change_gam_state_ins;
DROP TRIGGER IF EXISTS trg_change_gam_ledger_del;
DROP TRIGGER IF EXISTS trg_change_gam_ledger_upd;
DROP TRIGGER IF EXISTS trg_change_gam_ledger_ins;
DROP TRIGGER IF EXISTS trg_change_gam_targets_del;
DROP TRIGGER IF EXISTS trg_change_gam_targets_upd;
DROP TRIGGER IF EXISTS trg_change_gam_targets_ins;
DROP INDEX IF EXISTS idx_gam_targets_user;
DROP INDEX IF EXISTS idx_gam_ledger_user_day;
DROP TABLE IF EXISTS gamification_state;
DROP TABLE IF EXISTS gamification_ledger;
DROP TABLE IF EXISTS gamification_targets;
-- Drop the settings flag to keep Up→Down→Up symmetric (so re-up's ADD COLUMN
-- doesn't hit a duplicate-column error). modernc.org/sqlite supports
-- ALTER TABLE ... DROP COLUMN; this mirrors migration 022's feature toggles.
ALTER TABLE settings DROP COLUMN gamification_enabled;
-- +goose StatementEnd
