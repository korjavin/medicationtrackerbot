# Cloud read-perf: plaintext records memo + bootstrap flag + cached DB handle (med-90w.1)

## Overview

Cloud-mode reads (`web/cloud/js`) have no in-memory memoization: every
`records.list(type)` re-opens IndexedDB, `getAll`+structured-clones+filters+sorts
the full history of a type. Section-open fires this ~8+ times. This plan adds
three tightly-coupled read-side optimizations, ALL confined to
`web/cloud/js/sync.js` + `web/cloud/js/localdb.js` (they interact; do not split):

1. **Plaintext records memo** (the core deliverable): a module-level
   `Map<recordType, record[]>` populated by `listRecords`, invalidated PRECISELY
   at every physical write funnel. Exposes a monotonic `getRecordsChangeCount()`
   for the follow-up gamification bead (med-90w.2).
2. **Bootstrap flag**: `bootstrapIfNeeded` short-circuits once `localLastSeq`
   is known, skipping the 11-key `sync_meta` read on every list call.
3. **Cached DB handle**: sync.js reuses one open IndexedDB connection instead of
   open/close per call, with a reopen-on-`InvalidStateError` guard.

**Correctness is paramount**: a stale memo shows wrong/old health data. The
invalidation must be exhaustive and tested. This is PURELY a read-side cache +
connection reuse — record shapes, seq handling, and the encrypt/decrypt path are
NOT touched.

## Context (from discovery)

- Files involved: `web/cloud/js/sync.js`, `web/cloud/js/localdb.js`, tests in
  `web/cloud/js/tests/sync.test.js`.
- `listRecords` (sync.js ~1123) reads via the `recordType` index (v3 opt, keep
  it), filters `!deleted`, sorts newest-first by `clientTs`.
- `listRecordsInRange` (sync.js ~1145) is a bounded primary-key range read (v3
  opt, keep it). LEAVE IT UNCACHED — already bounded/cheap.
- **The single physical single-record write funnel is `putRecord`** (sync.js
  ~169). Both `writeRecord` (UI/voice/MCP/inbox) and `applyIncoming` (inbound
  sync) route through it, and both pass a record carrying `.recordType`.
  `replaceAllRecords` (vault import/snapshot bootstrap) and `resetLocalSync`
  (clear-all) write to the `records` store directly (bulk `store.put`/`clear`),
  NOT through putRecord — they invalidate the whole memo.
- **Do NOT invalidate at `notifyRecordsChanged` (sync.js ~356)**: it early-returns
  on `ORIGIN_UI` writes, so a UI write would leave a stale memo. The physical
  funnel is the correct, exhaustive seam. (This is the exact conclusion the prior
  canceled attempt reached; honor it.)
- `withStore`/`readMeta`/`resetLocalSync` each `openDb()` then `db.close()` in a
  `finally`. `openDb` is ALSO imported and `.close()`d by push.js, feedback-submit.js,
  mcp-responder.js, unlock.js — all OUTSIDE this plan's scope. So `openDb` MUST
  stay unchanged (fresh handle, caller closes) for those; sync.js gets a SEPARATE
  cached accessor. Two concurrent connections at the same DB_VERSION are safe;
  the only cross-connection hazard is a version upgrade, handled by onversionchange.
- Tests wipe via `indexedDB.deleteDatabase('medtracker-cloud')` in `beforeEach`
  and use `fake-indexeddb/auto`. The getAll-spy pattern already exists (test
  "never full-scans the records store"): `vi.spyOn(IDBIndex.prototype, 'getAll')`.
  Module-level caches (memo, bootstrapped) leak across tests unless reset — the
  onversionchange fired by `deleteDatabase` on the cached connection is the reset
  hook (see Task 3).

## Development Approach
- **Testing approach**: Regular (code first, then tests) — pure-unit tests for
  sync/localdb are explicitly allowed (CLAUDE.md testing posture: these layers
  have no integration entry point). Add tests to the EXISTING
  `web/cloud/js/tests/sync.test.js` (new `describe` blocks), do NOT create new
  `*-branches`/`task-N` files.
- Node 20 required for vitest: `export PATH="$(ls -d /tmp/node-v20*/bin | head -1):$PATH"`
  (Node 18 silently skips vitest). Verify `node -v` is v20 before running tests.
- Small, focused changes. Run `npx vitest run web/cloud/js/tests/sync.test.js`
  after each task; full `npx vitest run` at the end.
- Maintain backward compatibility: returned data shape/order must be identical.

## Testing Strategy
- **Unit tests** (required per task) in `web/cloud/js/tests/sync.test.js`.
- Invalidation completeness is the whole ballgame. Tests MUST cover fresh data
  after: (a) same-type write, (b) inbound sync apply, (c) `replaceAllRecords`
  import, (d) cross-type isolation (write X must not serve stale Y), (e)
  `resetLocalSync` clears all.
- A spy/counter test proving repeated `list(type)` hits memory after the first
  `getAll` and re-reads after each invalidation.
- No E2E tests for this layer.

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## What Goes Where
- Implementation Steps (`[ ]`): all code + tests, automatable by the agent.
- Post-Completion (no checkboxes): manual perf verification notes only.

## Implementation Steps

### Task 1: Cached DB handle + drop-listener in localdb.js
- [x] In `web/cloud/js/localdb.js`, extract the `onupgradeneeded` store/index
      creation into a shared `applyUpgrade(req)` helper (device, records+recordType
      index, pending, sync_meta, feedback_outbox — identical to today). Keep
      `openDb()` behaviorally UNCHANGED (fresh connection, `onversionchange` closes
      itself, caller closes) so push/feedback/mcp-responder/unlock are unaffected.
- [x] Add `let dbPromise = null;` and a `Set` of drop-listeners with
      `export function onCachedDbDropped(cb)` (returns an unsubscribe) and an
      internal `dropCache()` that nulls `dbPromise` and fires all listeners
      (each in try/catch so one throw can't break the rest).
- [x] Add `export function cachedDb()`: returns the shared `dbPromise`, opening
      one if null via `applyUpgrade`; on `onsuccess` wire `db.onversionchange = () => { db.close(); dropCache(); }` and `db.onclose = () => dropCache()`; on open error null `dbPromise` and reject.
- [x] Add `export function dropCachedDb()` calling `dropCache()` (for sync.js's
      reopen guard).
- [x] write test: `cachedDb()` twice returns the SAME handle identity; after
      `dropCachedDb()` (or a versionchange) the next `cachedDb()` returns a NEW
      handle; `onCachedDbDropped` callback fires on drop.
- [x] run `npx vitest run web/cloud/js/tests/sync.test.js` (Node 20) — must pass before Task 2.

### Task 2: Route sync.js DB access through a guarded `withDb`; keep handle open
- [x] In `web/cloud/js/sync.js`, import `cachedDb, dropCachedDb, onCachedDbDropped`
      from `./localdb.js` (keep `openDb` import only if still needed; it is not —
      remove if unused). (imported `cachedDb, dropCachedDb`; `openDb` removed as
      unused; `onCachedDbDropped` deferred to Task 3 where it is first used.)
- [x] Add `async function withDb(fn)`: `let db = await cachedDb(); try { return await fn(db); } catch (err) { if (err && err.name === 'InvalidStateError') { dropCachedDb(); db = await cachedDb(); return await fn(db); } throw err; }`.
- [x] Rewrite `withStore` to use `withDb` (build the transaction inside `fn(db)`),
      REMOVING the `db.close()` finally.
- [x] Rewrite `readMeta` to use `withDb` (single `sync_meta` readonly tx +
      `Promise.all` of the 11 gets), REMOVING its `db.close()`.
- [x] Rewrite `resetLocalSync`'s raw open/close block to use `withDb` for the
      multi-store clear tx, REMOVING its `db.close()`.
- [x] write test: a `withStore`-backed read (e.g. `listRecords`) still succeeds
      after the cached handle is externally `close()`d (guard reopens transparently,
      no throw).
- [x] run `npx vitest run web/cloud/js/tests/sync.test.js` (Node 20) — must pass before Task 3.

### Task 3: Plaintext records memo + bootstrap flag + invalidation wiring
- [x] In sync.js add module state: `const recordsMemo = new Map();`,
      `let recordsChangeCount = 0;`, `export function getRecordsChangeCount() { return recordsChangeCount; }`,
      and `function invalidateRecords(type) { if (type) recordsMemo.delete(type); else recordsMemo.clear(); recordsChangeCount++; }`.
- [x] Add `let bootstrapped = false;` and register
      `onCachedDbDropped(() => { recordsMemo.clear(); recordsChangeCount++; bootstrapped = false; });`
      so a dropped connection (versionchange / `deleteDatabase` / account-delete)
      resets all derived caches — this also cleans module state between tests.
- [x] Invalidate at the physical funnel: in `putRecord`, after the awaited
      `withStore` write, call `invalidateRecords(record && record.recordType)`
      (undefined recordType defensively clears all). In `replaceAllRecords`, after
      the clear/relay tx call `invalidateRecords()` (all). In `resetLocalSync`,
      after the clear call `invalidateRecords()` and set `bootstrapped = false`.
- [x] Short-circuit `bootstrapIfNeeded`: `if (bootstrapped) return; const meta = await readMeta(); if (meta.localLastSeq !== null) { bootstrapped = true; return; } if (await bootstrap(ctx)) bootstrapped = true;`.
- [x] Rewrite `listRecords` to serve from memo: after `bootstrapIfNeeded`, return
      `cached.slice()` on hit; on miss capture `const gen = recordsChangeCount;` BEFORE
      the index `getAll`, build the filtered+sorted `result`, and ONLY
      `recordsMemo.set(recordType, result)` when `recordsChangeCount === gen` (a
      write that raced the async read must not cache stale); always return
      `result.slice()`. Keep `listRecordsInRange` UNCACHED and unchanged.
- [x] write test (memoization): repeated `listRecords({}, 'bp')` calls the index
      `getAll` exactly ONCE (spy on `IDBIndex.prototype.getAll`); result identical.
- [x] write test (a) same-type write: after `writeRecord`/`recordsPort().put` of a
      `bp` record, `listRecords('bp')` returns the new record (memo invalidated).
- [x] write test (b) inbound sync apply: after a `pullOnOpen` that applies an
      incoming record of a type previously listed, `listRecords(type)` reflects it.
- [x] write test (c) `replaceAllRecords` import: after `replaceAllRecords`,
      `listRecords(type)` reflects the imported set, not the pre-import memo.
- [x] write test (d) cross-type isolation: listing `bp` then writing `weight` must
      NOT invalidate `bp`'s memo (second `bp` list still one getAll), and listing
      `weight` returns the new weight (write X does not serve stale Y, nor evict X).
- [x] write test (e) `resetLocalSync` clears all: after reset+re-bootstrap,
      `listRecords(type)` reflects the server snapshot, memo empty for every type.
- [x] write test: `getRecordsChangeCount()` is monotonic and increases on each
      write path (put, replaceAll, reset), unchanged by a pure read.
- [x] run `npx vitest run web/cloud/js/tests/sync.test.js` (Node 20) — must pass before Task 4.

### Task 4: Verify acceptance criteria
- [x] Re-read the memo invalidation points against every `records`-store mutator
      (`putRecord` ← `writeRecord`+`applyIncoming`, `replaceAllRecords`,
      `resetLocalSync`) — confirm none is missed. (grep of all `records`-store
      writes confirms only putRecord/replaceAllRecords/resetLocalSync mutate it;
      each invalidates.)
- [x] Confirm the v3 `recordType` index read and `listRecordsInRange` bounded
      reads are NOT regressed (existing "never full-scans" / range tests green).
      (listRecords still reads via `index('recordType').getAll`; listRecordsInRange
      unchanged bounded primary-key range; sync.test.js 76/76 green.)
- [x] Run full frontend suite: `npx vitest run` (Node 20) — all green.
      (321 files, 3934 passed / 29 skipped.)
- [x] Run `go build ./...` (no-op for this JS-only change; must still pass). (OK.)

### Task 5: [Final] Docs
- [ ] No doc changes required (internal read-side cache, no API/behavior change).
      If any behavior note is warranted, add a one-line comment at the memo
      definition in sync.js; do not touch docs/ otherwise.

## Technical Details

- **Memo value**: canonical filtered+sorted array per type stored in `recordsMemo`;
  callers always get a `.slice()` (shallow copy) so in-place array mutation
  (`sort`/`reverse`/`push`) can't corrupt the cache. Record objects are shared
  references (read-only contract); the domain layer builds new output objects.
- **Generation guard**: `recordsChangeCount` is bumped by EVERY invalidation and
  captured before each uncached `getAll`; a mismatch after the read means a write
  raced in, so the result is returned but not cached. Doubles as the monotonic
  `getRecordsChangeCount()` for med-90w.2.
- **Reopen guard**: `db.transaction()` on a closed connection throws
  `InvalidStateError` synchronously (inside the tx-body promise → rejects);
  `withDb` catches by `err.name`, drops the cache, reopens once, retries.
- **Scope guard**: `openDb` stays byte-for-byte behavioral for push/feedback/
  mcp-responder/unlock; only sync.js migrates to `cachedDb`.

## Post-Completion
*Informational only — no checkboxes*

**Manual verification** (optional): open a cloud section (Today/Food) in a real
browser with a populated vault and confirm section-open no longer shows repeated
`records` `getAll` structured-clone cost (DevTools performance), and repeated
navigation to the same section is instant. Not required for merge (unit tests
cover correctness; this is a perf lever with no behavior change).
