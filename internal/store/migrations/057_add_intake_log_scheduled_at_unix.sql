-- +goose Up
-- Add INTEGER unix-seconds-UTC column for intake_log.scheduled_at to close the
-- TZ-name equality bug class. See docs/plans/2026-05-10-intake-log-utc-unix-fix.md
-- and the dose-time-columns comment at the top of internal/store/store.go.
--
-- Backfill strategy. Two storage formats appear in production rows, both
-- produced by modernc.org/sqlite serializing time.Time:
--   1. RFC3339-ish, e.g. "2026-05-10T17:20:00+02:00" (newer driver default).
--      SQLite's strftime('%s', col) parses this directly.
--   2. Go t.String(), e.g. "2026-05-10 17:20:00 +0200 CEST" (older path; the
--      format that produced today's incident). SQLite's date parser does NOT
--      accept the trailing zone name or the un-colon'd "+0200" offset, so we
--      reformat via substr: positions 1..19 are the wall clock, positions
--      21..23 are the offset sign+hour, positions 24..25 are the offset
--      minutes. Splicing a ':' between them yields "+02:00", which the
--      parser accepts.
-- The migration test (TestMigration057_BackfillsProductionTZFormats) pins
-- both formats against every TZ name observed in prod (PDT, MST, CEST, UTC).
ALTER TABLE intake_log ADD COLUMN scheduled_at_unix INTEGER;

UPDATE intake_log SET scheduled_at_unix = CAST(
    COALESCE(
        strftime('%s', scheduled_at),
        strftime('%s',
            substr(scheduled_at, 1, 19) || ' ' ||
            substr(scheduled_at, 21, 3) || ':' ||
            substr(scheduled_at, 24, 2)
        )
    ) AS INTEGER
);

CREATE INDEX IF NOT EXISTS idx_intake_log_scheduled_at_unix ON intake_log(scheduled_at_unix);

-- +goose Down
DROP INDEX IF EXISTS idx_intake_log_scheduled_at_unix;
ALTER TABLE intake_log DROP COLUMN scheduled_at_unix;
