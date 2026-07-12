# Cloud sync: reconnect auto-drain + session-expiry re-auth (med-deq.2)

## Overview
Two client-side halves in the cloud sync engine, one coherent PR. Client-side ONLY — do NOT touch `internal/cloudserver` session semantics (`session.go`, `webauthn.go`).

1. **Reconnect auto-drain.** Today the only drain triggers are boot (`cloud-boot.js:221 pullOnOpen`) and the side effect of the next `writeRecord` (`sync.js:1050 flushPending`). There is no `online`/`visibilitychange` listener anywhere in `web/cloud/js` (grep-confirmed). So queued offline edits sit until the user writes again or reloads. Fix: on window `online` and on `visibilitychange`→visible while `navigator.onLine`, trigger the same boot drain path (`pullOnOpen`), debounced, with no overlapping runs. Two listeners, no scheduler framework.

2. **Session-expiry detection + re-auth.** The 30-day server session is non-sliding and re-minted only at WebAuthn login/register finish. When it expires the server returns 401. The client currently buckets 401 as `offline` at four sites (`sync.js` bootstrap 448-451, pullTail 506-509, flushPending 908-923, and the `isPermanentSyncStatus` transient list 677-679), so `describeSyncStatus` reports "Offline" forever with no recovery path and the queue is stranded. Fix: classify 401 as a distinct `auth-expired` sync state (403/408/429 stay transient-offline as-is); NEVER drop pending ops; surface the state in the existing sync-status UI (`unlock.js renderUnlocked`'s `#sync-status`) with a "Re-authenticate" button that REUSES the existing passkey ceremony (`unlock.js assertPasskey` — the documented reauthentication primitive that hits `/api/webauthn/login/begin`+`/finish`, re-minting the server session cookie) and on success immediately drains the queue.

### Benefit
Queued offline edits sync on reconnect without a write or reload; an expired session shows an honest re-auth prompt instead of an eternal "Offline" badge stranding the queue.

## Context (from discovery)
- **Primary file:** `web/cloud/js/sync.js` (module with a global `let offline = false;` at line 52 and exported functions — no class/constructor). Drain machinery = `pullOnOpen(ctx)` (line 958: `bootstrapIfNeeded` + `tryForceSnapshot` + `flushPending` + `pullTail`).
- **401 sites to split from offline:** `sync.js` bootstrap snapshot 448-451, pullTail 506-509, flushPending 897-924, and the `isPermanentSyncStatus` helper 677-679 (401 currently listed as transient-not-permanent — keep it non-permanent but route to auth-expired instead of offline). `tryForceSnapshot` (698-770) also has 401-as-offline sites via `!res.ok` → `offline = true`; treat 401 there consistently.
- **Status surface:** `getSyncStatus` (1126) returns `{offline, ...}`; `describeSyncStatus` (1142) renders the badge text. Only render consumer of `describeSyncStatus` is `unlock.js renderUnlocked` (137: `#sync-status` element, 146-156). This is the "existing sync-status UI" and the blessed minimum affordance surface.
- **Passkey ceremony to reuse:** `unlock.js:72 assertPasskey()` — exported, documented as the reauthentication primitive; returns `{accountId, dek}` (we discard it — the point is the re-minted session cookie from `/api/webauthn/login/finish`). To avoid a static circular import (unlock.js already dynamic-imports sync.js), `sync.js`'s new `reauthenticate` uses a dynamic `import('./unlock.js')`.
- **Real-app boot path:** `cloud-boot.js:221` awaits `pullOnOpen(ctx)` — the place to also start the reconnect listeners for the real app.
- **Tests:** `web/cloud/js/tests/sync.test.js` — pure-unit layer, `fake-indexeddb/auto`, mocks `global.fetch` via `vi.fn`/`Response`, seeds `sync_meta`. Existing test at line 589 ("still treats 401/403/408/429 as transient, not as a full vault") asserts 401→`offline=true` and MUST be updated: 401→auth-expired, 403/408/429 stay offline.
- **Env:** `pnpm test` needs Node 20 — prepend `/tmp/node-v20.18.1-linux-x64/bin` to PATH.

## Development Approach
- **Testing approach:** Regular (code first, then tests) — this extends an existing pure-unit test file with established mocking patterns.
- Client-side only. Do NOT edit `internal/cloudserver/*`, `web/cloud/sw.js` (owned by another executor right now), and avoid `account-delete.js`/`settings.js` beyond nothing (the re-auth affordance lives in the sync-status surface, not Settings).
- Reuse existing machinery: `pullOnOpen` for draining, `assertPasskey` for re-auth, the module-global-flag pattern (`offline`) for `authExpired`, the single-slot promise-queue pattern (`withRecordsLock`, line 64) as the model for a simple in-flight guard.
- Every task ends with tests that must pass before the next.
- Run tests with: `PATH=/tmp/node-v20.18.1-linux-x64/bin:$PATH pnpm test web/cloud/js/tests/sync.test.js` for the focused loop, full `pnpm test` in the verify task.

## Testing Strategy
- **Unit tests:** extend `web/cloud/js/tests/sync.test.js` (the existing sync suite — no new file, per project testing-posture rule).
- Required cases: 401 → auth-expired state (not offline) with pending queue preserved; a real network failure (fetch throws) and a 5xx still classify offline; `online` event triggers a drain with no user write; re-auth success drains the queue; 403/408/429 stay offline (update the existing 589 test).
- No e2e layer for cloud shell unit sync.

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## What Goes Where
- Implementation Steps: sync.js state + classification + exports, listener wiring, unlock.js button, tests.
- Post-Completion: manual browser verification of the re-auth button + reconnect drain in a real cloud deployment (no automatable seam).

## Implementation Steps

### Task 1: Distinct auth-expired classification in sync.js
- [x] add a module-global `let authExpired = false;` beside `let offline = false;` (line 52), with a short comment: 401 = session expired, distinct from network-offline; pending ops are never dropped.
- [x] add a tiny helper `function isAuthExpiredStatus(status) { return status === 401; }` near `isPermanentSyncStatus` (677); keep 401 OUT of the permanent set (no wedge, no writeError) — it routes to auth-expired instead.
- [x] at each 401-reachable `!res.ok`/`!snapRes.ok`/`!snap.ok` site (bootstrap 448-451, pullTail 506-509, flushPending 897-924, tryForceSnapshot 724-744 & snapshot-leg), branch: if `isAuthExpiredStatus(status)` set `authExpired = true; offline = false;` and return without touching `offline`/writeError/pending; else keep the existing offline/permanent handling. 403/408/429 keep current transient-offline behavior. (401 check placed in snapshotAt so both maybeSnapshot and tryForceSnapshot's snapshot leg share it.)
- [x] clear `authExpired = false` at every existing success site that sets `offline = false` (bootstrap 452, pullTail 510, flushPending 925, tryForceSnapshot 745, and the catch-blocks that set `offline = true` on a thrown fetch must also leave `authExpired` untouched — a genuine network throw is offline, not auth-expired).
- [x] surface `authExpired` in `getSyncStatus` return object (1130) and lead `describeSyncStatus` (1145) with `'Session expired — re-authenticate'` when `status.authExpired` (takes precedence over the Offline/Synced clause).
- [x] reset `authExpired = false` in `resetLocalSync` if it clears `offline` (keep state consistent).
- [x] write test: with pending ops queued and the server returning 401 on `/api/sync/ops`, `getSyncStatus` reports `authExpired === true`, `offline === false`, and the pending row is preserved (still in the queue).
- [x] write test: `describeSyncStatus` text contains the re-authenticate wording when auth-expired.
- [x] update the existing "still treats 401/403/408/429 as transient" test (589): 401 → `authExpired === true && offline === false`; assert 403/408/429 still `offline === true`.
- [x] write test: a thrown fetch (network failure) and a 5xx still yield `offline === true` and `authExpired === false`.
- [x] run focused sync tests — must pass before Task 2. (49/49 pass)

### Task 2: reauthenticate(ctx) export that re-runs the passkey ceremony and drains
- [ ] add exported `async function reauthenticate(ctx)` in sync.js: `const { assertPasskey } = await import('./unlock.js');` then `await assertPasskey();` (re-mints the server session cookie via login/finish — discard the returned dek/accountId), then `authExpired = false;`, then `await pullOnOpen(ctx);` to drain immediately; return `getSyncStatus(ctx)` (or `describeSyncStatus`).
- [ ] ensure the dynamic import cannot deadlock the static graph (sync.js must NOT statically import unlock.js — unlock.js already dynamic-imports sync.js).
- [ ] write test: seed an auth-expired state with a pending op; stub `assertPasskey` (mock the `../unlock.js` module) to succeed and make the mocked fetch return 200 for `/api/sync/ops` afterward; assert `reauthenticate` clears `authExpired` and the pending queue drains (pending count → 0).
- [ ] run focused sync tests — must pass before Task 3.

### Task 3: Reconnect auto-drain listeners
- [ ] add exported `function startReconnectAutoDrain(ctx)` in sync.js: wire `window.addEventListener('online', trigger)` and `document.addEventListener('visibilitychange', ...)` where the visibility handler calls `trigger` only when `document.visibilityState === 'visible' && navigator.onLine`. `trigger` = a debounced runner that calls `pullOnOpen(ctx)` with a simple in-flight guard so concurrent/overlapping events coalesce into one run (reuse the single-slot-promise pattern à la `withRecordsLock`; e.g. a module `let drainInFlight = null;`). Return a teardown function that removes both listeners (for tests/cleanliness). Guard for missing `window`/`document` (no-op) so non-DOM contexts don't throw.
- [ ] keep it lazy: no timers framework — a short `setTimeout` debounce (e.g. 250ms) coalescing bursts is enough; the in-flight guard prevents overlap.
- [ ] write test: after `startReconnectAutoDrain(ctx)` with the server healthy, dispatching a `window` `online` event triggers a `pullOnOpen`/`flushPending` drain (mocked fetch sees a `/api/sync/ops` GET or the pending flush) with NO `writeRecord` call; assert the drain happened (e.g. pending drains or the ops fetch fires).
- [ ] write test: two rapid `online` events do not launch overlapping drains (assert the drain body runs once, or fetch not re-entered while in flight) — the in-flight guard holds.
- [ ] write test: teardown removes listeners (a post-teardown `online` event does not drain).
- [ ] run focused sync tests — must pass before Task 4.

### Task 4: Wire listeners into boot + re-auth button in the sync-status surface
- [ ] in `cloud-boot.js`, after `await pullOnOpen(ctx)` (221), call `startReconnectAutoDrain(ctx)` (import it alongside `pullOnOpen` at 191-194). Best-effort, never blocks boot.
- [ ] in `unlock.js renderUnlocked` (132-156), after computing `describeSyncStatus`, read `getSyncStatus(ctx)`; when `authExpired`, render a "Re-authenticate" button next to `#sync-status` that calls the new `reauthenticate(ctx)`, then re-renders the status text on success and shows an inline error on failure. Use `textContent`/DOM creation (E2EE threat model: never `innerHTML` with server-influenced values). Keep it minimal — no Settings changes.
- [ ] (no new unit test strictly required for the DOM wiring beyond what Task 1-3 cover; if a lightweight jsdom assertion for the button-appears-on-auth-expired is cheap in the existing suite, add it — otherwise cover reauthenticate() behavior in Task 2 and note the button as manual verification.)
- [ ] run focused sync tests — must pass before Task 5.

### Task 5: Verify acceptance criteria
- [ ] verify all Overview requirements: online/visibility drain with no write; 401→distinct auth-expired preserving pending ops; passkey re-auth drains; genuine network errors still offline; tests cover each path.
- [ ] confirm no edits to `internal/cloudserver/*`, `web/cloud/sw.js`, `account-delete.js`, `settings.js`.
- [ ] run the FULL suite: `PATH=/tmp/node-v20.18.1-linux-x64/bin:$PATH pnpm test` — all pass.
- [ ] run `go build ./...` (sanity — this is a JS-only change but keep the gate) and any JS lint the project runs in CI.

## Technical Details
- `authExpired` is a module-global boolean mirroring `offline`, exposed via `getSyncStatus`. Precedence in `describeSyncStatus`: auth-expired > offline > synced/pending, because an expired session is the actionable root cause (offline is a red herring the current bug produces).
- `reauthenticate` reuses `assertPasskey` (dynamic import) → `/api/webauthn/login/finish` re-mints the non-sliding 30-day session cookie server-side, then `pullOnOpen` drains. No server change.
- Reconnect trigger reuses `pullOnOpen` (the exact boot drain path). Debounce + single-slot in-flight guard prevents overlapping runs; `navigator.onLine` gate on visibility avoids draining while still offline.
- ponytail: module-global `authExpired` + `drainInFlight` — fine for one device's serial sync engine, same posture as the existing `offline`/`recordsLock` globals.

## Post-Completion
**Manual verification** (no automatable seam):
- In a real cloud deployment: let the session expire (or clear the session cookie), attempt a write, confirm the sync-status shows "Session expired — re-authenticate" with a working button that re-runs the passkey ceremony and drains the queue.
- Toggle the browser offline→online with a queued edit and confirm the edit syncs without a manual write or reload; repeat with a visibility regain (background→foreground tab) while online.
