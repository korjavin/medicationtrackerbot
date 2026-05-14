## Frontend Code Review (2026-05-13)

Cross-cutting review of the vanilla-JS frontend (~23.5K lines non-test across
49 production files, plus 41.7K lines across 175 test files). Reviewed:
`web/static/index.html`, `web/static/sw.js`, `web/static/css/styles.css`,
`web/static/js/{app,sync,db,data-store,cached-fetch,push,app-shell}.js`,
`web/static/js/core/*`, `web/static/js/components/*`, and every file under
`web/static/js/features/`.

The findings are grouped by theme, ranked by severity within each theme, and
every claim cites a specific file:line. Where a concern mirrors something the
companion Go review flagged, the section header notes the parallel — the same
class of bug usually appears on both sides of the wire.

## Contents

1. [Architecture: bundler-less load order is the build system](#1-architecture-bundler-less-load-order-is-the-build-system)
2. [`app.js` and `features/{workout,food}.js` as god files](#2-appjs-and-featuresworkoutfoodjs-as-god-files)
3. [Global namespace as the IPC bus](#3-global-namespace-as-the-ipc-bus)
4. [Service Worker duplicates main-thread business logic](#4-service-worker-duplicates-main-thread-business-logic)
5. [Telegram identity coupling on the client](#5-telegram-identity-coupling-on-the-client)
6. [Auth header inconsistency (`X-Telegram-Init-Data` vs `Authorization: tma`)](#6-auth-header-inconsistency-x-telegram-init-data-vs-authorization-tma)
7. [Sync layer: three near-identical pipelines](#7-sync-layer-three-near-identical-pipelines)
8. [Module-level mutable state and weight-unit race scar tissue](#8-module-level-mutable-state-and-weight-unit-race-scar-tissue)
9. [No request timeouts, no `AbortController` anywhere](#9-no-request-timeouts-no-abortcontroller-anywhere)
10. [XSS surface and CSP-blocked inline `onclick=`](#10-xss-surface-and-csp-blocked-inline-onclick)
11. [Silent error swallowing](#11-silent-error-swallowing)
12. [Service Worker ships dead code](#12-service-worker-ships-dead-code)
13. [Cache-key ownership is scattered](#13-cache-key-ownership-is-scattered)
14. [What's already good](#14-whats-already-good)
15. [Lower-priority items](#15-lower-priority-items)
16. [Recommended priority order](#16-recommended-priority-order)

---

## 1. Architecture: bundler-less load order is the build system

There is no bundler. `web/static/index.html` lines 1529–1576 list **52
`<script src>` tags** loaded sequentially; they share state exclusively via
`window.*` globals. Adding a feature file means: edit `index.html` for the
script tag, edit `web/static/sw.js` lines 12–80 for the precache entry,
update `docs/frontend.md` script-load-order table, and probably update
`web/static/js/tests/architecture.globals.test.js` and
`architecture.sw-precache.test.js`.

This is intentional (CLAUDE.md: vanilla JS, no framework) and the architecture
tests do close most of the loops. But the cost is real:

- **Order is fragile.** `features/bootstrap.js` is the *last* tag because it
  runs `checkAuth()` → `mountCanonicalBottomNav()` → `switchTab('today')` and
  needs every other module already on `window`. Anyone moving a tag breaks
  startup with no compile-time error.
- **No dead-code elimination.** `features/settings.js` (252 lines) is
  precached in `sw.js:57` but *not* loaded by `index.html` — see §12. A
  bundler would have caught this on day one.
- **Cache-busting is a string replacement.** Every `<script src>` and the CSS
  link end in `?v=TIMESTAMP_PLACEHOLDER`. Combined with `BUILD_REVISION` in
  `sw.js:6` (manual integer bump), there are now two independent cache-bust
  mechanisms.
- **External script on every page load.** `index.html:18` loads
  `https://telegram.org/js/telegram-web-app.js` synchronously before any
  local script. The CSP at `internal/server/server.go:373` allows it
  (`script-src 'self' https://telegram.org …`), but a Telegram outage / DNS
  block would freeze app startup. There is no `defer` and no `async`.

Adopting an actual bundler (esbuild / Vite / Rollup) is a multi-week
refactor; the cheaper near-term wins are: explicit `defer` on the local
scripts, central manifest of script load order driven by data, and serving
Telegram WebApp SDK from the same origin (CSP would simplify too).

---

## 2. `app.js` and `features/{workout,food}.js` as god files

(Mirrors Go review §2 "Store package as god object" and §6 "Fat HTTP handler files".)

| File                          | Lines  | Top-level functions | Module-level mutable state declarations |
|-------------------------------|--------|---------------------|------------------------------------------|
| `js/app.js`                   | 3,274  | 100                 | 34                                       |
| `js/features/workout.js`      | 3,266  | 100                 | 21                                       |
| `js/features/food.js`         | 2,796  | 81                  | 23                                       |
| `js/features/health.js`       | 1,246  | 52                  | 22                                       |
| `js/features/meds.js`         | 1,239  | 33                  | 4                                        |
| `js/features/today.js`        | 1,212  | 0 (single IIFE)     | 0                                        |
| `js/features/weight.js`       | 1,178  | 37                  | 9                                        |
| `js/features/bp.js`           | 697    | 25                  | 4                                        |

`app.js` mixes:

- Telegram bootstrap (`window.tg = …`, lines 1–9).
- Settings-bundle normalization (lines 50–80).
- Server-time / TZ-info display (lines 82–200+).
- Auth flow (`verifyAuthInBackground`, `clearSwBootstrapCache`, lines 350–390).
- Bootstrap hydration (`applyBootstrapPayload`, ~line 217+).
- Tab-binding helpers (`bindTabGroup` etc, ~line 1150+).
- Today-tab refresh debouncer (`pendingRefreshReason`, `refreshDebounceTimer`,
  lines 2308–2309).
- Weight-unit optimistic-write state machine (lines 2110–2218 — see §8).
- Push-modal flow (`pendingMedConfirmIds`, lines 2978–2982).
- Medication scheduling utilities (`getNextScheduledDate`, line 2707).
- `escapeHtml` itself (line 2779) — the *only* shared escaping primitive in
  the codebase (see §10).

`features/today.js` is the counter-example: 1,212 lines, 0 module-level
mutable declarations, packaged as a pure IIFE behind `window.TodayDashboard`
(`features/today.js:17`). Every other feature file could plausibly take this
shape. The fact that one already has shows it's achievable.

`features/workout.js` mixes CRUD modal logic, three sub-tab loaders, the
"next workout" card, exercise-library editing, mi-band import flow, ad-hoc
session start, and rotation-advance UI in one file with shared module-level
`workoutGroups`, `currentEditingGroupId`, `currentEditingVariantId`,
`currentEditingExerciseId`, `currentGroupForVariant`, `currentVariantForExercise`
(lines 7–12). Any two of these "current editing" entries being non-null at
once is a bug surface; nothing structurally prevents it.

The same split logic the Go review proposes for `store.Store` applies here
unchanged: split by feature concern (workout-groups vs workout-sessions vs
workout-history vs ad-hoc) into smaller files, give each one a single
`{Feature}Module.init()` entry point, and forbid module-level `let`/`var`
in feature files via an architecture test.

---

## 3. Global namespace as the IPC bus

`window.*` is the entire cross-file communication mechanism. Census:

- **72 distinct `window.X = …` write sites** across non-test JS.
- **Cross-feature direct calls.** Feature files reach into each other through
  globals: `features/bp.js:125` calls `window.loadToday()`, `features/weight.js:397`
  same, `features/food.js:1734` same. `features/settings.js:103` calls
  `window.loadFoodLogs` — but `settings.js` itself isn't loaded by
  `index.html` (§12), so this code never runs.
- **`window.userInitData` is read in 10+ files** (`features/food.js:345, 492,
  1041, 2609`, `features/elevenlabs-call.js:181`, `app.js:3241`, `core/api.js:8`,
  …). This is the auth identity primitive, scattered.
- **The allowlist is enforced** (`tests/architecture.globals.test.js`) — so
  globals can't be added invisibly. But the allowlist mostly *documents*
  rather than *constrains*: nothing rejects "cross-feature direct call via
  global function reference", which is the actual coupling that hurts.

Concrete consequences:

- The `window.featureSettings` object is read in many places and written by
  three different code paths in `app.js` (lines 226–230, 341–345, 414–420)
  plus settings.js (loaded only in tests). All three writes do roughly the
  same thing; the order of arrival is not asserted anywhere. Bootstrap
  payload, `BOOTSTRAP_UPDATED` postMessage, and Dexie hydration all race for
  this same slot.
- The "feature file" abstraction is leaky: if `today.js` needs the BP
  reading, it goes through caches, but if `bp.js` wants to refresh Today
  after a save, it calls `window.loadToday()` — bidirectional coupling
  through globals.

A small `EventBus` (`AppKernel.publish('bp:saved', payload)` →
`AppKernel.subscribe('bp:saved', loadToday)`) would let cross-feature
notifications be one-way and removable. The kernel already exists
(`core/app-kernel.js`) but is only used for tab-switch sync today.

---

## 4. Service Worker duplicates main-thread business logic

**This is the highest-impact concern in the codebase.**

`web/static/sw.js` defines **11 `async function handleX(…)`** (lines
559–767) that POST to backend endpoints directly, in parallel to the
identical flows in the main thread. Examples (sw.js):

- `handleMedicationConfirm` (line 614) → POST `/api/medications/confirm-schedule`
- `handleMedicationSkip` (line 735) → POST `/api/medications/skip`
- `handleMedicationServerSnooze` (line 752) → POST `/api/medications/snooze`
- `handleBPSnooze` (line 642) → POST `/api/bp/reminder/snooze`
- `handleBPDontBug` (line 657) → POST `/api/bp/reminder/dontbug`
- `handleWeightSnooze`, `handleWeightDontBug` (672, 687)
- `handleWorkoutSnooze`, `handleWorkoutSkip` (702, 719)
- `handleTZPlanAction` (559) → POST `/api/tz-plan/{id}/{action}`
- `handleCancelIntake` (583) → POST `/api/medications/cancel-intake`

Each of these:

1. **Does not send `X-Telegram-Init-Data`.** sw.js has zero references to
   that header (`grep` confirms). They rely entirely on the `auth_session`
   HttpOnly cookie. So in any deployment where the header is the primary
   identity (e.g. Telegram Mini App embedded view without server-set cookie,
   local dev with cookie disabled), every push-notification action button
   silently 401s and the user never knows. The main thread's `apiCallDirect`
   sends the header (`core/api.js:8`); the SW does not.
2. **Has no retry, no offline queue.** If the POST fails, it `console.error`s
   and the action is lost. The notification has already been dismissed — so
   "skip from notification" can be a black hole.
3. **Bypasses the entire SyncManager / DataStore stack.** No cache
   invalidation, no `requestTabRefresh`. The SW does `client.postMessage({
   type: 'MEDICATION_CONFIRMED' })` (line 638) and trusts the main thread to
   refresh — but the main thread handler is in `app.js` and the wire-up is
   not visible at the SW call site.
4. **Is impossible to test.** Vitest covers very little of `sw.js` —
   `architecture.sw-precache.test.js` only checks the asset list. None of
   these handlers have a unit test; they would need a SW test harness.
5. **Drift risk is concrete.** A `/api/medications/snooze` payload change in
   the Go server would need to be applied in `sw.js:752` *and* in the main
   thread sync path. There is no compile-time link.

Recommended: extract a single `swApiCall(endpoint, method, body)` in a
`sw-api-helper.js` precached alongside `sw.js`, mirror the main thread's
auth header behaviour, and queue failed POSTs into an IndexedDB store the
main thread can drain on next `online` event.

---

## 5. Telegram identity coupling on the client

(Mirrors Go review §1 "messenger pluggability — identity blocker".)

The Go review identifies that the *server* identity model is Telegram-shaped.
The client mirrors this: the assumption "we have a Telegram user, and their
identity is `userInitData`" is hardcoded throughout the JS. Reach into
`window.Telegram.WebApp` from:

- `core/utils.js:5, 18` (`safeAlert`, `safeConfirm` use Telegram popup APIs)
- `app.js:5` (`window.tg = Telegram.WebApp`, then `tg.ready()`, `tg.expand()`)
- `features/back-button.js:17` (BackButton wiring)
- `features/modal-history.js:15` (modal-history MutationObserver)
- `features/deeplink-router.js:89` (`Telegram.WebApp.initDataUnsafe.start_param`)

Plus 11+ HTTP call sites that put `userInitData` into the auth header (see
§6). For "Telegram-optional" to be a true property of this app:

1. A small `MessengerAdapter` interface (`adapter.identityToken()`,
   `adapter.openBackButton()`, `adapter.alert(msg)`, `adapter.deeplinkFromBoot()`)
   wrapped around `window.Telegram.WebApp` with a fallback that uses a
   cookie-only browser identity when Telegram isn't present.
2. Every reach-in (above) routed through the adapter — none of the call
   sites actually need the raw `Telegram.WebApp` object; they need one of
   four behaviours.
3. The `userInitData` global becomes one possible identity token of several;
   `core/api.js:8` becomes `headers[adapter.authHeaderName()] =
   adapter.identityToken()`.

This is a precondition for a non-Telegram-Mini-App deployment (browser /
PWA / future messenger). It is *not* a precondition for the OIDC / Google
login that already exists, because that path still maps users back to the
same Telegram-shaped identity (Go review §1).

---

## 6. Auth header inconsistency (`X-Telegram-Init-Data` vs `Authorization: tma`)

Two different auth header schemes coexist in the client:

| Header                                 | Files using it                                                                      |
|----------------------------------------|-------------------------------------------------------------------------------------|
| `X-Telegram-Init-Data: <initData>`     | `core/api.js:8`, `app.js:3241`, `features/elevenlabs-call.js:181`, `features/food.js:345, 492, 1041, 2609` |
| `Authorization: tma <initData>`        | `features/bp.js:682` (`exportBPCSV`), `features/weight.js:1163` (`exportWeightCSV`) |
| (none — relies on cookie only)         | every `handleX` in `sw.js`                                                          |

The two CSV-export call sites use a completely different header scheme from
every other request. If the server validates either form, fine — but the
two call sites are nearly identical (`bp.js:678-696` ≈ `weight.js:1159-1175`),
suggesting copy-paste rather than a deliberate decision. The fact that
nobody noticed the divergence for long enough to ship it both ways shows
the call-site pattern is too easy to get wrong.

Pull every auth-header construction into one helper
(`window.makeAuthHeaders()`), with one canonical scheme. Anything unusual
(SW background, third-party widget) explicitly opts out with a justification.

---

## 7. Sync layer: three near-identical pipelines

(Mirrors Go review §11 "reminder checker duplication".)

`web/static/js/sync.js` defines three sync methods, each ~50 lines:

- `syncBPReadings()` — sync.js:436–485
- `syncWeightLogs()` — sync.js:488–533
- `syncIntakeLogs()` — sync.js:536–578

They differ only in: store reference (`BPStore` / `WeightStore` /
`IntakeQueueStore`), endpoint, payload shape, and `confirmDelete` vs
`markSynced`. Otherwise: identical try/catch shape, identical
`isPermanentSyncError` branching, identical `markRejected`/`markError`
fallback.

Same shape duplicated downstream:

- `handleOfflineBPRead`, `handleOfflineWeightRead` — sync.js:749–765
- `handleOfflineBPWrite`, `handleOfflineWeightWrite`, `handleOfflineIntakeWrite`
  — sync.js:697–839

Adding offline support for a 4th entity (e.g. food logs, currently
explicitly out of scope per `docs/frontend.md`) means writing another
~120-line copy. A `defineOfflineEntity({ store, endpoint, payloadFn,
toastSingular, toastPlural, syncTag })` factory would reduce all of this
to per-entity config — and force consistency on retry behaviour, error
toast wording, and rejected-vs-error semantics.

---

## 8. Module-level mutable state and weight-unit race scar tissue

`app.js` carries 34 module-level `let`/`var` declarations. The most telling
cluster is the weight-unit machinery (`app.js:2110–2135`):

```javascript
let weightUnitPatchTail = Promise.resolve();
let weightUnitIntentSeq = 0;
let weightUnitLastCommitted = null;
let weightUnitPendingPatches = 0;
let weightUnitLocallyMutated = false;
```

The **80+ lines of comments above and inside `reconcileAuthoritativeUnit`**
(`app.js:2138–2218`) read as a written history of regressions: each `let`
was added because a prior fix shipped and broke. Quoted from the file:

> *"Once the user has explicitly committed a unit locally, an SW
> BOOTSTRAP_UPDATED whose underlying network fetch was issued before that
> PATCH but resolves after the queue drained carries the stale pre-PATCH
> unit. With no pending PATCH to gate it, the original guard accepted that
> stale value as authoritative — rolling window.weightUnitPreference,
> weightUnitLastCommitted and the cached settings_bundle back to the unit
> the server has since moved off of."*

This is real and the fix is correct. But the *reason* this had to be solved
in this shape is that:

1. State lives on `window.weightUnitPreference` (a global mutated by the
   user's tap) and in five module-level `let`s.
2. The "authoritative state" of a unit lives in three places: the local
   `let weightUnitLastCommitted`, the `settings_bundle` cache,
   `window.weightUnitPreference`. Each can be updated by ~5 different
   code paths (bootstrap, postMessage, Dexie hydration, user click, PATCH
   response).
3. There is no single owner. A reducer / state-machine model with one
   `dispatch({ type: 'WEIGHT_UNIT_PATCH_INTENT', value })` would make the
   invariants statically obvious; the current shape can only be reasoned
   about by reading every module-level `let` simultaneously.

Other stateful module-level lets in `app.js`:

- `var medications = []` (1077) — mutable shared array, also written by
  `features/meds.js`. Multiple writers, no documented protocol.
- `var foodTargets = …` (1080), `var currentFoodLogs = {}` (1079).
- `let pendingRefreshReason / refreshDebounceTimer` (2308–2309).
- `var pendingMedConfirmIds / pendingWorkoutSessionId / pendingMedConfirmMode
  / pendingMedConfirmIntakeIds` (2978–2982) — push-modal coordination.
- `let _nextIntakeTimerInterval` (2844) — timer reference, manually
  cleared in three places.

`features/workout.js:7–12` carries six "currently editing" globals. The
implicit invariant — at most one is non-null at a time — is undefended.

---

## 9. No request timeouts, no `AbortController` anywhere

```
$ grep -r AbortController web/static/js --include='*.js' | grep -v /tests/
(no matches)
```

`apiCallDirect` (`core/api.js:7–58`) calls `fetch()` with no `signal:`. A
slow backend hangs the call indefinitely; the only thing that breaks the
hang is the user navigating away or the SW returning a cached 503.

Effects:

- A user opening the Food tab with a stalled `/api/food/products/search`
  stream (`features/food.js:344–384` reads from a `ReadableStream` line by
  line — 70+ lines of stream-parsing logic) leaves the call hung until the
  TCP layer gives up.
- The `BOOTSTRAP_UPDATED` post-message handler (sw.js:159–162) holds a
  background revalidate inside `event.waitUntil(fetch(…)…)` with no
  timeout — if the network round-trip stalls, the SW keeps the install /
  fetch lifecycle event alive arbitrarily long.
- Tests (which mock `fetch`) cannot exercise "what happens when this
  endpoint takes 30s" because there is no signal to abort.

Adding `AbortController` is mechanical. A 60-second cap on `apiCallDirect`,
plumbed via an optional 4th `signal` arg for callers that want shorter
deadlines (the food search would want 10s), is a few lines and would
collapse a class of "everything just stops" bugs.

---

## 10. XSS surface and CSP-blocked inline `onclick=`

The CSP at `internal/server/server.go:373` is strong:

```
script-src 'self' https://telegram.org https://esm.sh blob: data:
```

No `'unsafe-inline'`. **Inline event handlers (`onclick="…"`) cannot
execute under this CSP** — the browser will block them silently.

`features/food.js:1620` builds exactly this:

```javascript
linkContainer.innerHTML = `<a href="#" onclick="navigateToFoodProduct(event, ${log.product_id}, ${log.is_meal ? 'true' : 'false'})" class="food-product-link">${linkText}</a>`;
```

Either the link silently does nothing under production CSP (latent bug; the
"View in Products" affordance is dead), or the deployed CSP allows
`'unsafe-inline'` (and `server.go:373` is not what actually ships). Worth
reproducing in a real browser before shipping. The fix is one event-listener
attached after `appendChild`.

Broader XSS hygiene census:

- `innerHTML` is assigned 96 times across non-test JS; `textContent` is used
  964 times. The ratio is healthy.
- Of the 96 `innerHTML` writes, the vast majority are static template
  strings with no interpolation — safe under CSP.
- Sites where server data lands in `innerHTML`:
  - `features/food.js:1620` — `${log.product_id}` and `${log.is_meal}` (numeric/boolean from server, low risk but the *pattern* is wrong).
  - `features/food.js:2384` — `${Math.round(totalCals)}` etc, all numeric, safe.
  - `features/food.js:2451` — pure HTML entities, safe.
  - `js/sync.js:79–91` — uses `_escapeHtml` correctly.
- **`escapeHtml` is defined exactly once** (`app.js:2779`) and called from
  exactly two non-test sites: `app.js:2754` (`escapeHtml(med.schedule)`) and
  `sync.js:59` (looked up via `window['escapeHtml']`). For ~24K lines of
  frontend rendering server data, two escaping call sites is suspiciously
  low. Either most data is rendered via `textContent` (which the 964 :
  96 ratio suggests is true) or there are unescaped `${…}` inside template
  strings somewhere; worth a more targeted audit than this review provided.

The CSP also blocks `'unsafe-eval'` by omission — confirmed clean: 0
matches for `eval(` or `new Function(` in production code.

---

## 11. Silent error swallowing

(Mirrors Go review §12.)

Pattern: `catch (_) { /* ignore */ }`, `catch (_) { /* best-effort */ }`,
`catch { return null; }` etc.

- **43 `catch` blocks with explicit `// ignore` / `// best-effort` /
  `// noop` / `// silent`** in production code.
- `core/api.js:84-91` — for `GET` requests, all errors are caught and the
  call returns `null`. The comment says "UI will handle empty state" — but
  this means transform bugs, contract drift, and CSP violations all surface
  the same way as offline. Programmer errors silently degrade.
- `cached-fetch.js:41-75` (`looksLikeNetworkError`) — explicitly tries to
  *avoid* this pattern by narrowing `TypeError` to "fetch failure or
  navigator-offline", with a comment that programmer errors must surface.
  Good model. This narrowing exists in exactly one place; the rest of the
  codebase still uses bare `catch (e) { console.error(e); }`.
- **30 `console.log` calls in production** (excluding tests). Some are
  observability (`SyncDebug.info` writes to console); others are leftover
  diagnostics (`core/api.js:46`: `console.log("Response is not JSON:", txt)`).
- One stray native `alert()` in `features/workout.js:579` —
  `alert('Failed to switch variant. Please try again.')`. Every other
  alert path goes through `safeAlert()` (`core/utils.js:9`), which prefers
  `Telegram.WebApp.showPopup`. Under a Telegram WebApp, the bare `alert()`
  blocks the WebView and looks foreign.
- `SyncDebug` ships a **DOM-injected debug panel into production**
  (`sync.js:104-132`) with hard-coded inline styles, attached on every
  `SyncManager.init()`. Displayed when the user taps the sync status bar
  (`sync.js:364`: `statusBar.onclick = () => SyncDebug.toggle()`).
  Acceptable for self-hosted single-user, but it is not gated and ships to
  every deployment.

---

## 12. Service Worker ships dead code

`web/static/sw.js:57` precaches `/static/js/features/settings.js`.
`web/static/index.html` has 52 `<script src>` tags (1529–1576) — none of
them are `features/settings.js`. Confirmed: the file is downloaded on first
SW install, re-downloaded on every `BUILD_REVISION` bump, and its 252
lines never execute. `docs/frontend.md` already documents this:
*"the in-tree `features/settings.js` is dead code; not loaded by
`index.html`"* — but the SW precache list keeps it.

The architecture test `architecture.sw-precache.test.js` checks the
precache list against `STATIC_ASSETS` for completeness (no missing files)
but doesn't reject the inverse — a precached file that nothing loads.

Either delete `features/settings.js` outright (the canonical `loadSettings()`
lives in `app.js:1926`) and remove from the SW precache, or wire it into
`index.html` and remove the duplicate definition in `app.js`. Picking the
former: ~250 lines of code goes away, plus a small bandwidth saving on
every install.

**Status (2026-05-13):** addressed by [docs/plans/2026-05-13-remove-dead-settings-js.md](plans/2026-05-13-remove-dead-settings-js.md) — file deleted, SW precache entry removed, architecture test added to prevent recurrence.

---

## 13. Cache-key ownership is scattered

The `api_cache` Dexie store is written by 4+ different code paths:

- `app.js` writes 6 distinct keys via `setCachedWithTags` / `setCached`
  (`app.js:44, 46, 3266`).
- `features/food.js:1842` writes the weekly food bundle.
- `data-store.js:62-87` (`setCached`, `setCachedWithTags`, `clearCached`)
  — the sanctioned API.
- `db.js:651-727` — direct put/get/delete via `ApiCache`.
- `cached-fetch.js:87-95` — writes through `cacheApiSnapshot` if available
  or falls back to `ApiCache.set`.
- `features/workout.js:26` — defines `WORKOUT_CACHE_KEYS` as a one-off
  array of 4 string literals; eagerly registers them with the `'workout'`
  tag (line 33-35) because otherwise mid-flight invalidation silently
  no-ops. This pattern is correct but not generalized.

There is no central registry that says *"these are the cache keys this app
uses, this is the tag each one belongs to, this is the freshness window
each one has"*. The closest thing is the table inside `docs/frontend.md`,
which is not enforced.

The cost shows up in the comments themselves:

- `data-store.js:144-152` — long comment explaining why `hydrateFromDexie`
  registers tags up-front: *"Without this … invalidation that fires while
  a GET is in flight silently no-ops".*
- `cached-fetch.js:116-129` — same explanation, again, in `cachedFetch`:
  *"on cold/reload paths … `tagToKeys` is empty for the key and an
  invalidation that fires while a GET is in flight silently no-ops".*
- `features/workout.js:14-46` — same explanation, third copy.

Three comment blocks documenting the same recurring footgun is the
codebase telling you it wants a registry. A `CACHE_KEYS = { medications: {
tag: 'medications', staleAfterMs: 24h }, … }` constant referenced by every
read/write site would centralize the policy and remove the cold-start race
class entirely (registration would happen once at boot, not at first
read).

---

## 14. What's already good

The codebase has done genuinely hard things well:

- **`DataStore` generation guard.** `data-store.js:213-247` (`fetchFresh`)
  and the matching guard in `cached-fetch.js:136-149` (`performAndCacheFetch`)
  correctly handle the supersede race: a slow GET that resolves after an
  authoritative write doesn't resurrect stale data. The fix has been
  applied consistently in both layers.
- **Architecture tests as a contract.** `tests/architecture.*.test.js` (8
  files) enforce: globals allowlist, design tokens (no JS hex literals),
  inline styles (banned), SW precache parity, toolbar-btn variant
  adoption, chart-theme tokens, offline-coverage allowlist, wg-primitives
  hex-literal rules. This is more architectural enforcement than most
  vanilla-JS projects ship.
- **Test ratio: 41,653 test lines vs 23,573 production lines (1.77 : 1)**
  across 175 test files — high for a frontend codebase.
- **Local-first read resilience design** (`cached-fetch.js`, the
  `<wg-stale-badge>` chip, `hydrateFromDexie`) is well-thought-out and
  consistently applied to the priority sections, with each pattern
  documented in `docs/frontend.md` and pinned by tests.
- **Wandergeek design system.** `--wg-*` tokens for everything that has a
  pixel value, `architecture.design-tokens.test.js` blocks JS reading of
  those tokens, `architecture.wg-primitives.test.js` blocks hex literals
  inside `.wg-*` blocks. The discipline is real.
- **Bottom-nav is the canonical surface** with no "More" aggregator and
  every section is a first-class destination — clean information
  architecture, supported by the deeplink router and the back-button
  contract.
- **`features/today.js` as a pure aggregator.** 1,212 lines, zero
  module-level mutable state, single `window.TodayDashboard` export. The
  shape every other feature file should aspire to.
- **Offline write queues** for BP, weight, and medication intake confirmations
  with separate `pending` / `error` / `rejected` state tracking
  (`db.js:79-235`), exponential backoff (`sync.js:200-214`), and visible
  UI (`sync.js:359-396` status bar).

---

## 15. Lower-priority items

- **No CSRF tokens on state-mutating routes.** Same finding as Go review:
  POST/PUT/DELETE on the SPA is defended by `SameSite` cookies plus
  `X-Telegram-Init-Data` header validation. Adequate, but explicit.
- **CSS file is 10,334 lines, single file.** `styles.css` carries 142 hex
  literals (most are inside `:root` token definitions and Telegram-theme
  fallback chains, which is correct). 14 `!important` declarations.
  Splitting per-feature CSS files would mirror the JS split.
- **`config.js` is server-generated** (`internal/server/server.go:386`)
  and loaded as an early script in `index.html:21`. Makes
  precaching brittle — the SW caches the dynamic asset; redeploys with
  changed `OIDC_CONFIG` shape need cache busting too. Currently relies on
  same `BUILD_REVISION` knob.
- **27 `setTimeout`/`setInterval` calls vs 11 `clearTimeout`/`clearInterval`**
  — most timers are intentionally fire-and-forget (toasts, retry backoff),
  but the imbalance suggests audit-worthy spots. `_nextIntakeTimerInterval`
  in `app.js:2844` and `settingsTimeInfoTimer` in `app.js:90` are
  module-level singletons that could leak under unusual nav flows.
- **`removeEventListener` is used 6 times.** Most listeners attached via
  `addEventListener('click', …)` are attached once and live forever, which
  is fine for static DOM. Dynamic re-rendering paths (e.g. workout's
  `bindClick` on dynamically-added elements) may double-bind under repeat
  renders; the `dataset.tabBound = '1'` guard pattern in `app.js:1151-1152`
  is the manual workaround.
- **Sub-tab persistence keys are in three different storage tiers.**
  `mt-meds-subtab` uses `sessionStorage` (Round-2 Task 4 deliberate
  decision), `mt-workouts-subtab` uses `localStorage`, range selectors all
  use `localStorage`. Documented but not enforced by anything.
- **Native `confirm()` in `safeConfirm` fallback** (`core/utils.js:34, 39`)
  — same pattern as `safeAlert`, but `confirm()` is *blocking* and can be
  awkward in WebViews. Telegram WebApp's `showConfirm` is async-callback
  shape; the fallback wraps both behind a Promise.
- **No service-worker version skew handling.** `app-shell.js:44, 76`
  reload the page when an updated SW activates. The `BUILD_REVISION` knob
  in `sw.js:6` is the intended bump mechanism, but bumping it isn't
  obviously tied to actual UI changes — it's manual. A pre-commit hook
  (`scripts/bump-sw-revision.js` checking changed-files heuristics) would
  reduce "shipped UI but didn't bump revision" misses.
- **`ScheduleManager` (Telegram WebApp BackButton ownership) is a single
  global handler** (`features/back-button.js`) that mutates state on every
  tab switch via `AppStore.subscribe('currentTab')`. Works today, but the
  back-button contract is the kind of subtle thing where a future modal
  shape introduces a regression.
- **`SyncDebug` panel ships in production.** §11 already noted; logged
  here as a lower-priority cleanup target.

---

## 16. Recommended priority order

For "Telegram-optional + maintainable" as the north star — directly
parallel to the Go review's ordering:

1. **SW handler unification.** Pull the 11 `handleX` POSTs in `sw.js` into
   a single `swApiCall()` helper that mirrors the main thread's auth header
   behaviour and queues failures. Closes the silent-401 gap (§4) and is
   ~hours of work.
2. **Auth header consolidation** (§6). One `makeAuthHeaders()` helper, one
   scheme. Delete the `Authorization: tma` divergence in `bp.js:682` and
   `weight.js:1163` unless there's a documented reason.
3. **`AbortController` on `apiCallDirect`** (§9). 60s default timeout,
   optional override. Single file change, removes a class of "everything
   stops" bugs.
4. **Delete or wire `features/settings.js`** (§12). Either remove the file
   and its precache entry or load it from `index.html` and delete the
   `loadSettings` shadow in `app.js`.
5. **Centralized cache-key registry** (§13). `CACHE_KEYS = { … }` constant
   referenced everywhere. Removes the cold-start race class and the three
   parallel comment blocks documenting it.
6. **Split `app.js`** (§2). Same shape as the Go store split: extract
   `auth-flow`, `bootstrap-apply`, `weight-unit-state`, `push-modal`,
   `time-display`, `medication-utils` into separate files. Forbid
   module-level `let`/`var` in extracted files via architecture test.
7. **Split `features/workout.js` and `features/food.js`** (§2). Each
   carries 4+ distinct concerns (workout: groups/sessions/library/stats;
   food: log/products/scanner/photo-summary).
8. **`MessengerAdapter`** (§5). Wrap every `window.Telegram.WebApp.X` reach
   into the adapter. Precondition for a non-Telegram deployment.
9. **Sync-pipeline factory** (§7). `defineOfflineEntity({…})` to compress
   three ~50-line copies. Easier to add the next entity.
10. **Inline `onclick=` in `food.js:1620`** (§10). Verify under production
    CSP whether the link works at all; replace with an `addEventListener`
    either way.

Items 1–4 are each hours, not days. Items 5–10 are larger refactors that
mostly enable each other (cleaner globals → easier to split → easier to
adapt to non-Telegram).
