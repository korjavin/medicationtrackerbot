# Wandergeek Phase 9 — Settings Screen Rewrite

## Overview

Reskin the Settings screen to match the Wandergeek deep-teal / glossy / JetBrains-Mono aesthetic established in Phase 1+2 (`docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md`) and extended by Phase 3 BP, Phase 4 Food, Phase 5 Meds, Phase 6 Weight, Phase 7 Workouts, and Phase 8 Health (`docs/plans/completed/2026-04-XX-wandergeek-phase8-health.md`). Phase 9 is the final per-screen reskin and the largest CSS surface of the redesign, so it lands last — after all Wandergeek primitives are stable and the earlier phases have already validated the token set for inputs, toggles, and action buttons.

Settings is form-heavy and section-dense rather than data-heavy: no charts, no pagination, no modals beyond the (now-legacy) feature-toggle confirm dialogs. The surface area is almost entirely toggles, numeric inputs, info rows, and action buttons grouped into titled sections. That shape is what makes Phase 9 expensive — every input state (default / focus / hover / disabled / error) needs a token and a visual treatment, and the existing `<mt-setting-toggle>` custom element and its `.toggle` / `.toggle-slider` structure need to be reskinned or replaced with a Wandergeek-native equivalent.

The target layout:

- **Sectioned cards** — each logical grouping (Sync, Time, Notifications, Features, Reminders, Food targets, Test notifications, Version) renders as a `.wg-card` with a mono section header, optional `.wg-section-label` eyebrow, and a stack of setting rows inside.
- **Setting rows** — a canonical `.wg-settings-row` layout: left column mono title + muted description, right column either a `WGToggle` pill, a `.wg-gloss--inset` input wrap, or a `.wg-gloss` action button. Rows carry a bottom hairline divider via a token'd border (no ad-hoc `border-bottom: 1px solid #ddd`).
- **Toggle primitive** — new `WGToggle` (or reskinned `<mt-setting-toggle>`) rendering a `.wg-gloss--sun`-when-on pill with a mono knob. Existing input IDs (`bp-feature-toggle`, `weight-feature-toggle`, `workout-feature-toggle`, `medication-feature-toggle`, `food-intake-toggle`, `health-feature-toggle`, `bp-reminders-toggle`, `weight-reminders-toggle`, `webpush-toggle`) stay so `features/settings.js` binds without change.
- **Input primitive** — `.wg-gloss--inset` wrap around mono `<input type="number">` / `<input type="text">` / `<input type="time">` with a small uppercase label above. Used for Food Targets and any future numeric inputs. Reused by Phase 8 already (notes textarea, edit-note modal) but Phase 9 canonicalizes the field-shape into `renderSettingsNumberField({ id, label, placeholder, unit })`.
- **Action button** — full-width or inline `.wg-gloss` / `.wg-gloss--sun` buttons for Save Targets, Test Meds, Test BP, and any destructive actions. Per modal-button-order convention, primary / confirm actions get `.wg-gloss--sun`.
- **Sync status card** — top section renders the existing `#sync-status-bar` mount inside a `.wg-card`. Icon + mono label + muted eyebrow when offline.
- **Time & timezone card** — read-only info rows rendered as a `.wg-gloss--inset` grid with mono values.
- **Version footer** — mono section-label with the `VERSION_PLACEHOLDER` string, wrapped in a muted `.wg-card` without header.

No backend changes. The existing `/api/settings/*`, `/api/bp/reminder/*`, `/api/weight/reminder/*`, `/api/food/settings/targets`, `/api/webpush/*` endpoints stay intact — we rewrite only the render layer, the CSS, and the `<mt-setting-toggle>` custom element.

## Context (from discovery)

**Existing settings code (target):**

- `web/static/js/features/settings.js` (~227 lines) — already extracted as a feature module. No fold-in needed this phase.
  - `applyFeatureSettings(settings)` — writes toggle checked state from settings payload
  - `loadFeatureSettings()` / `loadFoodTargets()` / `loadReminderSettings()` — SWR-backed loaders
  - `saveFoodTargets()` / `toggleFeatureSetting(feature, enabled)` / `saveTabOrder(order)` — action dispatchers
  - `bindSettingsControls()` — DOM event wiring (toggles + save button + webpush toggle)
- `web/static/js/components/mt-elements.js` — `MTSettingToggle` custom element (lines 34-72) renders the `.setting-item` + `.toggle` + `.toggle-slider` structure. Phase 9 rewrites its innards to use `.wg-gloss` + `.wg-gloss--sun` classes without changing the `<mt-setting-toggle>` tag contract.
- `web/static/index.html` — `#settings-view` section (lines ~294-407): Sync status, OIDC setup mount, Time/Timezone info block, Webpush toggle + status div, feature toggles (BP / Weight / Workouts / Medications / Food / Health), reminder toggles (BP / Weight), Food targets form, Test Meds + Test BP buttons, Version footer.
- `web/static/css/styles.css` — existing `.setting-item` / `.setting-item-divider` / `.setting-desc` / `.settings-info-*` / `.toggle` / `.toggle-slider` / `.bp-inputs-row` / `.bp-input-group` paper-era classes get replaced with `.wg-settings-*` equivalents.

**Handoff prototype:** no dedicated Settings screen; Phase 9 composes from existing primitives plus a new `WGToggle` primitive that didn't exist in prior phases (the Wandergeek design has no switch/toggle yet — every prior phase used tap-to-advance pills or dropdown pickers instead).

**Wandergeek primitives available (from Phase 1+2+3+4+5+6+7+8):**

- `.wg-card` / `.wg-card--inset` / `.wg-gloss` / `.wg-gloss--sun` / `.wg-gloss--inset` / `.wg-tag` + variants / `.wg-mono-display` / `.wg-section-label` / `.wg-icon-btn`
- `WGIcons.iconSvg('bell' | 'clock' | 'chevronRight' | 'check' | 'refresh', …)` — confirm icon names exist or add the missing ones
- `WGBottomNav.DEFAULT_ITEMS` already carries the `settings` slot (confirm icon + contract test in the final task)
- No existing chart or data-visualization primitives are used on the Settings screen
- **Missing primitive** — Phase 9 must ship a `WGToggle` component since no prior phase introduced one. The existing `<mt-setting-toggle>` custom element is the extension point; Phase 9 rewrites its render to emit Wandergeek markup + class names.

**Tests touching Settings (will need updates):**

- `app.unit.test.js` — existing tests against `<mt-setting-toggle>` render; verify no regression after the custom element's render is rewritten
- `settings.render.test.js` / `settings.toggles.test.js` / `settings.food-targets.test.js` / `settings.reminders.test.js` / `settings.webpush.test.js` / `settings.version.test.js` — new, created in this phase
- `components.wg-toggle.test.js` — new, covering the toggle primitive (on/off state, disabled state, label + description render, click dispatches `change` on the hidden checkbox so existing `bindChange` handlers keep working)
- Architecture tests — `architecture.design-tokens.test.js` gets new `--wg-settings-*` dimensional tokens + `--wg-toggle-*` input-state tokens; `architecture.globals.test.js` gets `WGToggle` and any new `WGSettings*` globals with justification

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy; visual checking per task.
- Each task includes new/updated Vitest coverage in the same commit.
- **CRITICAL**: `pnpm test` and (when backend-adjacent) `go test ./...` must pass before the next task.
- Keep the SPA single-document model — all new markup lives in `index.html`'s existing `#settings-view` section.
- No inline styles, no hardcoded hex — every visual value comes from a `--wg-*` token, every dimensional value goes into `WANDERGEEK_TOKENS` in the architecture test. The existing `#settings-view` markup has several inline `style=` hits (`style="display: none;"` on sync-status-bar, `style="width: 100%;"` on info-block wrapper, `margin-top` / `border-top` / `padding-top` on food-targets + test-notifications sections, version footer styling) — every one of these moves to a `.wg-settings-*` class in Task 1.
- Follow Phase 3+4+5+6+7+8's migration pattern (clean migrate to `.wg-settings-*` classes; dual-class only where DOM-query tests require).
- **Scope note**: no feature-module extraction needed — `features/settings.js` already exists. Phase 9 rewrites the render layer (index.html markup + CSS + `MTSettingToggle` custom element) while keeping the data-flow code in `features/settings.js` unchanged.

## Testing Strategy

- **Unit tests** (Vitest, jsdom): each render helper (`renderSettingsSection`, `renderSettingsRow`, `renderSettingsNumberField`, `renderSyncStatusCard`, `renderTimezoneCard`, `renderVersionFooter`) gets coverage for primary + empty + offline-stale states where applicable.
- **Architecture tests**: every new `--wg-*` token appended to `WANDERGEEK_TOKENS`; every new `window.WGToggle` / `WGSettings*` global registered in `architecture.globals.test.js` with a one-line justification.
- **Toggle test**: assert `<mt-setting-toggle>` renders the Wandergeek markup, click toggles the hidden `<input type="checkbox">` and fires `change`, existing `features/settings.js` handlers keep binding (smoke: a toggle click still dispatches `toggleFeatureSetting`).
- **Food-targets test**: assert inputs round-trip through `applyFoodTargetsToInputs` / `saveFoodTargets`, Save button dispatch, empty / prefilled state, offline-pending state.
- **Reminders test**: assert BP + Weight reminder toggles round-trip through `/api/bp/reminder/toggle` and `/api/weight/reminder/toggle`, failure path reverts the checkbox.
- **Webpush test**: assert webpush toggle dispatches subscribe/unsubscribe and surfaces the status message with the correct variant class (`status-success` / `status-error` / `status-muted`) — now rendered as `.wg-tag--mono--success` / `--alert` / `--muted`.
- **Snapshot test**: SettingsScreen renders against a fixed fixture and matches a stable DOM structure across all sections.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- `+` prefix for newly discovered tasks.
- `!` prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tokens, `WGToggle` primitive + `<mt-setting-toggle>` rewrite, sectioned-card shell, sync + timezone + webpush cards, feature + reminder toggle sections, food-targets form card, test-notifications card, version footer, test updates, grep-cleanup of paper-era classes.
- **Post-Completion** (no checkboxes): real-device side-by-side, Lighthouse / contrast audit, reduced-motion audit on toggle `:active` transforms.

## Implementation Steps

### Task 1: Extend tokens + build the `WGToggle` primitive

- [x] add `--wg-settings-*` dimensional tokens to `:root` in `styles.css` (section-card padding, row grid-template-columns, row hairline divider, info-grid grid-template-columns, number-field input height, action-row gap)
- [x] add `--wg-toggle-{bg,bg-on,knob,knob-on,border,border-focus,border-disabled}` semantic tokens for the toggle on/off/focus/disabled states
- [x] extend `WANDERGEEK_TOKENS` in `web/static/js/tests/architecture.design-tokens.test.js` with every new token
- [x] create `web/static/js/components/wg-toggle.js` exposing `WGToggle.render({ id, checked, disabled, onToggle })` returning a DOM element with a hidden `<input type="checkbox" id="...">` (so existing `bindChange('...-toggle', …)` keeps working) + a visual `.wg-gloss--sun`-when-on pill + knob
- [x] register `window.WGToggle` in `architecture.globals.test.js` with a one-line justification
- [x] rewrite `MTSettingToggle.connectedCallback()` in `web/static/js/components/mt-elements.js` to emit `.wg-settings-row` markup + call `WGToggle.render({ id: inputId })` for the pill — keeps the `<mt-setting-toggle>` tag contract stable so `index.html` doesn't need to change yet
- [x] write `components.wg-toggle.test.js` — on/off state, disabled state, click dispatches `change` on hidden checkbox, focus-visible outline present
- [x] verify no behavior change — existing `app.unit.test.js` coverage against `<mt-setting-toggle>` stays green (update expected class names, not structure)
- [x] run `pnpm test` — design-tokens test + `WGToggle` test must be green before next task

### Task 2: Build the sectioned-card shell + row primitive

- [x] create `renderSettingsSection({ eyebrow, title, description, children })` helper returning a `.wg-card` with mono header, optional `.wg-section-label` eyebrow, optional muted description, and a `.wg-settings-row-list` child container
- [x] create `renderSettingsRow({ title, description, control })` helper returning a `.wg-settings-row` with left-column mono title + muted description and right-column control slot
- [x] create `renderSettingsInfoRow({ label, value })` helper for read-only info rows (used by Timezone card)
- [x] write `settings.render.test.js` — section render (with/without eyebrow + description), row render (with toggle / input / button control), info-row render
- [x] run `pnpm test` — must pass before next task

### Task 3: Rewrite sync status + OIDC setup + timezone cards

- [x] replace the sync-status `.setting-item` block with a `renderSettingsSection({ title: 'Sync', … })` + `#sync-status-bar` mount inside a `.wg-card--inset` container; remove inline `style="display: none;"` in favor of a `.wg-settings-hidden` class that `sync-status` code toggles
- [x] keep `#oidc-setup-container` mount as-is (rendered by separate OIDC flow); wrap it in a `.wg-card` shell for visual parity
- [x] replace the Time & Timezone block with `renderSettingsSection({ title: 'Time & Timezone', description: '…' })` + a `.wg-gloss--inset` info grid containing the four info rows (Saved Timezone / Time In Saved Timezone / Browser Local Time / Server Time) — values are still populated by the existing timezone-loading code in `app.js`
- [x] write `settings.sync-timezone.test.js` — sync card render, timezone info-grid render, values round-trip from the existing data sources
- [x] run `pnpm test` — must pass before next task

### Task 4: Rewrite the web push + notifications section

- [x] replace the Web Push `<mt-setting-toggle>` block with a section-grouped row — "Notifications" section header with webpush + test-notifications buttons inside
- [x] replace `#webpush-status` inline `style="display:none; padding:8px; margin-top:8px; border-radius:4px"` with a `.wg-settings-webpush-status` class + `.wg-tag--mono--success` / `--alert` / `--muted` variants; keep the `status-success` / `status-error` / `status-muted` class names as aliases so existing `features/settings.js` keeps binding
- [x] replace Test Meds + Test BP buttons with `.wg-gloss` action buttons in a `.wg-settings-action-row` grid (no `margin-left: 10px` inline)
- [x] write `settings.webpush.test.js` — toggle dispatch, status variant class switching, test-notification button click handlers
- [x] run `pnpm test` — must pass before next task

### Task 5: Rewrite the feature + reminder toggle sections

- [x] wrap the six feature toggles (BP / Weight / Workouts / Medications / Food / Health) in a `renderSettingsSection({ title: 'Features', description: 'Enable or disable sections' })` card — each `<mt-setting-toggle>` now renders inside a `.wg-card` row via the Task 1 rewrite
- [x] wrap the two reminder toggles (BP / Weight) in a `renderSettingsSection({ title: 'Reminders', description: 'Smart periodic reminders' })` card
- [x] remove the `divider` attribute from toggles now that section-card borders provide the grouping; keep the attribute working for backwards compatibility
- [x] write `settings.toggles.test.js` — feature + reminder toggle round-trip, disabled-state visual, group render
- [x] run `pnpm test` — must pass before next task

### Task 6: Rewrite the Food Targets section

- [x] replace the Food Targets `.setting-item` block with `renderSettingsSection({ title: 'Food Targets', description: 'Daily targets for calories and macronutrients' })`
- [x] replace `.bp-inputs-row` + `.bp-input-group` markup with a `.wg-settings-number-grid` 2×2 grid of `renderSettingsNumberField({ id, label, unit, placeholder })` — mono labels, `.wg-gloss--inset` input wraps, trailing unit tags (`kcal` / `g`)
- [x] replace `<button id="save-food-targets-btn" class="btn btn-secondary">` with `.wg-gloss--sun` full-width Save Targets button, no inline `margin: 0`
- [x] write `settings.food-targets.test.js` — field round-trip, Save button dispatch, empty-state pre-fill, offline-rejected state
- [x] run `pnpm test` — must pass before next task

### Task 7: Rewrite the version footer

- [x] replace the version `<div style="text-align:center;color:var(--hint-color);font-size:10px;padding:20px 10px 10px;">` with a `.wg-settings-version` block — mono eyebrow "VERSION · " + the `VERSION_PLACEHOLDER` value
- [x] keep `VERSION_PLACEHOLDER` substitution logic in `cmd/bot/` unchanged (substitution lives in `.github/workflows/deploy.yml` via sed against `index.html`; untouched)
- [x] write `settings.version.test.js` — version string renders, placeholder-replacement still works at the mount point
- [x] run `pnpm test` — must pass before next task

### Task 8: Wire Settings into the canonical bottom nav + cleanup

- [x] confirm `WGBottomNav.DEFAULT_ITEMS` still carries the `settings` slot with the gear (or equivalent) icon; add a Phase 9 contract test matching the BP/Food/Meds/Weight/Workouts/Health contract tests
- [x] grep-verify remaining paper-era settings classes (`setting-item`, `setting-item-divider`, `setting-desc`, `settings-info-*`, `bp-inputs-row`, `bp-input-group`, `btn-secondary`) — remove truly orphaned rules from `styles.css`, dual-class only where DOM-query tests require
- [x] grep `style="` and `\.style\.` in `#settings-view` markup + `features/settings.js` — every hit in new Phase 9 code must be justified (component-local CSS custom property setters only; no hardcoded visual values)
- [x] run `pnpm test` — must pass before next task

### Task 9: Verify acceptance criteria for Phase 9

- [x] manual desktop 390×844 visual check (skipped - not automatable)
- [x] manual mobile viewport 375×812 visual check (skipped - not automatable)
- [x] full `pnpm test` suite green (118 files / 1337 tests passing)
- [x] `go test ./...` green (all packages passing; no backend changes)
- [x] grep `style="` in the new markup + JS — zero matches in `#settings-view` markup and `features/settings.js`
- [x] Wandergeek design rewrite is now complete: Phase 1 (primitives) + Phase 2 (tokens) + Phase 3 (BP) + Phase 4 (Food) + Phase 5 (Meds) + Phase 6 (Weight) + Phase 7 (Workouts) + Phase 8 (Health) + Phase 9 (Settings) — every screen reskinned

### Task 10: [Final] Update plan and close the Wandergeek arc

- [ ] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [ ] write a short retrospective note in `docs/` capturing the final token surface, primitive inventory, and any follow-ups surfaced during the arc (e.g. shared chart base, dark theme, reduced-motion parity, a11y findings)
- [ ] no code changes in this task beyond the retrospective doc

## Technical Details

**Toggle primitive strategy**: `WGToggle` is a new primitive this phase because no prior Wandergeek screen used a switch/toggle — every earlier phase used tap-to-advance pills, dropdown pickers, or `<input>` fields. The design constraint is that existing `features/settings.js` binds `change` events to hidden `<input type="checkbox">` elements by ID, so `WGToggle` renders both the hidden checkbox (for event compatibility) and the visual `.wg-gloss--sun` pill that drives display state. The `<mt-setting-toggle>` custom element stays as the declarative entry point in `index.html`; its render body is rewritten to call `WGToggle.render()` rather than assembling `.toggle` + `.toggle-slider` markup directly.

**Section-card vs. row-divider decision**: paper-era Settings grouped rows with hairline dividers and occasional `margin-top: 20px; border-top: 1px solid #ddd` spacers. Phase 9 replaces both with full `.wg-card` section groupings because (a) every earlier Wandergeek phase established cards as the canonical grouping primitive, (b) section cards naturally carry a mono header which makes the hierarchy scannable, (c) the hairline divider between rows inside a card becomes a token'd bottom border rather than a box-shadow hack.

**Input-state tokens**: Phase 9 is the first screen where input state (default / focus / hover / disabled / error) matters for the design system. The `--wg-toggle-*` tokens handle the toggle-specific states; `--wg-input-{border,border-focus,bg,bg-focus,placeholder}` tokens (reused from Phase 4 Food + Phase 8 Health if already present, or added this phase) handle numeric inputs. Error state is surfaced via a `.wg-settings-row--error` modifier rather than coloring the input — matches the Phase 8 notes-rejected pattern.

**Webpush status-message parity**: the existing webpush toggle change handler in `features/settings.js` sets `status.className` to `status-success` / `status-error` / `status-muted` and toggles `status.style.display` to show/hide. Phase 9 keeps those class names as aliases that resolve to `.wg-tag--mono--success` / `--alert` / `--muted` variants so the handler code doesn't change; the `style.display` toggle migrates to a `.wg-settings-hidden` class toggle instead.

**Test-Notifications block**: the Test Meds + Test BP buttons currently have no backing click handlers in `features/settings.js` (they're bound in `app.js` or at the handler layer). Phase 9 moves the click-handler binding into `features/settings.js` during Task 4 if the handlers are still paper-era inline; otherwise they stay wherever they are today and Phase 9 only restyles the buttons.

**Backwards-compat for `<mt-setting-toggle>`**: the tag contract (`title`, `description`, `input-id`, `divider` attributes) stays stable. Only the internal render changes. Any test asserting specific class names (`.setting-item`, `.toggle`, `.toggle-slider`) needs updating in Task 1, but tests asserting behavior (label text, checkbox state) stay green without changes.

**Tab-order persistence**: `features/settings.js` exposes `saveTabOrder(order)` called from the drag-and-drop tab reorder flow. Phase 9 does not change the tab-reorder UI (that lives elsewhere); the settings screen does not currently expose a visible tab-order editor, and one is out of scope for this phase.

**Scope boundary**: Settings is the *last* per-screen reskin in the Wandergeek arc. After Phase 9 ships, the remaining work is non-per-screen: reduced-motion polish, dark-theme tokenization, shared-chart-base extraction, and any a11y / contrast follow-ups surfaced during the arc. Those live in a later consolidated phase or as standalone tickets, not in the per-screen sequence.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes.*

**Manual verification:**
- Real-device side-by-side on iPhone (PWA install) and Android Chrome
- Lighthouse / a11y audit on Settings screen — minimum-touch-target check on toggles, contrast on webpush status messages, form label association, focus order through the long form
- Reduced-motion preference: toggle `:active` transforms and any card-enter animation respect `prefers-reduced-motion`
- Telegram WebApp BackButton verification inside the actual Telegram client — confirm Settings screen history is clean after visiting + leaving
- Form-input behavior on iOS Safari (numeric keypad for Food Targets, no unwanted autocorrect on labels, no zoom-in on input focus)
- OIDC setup container renders correctly inside the Wandergeek shell (the OIDC flow is rendered by a separate module; verify no layout or z-index regression)

**External system updates:**
- Update `pitch.html` screenshots once Phase 9 lands — final per-screen reskin
- Announce the full Wandergeek rollout in whatever release-notes channel applies
- Archive the Wandergeek plan set under `docs/plans/completed/` and write a short arc retrospective

## Follow-up Phases (out of scope; named only)

### Phase 10 — Reduced-motion + dark-theme + a11y consolidation (future)
Consolidate reduced-motion support across every gloss/:active animation, every chart draw-in, and every modal transition. Tokenize a dark theme variant of the Wandergeek palette and gate it on `prefers-color-scheme: dark`. Address any a11y findings (contrast, touch targets, keyboard-focus traps) surfaced during the per-screen arc. Naming only — not scheduled yet.

### Phase 11 — Shared chart base extraction (future, conditional)
If duplication across `WGBpChart` / `WGWeightChart` / `WGWorkoutChart` / `WGSleepChart` / `WGStepsChart` / `WGVitalsChart` proves burdensome after Phase 9 lands, extract a shared base component (`WGChart`) that handles axis rendering, grid, and common tick logic. Only worth doing if the per-chart drift is small enough that the abstraction stays thin.
