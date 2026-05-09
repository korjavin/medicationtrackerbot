# Persist Active Section Across Page Reload

## Overview

When the user reloads the Mini App in a browser they are always thrown back to the Today section, even if they were on BP, Vitals, Workouts, etc. The fix is to remember the last active bottom-nav section in `localStorage` and use it as the initial view on next load. Today's view stays the default for first-time users and as a fallback when the saved section is invalid or its feature is disabled.

## Context

- **Root cause**: `web/static/js/features/bootstrap.js:174` unconditionally calls `switchTab('today')` after auth, and the bottom nav is mounted with a hard-coded `active: 'today'` at `bootstrap.js:92`. Nothing reads any persisted section.
- **Where the active tab lives today**: `switchTab(tab)` in `web/static/js/app.js:1015-1060` writes to `window.AppStore.set('currentTab', tab)` (in-memory only, not persisted).
- **Why deep links still work after the change**: `bootstrap.js:182` calls `handleDeepLinks()` *after* the initial `switchTab(...)`. `handleDeepLinks()` (`web/static/js/features/deeplink-router.js`) calls `switchTab(target)` itself for `/bp_add`, `?tab=…&action=add`, push actions, and Telegram `start_param`. So deep links continue to override the initial section regardless of what we restore.
- **Existing similar localStorage usage** (naming convention reference):
  - `mt-health-subtab` (`web/static/js/features/health.js`) — Vitals sub-tab
  - `mt-workouts-subtab` (`web/static/js/features/workout.js`) — Workouts sub-tab
  - `bp_range_days`, `weight_range_days` — chart ranges
- **User-scoped key allowlist**: `web/static/js/features/auth-flow.js:22` defines `USER_SCOPED_LOCAL_KEYS` for keys that must be cleared on logout. The new key must be added there so a previous user's section choice does not leak into the next session on a shared browser.
- **Canonical bottom-nav ids** (`web/static/js/components/wg-bottom-nav.js:27-35`): `today`, `bp`, `food`, `meds`, `health`, `workouts`, `weight`, `settings`. The Vitals slot keeps internal id `health` for localStorage stability per CLAUDE.md rule 6 — that requirement still applies.
- **Feature-flag guarding**: `switchTab` (`app.js:1024-1028`) already bounces to Today when the requested section's feature is disabled. The bottom-nav mount flow uses `filterNavItemsByFeatures` (`bootstrap.js:77-83`) and falls back to `'today'` when the previously active id is no longer present (`bootstrap.js:118-121`). The restore logic must mirror this so we never paint an active state on a slot the user can't reach.
- **Existing tests that must change**:
  - `web/static/js/tests/bootstrap.today-default.test.js` — explicitly asserts `switchTab('today')` is called even with a saved server-side `tab_order`. Its premise ("Today is unconditionally the initial view") is what we are deliberately relaxing. Needs rewriting.
  - `web/static/js/tests/bootstrap.dynamic-tab.test.js` — guards that the **server-side** `tab_order` setting (used for ordering Today cards) does not redirect bootstrap to a section. Different concept from the new client-side `mt-active-tab` key, so the assertions stay valid; the test should remain green because `loadFrontendEnv` produces a fresh JSDOM (and therefore an empty localStorage) per test.
- Adopted from `docs/plans/2026-05-06-persist-active-section-across-reload.md`.

## Development Approach

- Testing approach: regular (code first, then tests). Each task ships with new/updated tests as in the project standard.
- Storage key: `mt-active-tab` (matches the existing `mt-*-subtab` convention).
- Restore precedence:
  1. Saved value from `mt-active-tab` if present, valid, and feature-enabled.
  2. Otherwise `today`.
  3. Deep links (path/query/push/Telegram `start_param`) override either of the above by calling `switchTab(target)` themselves after the initial restore.
- No new write-after-read race: `switchTab` writes the key on every successful activation, including `today`. So returning to Today is also remembered.
- Complete each task fully before moving to the next.
- Update this plan when scope changes during implementation.

## Testing Strategy

- Frontend unit tests (Vitest + jsdom):
  - New cases in `bootstrap.today-default.test.js` (renamed conceptually but the file can stay) covering: no key → today; valid key (`bp`) → bp; key for disabled feature → today; key with unknown value → today.
  - Extend an existing app-level tab test (e.g., `app.tab-single-source.test.js`) to assert that calling `switchTab('bp')` writes `bp` to `localStorage['mt-active-tab']`, and `switchTab('today')` writes `today`.
- No backend changes, so no Go tests needed. CLAUDE.md MCP-coverage guard is unaffected (no new HTTP routes).
- Manual smoke: open BP → reload → expect BP. Open Workouts → reload → expect Workouts. Open BP via `/bp_add` deep link after reloading on Vitals → expect BP modal (deep link still wins). Disable BP feature in Settings while currently on BP → reload → expect Today.
- Run project tests after each Task before proceeding.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document blockers with ⚠️ prefix
- Update plan if implementation deviates

## Implementation Steps

### Task 1: Persist the active tab on every `switchTab`

Files:
- Modify: `web/static/js/app.js`

- [x] In `switchTab(tab)` (around `app.js:1037`), after the existing `window.AppStore && window.AppStore.set('currentTab', tab)` line and only when `activated` is truthy, write the tab to `localStorage` under the key `mt-active-tab` inside a `try/catch` (silent on failure — match the existing `try { ... } catch (_) {}` pattern used elsewhere in the codebase for sandboxed-localStorage cases).
- [x] Do **not** persist when `switchTab` early-returns due to feature-disabled bounce (the recursive call to `switchTab('today')` will record `today` correctly).
- [x] write tests: extend `web/static/js/tests/app.tab-single-source.test.js` (or create `app.active-tab-persistence.test.js`) to mount the minimal DOM, call `switchTab('bp')` and assert `localStorage.getItem('mt-active-tab') === 'bp'`, then call `switchTab('today')` and assert the value flips to `today`.
- [x] run project tests - must pass before next task (`cd web/static/js/tests && npx vitest run`).

### Task 2: Restore the active tab on bootstrap

Files:
- Modify: `web/static/js/features/bootstrap.js`

- [x] Add a private helper near the top of the file (next to `filterNavItemsByFeatures`):
  ```js
  function readSavedActiveTab() {
      try {
          const saved = window.localStorage.getItem('mt-active-tab');
          if (!saved) return 'today';
          const items = window.WGBottomNav
              ? filterNavItemsByFeatures(window.WGBottomNav.DEFAULT_ITEMS, window.featureSettings)
              : [];
          return items.some((i) => i.id === saved) ? saved : 'today';
      } catch (_) {
          return 'today';
      }
  }
  ```
- [x] In `mountCanonicalBottomNav` (`bootstrap.js:85-102`), replace `active: 'today'` with `active: readSavedActiveTab()`.
- [x] In the post-auth block (`bootstrap.js:172-174`), replace `switchTab('today')` with `switchTab(readSavedActiveTab())`. Keep the surrounding comment but reword it to: "Restore the last section the user was on (Today by default; deep links below override)".
- [x] Confirm `handleDeepLinks()` is still called after the initial restore (`bootstrap.js:182`) so deep links continue to win.
- [x] write tests: update `web/static/js/tests/bootstrap.today-default.test.js`:
  - Rename describe to "bootstrap.js initial-section restore".
  - Keep the "no saved key → today" case.
  - Replace the "saved tab_order is ignored" case with three new cases:
    - `localStorage['mt-active-tab'] = 'bp'` + `bp` feature enabled → `switchTab('bp')`.
    - `localStorage['mt-active-tab'] = 'bp'` + `bp` feature disabled → `switchTab('today')` (and never `'bp'`).
    - `localStorage['mt-active-tab'] = 'unknown-id'` → `switchTab('today')`.
  - The existing helpers (`stubFetch`, `stubBootstrapGlobals`) can be reused; just set `window.localStorage` before `window.eval(bootstrapSource)`.
- [x] Verify `bootstrap.dynamic-tab.test.js` still passes (no source changes; the new client-side key is empty in a fresh JSDOM).
- [x] run project tests - must pass before next task (`cd web/static/js/tests && npx vitest run`).

### Task 3: Add `mt-active-tab` to the user-scoped logout-clear allowlist

Files:
- Modify: `web/static/js/features/auth-flow.js`

- [x] At `auth-flow.js:22`, extend `USER_SCOPED_LOCAL_KEYS` to include `'mt-active-tab'`.
- [x] write tests: no new test required — the existing `clearAuthState` loop already iterates this array; coverage is implicit. Skip if no behavior delta beyond the array entry.
- [x] run project tests - must pass before next task (`cd web/static/js/tests && npx vitest run`).

### Task 4: Verify acceptance criteria

- [ ] verify all requirements from Overview are implemented (reload preserves last section; Today remains the default for first-time users and disabled-feature fallback; deep links still override).
- [ ] run full project test suite: `cd web/static/js/tests && npx vitest run` and `go test ./...`.
- [ ] run project linter - all issues must be fixed.
- [ ] Manual smoke (Telegram Mini App in browser):
  - Open BP → reload → land on BP.
  - Open Workouts → reload → land on Workouts.
  - On BP, open the app via `?action=add&tab=weight` deep link → land on Weight with the Add modal (deep link wins).
  - Disable BP feature in Settings while on BP → reload → land on Today (graceful fallback).
  - Sign out, sign in as a different user on the same browser → land on Today (allowlist clear).

## Post-Completion

*Items requiring manual intervention - no checkboxes, informational only*

- Update CLAUDE.md rule 6 only if the wording becomes misleading (likely a one-line addition that the bottom-nav active state restores from localStorage, defaulting to Today).
- Update `docs/frontend.md` "navigation" / "data flow" section with one paragraph describing the `mt-active-tab` key (default fallback behaviour, logout clearing).
- Move this plan to `docs/plans/completed/` once everything above is checked.

## Risks / Open Questions

- **Mini-App relaunch from the bot button**: Telegram typically reopens the WebApp at the root URL. If the user opened from `start_param=bp_add`, the deep-link path triggers a `switchTab('bp')` after our restore — same as today. If they opened from a plain bot-attached button without `start_param`, they will land on whatever section they last left, which is the desired UX for users who keep the app open across sessions.
- **Settings as a "remembered" section**: A user who was last on Settings will reload into Settings. This matches the model of "the section you were on" and is consistent with every other slot. No special-case is added.
- **First reload after deploy**: Existing users have no `mt-active-tab` set, so they fall back to Today. No migration step needed.
- **Multiple windows/tabs**: `localStorage` is shared across browser tabs. If the user opens two windows on different sections and reloads one, it restores whichever section was activated last (last write wins). This is acceptable; the alternative (sessionStorage) would defeat the whole point of surviving a refresh.
