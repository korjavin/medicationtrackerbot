# Gamification — Plan 3 of 3: Frontend (Today rings + Journey screen + targets)

> **Plan group (3 coarse, mostly-sequential plans).**
> - Plan 1 — Backend core *(green first)*
> - Plan 2 — HTTP API + MCP coverage *(API contract frozen)*
> - **Plan 3 — Frontend** ← *you are here* (depends on Plan 2's contract)
>
> Design of record: [docs/gamification.md](../gamification.md). API contract: Plan 2
> "Technical Details". This can start once that contract is frozen (build against it
> with mocked `fetch` even before Plan 2 merges).

## Overview

Build the gamification UI in the vanilla-JS frontend: a **Today dashboard "rings"
widget**, a new **Journey** full-screen section (level, HP, streak, rings, insight
ladder L1–L4), and a **Settings targets editor** (self-set bands with recommended
defaults). All visuals come from `--wg-*` design tokens; reads go through
`cachedFetch`/`loadSWR`; writes go through `DataStore.applyOptimistic`.

**Problem it solves:** Plan 2 serves gamification data but nothing renders it. This
plan adds the three surfaces and gates them on the `gamification` feature flag.

**Integration:** follows the feature-module + bottom-nav conventions; new
`window.Gamification` global is allowlisted; the Journey nav slot is filtered out
when the feature is disabled (filtered *before* mount, per Critical Rule #6).

### Scope and non-goals

**In scope:** Today rings widget, Journey screen (rings + level/HP/streak + insight
ladder L1–L4), Settings targets editor, feature-flag gating, offline/cached render,
integration tests.

**Out of scope (Phase 2):** challenges UI, deeper-insight (L5+) visualizations
(correlations, good-day model, forecasts), recovery/ED-safe mode toggles.

## Context (from discovery)

**Conventions to mirror (verified file references):**

- **Feature module:** `web/static/js/features/today.js` (pure aggregator) + `today-loader.js` (orchestration); section modules like `web/static/js/features/bp.js`, `weight.js`. Modules use closure scope + a single `window.Xxx` namespace; no ES imports — call globals by name.
- **Load order:** script list in `web/static/index.html:21`-32; new `features/journey.js` loads in the feature block (`:31`) **before** `features/bootstrap.js` (loads last). Update the load-order list in `docs/frontend.md:202`.
- **Bottom nav:** `web/static/js/components/wg-bottom-nav.js:27` `DEFAULT_ITEMS` (frozen). Add `{ id: 'journey', label: 'Journey', icon: '<existing wg-icon>' }`.
- **Nav feature gating:** `web/static/js/features/bootstrap.js:104` `NAV_ID_TO_FEATURE` + `filterNavItemsByFeatures` (`:118`). Add `journey: 'gamification'`. A `#journey-view` element goes in `index.html` alongside the other `.view.wg-screen-stage` sections (`:50`-676).
- **Globals allowlist:** `web/static/js/tests/architecture.globals.test.js:25` — add `'window.Gamification'` with a justification comment.
- **Design tokens:** `web/static/css/styles.css` (`--wg-*`); enforced by `web/static/js/tests/architecture.design-tokens.test.js`. **No hardcoded colors, no inline `.style.`** — use CSS classes (`.wg-card`, `.wg-gloss`, `.wg-gloss--sun`, `.wg-gloss--inset`). Reuse `window.WGIcons`, `WGSparkline`, and chart primitives; only reference `--wg-*` from JS if added to `ALLOWED_JS_TOKEN_REFS`.
- **Today aggregation:** `today.js` `aggregateToday(bootstrap, swrCaches, now)` returns flat `{ field: {value, deeplink, status} }`; `today-loader.js:101` `todayFetchSpecs()` declares per-metric cache fetches. Add a `gamification_rings` spec + a rings cell (deeplink `'journey'`).
- **Reads:** `window.cachedFetch(key, url, {tags, freshAfterMs, staleAfterMs})` → `{data, fetchedAt, isFromCache, isStale}`, throws `OfflineNoCacheError` on cold cache; register the key in `web/static/js/core/cache-keys.js`. `window.DataStore.loadSWR(...)` for the Today spec.
- **Writes:** `window.DataStore.applyOptimistic(key, mutator, tags)` then `commit(serverPayload)`/`rollback()` (Critical Rule #9) — for the targets editor save.
- **Settings targets pattern:** Food Targets section in `index.html:526`-565 (`.wg-settings-section` + `.wg-settings-number-field` + `.wg-gloss--inset` input wraps + `.wg-gloss--sun` save button); `features/settings.js:87` `loadSettings()`/`applyBundle` populate + save.
- **Test harness:** `web/static/js/tests/helpers/frontend-harness.js` `loadFrontendEnv()`; integration-first per Critical Rule #8 (extend owning feature suites). Reference `tests/bp.render.test.js`.

## Development Approach

- **Testing approach: Regular** (build the surface, then its integration/render tests in the same task).
- Run `pnpm test` after each task; all green before the next.
- **No hardcoded colors / no inline `.style.`** — architecture tests enforce this; treat their passing as part of each task's test step.
- New `window.*` global requires the allowlist entry in the **same task** that introduces it.
- Build against Plan 2's frozen contract; mock `fetch` in tests (see harness `createMockResponse`).

## Testing Strategy

- **Integration-first** via `frontend-harness.js`, added to the owning suites:
  - `tests/features.gamification.test.js` — cross-feature: bootstrap renders rings widget on Today, nav shows/hides Journey by flag, Settings opens the targets editor.
  - `tests/gamification.render.test.js` — Journey render (level badge, HP/streak, rings, insight-ladder rows) from a mocked summary.
  - `tests/gamification.write.test.js` — targets editor optimistic save (commit + rollback paths).
- **Architecture tests** (must stay green): `architecture.globals.test.js` (new global allowlisted), `architecture.design-tokens.test.js` (no hardcoded colors / inline styles), SW precache list includes the new JS file.
- Do **not** add `*-branches`/`*-edges`/`pin-defect-N` files (Critical Rule #8).

## Progress Tracking

- `[x]` on completion, `➕` new tasks, `⚠️` blockers. Keep in sync.

## What Goes Where

- **Implementation Steps** (checkboxes): JS modules, HTML, CSS classes, nav wiring, tests — all in-repo.
- **Post-Completion**: manual device/emulator visual check; Phase-2 surfaces.

## Implementation Steps

### Task 1: Journey section scaffolding + feature gating
- [ ] add `{ id: 'journey', label: 'Journey', icon: '<existing wg-icon name>' }` to `DEFAULT_ITEMS` in `components/wg-bottom-nav.js:27`
- [ ] add `journey: 'gamification'` to `NAV_ID_TO_FEATURE` in `features/bootstrap.js:104` (so the slot is filtered out when disabled, before mount)
- [ ] add `<div id="journey-view" class="view wg-screen-stage">…</div>` to `web/static/index.html` (mirror an existing section view)
- [ ] add `features/journey.js` to the script load list in `index.html` (before `features/bootstrap.js`) and to the SW precache list + `docs/frontend.md:202` load-order
- [ ] write an integration test: nav includes "Journey" when `features.gamification` is true and omits it when false
- [ ] run `pnpm test` — must pass before next task

### Task 2: `features/journey.js` — renderer + `window.Gamification`
- [ ] create `features/journey.js`: closure-scoped module exposing `window.Gamification` (loader + `render`), reading `GET /api/gamification/journey` via `cachedFetch` (register `gamification` key in `core/cache-keys.js`)
- [ ] render with CSS classes + `--wg-*` tokens only: level badge + HP progress to next level, current/longest streak (+ freezes), the five rings, and the insight-ladder rows (L1–L4 with locked/unlocked state)
- [ ] handle `OfflineNoCacheError` with an explicit empty state; mount a `WGStaleBadge` freshness chip via `mountFromKey`
- [ ] add `'window.Gamification'` to `architecture.globals.test.js:25` with a justification comment
- [ ] write `tests/gamification.render.test.js`: from a mocked journey payload, assert level/HP/streak/rings/ladder DOM; assert empty state on cold offline
- [ ] run `pnpm test` — must pass before next task

### Task 3: Today dashboard rings widget
- [ ] extend `today-loader.js:101` `todayFetchSpecs()` with a `gamification_rings` spec (`feature: 'gamification'`, `tags: ['gamification']`, fetch `GET /api/gamification/rings`)
- [ ] load it in `loadToday()` and pass into `aggregateToday(bootstrap, {...swrCaches, gamification_rings}, now)`
- [ ] add a pure `gamificationRingsCell(rings, enabled)` to `features/today.js` returning `{value, deeplink: 'journey', status}` (`disabled` when off, `missing` when no data)
- [ ] render the rings tile in the Today view (`.wg-card`/`.wg-gloss`, tokens only); tapping deep-links to `journey`
- [ ] write integration tests in `features.gamification.test.js`: rings tile renders when enabled, omitted when disabled, deep-links to Journey
- [ ] run `pnpm test` — must pass before next task

### Task 4: Settings targets editor
- [ ] add a `<section id="gamification-targets-settings" class="wg-card wg-settings-section">` to `index.html` (mirror Food Targets `:526`): one `.wg-settings-number-field` per editable band (BP sys/dia, sleep duration, steps, calorie target, weight goal/mode), each showing its **recommended** default as placeholder/label
- [ ] in `features/settings.js` `applyBundle`, populate fields from `GET /api/gamification/targets` (show "recommended: …" when `isRecommended`)
- [ ] wire the Save button to `PUT /api/gamification/targets` via `DataStore.applyOptimistic('gamification', mutator, ['gamification'])` → `commit`/`rollback`; client-side guard against obviously unsafe values (e.g. weight goal below floor) before POST
- [ ] gate the whole section on `features.gamification`
- [ ] write `tests/gamification.write.test.js`: optimistic save repaints, commit reconciles, rollback restores on failure; recommended-vs-custom display
- [ ] run `pnpm test` — must pass before next task

### Task 5: Verify acceptance criteria
- [ ] verify the three surfaces render correctly and are all gated on the flag (nav slot filtered before mount; Today tile + Settings section hidden when off)
- [ ] run full `pnpm test` (unit + integration)
- [ ] confirm architecture tests pass: globals allowlist, design tokens (no hardcoded colors / inline styles), SW precache includes `features/journey.js`
- [ ] run the frontend linter — fix all issues

### Task 6: Update documentation
- [ ] document the Journey section + rings widget + targets editor in `docs/frontend.md` (sections list, load order, globals table)
- [ ] flip `docs/gamification.md` §14 surfaces note to "implemented"

## Technical Details

- **Reads:** Journey + rings via `cachedFetch` (local-first, offline-resilient, freshness chip). Today rings also flow through the existing `loadSWR` Today path so the bootstrap-warmed `gamification` cache (Plan 2 Task 6) is reused on cold start.
- **Writes:** targets editor only — `applyOptimistic` (Critical Rule #9), never `invalidateTags + loadX()`.
- **Tokens/components:** reuse `WGIcons`, `WGSparkline`, `WGStaleBadge`; rings can be a small SVG built with tokenized classes (no inline color). Consider a `<wg-rings>` component only if reused beyond Today + Journey — otherwise keep it as render helpers (YAGNI).
- **Gating:** `features.gamification` comes from the settings/features bundle; nav filtering happens in `bootstrap.js` before mount; Today/Settings check the same flag.

## Post-Completion

**Manual verification (no checkboxes):**
- Load on the Android emulator / device: confirm Journey nav slot appears, rings widget renders on Today, targets editor saves, and everything disappears cleanly when the feature is toggled off. Verify offline render (airplane mode) shows cached rings + stale badge.

**Phase 2 (separate plans):**
- Challenges UI (accept/complete) on the Journey screen.
- Deeper-insight visualizations (L5+): correlations, good-day model, forecasts.
- Recovery-mode / ED-safe-mode toggles (hide numbers, pause streaks) in Settings.
