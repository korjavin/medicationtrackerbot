# Cloud import self-heal + vault-import snapshot-path verification (med-0ol.7, med-0ol.8)

## Overview

Two related cloud-sync-engine issues under epic med-0ol, done together in one PR
because both live in `web/cloud/js/sync.js` + the shared Settings import UI.

**med-0ol.7 (P1)** — A failed/interrupted bulk import can leave a cloud account
chronically WEDGED: pending ops that hit a *permanent* server error (413 quota /
400) are recorded but never stop being re-POSTed (once per open, forever), and a
bloated un-compacted oplog re-downloads on every open. Must self-heal so a bad
import can't brick a real user's account, plus a user-facing recovery affordance.

**med-0ol.8 (P2)** — VERIFY the full-vault (archive/json/gzip) CloudVault import
uses the single-snapshot path (not per-record ops) and has the same import-UX
safeguards added for .nxk in #613. Document the finding; fix only if a gap exists.

### What #613 already covers (verified by reading the merged code)

- **Over-cap 400 storm — FIXED.** `flushPending` drains `pending` in
  `≤MAX_OPS_PER_BATCH` (500) / `≤FLUSH_MAX_BODY_BYTES` (900 KiB) chunks, so a
  bulk import no longer trips the server's 500-op / 1 MiB caps with a permanent
  400 that blind retries can never clear.
- **Permanent-vs-transient — FIXED.** `isPermanentSyncStatus` splits 413/400
  (durable `writeError`/`snapshotError`, returns instead of tight-looping) from
  401/403/408/429/5xx/network (transient, `offline`, retried).
- **Oplog compaction — FIXED (bounded).** `maybeSnapshot` compacts once the
  un-compacted tail passes `SNAPSHOT_THRESHOLD` (500) ops, and backs off to one
  attempt per threshold via `snapshotErrorSeq` when the snapshot itself is
  over-cap — no more re-gzip+re-encrypt of the whole vault on every flush.
- **Import UX — FIXED.** `setImportBusy` in `importexport.js` gives the vault
  import a busy label, a re-entry guard (`importInFlight`), and a `beforeunload`
  prompt; it is shared by both the `.nxk` and full-vault import buttons.

### The remaining gap (this PR)

1. A permanently-failing write batch stays in `pending` and is re-POSTed on
   **every open, forever** — #613 stopped the *tight loop* but not the
   *per-open* retry. There is no retry budget and no manual un-wedge. Add:
   - **(a) a write-error retry budget** → after N consecutive permanent-error
     opens, PAUSE syncing (`syncWedged`) instead of re-posting the doomed batch
     forever. Transient errors never count toward the budget.
   - **(b) a Settings "Reset local sync (rebuild from server)" affordance** →
     `resetLocalSync(ctx)` clears the local IDB mirror + sync meta + pending and
     re-bootstraps this device from the server's compacted snapshot. Un-wedges
     without support; also escapes a bloated-oplog-every-open device.

### med-0ol.8 finding (to confirm with a test + doc, not re-architect)

`CloudVault.importAll` (cloud-boot.js) → `replaceAllRecords` (local, zero ops) +
`forceSnapshot` → `tryForceSnapshot` posts exactly **1 bump op + 1 gzip'd
snapshot** = a CONSTANT 2 requests regardless of vault size, NOT per-record ops.
UX safeguards already present via shared `setImportBusy`. So .8 is verify + test
+ doc; add a snapshot-path invariant test so a future regression to per-op writes
is caught.

## Context (from discovery)

- Files/components involved:
  - `web/cloud/js/sync.js` — sync engine: `flushPending`, `maybeSnapshot`,
    `readMeta`, `getSyncStatus`, `describeSyncStatus`; add `resetLocalSync`.
  - `web/cloud/js/cloud-boot.js` — `window.CloudVault`; add `resetLocalSync` wrapper.
  - `web/static/js/features/settings/importexport.js` — Settings import/export UI;
    add a cloud-gated "Reset local sync" control (mirrors the `.nxk` group gating).
  - `web/static/index.html` — the Import/Export section HTML; add the reset button.
  - `web/cloud/js/tests/sync.test.js` — integration tests (real fetch-mock harness).
  - `web/static/js/tests/settings.importexport.test.js` — UI-binding test.
  - `docs/cloud-mode.md` — document self-heal + reset + the .8 finding.
- Related patterns found:
  - Durable meta fields (`writeError`, `snapshotError`, `snapshotErrorSeq`) read
    in `readMeta`, surfaced in `getSyncStatus`/`describeSyncStatus` — mirror for
    `writeErrorStreak` + `syncWedged`.
  - `isPermanentSyncStatus` already classifies the exact errors the budget counts.
  - `withRecordsLock` serializes destructive record-store mutations (used by
    `replaceAllRecords`, `dropPendingForTypes`) — `resetLocalSync` must use it.
  - Cloud-only controls are gated by `isCloud()` and revealed like `importexport-nxk-group`.
  - `window.CloudVault.{exportAll,importAll}` are dynamic-import wrappers in
    cloud-boot.js so the shared `importexport.js` never imports cloud-only modules
    directly — `resetLocalSync` follows the same shape.
- Dependencies identified: none new. Pure JS. `pnpm test` (Vitest + jsdom /
  fake-indexeddb) is the gate; no Go changes expected.

## Development Approach
- **Testing approach**: NO unit tests. Add integration tests to the existing
  `web/cloud/js/tests/sync.test.js` (real crypto + fake-indexeddb + fetch mock)
  and one binding test to `settings.importexport.test.js` — these guard real
  boundaries (the sync-engine wedge/reset state machine and the snapshot-path
  request-count invariant). No `*-branches` / `pin-defect-N` files.
- Complete each task fully before moving to the next.
- **CRITICAL: preserve sync correctness** — seq ordering, snapshot compaction,
  optimistic-write reconciliation. Self-heal/reset must not dup or lose records,
  and the normal single-write path must be unchanged.
- No hardcoded colors / inline `.style.` in any Settings UI (design-token guards).
- Maintain backward compatibility: new meta keys default safely when absent.

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**:
  - sync.test.js — the retry-budget → wedged transition, and `resetLocalSync`
    rebuild-from-snapshot (guards the med-0ol.7 state machine).
  - sync.test.js — the med-0ol.8 snapshot-path invariant (forceSnapshot after a
    large `replaceAllRecords` issues exactly 1 ops POST + 1 snapshot POST,
    independent of record count).
  - settings.importexport.test.js — the reset control is cloud-gated and calls
    `CloudVault.resetLocalSync` (guards the UI wiring).
- **E2E tests**: none (no cloud e2e suite exists for this flow).

## Progress Tracking
- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix.
- Keep this plan in sync with actual work.

## Implementation Steps

### Task 1: Write-error retry budget → pause syncing (med-0ol.7 self-heal a)
- [x] In `sync.js`, add `const WRITE_ERROR_BUDGET = 3;` near the other sync caps,
      with a comment: consecutive permanent-error opens before syncing pauses.
- [x] Extend `readMeta()` to read `writeErrorStreak` (default 0) and `syncWedged`
      (default false); add both to the returned object and the `Promise.all` batch.
- [x] In `flushPending()`, at the top (before the drain loop), early-return
      `false` when `syncWedged` is set — a wedged device stops re-posting the
      doomed batch (writes still queue durably to `pending`, nothing is lost).
- [x] In `flushPending()`'s permanent-4xx write-error branch, increment
      `writeErrorStreak`; when it reaches `WRITE_ERROR_BUDGET`, also set
      `syncWedged: true`. Persist both alongside the existing `writeError`.
- [x] On the successful-POST branch, reset `writeErrorStreak: 0` (add to the
      existing `writeMeta({ lastSyncedAt, writeError: null })`). Transient
      (offline/5xx) failures must NOT touch the streak — confirm that branch is
      untouched.

### Task 2: `resetLocalSync` — rebuild this device from the server snapshot (med-0ol.7 recovery b)
- [x] In `sync.js`, add exported `async function resetLocalSync(ctx)`: under
      `withRecordsLock`, clear the `records`, `pending`, and `sync_meta` stores in
      a SINGLE IDB transaction (atomic), set module `offline = false`, then
      `await pullOnOpen(ctx)` to re-bootstrap from the server's compacted snapshot
      + tail. Do NOT clear the `device` store (keeps NK / LDK / crypto state).
- [x] Document in the function header that this DISCARDS un-synced local pending
      writes by design (the un-wedge escape hatch) and that clearing `sync_meta`
      nulls `localLastSeq`/`syncWedged`/`writeError`/`forceSnapshotPending` so the
      next bootstrap starts clean.

### Task 3: Surface wedged state + wire CloudVault.resetLocalSync (med-0ol.7)
- [x] In `sync.js`, add `wedged: meta.syncWedged` to `getSyncStatus()`'s return.
- [x] In `describeSyncStatus()`, when `wedged`, push a clear recovery hint (e.g.
      "Sync paused after repeated failures — reset local sync to recover") —
      plain text, joined into the existing status line.
- [x] In `cloud-boot.js`, add `resetLocalSync` to `window.CloudVault` as a
      dynamic-import wrapper mirroring `exportAll`/`importAll`:
      `async resetLocalSync() { const { resetLocalSync } = await import('/js/sync.js'); await resetLocalSync(ctx); }`.

### Task 4: Settings "Reset local sync" affordance (med-0ol.7 recovery UI)
- [x] In `web/static/index.html`, inside `#settings-importexport`, add a
      cloud-only group (hidden by default, id `importexport-reset-sync-group`) with
      a heading, a short explanatory note ("Rebuild this device from the server —
      discards unsynced local changes; use if sync is stuck after a failed
      import."), and a button `#importexport-reset-sync-btn`. Reuse existing
      `wg-*` classes only; no inline styles/colors.
- [x] In `importexport.js`, reveal the reset group when `isCloud()` (like the
      `.nxk` group) and bind the button once (dataset guard). On click: confirm
      via `safeConfirm`, then `await window.CloudVault.resetLocalSync()`, then
      `location.reload()`. Guard against re-entry with the existing
      `importInFlight`/`setImportBusy` mechanism so it can't collide with an
      in-flight import.
- [x] Export the handler on `window.SettingsImportExport` (e.g. `resetSync`) for
      symmetry and testability, matching `importNxk`.

### Task 5: Integration tests (med-0ol.7 + med-0ol.8)
- [x] In `sync.test.js`, add a `describe` for the med-0ol.7 wedge state machine:
      seed a bootstrapped cursor, stub the ops POST to return 413/400, and assert
      that after `WRITE_ERROR_BUDGET` `flushPending`/`pullOnOpen` cycles
      `getSyncStatus().wedged` is true, `describeSyncStatus` names the recovery,
      and a subsequent cycle issues NO further ops POST (budget stops the retry).
- [x] In `sync.test.js`, add a test that `resetLocalSync(ctx)` clears local
      pending + records, then re-bootstraps from a stubbed 200 snapshot: after it,
      `wedged` is false, `pendingCount` is 0, and the records match the snapshot.
- [x] In `sync.test.js`, add the med-0ol.8 snapshot-path invariant: seed a large
      record set (e.g. 1500 records) via `replaceAllRecords`, run `forceSnapshot`,
      and assert exactly ONE POST to `/api/sync/ops` (the bump) and ONE POST to
      `/api/sync/snapshot` — request count is constant, NOT proportional to the
      record count (proves no per-op fallback).
- [x] In `settings.importexport.test.js`, add a test (via the existing harness)
      that the reset control is hidden outside cloud, revealed in cloud
      (`window.__MEDTRACKER_CLOUD__`), and its click calls
      `window.CloudVault.resetLocalSync` then reloads.

### Task 6: Verify acceptance criteria
- [x] `npx vitest run` — the full frontend suite (sync + settings + architecture
      guards) must pass, including `architecture.*` globals/design-token guards.
      (309 files, 3528 passed / 29 skipped.)
- [x] `go build ./...` — only if any Go file was touched (not expected; JS-only).
      This plan touches no Go files; the branch's Go changes belong to unrelated work.
- [x] Re-confirm the normal single-write path is unchanged: the wedged guard in
      `flushPending` (`sync.js:787`) early-returns only when `syncWedged` is set —
      a no-op when false, so a plain `writeRecord`/`recordsPort.put` still flushes
      inline (covered by existing repaint tests).

### Task 7: [Final] Document the self-heal + the med-0ol.8 finding
- [x] In `docs/cloud-mode.md` (sync-protocol / import section), document: the
      write-error retry budget + `syncWedged` pause, the "Reset local sync"
      recovery affordance, and the med-0ol.8 finding that full-vault import uses
      the single-snapshot path (constant 2 requests) with the shared import-UX
      safeguards. Be explicit about what #613 already covered vs what this PR adds.

## Technical Details

- New `sync_meta` keys (device-local, default-safe when absent):
  - `writeErrorStreak: number` — consecutive permanent-error flush opens; reset to
    0 on any accepted batch.
  - `syncWedged: boolean` — once true, `flushPending` early-returns; cleared only
    by `resetLocalSync` (which clears the whole `sync_meta` store).
- `WRITE_ERROR_BUDGET = 3` — small so a genuinely-doomed batch stops fast; only
  permanent 4xx (413/400 via `isPermanentSyncStatus`) increments it, so flaky
  networks/5xx never wedge.
- `resetLocalSync` atomicity: one `readwrite` transaction over
  `['records','pending','sync_meta']` under `withRecordsLock`, then `pullOnOpen`.
  Records/pending/meta wiped together, so a crash mid-reset leaves a null cursor
  the next bootstrap heals — no partial-state hazard.
- Correctness invariants preserved: seq ordering (untouched — reset re-bootstraps
  from the server floor), snapshot compaction (`maybeSnapshot` unchanged), and the
  optimistic single-write path (wedged guard is a no-op when not wedged).

## Post-Completion

**Manual verification** (informational, not agent-automatable):
- On a real wedged test account: confirm the status line shows the pause message,
  the "Reset local sync" button rebuilds the device cheaply (one snapshot pull,
  no 160 MB oplog re-download), and normal writes resume afterward.
- Confirm a large full-vault import still shows the busy/beforeunload UX and lands
  as a single snapshot upload (network panel: 1 ops POST + 1 snapshot POST).
