# Cloud-only composite health analysis (analyze_cardiovascular / analyze_fitness) — Path B

## Overview

Bot mode has two top-level composite MCP tools, `analyze_cardiovascular` and
`analyze_fitness` (`internal/mcp/cardiovascular.go`, `internal/mcp/fitness.go`),
that aggregate multi-row health data server-side. Cloud has no equivalent and no
`mcp_execute`, so a cloud agent would have to chain dozens of `mcp_call` reads
(bd med-eas.56).

This adds the two analyses to cloud **as cloud-only ops** — computed in-tab over
vault data, discoverable via `mcp_help` and callable via `mcp_call` — **with zero
Go / bot changes** (Path B, per the cloud-primary/bot-legacy direction). The cloud
MCP catalog is normally generated from the Go registry and drift-checked; instead
we add a **separate** cloud-extra ops file merged into the responder's catalog at
load, keeping the generated file untouched. A pure `web/domain/analysis.js`
reproduces the aggregation; two routes in the cloud router serve it.

**Acceptance:** in cloud, `mcp_help` lists both analyses and `mcp_call` returns the
same shape of aggregated summary bot mode returns, computed client-side over vault
data; no server runtime; **no Go touched** and the catalog drift test stays green.

## Context (from discovery)

### The cloud-only catalog seam (merge-only)
- `web/cloud/js/mcp-responder.js`: imports `CATALOG` from `./mcp-catalog.generated.js` (`:17`), re-exports it (`:22`), builds `BY_ID` (`:50`) and `TOPICS` (`:51`) from it. **Every** consumer — `mcp_help` enumeration (`buildHelp` `:166`, search `:120`), `mcp_call` dispatch (`handle` `:517` via `BY_ID` + `dispatch(op,…)` `:566`), the voice `CloudMCPDispatcher` (`apishim.js:899` → same `createDispatcher`), the relay responder (`:729`), and the tests (`mcp-responder.test.js:10` imports `{CATALOG}` from the responder) — reads these module bindings. So merging a cloud-extra array at the import site surfaces the ops **everywhere at once**, including the test sweeps.
- Merge point: replace `:17`/`:22` with `import {CATALOG as GENERATED}` + `import {CLOUD_EXTRA} from './mcp-catalog.cloud-extra.js'` + `export const CATALOG = [...GENERATED, ...CLOUD_EXTRA]`. No other responder change.
- **Drift stays green:** `internal/mcp/catalogjs/drift_test.go` parses only the `export const CATALOG` literal out of the *generated* file by text (`:18-56`); it never imports the responder or the cloud-extra file. Leave `mcp-catalog.generated.js` byte-for-byte unchanged (never hand-edit it) — extras live only in the new file.

### Op entry shape (`mcp-catalog.generated.js`)
Every op: `{id, topic, method, path, risk, description, response_summary}`; optional `params_schema`, `body_schema`, `path_params`, `required`, `response_example`. Reference GET-with-params: `health.sleep.list` (`:730-761`). Each analysis op = `{id:"health.analyze_cardiovascular"|"health.analyze_fitness", topic:"health", method:"GET", path:"/api/health/cardiovascular-analysis"|"/api/health/fitness-analysis", risk:"read", description, response_summary, params_schema:{start_date,end_date,days,exclude_notes}, response_example}` (no `path_params`).

### Router (`web/cloud/js/apishim.js`)
- `createApiRouter` (`:109`) builds the domain instances (`bp`, `weight`, `vitals`, `workout`, `food`, `medications`, `intake`, `notes`, `gamification`, …) from one injected `records` port, then `shimCall(endpoint, method, body)` (`:256`) matches by `path`+`method`; no match → `err.noRoute=true` (`:837`) → responder `-32603`.
- Precedent: the gamification-narrate composite route (`:748-763`) reads several domains via `Promise.all` and hands them to a pure composer (`createGamificationNarrator`). `analysis.js` mirrors that exactly.

### Aggregation to reproduce (bot oracle)
`internal/mcp/cardiovascular.go` / `fitness.go` (value-exact tests: `cardiovascular_test.go`, `fitness_test.go`). Params both: `start_date`,`end_date` (YYYY-MM-DD), `days` lookback, `exclude_notes`; default+max window **90d**. Per-section feature-gated; a disabled/failed section is added to an `unavailable` warning list, never aborts.
- **cardiovascular** → `{period, blood_pressure?, medications?, sleep?, heart_rate?, spo2?, diary_notes?, warning?}`: BP `avg_systolic`/`avg_diastolic` (integer mean) + `days_measured` (distinct dates); medications adherence = taken/total*100 over **resolved** intakes (TAKEN/SKIPPED/MISSED + overdue PENDING; future PENDING skipped); sleep `avg_duration_minutes`/`avg_deep_minutes` (integer means over non-nil); heart-rate `avg`/`min`/`max`/`readings_count`; spo2 `avg`/`min`/`readings_count`; diary notes unless `exclude_notes`. Gates: `bp`, `medications`.
- **fitness** → `{period, workouts?, steps?, nutrition?, weight?, diary_notes?, warning?}`: workouts (history in range + resolve group/variant names, mi-band counted completed, `completion_rate`=completed/total*100); steps `avg_daily_steps` over days-with-data; nutrition per-day calorie/protein/carb/fat sums with **food names dropped**, `avg_daily_calories`/`avg_daily_protein`; weight `current_kg` (newest), `change_kg` (current−oldest), `trend_direction` gaining/losing/stable (±0.1 kg) or `insufficient_data` (<2), **kg only**. Gates: `workout`, `food`, `weight`.

### Domain inputs (all already built in `createApiRouter`)
BP `bp.list`; meds `medications.list` + `intake.history`; sleep `vitals.sleep({from,to,days})` (windowed — OK); workouts `workout.listSessions/getStats/listMiBand`; nutrition `food.stats/listGrouped`; weight `weight.list`; notes `notes.list`. **Windowed-vitals gap:** `web/domain/vitals.js` exports only `{overview, sleep, importSamples}` (`:466`); `overview()` is fixed 7d/30d, and raw HR/SpO2 samples + daystats(steps) readers (`readSamples`/`readDayStats`) are internal — **no exported windowed HR/SpO2/steps read**. This is the one pure-domain code addition needed (still zero Go).

### Tests
`web/cloud/js/tests/mcp-responder.test.js` imports the **merged** `CATALOG`, so: the coverage sweep (`:987`) drives each cloud-extra op through `createApiRouter` and **requires** the two routes; help-count assertions self-adjust; the `response_example` conformance check (`:1236`) validates each example's shape automatically **if** the op carries `response_example` — which needs a seed fixture in `inputsFor`/`seedFixtures` so the seeded records yield a non-empty result. Domain purity: `web/static/js/tests/architecture.domain-purity.test.js` covers `analysis.js` + `vitals.js` automatically.

## Development Approach

- **Testing approach:** Regular. Zero Go. All new logic is pure `web/domain/*.js`; the only cloud-plumbing edits are the responder merge line, the cloud-extra file, and two router routes.
- **Parity oracle:** the JS aggregation must match the Go output shape/values. Path B runs no Go in tests, so model the `analysis.js` unit tests on the fixtures + expected values in `internal/mcp/cardiovascular_test.go` / `fitness_test.go` (hand-port the expectations) — integer means, adherence formula, completion_rate, weight ±0.1 kg trend, kg-only, food-names-dropped.
- Every task ends with passing tests before the next.

## Testing Strategy

- `web/domain` unit tests for `analysis.cardiovascular`/`fitness` (seed records via `createInMemoryRecordsPort`, assert the aggregated JSON against Go-test-derived expectations; cover a feature-disabled/empty-section case → `unavailable`). Windowed-vitals accessor test. The mcp-responder coverage sweep + response_example conformance exercise the two ops end-to-end through the real router.

## Progress Tracking

- Mark items `[x]` immediately. `➕` new tasks, `⚠️` blockers.

## Implementation Steps

### Task 1: Windowed vitals accessor (web/domain/vitals.js)
- [x] Export a windowed read for raw heart-rate + SpO2 samples and for daystats (steps) over an arbitrary `[from,to]` range (reuse the internal `readSamples`/`readDayStats`; e.g. `listHeart({from,to})`, `listSpO2({from,to})`, `listDayStats({from,to})`, or an `overviewRange({from,to})`). Keep `overview`/`sleep`/`importSamples` unchanged.
- [x] Write tests for the new windowed reads (seeded samples over a range → expected aggregates/rows).
- [x] Run the vitals domain test + `architecture.domain-purity.test.js` — must pass before Task 2.

### Task 2: analysis.js — cardiovascular (web/domain/analysis.js)
- [ ] Create `web/domain/analysis.js` exporting a pure factory `createAnalysis({ bp, vitals, medications, intake, food, weight, workout, notes, now, timeZone })`.
- [ ] Implement `cardiovascular({from,to,days,excludeNotes})`: resolve the range (default+max 90d), then per-section gated aggregation matching the Go output — BP (avg sys/dia integer + days_measured), medications (adherence over resolved intakes), sleep (avg duration/deep), heart_rate (avg/min/max/count), spo2 (avg/min/count), diary notes unless excluded; disabled/empty section → `unavailable` warning list. Match the `{period, blood_pressure?, …, warning?}` shape exactly.
- [ ] Write tests seeding bp/meds/intake/sleep/hr/spo2/notes records and asserting the JSON against `cardiovascular_test.go`-derived expectations; add a gated-off/empty case.
- [ ] Run the analysis test + domain-purity — must pass before Task 3.

### Task 3: analysis.js — fitness
- [ ] Implement `fitness({from,to,days,excludeNotes})`: workouts (completion_rate incl. mi-band + group/variant names), steps (avg_daily_steps), nutrition (per-day macro sums, **food names dropped**, avg calories/protein), weight (current_kg/change_kg/trend_direction ±0.1 kg, **kg-only**), diary notes; gates workout/food/weight; `unavailable` list. Match the `{period, workouts?, …, warning?}` shape.
- [ ] Write tests against `fitness_test.go`-derived expectations + a gated-off case.
- [ ] Run the analysis test — must pass before Task 4.

### Task 4: Cloud-extra catalog + responder merge
- [ ] Add `web/cloud/js/mcp-catalog.cloud-extra.js` exporting `CLOUD_EXTRA = [ {…cardiovascular op}, {…fitness op} ]` with `id, topic:"health", method:"GET", path, risk:"read", description, response_summary, params_schema:{start_date,end_date,days,exclude_notes}, response_example` (example copied from a real `analysis.js` result for seeded data).
- [ ] Edit `web/cloud/js/mcp-responder.js` `:17`/`:22`: merge `export const CATALOG = [...GENERATED, ...CLOUD_EXTRA]`. No other responder change. **Do not touch `mcp-catalog.generated.js`.**
- [ ] Confirm drift: run `go test ./internal/mcp/catalogjs/...` — must still pass (generated file unchanged).
- [ ] Add/confirm a test that `mcp_help` enumeration includes both new op ids (rides the existing sweep).
- [ ] Run `pnpm test` for `mcp-responder.test.js` help-count/enumeration — must pass before Task 5.

### Task 5: Router routes (apishim.js)
- [ ] In `createApiRouter`, instantiate the analysis composer (~`:143`) from the already-built domains: `const analysis = createAnalysis({ bp, vitals, medications, intake, food, weight, workout, notes, now, timeZone })`.
- [ ] Add two routes (near the other `/api/health/*` routes): `GET /api/health/cardiovascular-analysis` and `GET /api/health/fitness-analysis`, parsing `start_date`/`end_date`/`days`/`exclude_notes` from the query, applying the feature gates, and returning `analysis.cardiovascular(...)` / `analysis.fitness(...)`.
- [ ] Add seed fixtures for the two ops in `mcp-responder.test.js` `inputsFor`/`seedFixtures` so the `response_example` conformance check has non-empty results (no new assertions — the sweep + conformance validate automatically).
- [ ] Run `web/cloud/js/tests/mcp-responder.test.js` — coverage sweep (both routes served) + response_example conformance must pass before Task 6.

### Task 6: Verify acceptance + full suite
- [ ] Verify both analyses appear in `mcp_help` and return correct aggregates via `mcp_call` in cloud; **no Go changed**; `mcp-catalog.generated.js` untouched.
- [ ] Run `go build ./...` (should be untouched), `go test ./internal/mcp/catalogjs/...` (drift green), and the full frontend suite (`pnpm test`) incl. domain-purity + globals — all must pass.

### Task 7: [Final] Docs
- [ ] Update `web/cloud/js/mcp-responder.js` USAGE_PROTOCOL: cloud now offers the two composite analyses (still no `mcp_execute`; these are the aggregation shortcut).
- [ ] Update `docs/cloud-bot-parity.md`: move the composite-analysis row from gap to **parity**, noting it's served via a cloud-only catalog seam (no bot).

## Technical Details

- **Why a separate cloud-extra file, not editing the generated one:** the generated file is drift-guarded against the Go registry; hand-editing it fails `drift_test.go`. A separate `mcp-catalog.cloud-extra.js` merged in the responder keeps drift green and cleanly marks these as cloud-only.
- **One merge covers all surfaces:** responder help/call, the voice `CloudMCPDispatcher`, the relay responder, and the tests all read the one module-level `CATALOG`. Adding the routes once (single `createApiRouter`) covers both router instances.

## Post-Completion

**Manual verification** (needs a cloud account with seeded data):
- In a cloud session, `mcp_help` → confirm both analyses are listed; `mcp_call` each → confirm the summary matches what bot mode returns for the same window.
