# Cloud: vault-backed `first_run_complete` so `WGFirstRun` can mount

## Overview

bd `med-4pz.5`. The in-app onboarding overlay (`window.WGFirstRun`, `web/static/js/features/firstrun/`)
already exists, ships in the real app, and is mounted from `/api/bootstrap`'s top-level `needs_first_run`.
In cloud mode it is dead because the shim hardcodes the flag:

```js
// web/cloud/js/apishim.js:219
needs_first_run: false,
```

and its completion endpoint is a lie:

```js
// web/cloud/js/apishim.js:242 — the stub's own comment names this bead
// Cloud has no server-side settings row to flip (med-4pz.5 moves it into the
// vault); ack it so the overlay dismisses instead of erroring.
'POST /api/firstrun/complete': async () => ({ success: true }),
```

This change makes both real, backed by the encrypted vault so the flag syncs across devices.

**Owner decision: an absent `first_run_complete` means "needs onboarding".** A vault field cannot be
backfilled the way bot mode's migration `071_add_first_run_state.sql` backfilled its SQLite column, and an
absent field cannot mean two things. Consequence, accepted deliberately: **existing cloud vaults will see the
onboarding overlay once**, dismiss it, and never see it again. Cloud mode has essentially no outside users
yet, and nobody has ever been shown onboarding, so this is arguably correct rather than merely tolerable.

The alternative — have the claim wizard write `first_run_complete: false` so absence means "legacy, already
done" — was rejected: `web/cloud/js/signup.js` imports no sync engine and writes **zero** vault records today,
so it would wedge a networked oplog write (`bootstrapIfNeeded` → `/api/sync/snapshot` → `/api/sync/ops`) into
the signup ceremony, with an offline path to reason about, purely to spare a handful of vaults one dismissible
overlay.

**Out of scope.** No new onboarding screens (`med-4pz.2/.3/.4`), and no claim→app redirect (`med-8eh`). Do
**not** extend `VALID_STEPS` in `web/static/js/features/firstrun/state.js` — the four existing steps
(`welcome`, `permissions`, `integrations`, `done`) are what mounts, and adding step names with no screen module
would break the orchestrator's registry lookup. No Go changes at all.

## Context (from discovery)

- `web/cloud/js/apishim.js:217-224` — `bootstrapPayload()` returns `{cursor: 0, needs_first_run: false, ...}`.
  Both `cursor` and `needs_first_run` are **hardcoded literals**; `cursor` is unrelated to the sync engine's
  real cursor (`sync_meta.localLastSeq`) and stays as-is.
- `web/cloud/js/apishim.js:231-245` — the `STUBS` table: exact `"<METHOD> <path>"` string match, consulted
  **only after** the whole `shimCall` cascade falls through (`apishim.js:655-660`). Inline branches therefore
  always win over a STUBS entry. Unmatched → `apiError(404)` (`apishim.js:662-667`).
- `web/cloud/js/apishim.js:99` — `createSettingsDomain({ records, now, timeZone })`; `records` is
  `recordsPort(ctx)` (`web/cloud/js/sync.js:696-703`), needing only `ctx = {accountId, dek}`.
- `web/cloud/js/apishim.js:~209` — `settingsResponse()` already `await`s `settings.getGeneral()` as part of a
  `Promise.all`. **Reuse that read**; do not add a second one.
- `web/domain/settings.js:10-11` — `GENERAL_RECORD_TYPE = 'settings'` / `GENERAL_RECORD_ID = 'settings'`, the
  singleton that already carries `timezone` and `dismissed_tz_suggestion`.
- `web/domain/settings.js:73-117` — `getGeneral` / `setTimezone` / `setDismissedTzSuggestion`. Note the
  **merge-onto-existing** idiom (`...existing, recordId, clientTs: now(), deleted: false, …`) — it exists
  precisely so one field's write never clobbers a sibling. There is **no** `first_run_complete` accessor today.
- `web/static/js/features/auth-bootstrap.js:311-328` — the sole consumer: mirrors `res.needs_first_run` onto
  `window.__MEDTRACKER_BOOTSTRAP__` and calls `WGFirstRun.mount({needs_first_run})` on every fresh bootstrap.
- `web/static/js/features/firstrun/index.js:184-216` — `mount()` is latched by a module-local `_mounted`, but
  the latch is **per page load**. Across reloads, not re-opening the overlay depends entirely on the bootstrap
  payload flipping to `false`. So `bootstrapPayload()` must read the vault flag on **every** call — never cache it.
- `web/static/js/features/firstrun/index.js:170-181` — `complete()` `.catch(() => null)`s the POST, then sets
  the bootstrap mirror to `false` and dismisses. A failed vault write therefore dismisses the overlay for this
  page load and it reappears on the next reload. That is the safe direction; leave it.
- Tests: `web/static/js/tests/cloud.shim-contract.settings.test.js` owns the shim's settings/bootstrap shape;
  `web/static/js/tests/cloud.shim-contract.catchall.test.js:41-44` currently asserts the firstrun stub returns
  `{success:true}`. Harness: `web/static/js/tests/helpers/cloud-shim-harness.js` (in-memory `records` port,
  `installApiShim({}, {records, win})`).
- `web/static/js/tests/architecture.domain-purity.test.js` — scans every file under `web/domain/` and fails on
  `window.`, `document.`, `fetch(`, `indexedDB`, `navigator.`. The new accessor must do all I/O through the
  injected `records` port.

**Does not exist:** any `first_run_complete` in `web/domain/settings.js`; any dedicated unit test for that
module (it is exercised through the shim); any empty-vault signal in `bootstrapPayload`.

## Design decisions

- **Store the flag on the existing `settings` general singleton**, not a new record type. It already syncs,
  is already read once per `settingsResponse()`, and needs no new record plumbing.
- **`needs_first_run = !general.first_run_complete`.** Absent or `false` → mount. Only an explicit `true`
  suppresses it. This is the owner decision above.
- **Do not leak the flag into `GET /api/settings`.** Bot mode carries `needs_first_run` as a **top-level**
  bootstrap field, not inside the settings block (`internal/server/settings_handlers.go:460`). Keep the
  `/api/settings` response shape byte-identical, or the real app's settings code sees a new key.
  Practically: have `settingsResponse()` return the `general` object alongside `{settings, features}` for
  internal callers, and let `bootstrapPayload()` read `general.first_run_complete` from it. `GET /api/settings`
  spreads only `settingsBlock` + `features`, so it stays unchanged.
- **Replace the STUBS entry with a real inline branch**, not a smarter stub. STUBS entries are no-arg and are
  only reached after the cascade; a route that must `await` a domain write belongs in `shimCall`. Delete the
  stub (and its now-obsolete comment) so there is exactly one handler for the path.
- **`setFirstRunComplete` merges onto the existing record**, following `setTimezone`'s idiom, so completing
  onboarding never clobbers `timezone` or `dismissed_tz_suggestion`.
- **Read the flag on every `bootstrapPayload()` call.** Caching it would re-open the overlay across reloads
  (see the `_mounted` note above).

## Development Approach

- **Testing approach**: NO unit tests. They blow up the codebase for no value here.
  - add an integration test ONLY when it covers a real boundary (API contract, data migration, cross-component
    flow) and gives a guarantee manual checking can't
  - if no integration test adds a real guarantee, the task has NO test items — that is correct and expected
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: if a task adds an integration test, it must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Maintain backward compatibility

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: the shim's `/api/bootstrap` + `/api/firstrun/complete` contract is a real boundary —
  the overlay's re-open behavior across reloads depends on it. Drive it through the existing
  `cloud-shim-harness.js` (real `apishim.js`, in-memory `records` port), asserting the round trip. Extend the
  owning suites; do not add a new file (repo rule 8).
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Implementation Steps

### Task 1: `first_run_complete` accessor in the settings domain

- [x] in `web/domain/settings.js`, extend `getGeneral()` (`:73-80`) to return
      `first_run_complete: !!(rec && rec.first_run_complete)` alongside `timezone` and `dismissed_tz_suggestion`
- [x] add `async function setFirstRunComplete(done)` that merges onto the `GENERAL_RECORD_TYPE` singleton
      exactly as `setTimezone` (`:85-104`) does — `{...existing, recordId: GENERAL_RECORD_ID, clientTs: now(),
      deleted: false, first_run_complete: !!done}` — so it never clobbers `timezone` /
      `dismissed_tz_suggestion`
- [x] export it from the object `createSettingsDomain` returns, next to the other general-settings accessors
- [x] stay pure: I/O only through the injected `records` port — no `window`/`document`/`fetch`/`indexedDB`
      (`architecture.domain-purity.test.js` scans this directory)
- [x] comment the semantics at the accessor: **absent ⇒ needs onboarding**; a vault field cannot be backfilled
      the way bot-mode migration `071` backfilled its column, so only an explicit `true` suppresses the overlay

### Task 2: `bootstrapPayload` reports the real flag

- [x] in `web/cloud/js/apishim.js`, have `settingsResponse()` also return the already-fetched `general` object
      (it is in the existing `Promise.all`) — e.g. `return { settings: block, features: clampFeatures(features), general }`
- [x] in `bootstrapPayload()` (`:208-225`), replace the hardcoded `needs_first_run: false` (`:219`) with
      `needs_first_run: !settingsPart.general.first_run_complete`
- [x] leave `cursor: 0` exactly as-is — it is a shape-matching constant, unrelated to `sync_meta.localLastSeq`
- [x] **verify `GET /api/settings` is unchanged**: its handler spreads `settingsBlock` + `features` only
      (`apishim.js:238-241`), so `general` must not appear in its response. Assert this in Task 4.
- [x] add a comment noting the flag is read on every call by design — caching it would re-open the overlay on
      the next page load, because `WGFirstRun`'s `_mounted` latch does not survive a reload

### Task 3: `POST /api/firstrun/complete` durably flips the vault flag

- [ ] delete the `'POST /api/firstrun/complete'` entry from `STUBS` (`apishim.js:242`) **and** its now-obsolete
      three-line comment above it (`:239-241`), which explicitly defers to this bead
- [ ] add an inline branch in `shimCall`, alongside the other exact-path settings branches:
      `if (path === '/api/firstrun/complete' && method === 'POST') { await settings.setFirstRunComplete(true); return { success: true }; }`
- [ ] keep the `{ success: true }` response shape — `firstrun/index.js:170-181` ignores the body but
      `.catch()`es a rejection, and a 404 from an unmatched path would be a silent regression
- [ ] confirm no other STUBS entry or cascade branch also matches this path (exactly one handler)

### Task 4: Shim contract coverage

- [ ] extend `web/static/js/tests/cloud.shim-contract.settings.test.js` (the owning suite — do not add a file):
      fresh in-memory records port → `GET /api/bootstrap` reports `needs_first_run: true`
- [ ] same suite: `POST /api/firstrun/complete` → a subsequent `GET /api/bootstrap` reports
      `needs_first_run: false` (the durable round trip — this is the regression guard for the old fake stub)
- [ ] same suite: after completion, `GET /api/settings` response has **no** `first_run_complete` and no
      `general` key — the settings shape is unchanged
- [ ] same suite: completing onboarding does not clobber a previously-set `timezone` /
      `dismissed_tz_suggestion` on the shared singleton
- [ ] update `web/static/js/tests/cloud.shim-contract.catchall.test.js:41-44`, which asserts the old fake stub:
      the path is now a real handler, so either move the assertion or adjust it to the real behavior — it must
      not keep asserting a hardcoded ack
- [ ] ⚠️ flipping `needs_first_run` on may make other existing frontend tests mount the overlay unexpectedly.
      If a suite breaks, fix the test's bootstrap fixture rather than re-hardcoding the flag

### Task 5: Verify acceptance criteria

- [ ] verify a fresh cloud vault reports `needs_first_run: true` and the overlay mounts
- [ ] verify completing onboarding writes the vault record and a **reload** does not re-open the overlay
      (the across-reload path, not just the in-page `_mounted` latch)
- [ ] verify the flag round-trips through the encrypted record, i.e. it is on the `settings` singleton and not
      a new record type
- [ ] verify `GET /api/settings` and `GET /api/init` response shapes are unchanged
- [ ] verify `VALID_STEPS` was **not** extended and no new screen module was added
- [ ] `pnpm test` passes, including `architecture.domain-purity.test.js`
- [ ] `go build ./...` and `go vet ./...` still pass (no Go changes expected — confirm the diff has none)

### Task 6: [Final] Update documentation

- [ ] update `docs/onboarding-wizard.md`: the vault flag is implemented; record that
      `POST /api/firstrun/complete` was already routed as a fake stub and is now real; state plainly that
      **absent ⇒ needs onboarding**, so existing vaults see the overlay once
- [ ] update `docs/cloud-mode.md` where the shim's bootstrap payload is described, if `needs_first_run` is
      mentioned there
- [ ] note the remaining gap: a freshly-claimed user still dead-ends at `renderDone` and must unlock to reach
      the app (`med-8eh`), so the overlay is first seen after that unlock, not immediately after the kit

## Technical Details

**Semantics table** (`general` = the `settings` singleton record):

| `general.first_run_complete` | `needs_first_run` | who |
|---|---|---|
| absent | `true` | fresh vault **and** any vault predating this change |
| `false` | `true` | in-flight onboarding |
| `true` | `false` | completed |

**Round trip:**

```
GET /api/bootstrap
  -> settingsResponse() -> settings.getGeneral()   [already in the Promise.all]
  -> needs_first_run: !general.first_run_complete
  -> auth-bootstrap.js mirrors it, WGFirstRun.mount({needs_first_run})

...user finishes or skips-all...

POST /api/firstrun/complete            [inline shimCall branch, not a STUB]
  -> settings.setFirstRunComplete(true)
  -> records.put('settings', {...existing, first_run_complete: true, clientTs})
  -> encrypted oplog -> syncs to every device

next GET /api/bootstrap -> needs_first_run: false -> no overlay
```

**Why the flag must not be cached:** `WGFirstRun`'s `_mounted` latch is module state, lost on reload. Across
reloads the only thing preventing the overlay from re-opening is the payload reporting `false`.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification:**

- On the deployed cloud account: reload the app once. The onboarding overlay appears (expected — this vault
  predates the flag). Complete or skip it, reload again, and confirm it stays gone.
- Confirm the flag propagates: complete onboarding on device A, then open device B and confirm no overlay.
- Watch the `permissions` and `integrations` screens specifically — they were written for the Capacitor
  first-run flow and have never run under cloud push / vault-backed integrations. If either misbehaves, file a
  bead; do **not** widen this change to fix it.

**External system updates:**

- None. No migration, no new route, no config, no deployment change.
- Follow-ups this unblocks: `med-8eh` (claim → app redirect), `med-4pz.2/.3/.4` (the new screens),
  `med-4pz.6` (Settings re-run row).
