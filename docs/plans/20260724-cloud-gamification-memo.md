# Cloud perf: memoize gamification buildContext + bounded HR read (bd med-90w.2)

## Context

`web/domain/gamification.js` `createGamificationDomain({ records, now, timeZone })` is the
cloud-only port of the Go gamification engine (instantiated in `web/cloud/js/apishim.js:139`
and `web/cloud/js/reminders.js:101`; bot mode uses the Go server, and the test suites in
`web/static/js/tests/gamification.*.test.js` instantiate it directly).

`buildContext(cfg)` (gamification.js ~1889) fires `Promise.all` of **eleven** full
`records.list(...)` scans (BP, WEIGHT, WEIGHTGOAL, SLEEP, DAYSTATS, HR, FOOD_LOG,
FOODTARGETS, INTAKE, NOTE, WORKOUT_SESSION). Its result `ctx` is produced by
`loadForRead()` (~2371, which also folds `effectiveConfig()`), and the real COMPUTE cost is
`scoreWindow(ctx, cfg)` (~2329) which folds a 365-day (`SCORING_WINDOW_DAYS`) trailing window
of `scoreOneDay` on **every** read. `loadForRead()` is called by `getSummary`/`getRings`/
`getJourney`/`getGauges`/... and Today's fan-out (`today-loader.js`) fires several of these
per Today open, so the full read+fold runs many times per open with no intervening write.

med-90w.1 (merged, PR #697) added a monotonic records change-counter to
`web/cloud/js/sync.js`, exported as `getRecordsChangeCount()` — a value that increments at
every physical write funnel. We reuse it as the memo-invalidation signal.

Two fixes, both **must be behavior-preserving** (gamification scoring is behavior-sensitive:
docs/gamification.md + the in-file "no-effect-rewarded-like-effect" / deterministic-value
invariants — a memo hit MUST return byte-identical scoring output; a miss recomputes exactly
as today):

1. Memoize `loadForRead` (the 11 reads + effectiveConfig) AND the 365-day fold
   (`scoreWindow`), keyed on the records change-counter, threaded in as an **injected port**
   (web/domain modules are runtime-agnostic — `architecture.domain-purity.test.js` bans
   `window`/`document`/`fetch`/imports of browser/sync modules, so gamification.js must NOT
   import sync.js; it receives `getRecordsChangeCount` like `now`/`records`). When the port is
   absent (bot mode / existing test harnesses) → always recompute (behavior unchanged).
2. Replace the unbounded `records.list(HR_RECORD_TYPE)` in buildContext with the bounded
   `records.listRange('hrsample', 'hrsample-<fromDay>', 'hrsample-<toDay>')` pattern
   (mirror `web/domain/vitals.js:135-137`), windowed to `SCORING_WINDOW_DAYS` with ±1 UTC-day
   padding so no scoring day is silently dropped. HR is the one dense stream (~96 samples per
   day-batch, all of time) and unlike vitals overview it was never bounded.

Key facts already verified:
- Factory signature: `export function createGamificationDomain({ records, now, timeZone })` (gamification.js:905).
- `msToUTCDay(ms)` (gamification.js:528) === `new Date(ms).toISOString().slice(0,10)`, the exact
  format vitals uses for its `hrsample-<YYYY-MM-DD>` batch keys. `DAY_MS` const at line 15.
- `HR_RECORD_TYPE = 'hrsample'` (gamification.js:1755); `buildHRDailyMin(hrRecords)` (1864)
  consumes records with `.samples` arrays — the shape `listRange` returns unchanged.
- `records.listRange` exists on the port (vitals uses it; in-memory test port
  `web/static/js/tests/helpers/cloud-shim-harness.js` implements inclusive `list`/`listRange`).
- `scoreWindow(ctx, cfg)` is a pure deterministic function; `cfg` is always the sibling of
  `ctx` from the same `loadForRead()`, so a `WeakMap<ctx, scored>` keyed on ctx identity is a
  safe fold-memo: on a loadForRead hit the same ctx object is returned → fold cached; in bot
  mode a fresh ctx each call → WeakMap miss → recompute (unchanged).
- apishim: `records = recordsOverride || recordsPort(ctx, origin)` (apishim.js:114); the real
  port is sync-backed (tracked by `getRecordsChangeCount`), but a test `recordsOverride` is a
  fake NOT backed by sync — so the memo signal must be `null` when `recordsOverride` is set,
  or those shim tests would read stale data. Only the real port gets the change-count.

Node 20 required for vitest: `export PATH="$(ls -d /tmp/node-v20*/bin | head -1):$PATH"`.

## Files

- `web/domain/gamification.js` — factory port + memo + fold memo + bounded HR read.
- `web/cloud/js/apishim.js` — import `getRecordsChangeCount` from sync.js, thread it into
  `createGamificationDomain` (only when the real port is used; allow a test override param).
- `web/static/js/tests/gamification.substrate.test.js` — extend with memo + HR-bound tests.

## Constraints

- NO `window`/`document`/`fetch` and NO import of `sync.js` (or any browser/IDB module) in
  `web/domain/gamification.js` — `architecture.domain-purity.test.js` enforces this.
- A memo HIT must return scoring output byte-identical to a fresh recompute. A memo MISS must
  behave exactly as today. Verify by diffing getSummary/getRings/getGauges/getJourney output
  with the port present vs absent over the same seeded vault.
- Do NOT change bot behavior: with no `getRecordsChangeCount` port, `loadForRead` recomputes
  every call and the WeakMap fold-memo misses every call (fresh ctx).
- Do NOT slow the write path; the memo only affects reads.

---

### Task 1: Thread `getRecordsChangeCount` port + memoize loadForRead and the fold

In `web/domain/gamification.js`:

1. Add `getRecordsChangeCount` to the factory destructure:
   `export function createGamificationDomain({ records, now, timeZone, getRecordsChangeCount }) {`
   Default-absent is fine (JS `undefined`). Add a short comment: it is the optional
   records-change signal (sync.js `getRecordsChangeCount` in cloud mode); when absent
   (bot mode / direct test harnesses) the read path always recomputes.

2. Memoize `loadForRead()` (~2371). Add closure state near it:
   ```js
   let readMemo = null; // { key, cfg, ctx } — cleared implicitly by key mismatch
   ```
   Rewrite loadForRead so that when `getRecordsChangeCount` is a function, it computes
   `const key = `${getRecordsChangeCount()}:${msToUTCDay(now())}`;` and returns the cached
   `{ cfg, ctx }` when `readMemo && readMemo.key === key`; otherwise recompute
   (`effectiveConfig()` + `buildContext(cfg)`), store `readMemo = { key, cfg, ctx }`, return.
   When `getRecordsChangeCount` is absent, skip the cache entirely (compute every call).
   - The `:${msToUTCDay(now())}` day-suffix is a correctness guard: the change-count alone
     does not move at midnight, and a stale ctx would score the wrong "today". Same-day repeat
     opens with no write still hit (the acceptance scenario). Comment this rationale.

3. Memoize the 365-day fold. Add a per-instance `const scoreWindowMemo = new WeakMap();`
   and in `scoreWindow(ctx, cfg)` (~2329) return `scoreWindowMemo.get(ctx)` when present, else
   compute as today and `scoreWindowMemo.set(ctx, result)` before returning. Because `cfg` is
   always the sibling of `ctx` from `loadForRead`, keying on `ctx` identity is sufficient.
   Comment: bot mode / no-memo gets a fresh ctx each read so this WeakMap misses and recomputes.

Acceptance for this task: two consecutive `getSummary()` calls with the port present and no
intervening write must NOT re-run the record reads nor `scoreOneDay`; with the port absent
they recompute both. Scoring output identical either way.

### Task 2: Bounded HR read in buildContext

In `buildContext(cfg)` (~1889), replace the `records.list(HR_RECORD_TYPE)` entry in the
`Promise.all` with a bounded `records.listRange` windowed to `SCORING_WINDOW_DAYS`, mirroring
`web/domain/vitals.js` `readSamples`:
```js
const nowMs = now();
const hrFromKey = `${HR_RECORD_TYPE}-${msToUTCDay(nowMs - (SCORING_WINDOW_DAYS + 1) * DAY_MS)}`;
const hrToKey   = `${HR_RECORD_TYPE}-${msToUTCDay(nowMs + DAY_MS)}`;
// ...in the Promise.all, the HR slot becomes:
records.listRange(HR_RECORD_TYPE, hrFromKey, hrToKey)
```
- Lower bound `SCORING_WINDOW_DAYS + 1` days back (extra UTC-day pad below `today-364`), upper
  bound `+1` day (covers `today` and any in-progress-week end day; future HR does not exist).
  Overshoot is at most a couple extra clones and `buildHRDailyMin`/`meanInRange` only read the
  days they need, so no scoring day is dropped and none is wrongly added.
- `'#'`-suffixed overflow sub-records (`hrsample-<day>#k`) fall inside the range for free (`#`
  sorts below any digit and `toDay > any real sample day`), same as vitals — keep a one-line
  comment noting this.
- `buildHRDailyMin(hrAll)` stays unchanged (same `.samples` record shape).

### Task 3: Wire the port in apishim (cloud only)

In `web/cloud/js/apishim.js`:
- Extend the sync.js import to include the change-counter:
  `import { recordsPort, getRecordsChangeCount, ORIGIN_UI, ORIGIN_EXTERNAL } from './sync.js';`
  (adjust to the existing named-import list; alias if a local name would collide).
- In `createApiRouter`, add an optional override param
  `getRecordsChangeCount: changeCountOverride` to the options destructure (sibling of
  `records: recordsOverride`), then compute the signal:
  ```js
  // Memo signal only when the sync-backed port is in use; a test recordsOverride is not
  // sync-tracked, so pass null there to keep those reads always-fresh (unless a test opts in).
  const recordsChangeCount = changeCountOverride
    || (recordsOverride ? null : getRecordsChangeCount);
  ```
  and pass it: `createGamificationDomain({ records, now, timeZone, getRecordsChangeCount: recordsChangeCount });`
- Leave `web/cloud/js/reminders.js` untouched (no port → recompute; reminder recompute is
  infrequent and its instance uses a shifted clock).

### Task 4: Tests (extend gamification.substrate.test.js)

Add a `describe('read-path memoization (med-90w.2)')` block to
`web/static/js/tests/gamification.substrate.test.js` (integration-first — extend the existing
suite, do not create a new coverage file). Reuse the `createInMemoryRecordsPort` harness and
`vi.spyOn`.

1. **Memo hit when port present, no write** — build a domain with a `getRecordsChangeCount`
   port returning a fixed value; `vi.spyOn(records, 'list')` (and/or `listRange`); call
   `getSummary()` twice; assert the read count does not grow on the 2nd call (memo hit). Bump
   the change-count between two more calls and assert reads fire again (invalidation).
2. **No memo when port absent** — same vault, no `getRecordsChangeCount` port; two
   `getSummary()` calls re-read (spy count grows), proving bot behavior is unchanged.
3. **Scoring identical with vs without memo** — deep-equal `getSummary()` (and `getRings()` /
   `getGauges()`) output from a port-present instance vs a port-absent instance over the same
   seeded vault, proving the memo changes no scoring value.
4. **HR read is bounded** — seed `hrsample` day-batch records (recordId `hrsample-<day>`, with
   `.samples`), spy `listRange`, call `getSummary()`, and assert HR was read via
   `listRange('hrsample', ...)` with bounds inside the scoring window (NOT via
   `list('hrsample')`). Mirror `cloud.shim-contract.vitals.test.js`'s listRange assertion.

### Task 5: Verify

Run with Node 20 (`export PATH="$(ls -d /tmp/node-v20*/bin | head -1):$PATH"`; confirm `node -v` is v20):
- `npx vitest run` — full frontend suite green (includes the architecture purity + native +
  globals guards and the new memo/HR tests).
- `go build ./...` — must stay green (no-op; no Go touched).

Update the progress block below as each task completes.

## Progress

- [x] Task 1: port + loadForRead memo + fold WeakMap memo
- [x] Task 2: bounded HR listRange read
- [x] Task 3: wire getRecordsChangeCount in apishim (cloud only)
- [ ] Task 4: memo + HR-bound tests in gamification.substrate.test.js
- [ ] Task 5: verify (vitest full + go build)
