# Cloud-mode Mi Band NXK Vitals Ingestion (bd med-nzz)

## Overview

Cloud vitals is read-only today. This adds an **ingestion** path for Mi Band `.nxk`
backup files into a zero-knowledge cloud user's encrypted vault, via two entry points:

1. **Upload** the `.nxk` file in the app (session-gated HTTP endpoint).
2. **Send** the `.nxk` file to the cloud Telegram bot (detected by `.nxk` extension).

Both paths **parse the NXK server-side** (reusing the existing Go parsers in
`internal/domain/sleepimport.go`), then **seal** the parsed vitals to the account's
sealed inbox. The client **drains** the inbox and writes the samples into vault vitals
records. The server sees plaintext only transiently, then seals it — the same trust
model as the existing cloud Telegram inbound plaintext policy
(`docs/cloud-mode.md` → "Inbound plaintext policy").

**Explicitly out of scope (locked decisions):**
- NO live device webhook (the original issue's per-account webhook token + migration is dropped).
- NO GPS import (`ParseOutdoorWorkouts` returns `(workouts, gps)` — use workouts only).
- NO browser-side SQLite/WASM parsing.

**Done:** a `.nxk` uploaded or sent to the bot results in HR/SpO2/sleep/stress/daystats/
mi-band-workout (no GPS) samples appearing in the user's vault vitals after the client
drains, exactly once (re-drain / re-upload converges).

## Context (from discovery)

Files/components involved:
- **Reuse wholesale (do NOT reinvent):**
  - Seal crypto: `internal/cloudserver/sealedbox.go` (`mt/v1/inbox`).
  - Queue: `internal/cloudserver/inbox.go` — `SealAndQueue` (:164), `InboxQueue` iface (:153), `ErrNoInboxKey` + `AccountInboxPublicKey`-drop-if-absent guard.
  - Store + migration: `internal/cloudstore/inbox.go`, `internal/cloudstore/migrations/012_inbox.sql` (no new migration needed).
  - Client drain: `web/cloud/js/inbox.js` — `drainInbox` (:130-171), ack-after-flush barrier (:151-160), polling (:192).
  - Applier dispatch: `web/cloud/js/inbox-apply.js` — `createInboxApplier` (:391-460), deterministic-id discipline (`tg-${eventId}`).
- **Mirror (existing bot-mode NXK flow):** `internal/bot/sleep_import.go` `handleDocumentUpload` + `importSleepFile`. Uses `domain.ValidateImportFile`, `domain.PrepareBackupDB`, `domain.Parse{Sleep,Heart,SpO2,Stress,Day}Database`, `domain.ParseOutdoorWorkouts`.
- **Parsers + types:** `internal/domain/sleepimport.go` — `SleepLog`, `VitalsHeartLog`, `VitalsSpO2Log`, `VitalsStressLog`, `DayStat`, `MiBandWorkout` (pure Go, importable from `internal/cloudserver`).
- **Seal producer template:** `internal/cloudserver/telegram.go` `sealCommand` (:792-849); relay dispatch of `sealCommand`/`sealPhoto`/`sealText` (~:718-755) — add a Document branch here.
- **Cloud route registration idiom:** `FooAPI` struct + `NewFooAPI` + `RegisterRoutes(mux)`; `internal/cloudserver/food_proxy.go` is the RequireSession-gated model.
- **Vitals domain (read-only, add writes):** `web/domain/vitals.js` — `createVitalsDomain({records, now, timeZone})` (:103), record types `sleep`/`daystats`/`hrsample`/`spo2sample`/`stresssample` (:28-32), day-batched HR/SpO2/stress one record per `(stream, utcDay)` body `{day, samples:[]}` (:15-21), natural key `${type}-${utcDay}` (:44-46), `records` port has `.put/.list/.listRange/.del` (see `web/domain/bp.js` create at :181-198 for the write pattern).
- **Mi-band workout write already in cloud:** `web/cloud/js/apishim.js` `workout.listMiBand/updateMiBand/deleteMiBand` (:621-630) — reuse its create/put path (no GPS).
- **Wire shapes to mirror:** `internal/server/health_handlers.go`, `internal/store/vitals/repo.go` (`ImportSleepLogs`/`ImportVitals`/`ImportDayStats`), `internal/store/workout/miband.go` `ImportMiBand`.
- **Upload UI home:** shared Settings → Import/Export UI (C2e); `web/static/js/features/health.js:402` already shows a "DATA SOURCE · .nxk backups" disclaimer.

Related patterns found: sealed-mailbox producer→drain→apply (C3b), domain-service parity, `records`-port domain purity.

Dependencies identified: none new. Reuses inbox key, seal crypto, drain, existing Go NXK parsers.

## Development Approach

- **Testing approach**: NO unit tests. Add an integration test ONLY where it guards a real boundary:
  - Go: parse a fixture `.nxk` → assert the expected sealed events are queued to a test account inbox (real parse + real seal + real queue), and assert GPS is not present in the sealed payload.
  - JS: applier idempotency through the real drain path (`frontend-harness.js`) — apply a `vitals_import` event twice, assert vault vitals records converge and no duplicates.
- Complete each task fully before the next. Small, focused changes.
- **CRITICAL: an integration test added by a task must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**
- Maintain backward compatibility (read-only vitals paths unchanged).

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: the two above only. Most tasks have none — that is fine.
- **E2E tests**: none stood up; reuse existing Go + Vitest suites.

## Progress Tracking

- Mark completed items `[x]` immediately.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.
- Keep plan in sync with actual work.

## Implementation Steps

### Task 1: Server-side NXK parse→events helper (no GPS)

- [x] add `internal/cloudserver/vitals_import.go` with a pure helper `parseNXKToVitalsEvents(nxkPath string) ([]vitalsImportEvent, error)`, that reuses the NXK parsers (`PrepareBackupDB` + `Parse{Sleep,Heart,SpO2,Stress,Day}Database` + `ParseOutdoorWorkouts`) (mirror `internal/bot/sleep_import.go:importSleepFile`).
- [x] map parsed rows into the sealed event payload matching the vault wire shapes (`internal/server/health_handlers.go` + `internal/store/vitals/repo.go` field names): `sleep[]`, `hr[]`, `spo2[]`, `stress[]`, `daystats[]`, `workouts[]`.
- [x] **drop GPS**: call `ParseOutdoorWorkouts` but discard the `gps` return; never include GPS points in the payload.
- [x] pick the sealed-event shape: one event `{kind:"vitals_import", ...streams..., at_unix}` per import (simplest, one atomic import); include a stable `import` grouping (content hash) so the applier can derive deterministic per-sample ids. `// ponytail:` note the ceiling — a very large 90-day NXK seals as one big ct blob; chunk per-stream only if a real size limit is hit.
- [x] validate the file first with `ValidateImportFile` (`.nxk`/`.sqlite`, 100MB cap) before parsing.
- [x] integration test: build a full backup.db → `.nxk` fixture (schemas borrowed from `nxk` parser tests), assert the mapped events contain sleep/hr/spo2/stress/daystats/workout data and contain **no GPS** (asserted on wire JSON); also assert the import id is deterministic.

⚠️ **Scope change (goose-registry landmine):** `internal/cloudserver` importing `internal/domain` transitively linked `internal/store/migrations`, whose `init()` registers go-migration 068 into the *global* goose registry — which then ran against `cmd/cloud`'s cloudstore schema and failed (`no such table: tz_transition_steps`). Same landmine `internal/cloudstore` avoids by never importing `internal/store`. Fix: the self-contained NXK parsers (the whole of `sleepimport.go` — types, `ValidateImportFile`, `PrepareBackupDB`/`ExtractBackupDB`, `Parse*Database`, `ParseOutdoorWorkouts`; stdlib + `modernc.org/sqlite` only) were extracted into a new **leaf package `internal/domain/nxk`** (moved `sleepimport.go`→`nxk/nxk.go`, plus its two test files). `internal/bot/sleep_import.go` now calls `nxk.*`; `internal/cloudserver` imports `internal/domain/nxk` (no store, no migrations). Later tasks reference `nxk.*`, not `domain.*`, for these symbols.

### Task 2: Session-gated HTTP upload endpoint

- [x] add a `VitalsImportAPI` (or fold onto `InboxAPI`) in `internal/cloudserver` with `RegisterRoutes(mux)`, modeled on `food_proxy.go` (RequireSession-gated). Route: `POST /api/vitals/import` accepting a multipart `.nxk` upload. — new `internal/cloudserver/vitals_import_api.go`.
- [x] handler: resolve session account → write upload to a temp file → `parseNXKToVitalsEvents` (Task 1) → for each event `SealAndQueue` to the account inbox; return a small JSON summary `{queued: n}`. Honor the `ErrNoInboxKey` guard (no inbox key published → 409/412, never store plaintext). — returns 412 Precondition Failed on `ErrNoInboxKey`.
- [x] register the API where the other cloud APIs register (same call site as `InboxAPI.RegisterRoutes`). — `cmd/cloud/main.go:221`.
- [x] ~~add the route to `internal/server/mcp_coverage_exempt.go`~~ — **scope correction:** `/api/vitals/import` is a cloud-only route on `cmd/cloud`'s mux; the MCP coverage guard only scans the **bot-mode** `internal/server` routes (food-proxy + inbox cloud routes are likewise absent from `mcpCoverageExempt`). Adding an entry would trip `TestMCPCoverage_NoStaleExemptions` (no matching bot-mode route). No exempt entry added; `TestMCPCoverage_*` all pass unchanged. No registry op added (correct — avoids the catalog/responder cascade).
- [x] confirm this is a cloud **server** endpoint (like `inbox.go`), NOT an apishim domain route — so `web/cloud/js/apishim.js` `createApiRouter` does not need a branch; the browser POSTs directly and it hits the Go handler. — confirmed; browser POSTs multipart directly to the Go handler.

### Task 3: Cloud Telegram `.nxk` document branch

- [x] in `internal/cloudserver/telegram.go`, add a `msg.Document` branch alongside the `sealPhoto`/`sealText`/`sealCommand` dispatch (~:718-755): if the document filename ends in `.nxk` (case-insensitive), handle it; otherwise fall through to existing behavior. — added after the photo branch; non-`.nxk` documents fall through to the empty-message drop. Added a `Document` type + `Message.Document` field to `internal/tgclient`.
- [x] new `sealNXKDocument` modeled on `sealCommand` (:792-849): check inbox key → send a "⏳ Queued" ack → download the file (reuse the relay's file-download path; mirror `internal/bot/sleep_import.go` local-vs-remote fetch) → `parseNXKToVitalsEvents` (Task 1) → `SealAndQueue` each event → edit the ack to a success summary. — new `sealNXKDocument` + `downloadDocument` helper (local-vs-remote via `tgclient.GetFile`/`DownloadFile`).
- [x] respect `ValidateImportFile` size/type; on parse error, edit the ack to a clear failure message (do not leak internals). — `nxk.ValidateImportFile` up front (replies its own extension/size text); download + parse failures edit the ack to generic messages.
- [x] integration test: a fake `.nxk` document update → assert events are sealed to the linked account's inbox (reuse the telegram test harness + fixture `.nxk`). — `TestChildWebhook_NXKDocumentSealsVitalsToMailbox`: real `.nxk` fixture streamed via the recording-TG file endpoint, asserts one sealed `vitals_import` event with all streams, no GPS, no plaintext at rest, ack edited.

### Task 4: Client `vitals_import` applier + `web/domain/vitals.js` write methods

- [ ] add write methods to `web/domain/vitals.js` (keep the file pure — no `window`/`document`/`fetch`/IndexedDB; enforced by `architecture.domain-purity.test.js`):
  - `importSamples({sleep, hr, spo2, stress, daystats, workouts}, {importId})` that, per stream, upserts vault records via the injected `records` port.
  - day-batched HR/SpO2/stress: read existing `${type}-${utcDay}` (`records.list`/`listRange`), **merge** new samples into `samples[]` de-duped by sample instant (LWW), `records.put`. Re-applying the same import converges (idempotent).
  - `sleep`/`daystats`: upsert by natural key (day / start instant) so re-drain is a no-op.
  - workouts: reuse the existing mi-band create/put path (no GPS).
- [ ] add a `vitals_import` branch to `createInboxApplier` in `web/cloud/js/inbox-apply.js` that calls `vitals.importSamples(...)`, deriving deterministic ids from `eventId` + sample instant (matching the `tg-${eventId}` discipline) so the drain's ack-after-flush barrier stays exactly-once.
- [ ] integration test (`frontend-harness.js`): apply a `vitals_import` event, assert sleep+hr+spo2+stress+daystats+workout vault records exist and GPS is absent; apply the **same** event again, assert no duplicates / records converge.

### Task 5: Upload UI control

- [ ] add an NXK file-upload control (`<input type="file" accept=".nxk,.sqlite">` + a button) to the shared Settings → Import/Export section (near where C2e import/export lives); reuse existing design tokens / CSS classes — no hardcoded colors, no inline `.style.` assignments.
- [ ] on submit, POST the file as multipart to `/api/vitals/import`; show a success/queued toast and a failure state. Reuse existing toast/helpers; do not add a new `window.*` global (or add an allowlist entry with justification if unavoidable).
- [ ] confirm `tests/architecture.native-abstractions.test.js` does not flag a plain `<input type=file>` (it bans `getUserMedia`/`BarcodeDetector`, not file inputs); if it does, route through the existing abstraction.

### Task 6: Verify acceptance criteria

- [ ] `go build ./...` and `go build -tags mobile ./...` both pass (`internal/cloudserver` is server-build; ensure no mobile-tag breakage).
- [ ] `go test ./internal/cloudserver/... ./internal/cloudstore/...` pass.
- [ ] `pnpm test` passes (incl. domain-purity + architecture guards).
- [ ] end-to-end demonstrated in tests: fixture `.nxk` → events sealed to a test inbox → client applier writes sleep+hr+spo2+stress+daystats+workout (no GPS) vault records with deterministic ids → re-drain is a no-op. GPS is asserted absent.
- [ ] `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt` passes with the new exempt entry.
- [ ] run linter — all issues fixed.

### Task 7: [Final] Update documentation

- [ ] update `docs/cloud-mode.md` vitals section: cloud vitals ingestion now exists via NXK upload + Telegram `.nxk`, server-parse-then-seal, no webhook, no GPS. Remove/adjust the "Vitals is empty until C2e" / "external Mi Band Notify webhook left unmapped" notes.
- [ ] update the `apishim.js` route-table note (:490-499) that lists the Mi Notify webhook as intentionally unrouted, to reflect the new import path (still no live webhook).

## Technical Details

- **Sealed event shape:** `{kind:"vitals_import", import:"<stable-id>", at_unix:<int>, sleep:[…], hr:[…], spo2:[…], stress:[…], daystats:[…], workouts:[…]}`. Streams mirror `internal/store/vitals/repo.go` + `miband.go` field names so the client writes match existing read shapes. GPS omitted entirely.
- **Idempotency:** day-batched streams keyed `${type}-${utcDay}`, samples merged by instant (LWW); sleep/daystats/workouts upserted by natural key. Applier ids derive from `eventId` — re-drain converges; the existing ack-after-flush barrier gives exactly-once.
- **Trust boundary:** upload endpoint is `RequireSession`; Telegram path uses the existing linked-bot flow. Both drop the payload if no inbox key is published (`ErrNoInboxKey`) rather than storing plaintext.
- **No new migration, no new dependency, no per-account token, no live webhook, no GPS.**

## Post-Completion

**Manual verification:**
- In a real cloud account with a linked Telegram bot + published inbox key: send a real `.nxk` to the bot → confirm the "queued" ack → open the app → confirm HR/SpO2/sleep/stress/daystats/workout appear in Vitals after the drain, and that a second send does not duplicate.
- Upload the same `.nxk` via the Settings control → same result; re-upload is a no-op.
- Confirm no GPS tracks appear anywhere.

**External system updates:** none.
