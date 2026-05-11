-- +goose Up
-- Add INTEGER unix-seconds-UTC column for intake_log.taken_at — Task 5 of the
-- May 10 UTC-unix fix plan. Same shape as migration 057 (scheduled_at_unix);
-- see docs/plans/2026-05-10-intake-log-utc-unix-fix.md and the dose-time-columns
-- comment at the top of internal/store/store.go.
--
-- Backfill strategy. taken_at rows in production carry several storage
-- formats, all produced by modernc.org/sqlite serializing time.Time:
--   1. RFC3339-ish, e.g. "2026-05-10T17:20:00+02:00".  strftime('%s') handles
--      this directly.
--   2. Go t.String(), e.g. "2026-05-10 17:20:00 +0200 CEST". SQLite's date
--      parser does NOT accept the trailing zone name or the un-colon'd
--      "+0200" offset; we reformat via substr.
--   3. Go t.String() WITH sub-second precision, e.g.
--      "2026-05-10 17:20:00.123456789 +0200 CEST". This is the common form
--      for taken_at, which is written from time.Now() — .Truncate(0) strips
--      monotonic clock but preserves nanoseconds, and modernc.org/sqlite
--      serializes via t.String() which renders the fractional portion. We
--      locate the offset dynamically with instr() instead of assuming a
--      fixed position, so the formula handles both with- and without-
--      fractional variants.
--   4. Go t.String() WITH monotonic-clock residue, e.g.
--      "… +0200 CEST m=+201.247835759". The substr prefix stops at the
--      offset, so trailing monotonic residue is ignored.
-- The migration test (TestMigration059_BackfillsProductionTakenAtFormats)
-- pins all formats against every TZ name observed in prod (PDT, MST, CEST,
-- UTC) including the sub-second-precision variant.
ALTER TABLE intake_log ADD COLUMN taken_at_unix INTEGER;

UPDATE intake_log SET taken_at_unix = CAST(
    COALESCE(
        strftime('%s', taken_at),
        strftime('%s',
            substr(taken_at, 1, 19) || ' ' ||
            substr(taken_at, 20 + instr(substr(taken_at, 20), ' '), 3) || ':' ||
            substr(taken_at, 20 + instr(substr(taken_at, 20), ' ') + 3, 2)
        )
    ) AS INTEGER
) WHERE taken_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intake_log_taken_at_unix ON intake_log(taken_at_unix);

-- +goose Down
DROP INDEX IF EXISTS idx_intake_log_taken_at_unix;
ALTER TABLE intake_log DROP COLUMN taken_at_unix;
