-- +goose Up
-- Add INTEGER unix-seconds-UTC column for intake_log.taken_at — Task 5 of the
-- May 10 UTC-unix fix plan. Same shape as migration 057 (scheduled_at_unix);
-- see docs/plans/2026-05-10-intake-log-utc-unix-fix.md and the dose-time-columns
-- comment at the top of internal/store/store.go.
--
-- Backfill strategy. taken_at rows in production carry three storage formats,
-- all produced by modernc.org/sqlite serializing time.Time:
--   1. RFC3339-ish, e.g. "2026-05-10T17:20:00+02:00".  strftime('%s') handles
--      this directly.
--   2. Go t.String(), e.g. "2026-05-10 17:20:00 +0200 CEST". SQLite's date
--      parser does NOT accept the trailing zone name or the un-colon'd
--      "+0200" offset; we reformat via substr (same trick as migration 057).
--   3. Go t.String() WITH monotonic-clock residue, e.g.
--      "2026-05-10 17:20:00 +0200 CEST m=+201.247835759". The substr-based
--      fallback still works because positions 1..25 of the string remain the
--      wall-clock + offset; we strip whatever comes after position 25 by only
--      taking that prefix.
-- The migration test (TestMigration059_BackfillsProductionTakenAtFormats)
-- pins all three formats against every TZ name observed in prod (PDT, MST,
-- CEST, UTC) plus the monotonic-clock variant.
ALTER TABLE intake_log ADD COLUMN taken_at_unix INTEGER;

UPDATE intake_log SET taken_at_unix = CAST(
    COALESCE(
        strftime('%s', taken_at),
        strftime('%s',
            substr(taken_at, 1, 19) || ' ' ||
            substr(taken_at, 21, 3) || ':' ||
            substr(taken_at, 24, 2)
        )
    ) AS INTEGER
) WHERE taken_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intake_log_taken_at_unix ON intake_log(taken_at_unix);

-- +goose Down
DROP INDEX IF EXISTS idx_intake_log_taken_at_unix;
ALTER TABLE intake_log DROP COLUMN taken_at_unix;
