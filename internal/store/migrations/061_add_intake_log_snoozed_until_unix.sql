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
--      "+0200" offset; we reformat via substr.
--   3. Go t.String() WITH sub-second precision, e.g.
--      "2026-05-10 17:20:00.123456789 +0200 CEST" — SnoozeIntake takes
--      time.Now().Add(d), so the input typically carries nanoseconds. We
--      locate the offset dynamically with instr() instead of assuming a
--      fixed position, so the formula handles both with- and without-
--      fractional variants.
--   4. Go t.String() WITH monotonic-clock residue, e.g.
--      "… +0200 CEST m=+201.247835759". The substr prefix stops at the
--      offset, so trailing monotonic residue is ignored.
-- The migration test (TestMigration061_BackfillsProductionSnoozedUntilFormats)
-- pins all formats against every TZ name observed in prod.
ALTER TABLE intake_log ADD COLUMN snoozed_until_unix INTEGER;

UPDATE intake_log SET snoozed_until_unix = CAST(
    COALESCE(
        strftime('%s', snoozed_until),
        strftime('%s',
            substr(snoozed_until, 1, 19) || ' ' ||
            substr(snoozed_until, 20 + instr(substr(snoozed_until, 20), ' '), 3) || ':' ||
            substr(snoozed_until, 20 + instr(substr(snoozed_until, 20), ' ') + 3, 2)
        )
    ) AS INTEGER
) WHERE snoozed_until IS NOT NULL;

-- +goose Down
ALTER TABLE intake_log DROP COLUMN snoozed_until_unix;
