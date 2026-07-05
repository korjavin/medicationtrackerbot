# C2a: Cloud-Mode Easy Wins — Diary, Settings (incl. Integrations Keys), Vitals Read Side

## Overview

First of the C2 sequence (C2a → C2b meds+tz → C2c food+AI → C2d workouts →
C2e exporter/migration). Ports the three cheapest remaining domains to the
C1 pattern (`web/domain/` module + apishim route table + synced records):

1. **Diary/notes** — plain CRUD, the Health tab's notes subfeature. Nearly
   free: the C0 toy notes already proved the record pattern.
2. **Settings/preferences** — feature toggles, tab order, food targets, and
   the **Integrations screen (BYO provider keys)**. Porting integrations
   moves the OpenAI/food-DB/ElevenLabs keys into the *encrypted vault* —
   strictly better than the server-mode settings row, and the prerequisite
   for C2c's client-side food AI.
3. **Vitals read side** — `/api/health/overview` + `/api/health/sleep`
   aggregates computed over vault records. Ingestion (mi-band webhook,
   sleep import) has no cloud path yet; these records arrive via C2e's
   migration import (months of history) and render empty until then. C2a
   defines the record shapes and the aggregation so that import has a
   target.

Everything follows C1's conventions exactly: server JSON field names in
record bodies, runtime-agnostic domain modules (purity guard already
enforces `web/domain/**`), shim clamps, feature flags as the gating switch.

## Context (from discovery)

- **Diary routes** (UI: `features/health.js:518,1120,1178,1263,1289`):
  `GET /api/notes?limit=…`, `POST /api/notes`, `DELETE /api/notes/{id}`.
  Server logic: `internal/domain/notes.go` (~100 lines), repo
  `internal/store/diary/` — plain CRUD, mirror the handler shapes.
- **Settings routes** (UI: `features/settings.js`,
  `features/settings/integrations.js`, `core/bootstrap.js:79`):
  `GET|POST /api/settings`, `GET /api/settings/features`,
  `POST /api/settings/features/{feature}`, `POST /api/settings/tab-order`,
  `GET|PATCH /api/settings/integrations` (integrations.js:91-167),
  `GET|POST /api/food/settings/targets` (food/log.js:1357,1389).
  `PATCH /api/settings/weight-unit` already done in C1
  (`weightunitpref` record — the reference singleton pattern,
  `apishim.js:58-65`).
- **Vitals routes** (UI: `features/health.js:431`,
  `features/today-loader.js:170`): `GET /api/health/overview`,
  `GET /api/health/sleep`. Aggregation logic:
  `internal/server/health_handlers.go:35-54` (SpO2/stress/sleep-hours 7/30d
  windows, HR history, daily sleep stats), `internal/domain/vitals.go`
  (~160 lines). Store: `internal/store/vitals/`.
- **Shim state after C1** (`web/cloud/js/apishim.js`): `FEATURES` map
  gates nav (everything except bp/weight false); `STUBS` registry already
  fakes `GET /api/settings`, `/api/settings/features`,
  `/api/food/settings/targets`; unknown-route console.warn is the
  discovery oracle.
- **C1 conventions to follow**: `web/domain/bp.js` / `weight.js` module
  shape (`create<X>Domain({records, now, timeZone})`), records port from
  `web/cloud/js/sync.js` (`recordsPort(ctx)`), singleton records with fixed
  recordId, purity guard test over `web/domain/**`, shim-mode contract runs
  of existing feature suites.
- **Toy notes overlap**: the C0 cloud-shell demo (`web/cloud/js/notes.js`,
  reachable from the `/unlock` shell's unlocked screen) writes records with
  `recordType 'note'` and body `{text, deleted}`. The real diary feature
  replaces it.

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - contract mechanism (same as C1): run the existing Vitest feature suites for health/notes/settings flows under the shim harness
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- **CRITICAL: bot-mode must not regress.** No changes to `internal/server`,
  `internal/domain`, `internal/store`, `internal/bot`; `web/static` edits
  guard-only; `pnpm test` + `go test ./...` (both tags) green after every task.

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**: shim-mode runs of the existing feature suites
  covering notes (health tab), settings toggles/tab-order/integrations, and
  the health overview render (incl. empty state). Purity guard already
  covers new `web/domain/` files via glob — verify, don't duplicate.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Diary domain module

- [x] create `web/domain/notes.js` exporting `createNotesDomain({records, now})`
      with `list({limit})`, `create(input)`, `remove(id)` mirroring the
      handler shapes in `internal/server` (find the notes handlers; response
      field names verbatim — check what `features/health.js` reads back)
- [x] record: `recordType 'note'`, body = server JSON fields + `recordId`,
      `clientTs`, `deleted`; newest-first list order, `limit` default
      matching the handler
- [x] retire the cloud-shell demo notes screen: remove the Notes button +
      `web/cloud/js/notes.js` screen from the unlocked shell (the real app
      is the UI now); keep `sync.js`'s generic record functions; migrate
      nothing (demo data is disposable, and old `{text}` bodies simply
      render as notes with empty fields if any survive — acceptable on the
      test rig)
- [x] shim: route `GET/POST /api/notes` + `DELETE /api/notes/{id}`;
      remove any overlapping stub

### Task 2: Settings domain module — general, features, tab order, targets

- [x] create `web/domain/settings.js` exporting
      `createSettingsDomain({records, now})` managing singleton records
      (fixed recordIds, C1 `weightunitpref` pattern): `'settings'` (general
      row: timezone etc. — mirror `GET /api/settings` response fields),
      `'features'` (toggle map), `'taborder'`, `'foodtargets'`
- [x] shim: make `GET/POST /api/settings`, `GET /api/settings/features`,
      `POST /api/settings/features/{feature}`, `POST /api/settings/tab-order`,
      `GET/POST /api/food/settings/targets` live; delete the corresponding
      STUBS entries
- [x] **feature-flag clamp**: the shim's effective flags =
      (stored `'features'` record ∨ defaults) ∧ PORTED_SET — a user toggle
      can never enable a domain the shim can't serve; unported features
      stay hidden in the Settings toggle list too if the UI reads the same
      filtered map (verify how settings.js renders toggles)
- [x] bootstrap payload (`apishim.js` `/api/bootstrap`): source
      feature flags + settings from the records instead of hardcoded stubs

### Task 3: Integrations — provider keys as an encrypted vault record

- [x] extend `web/domain/settings.js` with the `'integrations'` singleton
      record mirroring `GET/PATCH /api/settings/integrations` shapes
      (see `features/settings/integrations.js:91-167` for what the UI
      sends/expects: OpenAI text + vision key/url/model, food-DB
      key/url/domain, ElevenLabs — masked-read semantics if the server
      does masking; check the handler)
- [x] shim: route both methods; the Integrations screen in Settings must
      round-trip (enter key → save → reload → masked/read back)
- [x] do NOT wire any consumer yet (client-side AI calls are C2c); this
      task only makes the keys live encrypted in the vault
- [x] docs note for later: record body holds secrets — confirm nothing
      logs record bodies (grep the sync/shim paths for console logging of
      decrypted bodies; the C1 unknown-route warn logs only paths)

### Task 4: Vitals read side — record shapes + aggregates

- [x] define vault record shapes for the vitals streams, matching the
      store schema field names (`internal/store/vitals/`): `'sleep'`
      (sessions), `'daystats'` (daily aggregates), `'hrsample'`,
      `'spo2sample'`, `'stresssample'` (continuous samples) — these are the
      C2e import targets; document each in the plan-completion notes
- [x] create `web/domain/vitals.js` exporting
      `createVitalsDomain({records, now, timeZone})` with `overview()` and
      `sleep()` reproducing `health_handlers.go:35-54` +
      `internal/domain/vitals.go` aggregation (7/30d windows, daily sleep
      stats); correct empty-state shapes when no records exist (the normal
      case until C2e)
- [x] shim: route `GET /api/health/overview` + `GET /api/health/sleep`;
      flip the `health` feature flag on — the Vitals nav slot appears and
      renders the empty state cleanly (no console errors, no infinite
      spinners)

### Task 5: Shim-mode contract runs

- [x] extend the C1 shim harness suites: notes CRUD flow through the real
      `features/health.js` UI path; settings toggle + tab-order + targets
      round-trips; integrations save/read-back; health overview empty-state
      render — additive test files per C1 convention, originals untouched
      (`cloud.shim-contract.notes.test.js`, `cloud.shim-contract.settings.test.js`)
- [x] seed-data variant for vitals: inject records through the in-memory
      port and assert the overview aggregates match the handler semantics
      for a small fixture (one week of sleep + samples)
      (`cloud.shim-contract.vitals.test.js`)
- ➕ writing the settings contract test surfaced a real gap from Task 2:
      `GET /api/settings/features` was never routed in `apishim.js` — it
      silently 404'd and fell back to `/api/settings`'s embedded features
      slice (functionally masked by `fetchBundle`'s fallback chain, but
      every Settings load hit the unmapped-route console.warn). Fixed by
      routing it to `clampFeatures(await settings.getFeatures())`, same as
      the `/api/init` stub.

### Task 6: Verify acceptance criteria

- [ ] Health tab: notes create/list/delete work in cloud mode; vitals
      overview renders (empty state without data, real numbers with seeded
      data); Settings: toggles persist across reload, integrations keys
      round-trip, tab order applies
- [ ] feature clamp holds: enabling an unported feature is impossible
- [ ] `pnpm test` fully green (old + new suites);
      `go build ./... && go build -tags mobile ./...` and
      `go test -count=1 ./...` green
- [ ] run linters — all issues fixed

### Task 7: [Final] Update documentation

- [ ] `docs/cloud-mode.md`: C2a status in phasing; document the new record
      types (`note`, `settings`, `features`, `taborder`, `foodtargets`,
      `integrations`, vitals streams) and the integrations-keys-in-vault
      property (BYO keys are now E2EE — better than server mode); note the
      vitals empty-until-migration behavior
- [ ] `CLAUDE.md`: no structural change expected — confirm the cloud-mode
      index row mentions C2a
- [ ] update the C2 sequence note (this file's Overview) if scope shifted

## Technical Details

- **Record types added**: `note`, `settings`, `features`, `taborder`,
  `foodtargets`, `integrations`, `sleep`, `daystats`, `hrsample`,
  `spo2sample`, `stresssample`. Singletons use fixed recordIds (C1
  pattern); sample streams are one record per sample **only for C2e import
  granularity discussion** — if per-sample records would explode the oplog
  (a 90-day Mi-Band history is ~9k HR samples), C2e may batch them
  (e.g. one record per stream-day); C2a should define shapes that allow
  day-batched bodies (`{date, samples:[…]}`) from the start — decide while
  implementing Task 4 and record the decision here with ➕
  ➕ **Decided in Task 4**: `hrsample`/`spo2sample`/`stresssample` are
  day-batched — one record per stream-day, `recordId` keyed by day,
  body `{day, samples: [{date_time, tz_offset, value[, info]}]}`. `sleep`
  and `daystats` are one record per session/day respectively (already
  natural granularity, no batching needed). `web/domain/vitals.js`
  expands the batched sample arrays in-memory before bucketing/averaging,
  so the aggregation math is unaffected by the storage granularity choice.
- **Integrations record holds secrets**: it is encrypted like everything
  else, but treat it as the most sensitive record — no logging of bodies,
  and the masked-read behavior of the server (if any) should be reproduced
  by the domain module, not skipped
- **Vitals timezone**: same accepted deviation as C1's BP stats — device
  timezone instead of server tz table
- **The shim's unknown-route warn list shrinks with every task** — after
  C2a, remaining warns should only be meds/food/workout/tz/gamification
  routes; paste the post-C2a list into the C2b/C2c plans as they're written

## Post-Completion

*No checkboxes — informational.*

**Manual verification on the rig**: unlock → Vitals tab renders empty state;
add a note, reload, second device sees it; set food targets + toggle a
feature + reorder tabs, reload both devices; enter a dummy OpenAI key in
Integrations, confirm round-trip, then check `cloud admin inspect` shows
only sizes/tags for the new record types (leakage ground truth still holds).

**Deferred by design**: vitals ingestion (mi-band/sleep import) — arrives
with C2e migration import; client-side AI consumers of the integrations
keys — C2c; gamification stays flagged off.
