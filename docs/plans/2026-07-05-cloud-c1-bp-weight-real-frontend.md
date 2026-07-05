# C1: Cloud-Mode First Data Slice — BP + Weight Through the Real Frontend

## Overview

C0 gave the cloud service accounts, passkeys, device lifecycle, and an encrypted
oplog sync engine with a toy Notes feature. C1 makes the first *real* health
domains — blood pressure and weight — work in cloud mode, rendered by the
**actual `web/static` frontend** (not a parallel UI), with all data living as
encrypted records in the C0c vault.

Three pillars:

1. **`web/domain/` — a runtime-agnostic JS domain layer** for BP + weight.
   Pure modules with injected ports (records store, clock, timezone), zero
   browser globals. This constraint is load-bearing: C6 later embeds this same
   code in the Go server via goja, so nothing in `web/domain/` may touch
   `window`, `document`, `fetch`, or IndexedDB directly.
2. **An `apiCall` shim** that installs into the existing
   `window.offlineAwareApiCall` slot (the single seam `api.js` already
   delegates through) and routes `/api/bp*` + `/api/weight*` to the domain
   layer, stubbing everything else with empty-but-valid shapes.
3. **`cmd/cloud` serves `web/static`** on account subdomains, with a cloud
   boot path in `app.js` (mirroring the existing mobile-build pattern):
   warm-unlock from the LDK cache, redirect to the unlock shell when locked,
   nav filtered to the ported sections via the feature-flag mechanism.

Bot-mode safety: every `web/static` change is an additive guard keyed on a
cloud bootstrap flag (same pattern as `window.__MEDTRACKER_BOOTSTRAP__` for
mobile); all existing Vitest suites must pass unchanged; Go changes to
`internal/server` are zero.

## Context (from discovery)

- **API surface to port** (`internal/server/bp_handlers.go`, `weight_handlers.go`):
  BP: POST/GET `/api/bp`, DELETE `/api/bp/{id}`, GET `/api/bp/goal`, GET `/api/bp/stats`.
  Weight: POST `/api/weight` (incl. `?replaces=<id>`), GET `/api/weight`,
  DELETE `/api/weight/{id}`, GET `/api/weight/goal`.
  Out of scope: reminder endpoints (Telegram plumbing), `/api/bp/import`
  (+gamification rescore), `/api/{bp,weight}/export` CSV (raw-fetch path),
  `/api/weight/goals/history` (MCP-only), `body_fat_trend`/`muscle_mass_trend`
  (import-only columns).
- **Real domain logic to port** (small and pure):
  - `CalculateBPCategory` + `CategorySeverity` (`internal/store/bp/repo.go:95,116`) — AHA buckets.
  - `CalculateWeightTrend` EMA α=0.1 (`internal/store/weight/repo.go:77`), seeded with current weight when no prior trend; the `?replaces=` edit path excludes the replaced row when finding the previous trend (`weight_handlers.go:39-45`).
  - Daily-weighted BP stats over 14/30/60d windows (`bp/repo.go:346`): average per local day first, exclude `ignore_calc` rows, timezone-aware.
  - Weight goal read model (`weight_handlers.go:215`): current goal merged with highest-ever weight + date.
- **The seam**: `apiCall` (`web/static/js/core/api.js:203`) delegates to
  `window.offlineAwareApiCall` when present, else `apiCallDirect`. Replacing
  that one slot reroutes all ~20 BP/weight call sites. Known bypasses: CSV
  export raw `fetch` (out of scope), and `data-store.js`'s change poller using
  `apiCallDirect` (handled by disabling the change stream in cloud mode —
  local writes already repaint via `applyOptimistic`, and sync pulls
  invalidate tags explicitly).
- **C0c sync engine** (`web/cloud/js/sync.js`): generic `writeRecord(ctx, recordType, record)`
  already exists; notes are just wrappers. `pullOnOpen`, `flushPending`
  (seq-prediction + re-pull retry), `maybeSnapshot` (threshold 500) are reused
  as-is. Record AAD binds `accountId‖recordType‖recordId‖seq`; the only
  plaintext server-side metadata is `record_type_tag` = `"<type>:<id>"`.
- **Serving**: `cloudserver.Handler` (`internal/cloudserver/router.go`) host-routes;
  subdomains currently rewrite `/`,`/claim`,`/recover` → `signup.html` from the
  embedded `web/cloud` FS. Strict CSP: `default-src 'self'`, no inline script.
- **Boot patterns to mirror**: mobile short-circuits `checkAuth()` on
  `window.__MEDTRACKER_BOOTSTRAP__?.apiBase` (CLAUDE.md rule 11); Telegram SDK
  is dynamically loaded by `messenger-adapter.js` only outside Capacitor; the
  bottom nav filters disabled features before mount (CLAUDE.md rule 6).

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component flow) and gives a guarantee manual checking can't
  - the chosen contract mechanism is: run the existing BP/weight Vitest feature suites with the shim installed (shim-mode harness) — that IS the cross-implementation boundary test
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- **CRITICAL: bot-mode must not regress.** `web/static` edits are guard-only
  (keyed on the cloud flag); `pnpm test` and `go test ./...` (both build tags)
  must stay green after every task. No changes to `internal/server`,
  `internal/domain`, `internal/store`, `internal/bot`.

## Testing Strategy

- **Unit tests**: none. Do not add unit tests.
- **Integration tests**:
  - shim-mode runs of the existing `web/static/js/tests` BP + weight feature
    suites (the Go↔JS drift alarm — see Task 7)
  - one Vitest purity guard for `web/domain/` (no browser globals)
  - one Go routing test for the new static-app serving in `cloudserver`
- **E2E tests**: none (no existing e2e suite).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: Generalize the record store port in the cloud sync engine

- [x] in `web/cloud/js/sync.js`, export a generic `listRecords(ctx, recordType)` (live records of a type from the local mirror, sorted by `clientTs` desc) alongside the existing generic `writeRecord`; reimplement `listNotes` on top of it
- [x] export a `recordsPort(ctx)` factory returning `{ list(type), put(type, record), del(type, recordId) }` — the object handed to `web/domain/` as its storage port; `del` writes a tombstone (`deleted: true`) via `writeRecord`, matching the notes pattern
- [x] keep all crypto/seq/snapshot behavior untouched — this task is exports-only refactoring; existing cloud shell must behave identically

### Task 2: `web/domain/` — runtime-agnostic BP domain module

- [x] create `web/domain/bp.js` (ES module, no browser globals) exporting `createBPDomain({ records, now, timeZone })` with methods mirroring the server contract: `create(input)`, `list({days, limit})`, `remove(id)`, `getGoal()`, `setGoal(goal)`, `getStats()`
- [x] port `calculateBPCategory` + `categorySeverity` from `internal/store/bp/repo.go:95` — identical buckets and strings; apply category at write time only when input category is empty and `ignore_calc` is false (same as `CreateReading`)
- [x] port daily-weighted stats (`bp/repo.go:346`): group readings by local calendar day in `timeZone`, average per day, then average the day-averages over 14/30/60-day windows; exclude `ignore_calc` rows; return the server's `{stats_14, stats_30, stats_60}` shape with `{systolic, diastolic, days, readings}` (ints, same rounding)
- [x] record shape: `recordType 'bp'`, body carries the server JSON field names (`measured_at` RFC3339, `systolic`, `diastolic`, `pulse`, `site`, `position`, `category`, `ignore_calc`, `notes`, `tag`); `id` = `recordId`; list applies `days`/`limit` filters and newest-first ordering exactly like `handleListBloodPressure`
- [x] BP goal: singleton record `recordType 'bpgoal'` (fixed recordId), body `{target_systolic, target_diastolic}` — nullable ints like the server response

### Task 3: `web/domain/` — runtime-agnostic weight domain module

- [x] create `web/domain/weight.js` exporting `createWeightDomain({ records, now, timeZone })` with `create(input, {replacesId})`, `list({days, limit})`, `remove(id)`, `getGoal()`, `setGoal(goal)`
- [x] port the EMA trend (α=0.1): previous trend = trend of the newest log by `measured_at` excluding `replacesId` (the `?replaces=` edit semantics from `weight_handlers.go:39-45`); seed with current weight when no prior log
- [x] record shape: `recordType 'weight'`, server field names (`measured_at`, `weight`, `weight_trend`, `body_fat`, `muscle_mass`, `notes`); skip `body_fat_trend`/`muscle_mass_trend` (import-only server-side)
- [x] weight goal: `recordType 'weightgoal'`, append-only like the `weight_goals` table (`set_at`, `target_weight`, `target_date`, `start_weight`); `getGoal()` reproduces `handleGetWeightGoal`'s merged response: latest goal + `highest_weight`/`highest_date` derived from the weight records
- [x] Vitest purity guard `web/static/js/tests/architecture.domain-purity.test.js` (or alongside existing arch tests): source of every file under `web/domain/` contains no `window.`, `document.`, `fetch(`, `indexedDB`, `navigator.` — the C6/goja portability invariant

### Task 4: The apiCall shim

- [x] create `web/cloud/js/apishim.js` exporting `installApiShim(ctx)`: builds the domain instances over `recordsPort(ctx)` and assigns `window.offlineAwareApiCall = shimCall`
- [x] route table: method+path patterns for the ported endpoints → domain calls, returning the exact server JSON shapes (including `{imported:…}`-style envelopes where the server has them); `?days=`/`?limit=`/`?replaces=` query parsing to match handler defaults (`days` default 30 for BP list / 30 for weight list, `limit` 100)
- [x] stub registry for boot-path endpoints the frontend calls unconditionally: `/auth/status` → `{authenticated:true, method:"cloud"}`, `/api/bootstrap` → minimal payload with feature flags enabling only Today/BP/Weight/Settings (nav filters the rest before mount — CLAUDE.md rule 6), reminder-status endpoints → disabled shape, `/api/settings*` reads → sane defaults; every stub logs once at debug so gaps are discoverable
- [x] unknown `/api/*` route → reject like a 404 `apiCall` error (never silently hang), with a console.warn naming the path — this is the discovery mechanism for endpoints C2 must port
- [x] writes that reach the shim while a sync flush is pending must still resolve immediately with the domain result (local-first: the oplog flush is async, same UX as the current optimistic path)

### Task 5: Serve `web/static` from cmd/cloud

- [x] add an embed of `web/static` reachable from `cmd/cloud` (check how `internal/server` exposes it today — reuse the same embed package if one exists rather than embedding twice; otherwise add `web/static/embed.go`)
- [x] `internal/cloudserver/router.go`: on account subdomains, serve the app — `/` → `web/static/index.html`, static assets from the app FS; move the shell to explicit paths (`/unlock`, `/claim`, `/recover` → `signup.html` rewrites as today); `/api/*` unchanged
- [x] CSP audit: `web/static/index.html` must load under `default-src 'self'` — verify no inline scripts/styles break; if the page has inline bootstrap snippets, move them to a file served same-origin (do NOT weaken the CSP)
- [x] confirm `index.html` contains no `telegram.org` script tag (rule 11 already guarantees this) and that the placeholders (`VERSION_PLACEHOLDER`) render harmlessly in the cloud build
- [x] Go routing test in `internal/cloudserver/router_test.go`: subdomain `/` serves the app index, `/unlock` serves the shell, assets resolve, unknown subdomain still 404s

### Task 6: Cloud boot path in the frontend

- [x] serve a tiny `cloud-boot.js` (from `web/cloud/js/`, loaded by a script tag the cloud router injects — or a cloud-only variant of index.html if injection is uglier) that runs before `app.js`: sets `window.__MEDTRACKER_CLOUD__ = true`, attempts warm unlock via the LDK cache (`web/cloud/js/unlock.js` readLdkRecord/unwrapWithLdk), on success builds `ctx` and calls `installApiShim(ctx)` + kicks `pullOnOpen(ctx)`, on failure redirects to `/unlock`
- [x] `app.js` `checkAuth()`: short-circuit on `window.__MEDTRACKER_CLOUD__` (exact mirror of the `__MEDTRACKER_BOOTSTRAP__` mobile pattern) — never render the Telegram login screen in cloud mode
- [x] guard `messenger-adapter.js` `loadTelegramSdk()`: skip when `__MEDTRACKER_CLOUD__` (CSP would block telegram.org anyway; fail closed, not noisily)
- [x] guard `web/static` service-worker registration: skip when `__MEDTRACKER_CLOUD__` (the cloud origin already has `web/cloud/sw.js`; two SWs on one scope is a fight we skip — ponytail: revisit offline-app-shell for cloud in C2)
- [x] disable the DataStore change stream (SSE/poller) in cloud mode via the same flag; after each `pullOnOpen` that applied ops, call `DataStore.invalidateTags(['bp','weight'])` so remote changes repaint
- [x] `/unlock` shell: after successful unlock/enrollment, `location.href = '/'` (the LDK cache carries the DEK across — `establishLdkCache` already runs on every unlock path)
- [x] new `window.*` globals get allowlist entries in `tests/architecture.globals.test.js` with justification (rule 4)

### Task 7: Shim-mode contract runs of the existing feature suites

- [x] add a shim-mode harness helper (extend `web/static/js/tests/helpers/frontend-harness.js` or a sibling `cloud-shim-harness.js`): installs `installApiShim` with an in-memory records port (no crypto, no IndexedDB — the port interface makes this trivial) before loading feature files
- [x] run the existing BP feature suite(s) (`features.bp*` / `bp.*.test.js`) under the shim harness: save/list/delete/goal/stats flows must pass against the JS domain layer — divergences are contract bugs, fix them in `web/domain/` (or flag server quirks worth documenting)
- [x] same for the weight suite(s), including the edit (`?replaces=`) flow and trend rendering
- [x] these runs are ADDITIVE test files (e.g. `cloud.shim-contract.bp.test.js`) that import the same describe blocks or drive the same flows — the original suites keep running un-shimmed; both must be green

⚠️ Goal-setting has no confirmed contract bug to fix: the server only exposes `GET /api/bp/goal` / `GET /api/weight/goal` (`internal/server/server.go:825,840`) — there's no POST route in production, so `apishim.js` correctly has no POST handler for either goal endpoint even though `bp.setGoal`/`weight.setGoal` exist in `web/domain/`. The shim-contract tests seed goal/weight records directly via `seedRecords` (simulating a cross-device sync arrival) instead of exercising a nonexistent POST call.

### Task 8: Verify acceptance criteria

- [ ] BP + weight full flows work through the shim: create/list/delete/goal/stats for BP; create/edit-replace/delete/goal for weight; derived fields (category, trend) match server semantics
- [ ] `web/domain/` purity guard green; no new direct store/network calls from feature files
- [ ] `pnpm test` fully green (old suites unchanged + new shim suites)
- [ ] `go build ./... && go build -tags mobile ./...` and `go test -count=1 ./...` (both tags) green
- [ ] run linters (golangci-lint if configured, eslint if configured) — all issues fixed

### Task 9: [Final] Update documentation

- [ ] `docs/cloud-mode.md`: mark C1 implemented in the phasing section; document the shim architecture (offlineAwareApiCall slot, stub registry, unknown-route warning as the C2 discovery mechanism) and the record types (`bp`, `weight`, `bpgoal`, `weightgoal`)
- [ ] `CLAUDE.md`: update the cloud-mode doc index row (C1 status) and the `web/domain/` entry in Code Layout with its purity constraint
- [ ] `docs/cloud-deployment.md`: note that account subdomains now serve the full app; unlock shell moved to `/unlock`

## Technical Details

- **Record types**: `bp` (one per reading), `weight` (one per log), `bpgoal`
  (singleton, fixed recordId `bpgoal`), `weightgoal` (append-only history).
  Bodies use the server JSON field names verbatim so the shim needs no
  translation layer. `id` exposed to the frontend = `recordId` (string UUID —
  the frontend treats ids opaquely; verify no call site does arithmetic on
  numeric ids, and fix the shim if one does).
- **Ports**: `records` = `{ list(type), put(type, record), del(type, id) }`;
  `now()` returns ms epoch; `timeZone` an IANA string (browser:
  `Intl.DateTimeFormat().resolvedOptions().timeZone`). goja later provides Go
  implementations of the same three.
- **Sync semantics unchanged from C0c**: every domain write is one encrypted
  op; LWW on `clientTs`; snapshot at 500 ops; AAD anti-reorder. Bulk import
  is NOT in C1 (arrives with C2's migration pair).
- **Stats parity trap**: Go computes local days via the tz table
  (`tz.Repo.GetCurrent`, UTC fallback); cloud uses the device timezone. Same
  user, same device → same answer; documented as an accepted difference.
- **Change stream**: cloud mode has none in C1 (single-device repaint via
  optimistic path + pull-then-invalidate). Multi-device liveness beyond
  pull-on-open is a C2 concern (the push relay from C0c can carry a "sync"
  nudge later).

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes.*

**Manual verification on the Hetzner rig:**
- redeploy the cloud stack (CI webhook), hard-refresh the account subdomain
- unlock with the Apple Passwords passkey → real app renders with Today/BP/Weight/Settings nav only
- log a BP reading and a weight; confirm category + trend render; reload → data persists (pull from vault); second device (after claim flow) sees the records after its pull-on-open
- check browser console for the shim's unknown-route warnings — that list seeds C2 scoping

**Known deferrals (intentional):**
- CSV export buttons in cloud mode (raw-fetch path) will error — acceptable on the test rig; port or hide in C2
- Reminders UI shows disabled state in cloud mode until C3b (Telegram delivery / local notifications)
- No offline app shell (SW) for the cloud origin yet
