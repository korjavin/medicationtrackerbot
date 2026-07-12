# Cloud Mi Band .nxk import: chunk + downsample so a real backup completes (med-0cf)

## Overview

P0 bd **med-0cf**: uploading a real (large, multi-month) Mi Band `.nxk` in cloud
mode NEVER completes. The relay parses the whole backup server-side and seals it
as **one** ~160MB inbox event; the client then day-batches the dense HR/SpO2/stress
streams into **one record per stream-day** that serializes past the 64 KiB per-op
cap, so `POST /api/sync/ops` returns 400 "op field too large or missing" →
`WRITE_ERROR_BUDGET` → `syncWedged`. med-eas.51 stopped the brick-loop (byte-capped
inbox drain) but the import still does not work.

Three fixes, all required:

1. **Server downsampling** (the real size fix) — downsample the dense continuous
   streams to the app cadence (HR/SpO2 = 15 min, stress = 30 min) at the parse/map
   step in `vitals_import.go`, so BOTH the web-upload path and the Telegram `.nxk`
   path shrink ~160MB → a few thousand samples with no user-visible fidelity loss
   (the vitals graphs re-bucket hourly anyway).
2. **Server event chunking** — `parseNXKToVitalsEvents` already returns
   `[]vitalsImportEvent`; populate it with MANY bounded events so no single sealed
   event approaches `maxInboxDrainBytes` (1 MiB). The caller already
   `SealAndQueue`s each event in the slice.
3. **Client record chunking** (defensive guard) — split a stream-day into multiple
   sub-records in `importDayBatched` so each record's ct stays well under
   `maxOpCTLen` (64 KiB). After downsampling a day is ~96 samples (tiny), so this
   is a safety net that guarantees the client never emits an op the server 400s.

**Acceptance:** a dense multi-month `.nxk` imports to completion — vitals appear in
the vault, no 160MB inbox blob, no op > 64 KiB / 400, no wedge; total transferred is
a small fraction of the raw file; high-freq streams stored at the app cadence;
daily aggregates (sleep, daystats, mi-band workouts) preserved as-is; re-import is
idempotent.

## Context (from discovery)

Files/components involved:
- `internal/cloudserver/vitals_import.go` — `parseNXKToVitalsEvents(nxkPath)` (parse
  + map + seal-shape). Returns `[]vitalsImportEvent` already; today returns one
  giant event (lines ~112-185). GPS is parsed-and-discarded — keep it discarded.
- `internal/cloudserver/vitals_import_api.go` — `sealEvents()` loops the returned
  slice and `SealAndQueue`s each (no change needed; verify it still loops).
- `internal/cloudserver/telegram.go` (~line 1145) — the Telegram `.nxk` path calls
  `parseNXKToVitalsEvents` then `SealAndQueue`s each event (shared path; verify).
- `internal/cloudserver/inbox.go` — `maxInboxDrainBytes = 1 << 20` (1 MiB), the
  per-drain byte cap (med-eas.51); drain always includes the first event even if it
  alone exceeds the budget, then trims the tail.
- `internal/cloudserver/sync.go` — `maxOpCTLen = 64 << 10` (64 KiB); an op ct over
  this → 400 "op field too large or missing".
- `web/domain/vitals.js` — `importSamples` / `importDayBatched` (one record per
  stream-day, recordId `<type>-YYYY-MM-DD`); `readSamples()` PK-range-scans
  `<type>-<fromDay>`..`<type>-<toDay>` and iterates `rec.samples`.
- `web/cloud/js/inbox-apply.js` — `apply()` VITALS_IMPORT branch →
  `createVitalsDomain().importSamples()`; already uses `deferFlush` + a chunked
  `flushConfirmed` barrier (med-0ol.2), so per-record ops are batched — but one
  record's ct can still exceed the cap.
- `internal/domain/nxk/nxk.go` — `VitalsHeartLog`/`VitalsSpO2Log`/`VitalsStressLog`
  (`DateTime time.Time`, `TzOffset int`, `Value int`, + `Type int`, `Info string`
  for stress); parse fns `ParseHeartDatabase`, `ParseSpO2Database`,
  `ParseStressDatabase`, `ParseSleepDatabase`, `ParseDayDatabase`,
  `ParseOutdoorWorkouts`.

Related patterns found:
- `internal/seeddemo/vitals_timeseries.go` — `alignUpToInterval` anchors the app
  cadence to 00:00 UTC: HR/SpO2 = 15 min, stress = 30 min. Match these constants.
- Idempotency already comes from `importSamples`' natural-key upserts (sleep by
  start instant, daystats by day, samples merged by instant, miband by
  source_start_ms), so many events / re-drain converge with no double-count.

Dependencies identified: none new. No new HTTP route. No schema/migration change.

## Development Approach
- **Testing approach**: NO unit tests. Extend the existing owning suites only:
  Go `internal/cloudserver/vitals_import_test.go` (integration over the real
  extract→parse path via `buildNXKFixture`), JS `web/cloud/js/tests/inbox-apply.test.js`
  (the owning suite for `importSamples` via the apply path). These guard real
  boundaries (byte cap, op cap, read-shape, idempotency) that manual checking can't.
- Complete each task fully before the next; small focused changes.
- **CRITICAL: a task that adds an integration test must have it pass before the next task.**
- **CRITICAL: update this plan file if scope changes.**
- Maintain backward compatibility: existing single-record days (`<type>-<day>`)
  keep working; sub-records only appear on overflow.

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: extend the two existing suites above — they guard the byte
  cap, the op cap, the vitals read shape, and re-import idempotency.
- **E2E tests**: none (no existing e2e suite covers this flow).

## Progress Tracking
- Mark completed items `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: Server-side downsampling of dense streams (vitals_import.go)
- [x] add named cadence constants in `internal/cloudserver/vitals_import.go`:
      `hrCadence = 15 * time.Minute`, `spo2Cadence = 15 * time.Minute`,
      `stressCadence = 30 * time.Minute` (comment: matches
      `internal/seeddemo/vitals_timeseries.go`, anchored to 00:00 UTC)
- [x] add a generic `downsampleSamples(samples []vitalsSampleWire, cadence time.Duration) []vitalsSampleWire`
      helper: sort by `DateTime` instant, bucket by
      `DateTime.UTC().Unix() / int64(cadence.Seconds())` (00:00-UTC anchored), keep
      exactly ONE deterministic representative per bucket (first after sort),
      preserving its `TzOffset`/`Type`/`Info`; output sorted by instant
- [x] apply it to the HR, SpO2, and Stress slices after parsing, before building
      events (HR/SpO2 → `hrCadence`/`spo2Cadence`, Stress → `stressCadence`)
- [x] do NOT downsample sleep, daystats, or workouts (pass through unchanged)
- [x] keep GPS discarded (no change to the `ParseOutdoorWorkouts` second-return drop)

### Task 2: Server-side event chunking into bounded events (vitals_import.go)
- [x] add named const `maxSamplesPerEvent = 2000` with a comment tying it to
      `maxInboxDrainBytes` (a bounded event seals well under 1 MiB)
- [x] restructure `parseNXKToVitalsEvents` to emit MANY bounded events instead of
      one: chunk the (downsampled) HR/SpO2/Stress streams into events of at most
      `maxSamplesPerEvent` samples each (one stream's samples per event group is
      simplest; do not mix a partial stream with unrelated ones if it complicates
      determinism), and emit sleep + daystats + workouts in their own bounded
      event(s). Every event keeps `Kind: inboxEventKindVitalsImport`.
- [x] deterministic chunk boundaries (stream order is already stable from the
      parse + downsample sort) so re-parsing the same backup yields identical events
- [x] preserve the "no vitals data → error" guard (return the existing
      `no vitals data found in backup` error when every stream is empty)
- [x] update the `parseNXKToVitalsEvents` doc comment + the stale `ponytail: one
      event per import` comment to describe the new bounded-event behavior
- [x] confirm `sealEvents()` (vitals_import_api.go) and the Telegram path
      (telegram.go ~1145) still loop the slice and `SealAndQueue` each — no caller
      change expected; adjust only if they assumed a single event

### Task 3: Server integration test — dense multi-day fixture (vitals_import_test.go)
- [x] extend `buildNXKFixture` (or add a sibling builder) to emit a DENSE
      multi-day backup: many samples per day (e.g. every ~30s) across several days
      for HR/SpO2/stress, plus a few sleep/daystat/workout rows
- [x] assert `parseNXKToVitalsEvents` returns MANY events (> 1) and each event's
      JSON-marshaled size is < `maxInboxDrainBytes`
- [x] assert downsampling: HR/SpO2 samples are spaced ≥ 15 min (≤ 96/day), stress
      ≥ 30 min (≤ 48/day) — check min spacing / per-day counts across all events
- [x] assert daily aggregates preserved: sleep sessions, daystats, and workouts
      appear unchanged (count + key fields) versus the fixture input
- [x] assert determinism/idempotency: parsing the same fixture twice yields
      identical events (same order, same sample sets)
- [x] assert GPS still never appears in any event
- [x] run `TZ=UTC go test ./internal/cloudserver/...` — must pass

### Task 4: Client record chunking in importDayBatched (web/domain/vitals.js)
- [x] add a named const `MAX_SAMPLES_PER_RECORD = 500` (comment: keeps a record's
      ct well under the server's 64 KiB `maxOpCTLen`)
- [x] in `importDayBatched`, after merging a day's samples, if the merged sample
      count exceeds `MAX_SAMPLES_PER_RECORD`, split into deterministic sub-records:
      part 0 keyed `<type>-<day>` (backward compatible), overflow parts keyed
      `<type>-<day>#<k>` (k = 1,2,…); split by sorted-sample-index buckets so the
      same input always produces the same partition (re-drain converges)
- [x] update `readSamples` if needed so the PK range scan
      `<type>-<fromDay>`..`<type>-<toDay>` still catches `#`-suffixed sub-records —
      verify `'#'` (0x23) sorts within the day's range against the `<toDay>` bound
      (`'#' < '-'` 0x2D, and the suffix is only reached after the full `<type>-<day>`
      prefix, which is < `<type>-<toDay>` for any day ≤ toDay); widen the upper
      bound if the raw ordering does not hold — verified: ordering holds (toDay is
      padded +1 day past nowMs), so no readSamples change needed beyond a doc note
- [x] ensure the merge still dedupes by sample instant across parts so re-applying
      the same import overwrites its own samples (no duplicates) — merge now unions
      base + every `#k` part keyed by instant, then re-partitions + tombstones stale
      trailing parts

### Task 5: Client integration test — dense-day split + read-back (inbox-apply.test.js)
- [x] add a case in `web/cloud/js/tests/inbox-apply.test.js`: apply a
      VITALS_IMPORT event whose one day carries > `MAX_SAMPLES_PER_RECORD` samples
- [x] assert the day is stored as MULTIPLE records (`<type>-<day>` + `<type>-<day>#k`),
      each with ≤ `MAX_SAMPLES_PER_RECORD` samples
- [x] assert the read side (`createVitalsDomain().overview()` / `readSamples`) reads
      ALL samples across the sub-records (none dropped)
- [x] assert re-applying the same event is idempotent (sample count unchanged, no
      duplicates)
- [x] run `npx vitest run` — must pass

### Task 6: Verify acceptance criteria
- [ ] verify all Overview requirements are implemented (downsampling + event
      chunking + record chunking; daily aggregates preserved; GPS discarded)
- [ ] `go build ./... && go build -tags mobile ./...`
- [ ] `TZ=UTC go test ./internal/cloudserver/... ./internal/domain/nxk/...`
- [ ] `npx vitest run`
- [ ] run any repo linter/architecture guards that apply to touched files

### Task 7: [Final] Update docs/knowledge if a new pattern emerged
- [ ] if the downsample cadence / chunk-size constants are a durable convention,
      add a one-line note where the existing cadence is documented (do not add loud
      startup warnings); otherwise no doc change

## Technical Details

- **Downsample buckets** are 00:00-UTC-anchored (`instant / cadenceSeconds`), matching
  seeddemo so cloud-imported and seeded data land on the same grid. First-sample-per-
  bucket is deterministic given the pre-sort → identical re-import.
- **Event chunking** is by sample count (`maxSamplesPerEvent`), not bytes — a
  downsampled sample is a small fixed JSON object, so a count cap keeps sealed ct far
  under 1 MiB without measuring bytes. Idempotency is at the record layer
  (`importSamples` natural keys), so the number of events is free to vary.
- **Record sub-keys** `<type>-<day>#<k>`: `readSamples` iterates `rec.samples` for
  every record in range, so multiple records for one day union naturally. The merge in
  `importDayBatched` keys by sample instant, so overlap across a re-import overwrites
  rather than appends.
- **Size estimate**: raw ~160MB (samples every few seconds, 90 days) → downsampled
  HR ~96/day + SpO2 ~96/day + stress ~48/day ≈ 21.6k samples over 90 days ≈ well under
  a few hundred KB sealed, split across ~a dozen bounded events — a small fraction of
  the raw file.

## Post-Completion

**Manual verification** (if applicable):
- Upload a real multi-month `.nxk` in a cloud deployment and confirm: vitals appear
  in the vault, no wedge, no 160MB inbox event, total transfer is a small fraction of
  the file, HR/SpO2/stress render on the graphs at the app cadence.
- Send the same `.nxk` via the Telegram `.nxk` path and confirm the shared function
  produces the same bounded-event import.
