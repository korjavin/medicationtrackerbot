-- +goose Up
-- Add INTEGER unix-seconds-UTC column for intake_log.snoozed_until — Task 6 of
-- the May 10 UTC-unix fix plan. Same shape as migrations 057 (scheduled_at_unix)
-- and 059 (taken_at_unix); see docs/plans/2026-05-10-intake-log-utc-unix-fix.md
-- and the dose-time-columns comment at the top of internal/store/store.go.
--
-- Backfill strategy. snoozed_until rows in production carry the same set of
-- storage formats as taken_at, all produced by modernc.org/sqlite serializing
-- time.Time:
--   1. RFC3339-ish, e.g. "2026-05-10T17:20:00+02:00".  strftime('%s') handles
--      this directly.
--   2. Go t.String(), e.g. "2026-05-10 17:20:00 +0200 CEST". SQLite's date
--      parser does NOT accept the trailing zone name or the un-colon'd
--      "+0200" offset; we reformat via substr (same trick as migrations
--      057/059).
--   3. Go t.String() WITH monotonic-clock residue, e.g.
--      "2026-05-10 17:20:00 +0200 CEST m=+201.247835759". The substr-based
--      fallback only consumes positions 1..25 of the string, so the trailing
--      monotonic suffix is ignored.
-- The migration test (TestMigration061_BackfillsProductionSnoozedUntilFormats)
-- pins all three formats against every TZ name observed in prod.
ALTER TABLE intake_log ADD COLUMN snoozed_until_unix INTEGER;

UPDATE intake_log SET snoozed_until_unix = CAST(
    COALESCE(
        strftime('%s', snoozed_until),
        strftime('%s',
            substr(snoozed_until, 1, 19) || ' ' ||
            substr(snoozed_until, 21, 3) || ':' ||
            substr(snoozed_until, 24, 2)
        )
    ) AS INTEGER
) WHERE snoozed_until IS NOT NULL;

-- +goose Down
ALTER TABLE intake_log DROP COLUMN snoozed_until_unix;
