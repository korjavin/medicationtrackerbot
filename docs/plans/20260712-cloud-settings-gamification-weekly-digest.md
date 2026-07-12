# Cloud Settings: hide dead weekly_digest toggle + add gamification toggle

## Overview

Two coupled fixes to the shared Settings feature-toggles UI (bot + cloud share
`web/static/index.html` + `web/static/js/features/settings.js`):

- **med-eas.44** — In cloud mode the Features list renders a `weekly_digest`
  toggle that does nothing. `weekly_digest` is a bot/server-mode scheduler
  feature (Telegram Sunday summary); `cmd/cloud` has no digest sender, and the
  cloud apishim leaves `weekly_digest` out of `PORTED_SET` so the flag is
  clamped to `false` and an enable POST is rejected. **Hide** the
  `weekly_digest` toggle in cloud mode only. Bot mode keeps it unchanged.

- **med-eas.45** — There is no gamification on/off control in Settings. The
  `gamification_enabled` flag exists and defaults ON (migration 073;
  `web/domain/settings.js` `DEFAULT_FEATURES.gamification = true`), `gamification`
  IS in the cloud apishim `PORTED_SET`, and `POST /api/settings/features/gamification`
  is already routed by the generic feature-toggle path in the shim. But no UI
  control is rendered. **Add** a gamification feature toggle wired through the
  existing generic `toggleFeatureSetting('gamification', …)` surface. Default ON.

Both surfaces the flag already gates: the Today rings tile reads
`pickFeature(features,'gamification')` (`today.js:389`) and is omitted from
`bootstrapPayload` when off (`apishim.js:225`); `switchTab('journey')` bounces to
Today when `!window.featureSettings.gamification` (`app.js:722-726`). So NO new
gating code is needed — only the control. Turning it off will hide the rings
tile and make Journey unreachable through existing gating.

## Context (from discovery)

- `web/static/index.html:602-641` — Features `<section>` with seven
  `<mt-setting-toggle>` rows (bp, weight, workout, medication, food-intake,
  health, weekly-digest). Add a gamification row here.
- `web/static/js/features/settings.js:772-781` — `updateFeatureToggles()` syncs
  each checkbox from `window.featureSettings`. Add the gamification checkbox.
- `web/static/js/features/settings.js:592-609` — cloud-mode block in
  `loadSettings()` that adds `wg-settings-hidden` to bot-only sections. Hide the
  weekly-digest toggle row here (same class + `?.` guard pattern).
- `web/static/js/app.js:573-595` — feature-toggle `change` listeners calling
  `toggleFeatureSetting(<feature>, this.checked)`. Add the gamification listener.
- `web/cloud/js/apishim.js:150` — `PORTED_SET` already contains `gamification`;
  `weekly_digest` is intentionally absent. No shim change needed.
- `web/domain/settings.js:69-78` — `DEFAULT_FEATURES` (`gamification:true`,
  `weekly_digest:false`), `setFeature` validates `feature in DEFAULT_FEATURES`.
- Tests: `web/static/js/tests/settings.toggles.test.js` hardcodes "seven feature
  toggles" (`toBe(7)`) and the id lists in three places (mount, divider,
  post-boot) — these must move to eight and include
  `gamification-feature-toggle`. Add a cloud-hides-weekly-digest case and a
  gamification round-trip case to the same suite.

## Development Approach

- **Testing approach**: NO unit tests. Extend the owning integration suite
  (`settings.toggles.test.js`) through the existing jsdom/`loadFrontendEnv`
  harness. Do NOT create `*-branches` / `pin-defect-N` files.
- Smallest coherent diff; reuse the existing toggle render + `toggleFeatureSetting`
  + `wg-settings-hidden` patterns. No hardcoded colors, no inline `.style.`.
- Complete each task fully before the next; keep the plan in sync.

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: extend `settings.toggles.test.js` — (a) gamification
  toggle exists + round-trips through `toggleFeatureSetting` to
  `POST /api/settings/features/gamification`; (b) in cloud mode
  (`window.__MEDTRACKER_CLOUD__ = true`) the weekly-digest toggle row gets
  `wg-settings-hidden` after `loadSettings()`, and is NOT hidden in bot mode.
  These guard real boundaries (the shared HTML contract + the cloud-vs-bot
  branch), so they add a guarantee the existing count-based tests don't.
- **E2E tests**: none (no existing suite covers this).

## Progress Tracking

- Mark completed items `[x]` immediately.
- ➕ newly discovered tasks, ⚠️ blockers.

## What Goes Where

- Implementation Steps: HTML/JS edits + settings.toggles.test.js updates.
- Post-Completion: manual cloud/bot smoke, `npx vitest run` full pass.

## Implementation Steps

### Task 1: Add the gamification feature toggle to the Features markup

- [ ] In `web/static/index.html`, inside the Features `<section>`
      (`.wg-settings-features`), add a `<mt-setting-toggle>` row with
      `title="Feature: Journey"`, a description like
      `"Enable the Journey gamification section"`, and
      `input-id="gamification-feature-toggle"`. Place it alongside the other
      feature toggles (e.g. after the health toggle, before weekly-digest), no
      `divider` attribute, matching the surrounding markup exactly.
- [ ] Confirm no inline `style=` and no hardcoded color were introduced.

### Task 2: Sync the gamification checkbox from feature flags

- [ ] In `web/static/js/features/settings.js` `updateFeatureToggles()`
      (~line 772), add
      `document.getElementById('gamification-feature-toggle').checked = !!flags.gamification;`
      following the existing pattern.

### Task 3: Wire the gamification toggle change handler

- [ ] In `web/static/js/app.js`, next to the other
      `*-feature-toggle` change listeners (~line 573-595), add a `change`
      listener on `gamification-feature-toggle` calling
      `await toggleFeatureSetting('gamification', this.checked);`.

### Task 4: Hide the weekly_digest toggle in cloud mode

- [ ] In `web/static/js/features/settings.js` `loadSettings()` cloud block
      (`if (window.__MEDTRACKER_CLOUD__) { … }`, ~line 592), add
      `document.querySelector('mt-setting-toggle[input-id="weekly-digest-feature-toggle"]')?.classList.add('wg-settings-hidden');`
      using the existing `?.`-guarded `wg-settings-hidden` pattern. Bot mode
      leaves the toggle visible (no change to the non-cloud path).

### Task 5: Update + extend the settings toggles integration suite

- [ ] In `web/static/js/tests/settings.toggles.test.js`, update the three
      hardcoded toggle-id lists (the "mounts all … feature toggles" test, the
      `divider`-attribute test, and the "checkboxes exist after harness boot"
      test) to include `gamification-feature-toggle`, and bump the two count
      assertions from `7`/`toBe(7)` to `8`/`toBe(8)`.
- [ ] Add a test: `window.toggleFeatureSetting('gamification', true)` calls
      `apiCall('/api/settings/features/gamification','POST',{enabled:true})`
      (mirror the existing round-trip test), and that flipping the
      `gamification-feature-toggle` checkbox drives it.
- [ ] Add a cloud-mode test: with `window.__MEDTRACKER_CLOUD__ = true`, after
      `loadSettings()` the `mt-setting-toggle[input-id="weekly-digest-feature-toggle"]`
      row has class `wg-settings-hidden`; and without the cloud flag it does not.
      Clean up the global in `finally` (match the existing cloud tests' pattern).

### Task 6: Verify acceptance criteria

- [ ] weekly_digest toggle hidden in cloud, visible in bot mode.
- [ ] gamification toggle renders in both modes, default ON for a fresh cloud
      account (DEFAULT_FEATURES.gamification = true), round-trips + persists.
- [ ] Confirm no inline `style=` / hardcoded hex added (architecture guards).
- [ ] Run the relevant suites and the architecture guards:
      `npx vitest run settings.toggles` and the repo-wide `architecture.*`
      guards (no-module-state, globals, offline-coverage) — must pass.
- [ ] Run the full frontend suite `npx vitest run` — must pass.

### Task 7: [Final] Docs

- [ ] No doc change expected (feature-toggle conventions already documented). If
      any new pattern emerged, note it; otherwise leave docs untouched.

## Technical Details

- Feature key: `gamification` (matches `DEFAULT_FEATURES`, migration 073, apishim
  `PORTED_SET`, and `switchTab` `tabToFeature.journey`).
- Hiding mechanism: `wg-settings-hidden` CSS class (same as the cloud-mode
  section hides already used in `loadSettings`).
- No backend, no migration, no apishim change — the routes and defaults already
  exist.

## Post-Completion

**Manual verification** (optional):
- Cloud build: Settings → Features shows Journey toggle, no Weekly Digest;
  toggling Journey off removes the Today rings tile and bounces Journey to Today.
- Bot build: Settings → Features still shows Weekly Digest and now also Journey.
