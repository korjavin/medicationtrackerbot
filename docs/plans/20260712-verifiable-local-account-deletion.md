# Verifiable local account deletion (bd med-yor.3)

## Overview
P0 cloud-privacy bug. Self-service account deletion can report success while the
browser still holds plaintext vault records and warm-unlock (LDK) material.
`clearLocalVault()` in `web/cloud/js/account-delete.js` fires
`indexedDB.deleteDatabase('medtracker-cloud')` bare — no promise wrap, no
`onsuccess`/`onerror`/`onblocked`, not awaited — and the delete flow in
`web/static/js/features/settings.js` navigates away immediately after. If a live
IndexedDB connection blocks the delete, the server account is gone but the local
copy survives, unverified. Push subscription and service-worker registration are
never removed. Separately, the safety export `exportVaultToFile()` writes
plaintext provider keys + access tokens with no warning, unlike the Import/Export
UI which gates that behind a confirm.

Fix: make local erasure verified (await the IDB delete, resolve only on
`onsuccess`, throw a recoverable honest error on `onerror`/`onblocked`), reuse the
existing `push.js` `unsubscribe()` + unregister the SW (both best-effort),
auto-close this tab's own DB handles so they don't block the delete, keep the
navigation gated on verified erasure, and gate the safety export's plaintext
secrets behind the same warning.

## Context (from discovery)
- Files/components involved:
  - `web/cloud/js/account-delete.js` — `clearLocalVault()` (lines 64-76),
    `exportVaultToFile()` (lines 14-28).
  - `web/cloud/js/push.js` — already exports `unsubscribe()` (line 72). REUSE.
  - `web/cloud/js/localdb.js` — `openDb()` (line 11) opens `medtracker-cloud`;
    registers no `onversionchange`, so a live connection blocks `deleteDatabase`.
  - `web/static/js/features/settings.js` — delete confirm handler (lines 523-536)
    inside `bindDeleteAccount()`. **Touch ONLY this handler; another queued task
    owns the rest of this file.**
  - `web/static/js/features/settings/importexport.js` — the reference
    plaintext-secrets warning (lines 94-107): message "This backup will contain
    your provider API keys and access tokens in plain text. Download anyway?".
- Related patterns found:
  - Promise-wrapped IDB with `onsuccess`/`onerror` is already the house style
    (`push.js` `readReminders`/`writeReminders`, `localdb.js` `openDb`).
  - Tests are integration-first; extend the existing describe blocks — never add
    standalone task-N/coverage-suffix files.
- Dependencies identified:
  - `account-delete.js` is dynamic-imported by the web/static shell as
    `/js/account-delete.js`; `push.js` sits beside it as `/js/push.js`, so a
    dynamic `import('./push.js')` resolves at runtime. Use a dynamic import inside
    `clearLocalVault()` so the push→crypto→sync chain only loads at deletion time
    and stays easy to stub in the unit test.

## Development Approach
- **Testing approach**: Regular (code first, then tests) — bug fix with a clear
  solution and existing suites to extend.
- Smallest coherent diff (ponytail): reuse `push.js` `unsubscribe()`; do not
  rebuild push removal. One-line handle-coordination fix in `localdb.js`. No new
  `window.*` globals. Frontend-only JS — no Go changes expected.
- Complete each task fully (including its tests) before the next.
- Run `pnpm test` after changes; all affected suites must pass before moving on.

## Testing Strategy
- **Unit/integration tests** (Vitest + jsdom, run via `pnpm test`):
  - Extend `web/cloud/js/tests/account-delete.test.js` `describe('clearLocalVault')`
    and `describe('exportVaultToFile')`.
  - Extend `web/static/js/tests/settings.toggles.test.js` delete-flow describe.
- No E2E harness in this project for these paths; integration tests via the
  frontend harness are the ceiling here.

## Progress Tracking
- Mark completed items `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.
- Keep this plan in sync with actual work.

## What Goes Where
- Implementation Steps (checkboxes): JS code changes + tests, runnable by the agent.
- Post-Completion (no checkboxes): manual cross-tab/browser verification notes.

## Implementation Steps

### Task 1: Harden clearLocalVault() with verified IDB deletion + best-effort push/SW cleanup
- [ ] In `web/cloud/js/account-delete.js`, rewrite `clearLocalVault()` so it, in
      order: (1) best-effort `await import('./push.js')` then `unsubscribe()`
      inside its own try/catch (a failure must NOT block or fail the wipe);
      (2) best-effort service-worker unregister — `navigator.serviceWorker
      ?.getRegistration('/')` then `reg.unregister()` — in its own try/catch;
      (3) the load-bearing verified IndexedDB delete; (4) best-effort
      `caches.keys()`/`delete()` cleanup as today.
- [ ] Implement the IDB delete as an awaited Promise around
      `indexedDB.deleteDatabase('medtracker-cloud')`: resolve on `req.onsuccess`
      (onsuccess IS the removal confirmation), reject on `req.onerror`, and treat
      `req.onblocked` as a recoverable failure that rejects with an actionable
      message (e.g. "Close other open tabs of this app and try again."). Guard the
      `typeof indexedDB === 'undefined'` / missing-`deleteDatabase` case (resolve).
- [ ] Ensure the function only resolves once deletion is verified; on
      error/blocked it THROWS (propagates) so the caller can surface an honest
      recoverable error — do not swallow the IDB failure (unlike the best-effort
      push/SW/caches steps).
- [ ] Update the `clearLocalVault` doc comment to state the new contract (verified
      erasure; throws on unverified local wipe; push/SW/caches are best-effort).
- [ ] Extend `web/cloud/js/tests/account-delete.test.js` `describe('clearLocalVault')`:
      happy path — `deleteDatabase` returns a request; firing `onsuccess` resolves
      and caches are still cleared; assert push `unsubscribe` + SW `unregister`
      were attempted. Mock `indexedDB.deleteDatabase` to return a request object
      whose `on*` handlers the test fires; mock `navigator.serviceWorker
      .getRegistration`/`registration.unregister`; stub the dynamic `./push.js`
      import (e.g. `vi.mock`) so `unsubscribe` is observable.
- [ ] Extend the same describe: BLOCKED path — firing `onblocked` → `clearLocalVault()`
      REJECTS with a recoverable error and never resolves as success. ERROR path —
      firing `onerror` → rejects. And: a push-unsubscribe throw or SW-unregister
      throw does NOT fail the wipe (IDB `onsuccess` still resolves).
- [ ] Run `pnpm test` (at least the account-delete suite) — must pass before Task 2.

### Task 2: Auto-close this tab's DB handles so they don't block deletion
- [ ] In `web/cloud/js/localdb.js` `openDb()`, on the resolved connection set
      `db.onversionchange = () => db.close();` (one line, in `req.onsuccess`)
      so a live connection auto-closes when `deleteDatabase` issues `versionchange`.
      This is the "close known handles / coordination before deletion" item.
- [ ] Add/extend a test asserting `openDb()` registers an `onversionchange`
      handler that closes the connection. Prefer extending an existing localdb
      test suite if one exists; otherwise add the case to the nearest owning
      suite (do NOT create a coverage-suffix file). If no owning suite exists and
      adding one is disproportionate, note it and rely on the account-delete
      blocked-path test to cover the observable behavior. ⚠️ decide during impl.
- [ ] Run `pnpm test` — must pass before Task 3.

### Task 3: Gate the safety export's plaintext secrets behind a warning
- [ ] In `web/cloud/js/account-delete.js` `exportVaultToFile()`, before calling
      `CloudVault.exportAll({ includeSecrets: true })`, show a confirm with the
      same message as Import/Export ("This backup will contain your provider API
      keys and access tokens in plain text. Download anyway?") using
      `window.confirm`; if the user declines, return without exporting/downloading.
      Keep it dependency-light (no heavy import of the importexport module).
- [ ] Extend `describe('exportVaultToFile')` in
      `web/cloud/js/tests/account-delete.test.js`: with a `window.confirm` stub —
      DECLINING aborts the download (no `CloudVault.exportAll`, no anchor click);
      ACCEPTING proceeds as the existing happy-path test expects. Update the
      existing happy-path test to provide a confirm stub that returns true.
- [ ] Run `pnpm test` — must pass before Task 4.

### Task 4: Keep settings.js navigation gated on verified erasure
- [ ] In `web/static/js/features/settings.js`, ONLY the delete confirm handler
      (~lines 523-536): confirm that because `clearLocalVault()` now throws on
      unverified erasure, the existing `await clearLocalVault()` before
      `window.location.href = baseDomainURL()` already prevents navigation on
      failure (the surrounding try/catch shows `err.message` in `errorEl` and
      re-enables the button). If the message would be misleading for a
      post-server-delete local-wipe failure, set a clearer honest message inside
      the catch (the account IS deleted server-side; only the local copy could not
      be erased) — but keep every change inside this handler. Do not touch any
      other part of settings.js.
- [ ] Extend the delete-flow describe in
      `web/static/js/tests/settings.toggles.test.js`: a case where
      `clearLocalVault` REJECTS (post-server-delete local wipe fails) → assert NO
      navigation occurs and the error text is shown. Reuse `mountCloudWithDeleteModule`.
- [ ] Run `pnpm test` — must pass before Task 5.

### Task 5: Verify acceptance criteria
- [ ] Verify: after deletion, IDB vault/device data removal is awaited and
      verified; push subscription + SW state are removed (best-effort); a blocked
      deletion produces a visible recoverable failure and no navigation; the
      safety export warns before writing plaintext secrets.
- [ ] Run the full frontend suite: `pnpm test` — all green.
- [ ] Confirm no new `window.*` globals were introduced (grep the diff); confirm
      no Go files changed.
- [ ] Sanity-check architecture suites that touch account-delete / settings still pass.

## Technical Details
- IDB delete promise shape:
  ```js
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('medtracker-cloud');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Could not erase this device’s local copy.'));
    req.onblocked = () => reject(new Error('Close other open tabs of this app and try again.'));
  });
  ```
- Push/SW/caches steps stay best-effort (try/catch, swallow) — only the IDB delete
  is allowed to reject `clearLocalVault()`.
- `localdb.js`: `db.onversionchange = () => db.close();` inside `req.onsuccess`
  before `resolve(req.result)`.

## Post-Completion
*No checkboxes — manual/external verification only.*

**Manual verification** (optional, cannot be automated in jsdom):
- Open the app in two tabs, trigger delete in one, confirm the blocked path
  surfaces the "close other tabs" message and does NOT navigate; close the other
  tab and retry to confirm success + navigation.
- Confirm in a real browser that after deletion, DevTools → Application shows the
  `medtracker-cloud` IndexedDB gone, the service worker unregistered, and the push
  subscription removed.
