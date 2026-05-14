---
status: ready
---

# Fix: Timezone-change prompt blocks first paint (white page in browser)

## Overview

When a user opens the web app in a regular browser (not the Telegram WebApp)
after travelling, the page renders completely white until the user presses
Esc — at which point a "change your timezone?" confirm dialog finally appears.

Root cause:

- `web/static/js/features/bootstrap.js:165` `await`s `maybeUpdateTimezone()`
  *before* `mountCanonicalBottomNav()` and `switchTab()` (line 176, 185).
- `maybeUpdateTimezone()` calls `safeConfirm()`
  (`web/static/js/features/bootstrap.js:35`).
- In a plain browser, `safeConfirm` falls through to the native
  `confirm(msg)` (`web/static/js/core/utils.js:39`) because
  `hasTelegramContext` is false. Native `confirm()` is a synchronous, modal
  dialog that halts the main thread before any paint has happened, so the
  user sees a white page with no visible dialog hint. Pressing Esc dismisses
  the (invisible) native modal as "cancel", `safeConfirm` resolves, and the
  rest of bootstrap finally renders.

Inside the Telegram WebApp this is invisible to users because
`tg.showConfirm` is a non-blocking Telegram-native dialog rendered
**over** the (already-painted) WebView. Only the plain-browser path is
broken.

The fix has two complementary parts:

1. **Sequencing** — move `maybeUpdateTimezone()` out of the pre-paint
   critical path so the bottom nav and initial tab render first regardless
   of TZ state.
2. **Modality** — replace the native `confirm()` fallback inside
   `safeConfirm` with the existing `mt-modal` primitive so the prompt is a
   normal in-page dialog the user can actually see and dismiss. This also
   silently fixes every other in-app `safeConfirm` caller in browser mode
   (workout skip, weight delete, bp delete, food/meds delete, etc. — see
   the `safeConfirm` grep below), which today produce the same
   invisible-confirm UX when running outside Telegram.

## Context (from discovery)

- TZ detection + prompt: `web/static/js/features/bootstrap.js:10-60`
  (`maybeUpdateTimezone`), invoked at line 165 inside the `checkAuth().then`
  chain.
- Confirm helper: `web/static/js/core/utils.js:17-41` (`safeConfirm`). The
  Telegram path is `tg.showConfirm(msg, handleResult)` on line 32; the
  fallback is `handleResult(confirm(msg))` on line 39.
- Other `safeConfirm` callers (all hit the same blocking-confirm path in
  browser mode):
  - `web/static/js/app.js:3230` — skip workout
  - `web/static/js/features/weight.js:1117` — delete weight entry
  - `web/static/js/features/bp.js:635` — delete BP entry
  - `web/static/js/features/food/products.js:698` — delete food product
  - `web/static/js/features/food/log.js:1097` — delete food entry
  - `web/static/js/features/food/meals.js:62` — delete meal
  - `web/static/js/features/health.js:1111` — delete health note
  - `web/static/js/features/meds.js:541,1115,1131` — meds confirmations
  - `web/static/js/features/workout/groups.js:454` — delete workout group
- Existing modal primitive: `web/static/js/components/mt-elements.js:4-32`
  (`MTModal`, registered as `<mt-modal>`). It is loaded via the standard
  component bundle and already supports `open()` / `close()` / `inert`.
- Bootstrap tests we'll extend:
  `web/static/js/tests/bootstrap.today-default.test.js` and
  `web/static/js/tests/bootstrap.dynamic-tab.test.js` (both use
  `loadFrontendEnv` + `eval(bootstrapSource)`).
- Existing TZ-adjacent test: `web/static/js/tests/settings.sync-timezone.test.js`
  (settings card layout; not behavioral).
- Suppression cookie: `localStorage.tz_prompt_dismissed` (set on cancel,
  cleared on accept) — preserved by this fix.

## Development Approach

- **Testing approach**: Regular (code + tests in the same task).
- Make small, focused changes. This is a UX/bug fix, not a refactor — keep
  `safeConfirm`'s public signature `(msg, callback?)` -> `Promise<boolean>`
  unchanged so the ~10 callers don't move.
- The Telegram (`tg.showConfirm`) path stays bit-identical; only the
  plain-browser fallback changes.
- Tests run via `pnpm test` (Vitest + jsdom). Run after every task.

## Testing Strategy

- **Unit tests (Vitest)**:
  - bootstrap-sequence: assert `switchTab` is called even when the
    cached `settings_bundle.timezone` differs from
    `Intl.DateTimeFormat().resolvedOptions().timeZone` (i.e., the prompt
    is in flight) — this regression-tests the white-page bug.
  - `safeConfirm` browser-mode: assert it mounts an `<mt-modal>`, that
    clicking Confirm resolves `true` and clicking Cancel resolves `false`,
    that the modal closes (`inert` attribute reapplied), and that the
    backing element is removed from the DOM after resolve.
  - `safeConfirm` Telegram-mode: assert `tg.showConfirm` is still used
    when `window.Telegram.WebApp` + `userInitData` are present, and that
    no `<mt-modal>` is created.
  - `maybeUpdateTimezone`: assert that on accept it POSTs `/api/settings`
    and invalidates `settings_bundle`; on cancel it writes
    `tz_prompt_dismissed`. (Verifies we did not regress the suppression
    cookie when swapping the confirm implementation.)
- **E2E tests**: none — repo does not have UI-driven e2e tests for this
  flow.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document blockers with ⚠️ prefix.

## Implementation Steps

### Task 1: Move `maybeUpdateTimezone()` out of the pre-paint critical path

- [ ] in `web/static/js/features/bootstrap.js`, reorder the post-auth
      block so the visible shell mounts before TZ detection:
  1. call `mountCanonicalBottomNav()` first
  2. call `switchTab(readSavedActiveTab())` next
  3. THEN schedule `maybeUpdateTimezone()` — fire-and-forget (no `await`),
     ideally inside `queueMicrotask(...)` or
     `requestAnimationFrame(() => requestAnimationFrame(() => ...))` so it
     runs after the first paint.
- [ ] keep the `TZPlanBanner.refresh()` call where it is (after the TZ
      detection schedule), and keep `AppBackButton.setup()` /
      `handleDeepLinks()` at the bottom — those depend on the active tab
      existing, not on TZ.
- [ ] confirm the "Clear the cached settings_bundle" comment block inside
      `maybeUpdateTimezone` still makes sense (the race it describes is
      now a real, hot race because `switchTab` runs first). Update the
      comment to reflect the new ordering and verify the existing
      `invalidateKey('settings_bundle')` call is enough; if not, also
      trigger a soft re-render of the active tab (call
      `window.refreshActiveTab?.()` if such a helper exists, otherwise
      leave a follow-up note in Post-Completion — do **not** add new
      cross-feature plumbing in this plan).
- [ ] write a Vitest case in
      `web/static/js/tests/bootstrap.today-default.test.js` (or a new
      sibling file `bootstrap.tz-prompt-nonblocking.test.js`) named
      `"renders the initial tab before the TZ prompt resolves"`. Setup:
      - mock `Intl.DateTimeFormat().resolvedOptions` to return
        `Europe/Berlin`
      - pre-seed `window.DataStore.getCached('settings_bundle')` to
        `{ timezone: 'America/Chicago' }`
      - stub `safeConfirm` to return a never-resolving Promise
      - eval bootstrap.js
      Assert: `switchTab` was called with the saved/default tab even
      though `safeConfirm` is still pending.
- [ ] run `pnpm test web/static/js/tests/bootstrap` — all bootstrap tests
      must pass before next task.

### Task 2: Replace native `confirm()` fallback in `safeConfirm` with `<mt-modal>`

- [ ] in `web/static/js/core/utils.js`, refactor the non-Telegram path of
      `safeConfirm(msg, callback)`:
  1. build an `<mt-modal>` element with two buttons (`Confirm`,
     `Cancel`) and the supplied message text. Reuse existing modal CSS
     classes already used by other in-app modals — grep
     `web/static/css/` for `wg-modal*` / `.modal*` classes; **do not**
     introduce new inline styles or hardcoded colors (CLAUDE.md rule 3).
     If no suitable existing class set exists, add a minimal
     `.mt-confirm-modal` class to the appropriate CSS file using
     `--wg-*` design tokens only.
  2. append it to `document.body`, call `.open()`, focus the Confirm
     button.
  3. wire `Confirm` click → resolve `true`; `Cancel` click,
     backdrop click, and `Escape` keydown → resolve `false`. Close and
     remove the element after resolve.
  4. preserve the existing `callback` semantics: if the caller passed a
     `callback`, await its return value before resolving the outer
     Promise (mirror the current `invokeCallback` flow on lines 20-23).
- [ ] keep the Telegram-context branch (`tg.showConfirm`) untouched —
      verify by reading it side-by-side with the new code. The `try /
      catch` fallback to `confirm(msg)` inside the Telegram branch
      (line 33-35) should also be swapped to the new modal, since
      reaching that branch means Telegram's own dialog failed.
- [ ] confirm there's no remaining reference to `window.confirm` /
      bare `confirm(` in `web/static/js/` after this change (other than
      possibly in tests).
- [ ] write Vitest cases in a new file
      `web/static/js/tests/safe-confirm.test.js`:
  - `"browser mode mounts an <mt-modal> and resolves true on Confirm"`
  - `"browser mode resolves false on Cancel"`
  - `"browser mode resolves false on Escape keydown"`
  - `"browser mode resolves false on backdrop click"`
  - `"browser mode removes the modal element after resolve"`
  - `"Telegram mode calls tg.showConfirm and does not mount mt-modal"`
  - `"callback receives the boolean result and its return value
       propagates"`
- [ ] update any existing test that asserts on the native `confirm`
      being called (grep `tests/` for `spyOn(window, 'confirm')` or
      similar) — replace with mt-modal assertions. If none exist, note
      that in the task body.
- [ ] run `pnpm test web/static/js/tests/safe-confirm` and `pnpm test
      web/static/js/tests/bootstrap` — must pass before next task.

### Task 3: Cover the `maybeUpdateTimezone` happy path / cancel path with the new modal

- [ ] add a Vitest case
      `"maybeUpdateTimezone: accept POSTs /api/settings and invalidates
       cache"` — drives the new mt-modal Confirm and asserts the
      `fetch('/api/settings', {method:'POST', body:{timezone:...}})`
      call, plus `DataStore.invalidateKey('settings_bundle')`, plus
      that `localStorage.tz_prompt_dismissed` is cleared.
- [ ] add a Vitest case
      `"maybeUpdateTimezone: cancel writes tz_prompt_dismissed"` —
      drives Cancel, asserts `localStorage.tz_prompt_dismissed ===
      detectedTz` and that `/api/settings` was NOT POSTed.
- [ ] add a Vitest case
      `"maybeUpdateTimezone: skip when detectedTz equals stored
       timezone"` — asserts no modal is mounted.
- [ ] add a Vitest case
      `"maybeUpdateTimezone: skip when tz_prompt_dismissed matches
       detectedTz"` — asserts no modal is mounted.
- [ ] place these in
      `web/static/js/tests/bootstrap.tz-prompt-nonblocking.test.js`
      (created in Task 1) or a sibling.
- [ ] run `pnpm test web/static/js/tests/bootstrap` — must pass.

### Task 4: Architecture-test housekeeping

- [ ] re-run `pnpm test` (full Vitest suite) — confirm
      `tests/architecture.globals.test.js`,
      `tests/architecture.wg-primitives.test.js`, and any
      design-token / no-inline-style architecture tests still pass.
      If the new `safe-confirm` modal introduces a new `window.*`
      global, add an allowlist entry per CLAUDE.md rule 4.
- [ ] if any CSS was added in Task 2, re-run the design-token /
      no-hardcoded-color architecture tests specifically and fix any
      violations (use `--wg-*` tokens, no inline `.style.` assignments
      per CLAUDE.md rule 3).

### Task 5: Verify acceptance criteria

- [ ] verify in code that bootstrap.js no longer `await`s
      `maybeUpdateTimezone()` before `switchTab()`.
- [ ] verify `safeConfirm` no longer calls the native `confirm()` in
      browser mode.
- [ ] run full Vitest suite: `pnpm test`.
- [ ] run full Go test suite: `go test ./...` (no server-side changes
      expected — this is a smoke check that the build still passes).
- [ ] manually load the app in a regular browser (not Telegram) with a
      mismatched timezone (e.g., flip system TZ before reload, or seed
      `settings_bundle.timezone` to a different value via DevTools)
      and confirm:
      - the bottom nav and Today tab paint immediately
      - the TZ prompt appears as a visible in-page modal
      - Confirm updates the stored TZ; Cancel suppresses re-prompt for
        this detected TZ
- [ ] confirm in the Telegram WebApp that the TZ prompt still shows as
      `tg.showConfirm` (visual smoke test).

### Task 6: [Final] Update documentation

- [ ] add a one-line note to `docs/frontend.md` (find the section that
      covers bootstrap / modal primitives) describing that
      `safeConfirm` now uses `<mt-modal>` in browser mode and
      `tg.showConfirm` in Telegram mode.
- [ ] no README change needed.

## Technical Details

- **Why fire-and-forget is safe.** Nothing after the TZ call depends on
  it: `mountCanonicalBottomNav`, `switchTab`, `AppBackButton.setup`, and
  `handleDeepLinks` all read from the cached `settings_bundle`, which is
  populated by `applyBootstrapPayload` *before* `checkAuth` resolves. If
  the user accepts the new TZ, `invalidateKey('settings_bundle')` flushes
  the cache and the next interaction (tab switch, polling tick, etc.)
  re-fetches with the new timezone. The user-visible artefact is that
  the Today tab briefly renders with the *old* TZ before the prompt is
  answered — which is identical to the experience inside Telegram today.
- **Why `mt-modal` over a new `wg-confirm` primitive.** `mt-modal`
  already ships, already handles `inert`/aria, and is what every other
  in-app modal uses. A bespoke `wg-confirm` would be a separate scope
  expansion. We can promote it later if we end up writing the same
  open/close/buttons wiring more than once.
- **Why we also touch the Telegram-fallback path inside `safeConfirm`.**
  Lines 33-35 today catch a `tg.showConfirm` failure and fall to the
  native `confirm()`. Replacing the fallback with the same `<mt-modal>`
  flow means *no* call site can ever surface the invisible native
  dialog — that's the regression-prevention story.
- **Suppression-cookie behaviour stays.** The
  `localStorage.tz_prompt_dismissed` write on cancel and clear-on-accept
  are part of `maybeUpdateTimezone`, not `safeConfirm`, so they are
  untouched by the modal swap. Task 3 tests reaffirm this.
- **No backend changes.** `/api/settings` (timezone POST) and the cache
  invalidation paths are unchanged.

## Post-Completion

*Items requiring manual intervention or external systems — no
checkboxes, informational only.*

**Manual verification after deploy**:

- Travel-simulation smoke test: set the browser/system timezone to a
  different zone, hard-reload the web app in a regular browser, confirm
  the page is interactive *before* the prompt is dismissed and that
  Confirm/Cancel produce the same server effect as today.
- Telegram WebApp smoke test: open the bot's web app on iOS and Android
  Telegram clients after a TZ change and confirm `tg.showConfirm` still
  fires.

**Follow-up (out of scope)**:

- Consider promoting the in-modal pattern in `safeConfirm` to a small
  named primitive (`wg-confirm` or a `safeConfirm`-shaped controller
  exported from `mt-elements.js`) once we have a second non-trivial
  usage site. Today every caller passes only `(msg, callback)`, so the
  helper itself is the abstraction.
- Audit other "best-effort, never block the app" startup paths
  (`MedTrackerPush.initialize`, `initOIDCSetupBanner`, `TZPlanBanner.refresh`)
  for any sneaky `await` that could similarly block the first paint.
  These all look non-blocking today, but a check during this work would
  be cheap.
