-- +goose Up
-- +goose StatementBegin
-- Add INTEGER unix-seconds-UTC columns for tz_transition_plans timestamps.
-- Task 7 of docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md:
-- close the TZ-name-equality bug class for the plan-lifecycle timestamps too,
-- so every dose-related time column (intake_log already, now tz_transition_plans)
-- uses the same unix-seconds-UTC primitive. See the dose-time-columns comment
-- in internal/store/medication/repo.go.
--
-- Backfill strategy mirrors migrations 057/059/061. The columns may carry:
--   1. RFC3339-ish ("2026-05-10T17:20:00+02:00") — strftime('%s') handles directly.
--   2. CURRENT_TIMESTAMP text ("2026-05-10 15:20:00") — strftime('%s') handles directly.
--   3. Go t.String() ("2026-05-10 17:20:00 +0200 CEST") with or without
--      sub-second precision — SQLite's parser rejects the trailing zone name
--      and un-colon'd offset; reformat via substr.
--   4. Monotonic-clock residue ("… m=+201.247835759") — the substr formula
--      only reads positions 1..25, so the trailing suffix is ignored.
-- Apply COALESCE(direct, fallback) for each nullable column.
ALTER TABLE tz_transition_plans ADD COLUMN created_at_unix INTEGER;
ALTER TABLE tz_transition_plans ADD COLUMN notified_at_unix INTEGER;
ALTER TABLE tz_transition_plans ADD COLUMN approved_at_unix INTEGER;

UPDATE tz_transition_plans SET created_at_unix = CAST(
    COALESCE(
        strftime('%s', created_at),
        strftime('%s',
            substr(created_at, 1, 19) || ' ' ||
            substr(created_at, 20 + instr(substr(created_at, 20), ' '), 3) || ':' ||
            substr(created_at, 20 + instr(substr(created_at, 20), ' ') + 3, 2)
        )
    ) AS INTEGER
);

UPDATE tz_transition_plans SET notified_at_unix = CAST(
    COALESCE(
        strftime('%s', notified_at),
        strftime('%s',
            substr(notified_at, 1, 19) || ' ' ||
            substr(notified_at, 20 + instr(substr(notified_at, 20), ' '), 3) || ':' ||
            substr(notified_at, 20 + instr(substr(notified_at, 20), ' ') + 3, 2)
        )
    ) AS INTEGER
) WHERE notified_at IS NOT NULL;

UPDATE tz_transition_plans SET approved_at_unix = CAST(
    COALESCE(
        strftime('%s', approved_at),
        strftime('%s',
            substr(approved_at, 1, 19) || ' ' ||
            substr(approved_at, 20 + instr(substr(approved_at, 20), ' '), 3) || ':' ||
            substr(approved_at, 20 + instr(substr(approved_at, 20), ' ') + 3, 2)
        )
    ) AS INTEGER
) WHERE approved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tz_plans_created_at_unix ON tz_transition_plans(created_at_unix);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_tz_plans_created_at_unix;
ALTER TABLE tz_transition_plans DROP COLUMN approved_at_unix;
ALTER TABLE tz_transition_plans DROP COLUMN notified_at_unix;
ALTER TABLE tz_transition_plans DROP COLUMN created_at_unix;
-- +goose StatementEnd
