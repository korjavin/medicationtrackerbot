# Gamification — Plan 3 of 3: Frontend (Today rings + Journey screen + targets)

> **Plan group (3 coarse, mostly-sequential plans).**
> - Plan 1 — Backend core *(merged on `master`)*
> - Plan 2 — HTTP API + MCP coverage *(API contract frozen)*
> - **Plan 3 — Frontend** ← *you are here* (depends on Plan 2's contract)
>
> Design of record: [docs/gamification.md](../gamification.md). API contract: Plan 2
> "Technical Details". This can start once that contract is frozen (build against it
> with mocked `fetch` even before Plan 2 merges).

> **⚠️ Testing note (intentional deviation):** by direction, **this plan does not
> require writing integration/render/write tests** (mirrors Plan 2). Verification is
> frontend lint + the *existing* architecture guards staying green + manual browser/
> emulator smoke (see Verification). This overrides the default ralphex "every task
> must include tests" mandate **and** the project's integration-first testing posture
> (Critical Rule #8) for Plan 3 only. The one non-negotiable that remains is the
> `window.Gamification` allowlist **registration** (Critical Rule #4) — that's a
> one-line entry, not an authored test, and CI fails without it.

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

> **⚠️ Risk accepted by stripping tests:** frontend JS has no compiler, so the two
> regressions most likely to slip through build/lint — **flag-gating** (feature
> leaking when disabled) and **optimistic rollback** (Rule #9, a failed save leaving
> stale UI) — are now caught **only by the manual smoke pass**. Exercise both
> deliberately (toggle the flag off; force a save failure) in Task 5.

### Scope and non-goals

**In scope:** Today rings widget, Journey screen (rings + level/HP/streak + insight
ladder L1–L4), Settings targets editor, feature-flag gating, offline/cached render.

**Out of scope (Phase 2):** challenges UI, deeper-insight (L5+) visualizations
(correlations, good-day model, forecasts), recovery/ED-safe mode toggles.

**Explicitly out of scope for this plan:** new authored integration / render / write
tests (`features.gamification.test.js`, `gamification.render.test.js`,
`gamification.write.test.js`). Do not author them here.

## Context (from discovery)

**Conventions to mirror (verified file references):**

- **Feature module:** `web/static/js/features/today.js` (pure aggregator) + `today-loader.js` (orchestration); section modules like `web/static/js/features/bp.js`, `weight.js`. Modules use closure scope + a single `window.Xxx` namespace; no ES imports — call globals by name.
- **Load order:** script list in `web/static/index.html:21`-32; new `features/journey.js` loads in the feature block (`:31`) **before** `features/bootstrap.js` (loads last). Update the load-order list in `docs/frontend.md:202`.
- **Bottom nav:** `web/static/js/components/wg-bottom-nav.js:27` `DEFAULT_ITEMS` (frozen). Add `{ id: 'journey', label: 'Journey', icon: '<existing wg-icon>' }`.
- **Nav feature gating:** `web/static/js/features/bootstrap.js:104` `NAV_ID_TO_FEATURE` + `filterNavItemsByFeatures` (`:118`). Add `journey: 'gamification'`. A `#journey-view` element goes in `index.html` alongside the other `.view.wg-screen-stage` sections (`:50`-676).
- **Globals allowlist (mandatory registration):** `web/static/js/tests/architecture.globals.test.js:25` — add `'window.Gamification'` with a justification comment. Required by Critical Rule #4; not optional.
- **Design tokens:** `web/static/css/styles.css` (`--wg-*`); enforced by `web/static/js/tests/architecture.design-tokens.test.js`. **No hardcoded colors, no inline `.style.`** — use CSS classes (`.wg-card`, `.wg-gloss`, `.wg-gloss--sun`, `.wg-gloss--inset`). Reuse `window.WGIcons`, `WGSparkline`, and chart primitives; only reference `--wg-*` from JS if added to `ALLOWED_JS_TOKEN_REFS`.
- **Today aggregation:** `today.js` `aggregateToday(bootstrap, swrCaches, now)` returns flat `{ field: {value, deeplink, status} }`; `today-loader.js:101` `todayFetchSpecs()` declares per-metric cache fetches. Add a `gamification_rings` spec + a rings cell (deeplink `'journey'`).
- **Reads:** `window.cachedFetch(key, url, {tags, freshAfterMs, staleAfterMs})` → `{data, fetchedAt, isFromCache, isStale}`, throws `OfflineNoCacheError` on cold cache; register the key in `web/static/js/core/cache-keys.js`. `window.DataStore.loadSWR(...)` for the Today spec.
- **Writes:** `window.DataStore.applyOptimistic(key, mutator, tags)` then `commit(serverPayload)`/`rollback()` (Critical Rule #9) — for the targets editor save.
- **Settings targets pattern:** Food Targets section in `index.html:526`-565 (`.wg-settings-section` + `.wg-settings-number-field` + `.wg-gloss--inset` input wraps + `.wg-gloss--sun` save button); `features/settings.js:87` `loadSettings()`/`applyBundle` populate + save.
- **API contract:** Plan 2 "Technical Details" (`/api/gamification/{summary,journey,rings,targets}`). Note Plan 2's `rings` shape is `{enabled, level, today_hp, rings:[{ring, hp}]}` — build the Today tile against that, not a `dailyMax`/`label`/`status` shape.

## Development Approach

- **No authored tests in this plan** (per direction). Each task is complete when it
  **lints clean, keeps the existing architecture guards green, and passes a manual
  smoke check** of the affected surface.
- The `window.Gamification` allowlist entry (Rule #4) and not breaking the
  design-token / SW-precache guards are **required** — they're registrations /
  compliance, not authored tests.
- All visuals via `--wg-*` tokens; reads via `cachedFetch`/`loadSWR`; writes via
  `applyOptimistic` (Rule #9).
- Update this plan when scope shifts (`➕` new task, `⚠️` blocker).

## Verification (in place of authored tests)

This plan relies on the following instead of authored integration/render/write tests:

- **Lint:** the frontend linter is clean on touched files.
- **Existing architecture guards stay green** (run by `pnpm test`, not new tests):
  `architecture.globals.test.js` (passes once `window.Gamification` is allowlisted),
  `architecture.design-tokens.test.js` (no hardcoded colors / inline styles), and the
  SW-precache guard (passes once `features/journey.js` is in the precache list).
- **No regressions:** the existing `pnpm test` suite still passes — we are not adding
  tests, only not breaking the ones already there.
- **Manual smoke (primary verification):** browser + Android emulator — Journey
  renders, Today rings tile renders/deep-links, targets editor saves, everything is
  hidden when the flag is off, optimistic **rollback** restores on a forced save
  failure, and offline shows cached rings + stale badge.

## Progress Tracking

- `[x]` on completion, `➕` new tasks, `⚠️` blockers. Keep in sync.

## What Goes Where

- **Implementation Steps** (checkboxes): JS modules, HTML, CSS classes, nav wiring,
  the mandatory allowlist + precache registrations, doc updates — all in-repo.
  **No test-authoring checkboxes.**
- **Post-Completion**: manual device/emulator visual check; Phase-2 surfaces.

## Implementation Steps

### Task 1: Journey section scaffolding + feature gating
- [x] add `{ id: 'journey', label: 'Journey', icon: 'bolt' }` to `DEFAULT_ITEMS` in `components/wg-bottom-nav.js` (placed before Settings so Settings stays last; also extended `colsFor` to support 9–10 items so the 9th slot lays out two rows of 5/4 instead of throwing, and updated the existing component-test assertions for the 9-item layout)
- [x] add `journey: 'gamification'` to `NAV_ID_TO_FEATURE` in `features/bootstrap.js` (so the slot is filtered out when disabled, before mount)
- [x] add `<div id="journey-view" class="view wg-screen-stage">…</div>` to `web/static/index.html` (mirrors weight-view: stale-badge row + `#journey-content`)
- [x] add `features/journey.js` to the script load list in `index.html` (after `today.js`, before `features/bootstrap.js`), to the **SW precache list**, and to `docs/frontend.md` load-order. Created a minimal IIFE stub at `features/journey.js` so the script tag + precache entry resolve (real `window.Gamification` renderer lands in Task 2); allowlisted it in `architecture.offline-coverage.test.js` as a no-API-reads scaffold (the dead-entry check forces its removal once Task 2 adds `cachedFetch`)
- [x] lint clean (no ESLint in repo — architecture guards are the de-facto lint; full `pnpm test` green) + manual smoke deferred to Task 5 (nav gating logic verified by the passing `filterNavItemsByFeatures`/`colsFor` tests; browser/emulator smoke is the plan's manual-only deviation)

### Task 2: `features/journey.js` — renderer + `window.Gamification`
- [ ] create `features/journey.js`: closure-scoped module exposing `window.Gamification` (loader + `render`), reading `GET /api/gamification/journey` via `cachedFetch` (register `gamification` key in `core/cache-keys.js`)
- [ ] render with CSS classes + `--wg-*` tokens only: level badge + HP progress to next level, current/longest streak (+ freezes), the five rings, and the insight-ladder rows (L1–L4 with locked/unlocked state)
- [ ] handle `OfflineNoCacheError` with an explicit empty state; mount a `WGStaleBadge` freshness chip via `mountFromKey`
- [ ] **(mandatory, Rule #4)** add `'window.Gamification'` to `architecture.globals.test.js:25` with a justification comment
- [ ] lint clean + globals + design-token guards green + manual smoke: Journey renders from a real `GET /api/gamification/journey`; cold-offline shows the empty state — before next task

### Task 3: Today dashboard rings widget
- [ ] extend `today-loader.js:101` `todayFetchSpecs()` with a `gamification_rings` spec (`feature: 'gamification'`, `tags: ['gamification']`, fetch `GET /api/gamification/rings`)
- [ ] load it in `loadToday()` and pass into `aggregateToday(bootstrap, {...swrCaches, gamification_rings}, now)`
- [ ] add a pure `gamificationRingsCell(rings, enabled)` to `features/today.js` returning `{value, deeplink: 'journey', status}` (`disabled` when off, `missing` when no data) — read the Plan 2 `rings` shape (`{ring, hp}` + `today_hp`)
- [ ] render the rings tile in the Today view (`.wg-card`/`.wg-gloss`, tokens only); tapping deep-links to `journey`
- [ ] lint clean + manual smoke: rings tile renders when enabled, omitted when disabled, deep-links to Journey — before next task

### Task 4: Settings targets editor
- [ ] add a `<section id="gamification-targets-settings" class="wg-card wg-settings-section">` to `index.html` (mirror Food Targets `:526`): one `.wg-settings-number-field` per editable band (BP sys/dia, sleep duration, steps, calorie target, weight goal/mode), each showing its **recommended** default as placeholder/label
- [ ] in `features/settings.js` `applyBundle`, populate fields from `GET /api/gamification/targets` (show "recommended: …" when `isRecommended`)
- [ ] wire the Save button to `PUT /api/gamification/targets` via `DataStore.applyOptimistic('gamification', mutator, ['gamification'])` → `commit`/`rollback`; client-side guard against obviously unsafe values (e.g. weight goal below floor) before POST
- [ ] gate the whole section on `features.gamification`
- [ ] lint clean + design-token guard green + manual smoke: save reconciles on success; **forced failure rolls back** (Rule #9); recommended-vs-custom display — before next task

### Task 5: Verify acceptance criteria (manual)
- [ ] manual smoke: the three surfaces render and are all gated on the flag (nav slot filtered before mount; Today tile + Settings section hidden when off)
- [ ] manual smoke the two compiler-can't-catch risks: feature fully hidden when disabled; optimistic **rollback** restores prior UI on a forced save failure
- [ ] manual smoke offline: cached rings + stale badge render in airplane mode
- [ ] existing architecture guards green (`pnpm test`): globals allowlist (incl. `window.Gamification`), design tokens, SW precache includes `features/journey.js`
- [ ] no regressions: existing `pnpm test` suite still passes (author no new tests)
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

**Manual verification (the primary verification for this plan — no checkboxes):**
- Load on the Android emulator / device: confirm Journey nav slot appears, rings widget renders on Today, targets editor saves, and everything disappears cleanly when the feature is toggled off. Force a save failure and confirm the optimistic **rollback** restores the prior values. Verify offline render (airplane mode) shows cached rings + stale badge.

**Phase 2 (separate plans):**
- Challenges UI (accept/complete) on the Journey screen.
- Deeper-insight visualizations (L5+): correlations, good-day model, forecasts.
- Recovery-mode / ED-safe-mode toggles (hide numbers, pause streaks) in Settings.
