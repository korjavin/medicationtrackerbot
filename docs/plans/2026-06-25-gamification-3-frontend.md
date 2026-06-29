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
- [x] create `features/journey.js`: closure-scoped module exposing `window.Gamification` (loader `load()` + `render(journey)`), reading `GET /api/gamification/journey` via `cachedFetch` (registered the `gamification` key in `core/cache-keys.js`, tag `gamification`, 6h staleAfterMs). Wired the loader into `app.js` `switchTab`/`reloadCurrentTab` (`else if (tab === 'journey')`) and added `journey: 'gamification'` to the `tabToFeature` deeplink/saved-tab gate. Also removed the now-stale `journey.js` entry from `architecture.offline-coverage.test.js` (the dead-entry check requires it once `cachedFetch` is present)
- [x] render with CSS classes + `--wg-*` tokens only: level badge (bolt) + lifetime HP + sun progress bar to next level, current/longest streak + freezes (3 mono stat cells), the five domain rings (gloss-inset bars scaled against the day's leader), and the insight-ladder rows (L1–L4, locked/unlocked from `unlocked_tiers`). New `.wg-journey-*` classes in `styles.css`; only dynamic value is `--fill-pct` (allowed, same convention as the weight-goal card)
- [x] handle `OfflineNoCacheError` with an explicit empty state; mount a `WGStaleBadge` freshness chip via `mountFromKey`
- [x] **(mandatory, Rule #4)** add `'window.Gamification'` to `architecture.globals.test.js:25` with a justification comment
- [x] lint clean + globals + design-token guards green (full `pnpm test` green: 241 files / 2621 tests). Manual browser/emulator smoke is this plan's manual-only deviation, batched into Task 5 (no ESLint in repo — architecture guards are the de-facto lint)

### Task 3: Today dashboard rings widget
- [x] extend `today-loader.js:101` `todayFetchSpecs()` with a `gamification_rings` spec (`feature: 'gamification'`, `tags: ['gamification']`, fetch `GET /api/gamification/rings`)
- [x] load it in `loadToday()` and pass into `aggregateToday(bootstrap, {...swrCaches, gamification_rings}, now)` — read the new key from IndexedDB in `_todayReadCaches` (both `readMeta` + `getCached` branches), track it in the oldest-timestamp `keyFeatures` map, and add it to the `loadToday` refetch `presence`/`missing` loop so a missing/invalidated rings cache re-fetches while Today is mounted
- [x] add a pure `gamificationRingsCell(rings, enabled)` to `features/today.js` returning `{value, deeplink: 'journey', status}` (`disabled` when off — also honours the payload's own `enabled:false` so a lagged flag still hides it; `missing` when no data) — reads the Plan 2 `rings` shape (`{ring, hp}` + `today_hp`); wired into `aggregateToday` as `gamificationRings`
- [x] render the rings tile in the Today view (`.wg-card` + reused `wg-journey-ring`/`wg-journey-bar` gloss-inset rows, tokens only; only dynamic value is `--fill-pct`); new `.wg-today-rings*` header classes; tapping deep-links to `journey`
- [x] lint clean (no ESLint in repo — architecture guards are the de-facto lint; full `pnpm test` green: 241 files / 2621 tests, incl. design-token + inline-style + globals + offline-coverage + sw-precache guards). Manual smoke (rings tile renders when enabled, omitted when disabled, deep-links to Journey) is this plan's manual-only deviation, batched into Task 5

### Task 4: Settings targets editor
- [x] add a `<section id="gamification-targets-settings" class="wg-card wg-settings-section wg-gam-targets hidden">` to `index.html` (mirror Food Targets `:535`): one Low/High `.wg-settings-number-field` pair per editable band with a per-metric head label + recommended hint. **Built against the frozen Plan 2 contract, not the plan's draft field list:** the backend only honors the 6 band metrics (`bp_systolic`, `bp_diastolic`, `resting_hr`, `stress`, `sleep_hours`, `steps`) — there is no calorie-target / weight-goal target in `gamification` (those live in Food Targets / weight-goal elsewhere). New `.wg-gam-target-metric{,__head,__hint}` classes in `styles.css`, tokens only
- [x] in `features/settings.js`, populate fields from `GET /api/gamification/targets` via `loadGamificationTargets()` (called best-effort at the end of `loadSettings`, mirroring `SettingsIntegrations.load`; gated on the flag) → `applyGamificationTargets(view)`: recommended bounds become placeholder + a "recommended …"/"custom · rec …" hint, custom overrides prefill the inputs
- [x] wire the Save button to `PUT /api/gamification/targets` via `DataStore.applyOptimistic('gamification', (prev)=>prev, ['gamification'])` → `commit(null)` on success + `invalidateTags(['gamification'])` (so the Journey re-scores), `rollback()` on failure (Rule #9 — the mutator is a no-op because a band change can't retro-repaint the Journey without a re-score; the value is the rollback + tag-refresh lifecycle). Client-side guard rejects negatives and `low > high` before the PUT. Only filled metrics are sent (blank pair keeps recommended). Bound in `app.js` (`save-gamification-targets-btn`)
- [x] gate the whole section on `features.gamification` (`updateGamificationTargetsVisibility()` toggles the `.hidden` class, called from `updateFeatureTabVisibility()` which runs in `applyBundle`)
- [x] lint clean + design-token / inline-style / globals guards green (full `pnpm test` green: 241 files / 2621 tests). Manual smoke (save reconciles; forced failure rolls back; recommended-vs-custom display) is this plan's manual-only deviation, batched into Task 5 (no ESLint in repo — architecture guards are the de-facto lint)

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
