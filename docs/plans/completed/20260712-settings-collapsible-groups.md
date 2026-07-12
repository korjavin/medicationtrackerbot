# Cloud Settings: collapsible `<details>` groups (med-eas.50)

## Overview
- The cloud Settings page (`#settings-view` in `web/static/index.html`) is a flat list of ~17 `wg-settings-section` cards. Most are set-once / rarely used.
- Group them into collapsible **native `<details><summary>`** groups (no custom JS collapse logic — keyboard-accessible for free), rarely-used groups **folded by default** (omit `open`), frequently-used **open** (`open` attribute).
- Solves: the settings page is a wall of cards; grouping + folding tames it and tucks away dangerous/rare controls (Delete account, Import/Export).

## Context (from discovery)
- **`web/static/index.html`** — `#settings-view` spans ~lines 418–1030. Sections in DOM order today:
  1. `.wg-settings-sync` (Sync, has `#sync-status-bar`) — **pin at top, NOT in a fold**
  2. `.wg-settings-cloud-devices` (Devices, `#settings-devices-link`, `#settings-claude-connector-link`) — hidden by default
  3. `.wg-settings-cloud-invite` (Invite a friend) — hidden
  4. `.wg-settings-privacy` (What can the operator see?) — hidden
  5. `.wg-settings-danger` (Delete account) — hidden
  6. `#oidc-setup-container` `.wg-settings-oidc` (empty mount) 
  7. `.wg-settings-timezone` (Time & Timezone)
  8. `.wg-settings-notifications` (Notifications — web)
  9. `.wg-settings-notifications-cloud` (Notifications — cloud) — hidden
  10. `.wg-settings-features` (Features)
  11. `.wg-settings-reminders` (Reminders)
  12. `.wg-settings-units` (Units)
  13. `#food-target-settings` `.wg-settings-food-targets` (Food Targets)
  14. `#gamification-targets-settings` `.wg-gam-targets` (Journey Targets) — `hidden` class
  15. `#settings-integrations` `.wg-settings-integrations` (Integrations)
  16. `#settings-importexport` `.wg-settings-importexport` (Import / Export — contains the #617 `#importexport-reset-sync-group` "Reset local sync" control)
  17. `#settings-about` `.wg-settings-about` (About) — hidden
- **`web/static/css/styles.css`** — `.wg-settings-section` styling at ~line 11339; tokens `--wg-settings-section-*` at ~802; `.wg-settings-hidden` at ~11425. All visual values via `--wg-*` tokens.
- **`web/static/js/features/settings.js`** — `loadSettings()` (~line 588) does cloud/bot gating by toggling `wg-settings-hidden` on sections via `document.querySelector('.wg-settings-*')`. Section classes/ids are the selectors — **must be preserved**.
- **Tests** — `web/static/js/tests/settings.render.test.js` is the render suite to extend.

## Grouping (owner-named groups in bold; page order top→bottom)
1. **Sync** — `.wg-settings-sync` — pinned, NOT wrapped in `<details>`.
2. **Preferences** (`<details open>`) — timezone, notifications, notifications-cloud, features, reminders, units.
3. **Targets** (`<details>` folded) — food-target-settings, gamification-targets-settings.
4. **Integrations** (`<details>` folded) — settings-integrations.
5. **Devices & connections** (`<details>` folded) — cloud-devices, cloud-invite, oidc-setup-container.
6. **Backup & data** (`<details>` folded) — settings-importexport (incl. #617 reset-sync control).
7. **Account & privacy** (`<details>` folded) — privacy, danger/delete, about.

## Development Approach
- **Testing approach**: NO unit tests. Extend the existing integration render suite `settings.render.test.js`.
- Smallest restructure that groups + folds. Reuse existing card markup **verbatim** inside the `<details>` wrappers — only move/wrap, never rewrite section internals. Preserve every id/class.
- Native `<details>`/`<summary>` only. No JS toggle logic. One small JS helper hides a group whose children are all hidden.
- No hardcoded colors, no inline `.style.` — summary styling via `--wg-*` tokens + CSS classes (architecture guards enforce).

## Testing Strategy
- **Unit tests**: none.
- **Integration tests**: extend `settings.render.test.js` — assert (a) the seven group structure / summaries render, (b) folded groups omit `open` and Preferences has `open`, (c) a group whose child sections are all `wg-settings-hidden` is itself hidden, (d) every preserved section id/class still resolves inside its group.
- **E2E**: none.

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Wrap settings sections into `<details>` groups in index.html
- [x] In `web/static/index.html` `#settings-view`, keep `.wg-settings-sync` pinned at top unchanged (not wrapped).
- [x] Wrap the Preferences sections (timezone, notifications, notifications-cloud, features, reminders, units) in `<details open class="wg-settings-group">` with a `<summary class="wg-settings-group__summary">Preferences</summary>` — move those existing `<section>` blocks inside verbatim.
- [x] Wrap Targets (food-target-settings, gamification-targets-settings) in a folded `<details class="wg-settings-group">` + summary "Targets".
- [x] Wrap Integrations (settings-integrations) in a folded `<details>` + summary "Integrations".
- [x] Wrap Devices & connections (cloud-devices, cloud-invite, oidc-setup-container) in a folded `<details>` + summary "Devices & connections".
- [x] Wrap Backup & data (settings-importexport) in a folded `<details>` + summary "Backup & data".
- [x] Wrap Account & privacy (privacy, danger, about) in a folded `<details>` + summary "Account & privacy".
- [x] Verify NO section `id` or `class` was changed and no inline `style=` was introduced. Reorder sections into group order only by moving whole `<section>` blocks.

### Task 2: Style the group `<details>`/`<summary>` via tokens
- [x] In `web/static/css/styles.css` add `.wg-settings-group` + `.wg-settings-group__summary` rules using existing `--wg-*` tokens (spacing, radius, surface, text). Provide a chevron affordance via CSS (e.g. rotate a `::marker`/pseudo-element or `[open]` state) — no hardcoded colors.
- [x] Ensure the summary is a clear tap target and matches the card visual language; group content spacing reuses `--wg-settings-section-gap`.
- [x] Confirm no hardcoded hex / rgb / hsl literals and no inline styles were added (architecture guards: design-tokens, inline-styles).

### Task 3: Hide a group whose children are all hidden
- [x] In `web/static/js/features/settings.js`, add a helper `hideEmptySettingsGroups()` that, for each `.wg-settings-group`, adds `wg-settings-hidden` (or `hidden`) when every descendant `.wg-settings-section` is hidden, else removes it.
- [x] Call it at the end of `loadSettings()` after the cloud/bot gating block runs (both cloud and bot paths), so a group with only cloud-only children collapses in bot mode.
- [x] Do NOT change existing per-section gating (`wg-settings-hidden` toggles keep matching `.wg-settings-*` selectors unchanged).

### Task 4: Extend the settings render integration test
- [x] In `web/static/js/tests/settings.render.test.js`, add cases asserting: the seven groups render with their summaries; Preferences `<details>` has `open` and the rarely-used groups do not; the reset-sync `#importexport-reset-sync-group` still resolves inside Backup & data; a group with all-hidden children is hidden; representative preserved ids/classes still query-select.
- [x] Run `npx vitest run web/static/js/tests/settings.render.test.js` — must pass.

### Task 5: Verify acceptance criteria
- [x] Settings renders as collapsible groups; owner's four groups (Devices/Claude, Backup/Import, Targets, Integrations) present; rarely-used folded; Preferences open. (covered by settings.render.test.js — group structure, open/folded, summaries)
- [x] All existing controls still mount and work inside groups; cloud-only sections still hidden in the right mode; #617 reset-sync control still present and functional in Backup & data. (render suite asserts preserved ids/classes + reset-sync inside Backup & data; full cloud/bot load-through is manual — skipped, not automatable)
- [x] Run `npx vitest run` — settings suites + architecture guards (design-tokens, inline-styles, globals) all pass. (309 files / 3535 tests passed)
- [x] Confirm no inline `style=` / hardcoded hex added to changed files. (grep of added lines: none)

## Technical Details
- `<details open>` = expanded; omit `open` = folded. Zero JS for collapse — the browser handles it, keyboard-accessible natively.
- Group wrapper class `.wg-settings-group`; summary class `.wg-settings-group__summary`. Sections keep every existing id/class so `document.querySelector('.wg-settings-*')` gating in `settings.js` and JS mount targets by id keep matching.
- Empty-group hiding is the only added JS: pure DOM read + class toggle, no new `window.*` global.

## Post-Completion
**Manual verification:**
- Load Settings in cloud mode and bot mode; confirm folded groups start collapsed, Preferences open, Sync pinned, empty groups gone, Reset local sync reachable under Backup & data.
