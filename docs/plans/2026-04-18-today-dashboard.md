# Today Dashboard — "Home" Tab

## Overview

Add a `Today` tab as the new default landing surface. Instead of dumping the user into BP history, the app opens to a glanceable summary: today's date, next medication, latest BP reading + 7-day trend arrow, today's calorie progress, next workout, sleep last night. Everything is read-only on this view — taps deep-link to the relevant tab for action.

Problem: the current default lands the user in a list with a FAB. The app feels like a logbook, not a daily companion. Most opens (per the bot use-case: "did I take my pill?", "what's next?") are *queries*, not log-entry actions.

Benefit: turns the Mini App from a logbook into something worth opening unprompted. Reuses data already in the bootstrap payload — no new backend work in the MVP.

## Context (from discovery)

- `/api/bootstrap` returns: features map, current meds, intake history (3 days), next intake, next workout, timezone, settings bundle, change cursor (`internal/server/settings_handlers.go` `handleBootstrap`)
- App currently lands on "the first visible tab from `#tabs`, defaults to BP" (`features/bootstrap.js:88-95`)
- SWR cache (`data-store.js`) already holds last-known BP, weight, food data per-feature — the dashboard can read those without firing new requests
- Tab order is user-configurable via `tab_order` (drag-and-drop, persisted in `settings_bundle`) — the Today tab needs to participate
- Deep-link router exists: `features/deeplink-router.js` `window.handleDeepLinks`
- Health tab already has sub-tabs ("Overview" / "Notes") via `bindTabGroup()` / `activateTabGroup()` — same pattern reusable for any sub-segmentation later
- Domain services live in `internal/domain/` — any future aggregate endpoint goes there, not in the handler

## Development Approach

- **Testing approach**: Regular — UI-heavy
- **Phase 1 (this plan)**: client-side aggregation only. Read from existing SWR caches. Zero backend changes. Ship-able as-is.
- **Phase 2 (out of scope, file as a follow-up plan)**: a `/api/today` endpoint that pre-aggregates server-side for first-paint speed
- Today tab is **opt-in** for existing users (preserve their `tab_order`); default-on for new users

## Testing Strategy

- **Unit tests** (Vitest): aggregation function pure-tested with fixture bootstrap payloads
- **UI characterization**: snapshot of the Today view for representative states (all-data, empty, partial-data, offline)
- **Architecture tests**: Today must obey design-token + no-inline-style rules; the new `window.TodayDashboard` global needs an allowlist entry in `architecture.globals.test.js`

## Progress Tracking

- Mark `[x]` when done; ➕ for new tasks; ⚠️ for blockers; update plan if scope changes

## What Goes Where

- **Implementation Steps**: new view, aggregation module, tab registration, tests
- **Post-Completion**: opt-in announcement, Phase-2 backend follow-up

## Implementation Steps

### Task 1: Define the Today aggregation contract

- [x] create `web/static/js/features/today.js` with a pure function `aggregateToday(bootstrap, swrCaches, now)` returning `{ greeting, nextMed, bpLatest, bpTrend7d, weightLatest, weightTrend7d, caloriesToday, caloriesTarget, nextWorkout, sleepLastNight }`
- [x] each field is `{ value, deeplink, status: 'ok'|'missing'|'stale'|'overdue' }` so the renderer can show the right state without re-deriving
- [x] handle missing data gracefully (no entry today, feature disabled, offline-stale cache)
- [x] write Vitest cases for all-present, all-missing, partial, offline-stale, and feature-disabled scenarios using fixture payloads
- [x] run `pnpm test` — must pass before next task

### Task 2: Render the Today view

- [x] add `<div id="today-view" class="view active">` to `index.html` (move `active` off `meds-view`)
- [x] add `<button class="tab active" data-tab="today" aria-label="Today">` as the first tab (with a sun-shaped or calendar SVG icon, stroke-based to match siblings)
- [x] in `features/today.js`, implement `renderToday(state)` that builds the DOM using existing primitives (`stat-card.js`, `action-row.js`, `empty-state.js`)
- [x] each card is tappable → calls `handleDeepLinks` to switch tabs; no inline `style.` assignments — use CSS classes only
- [x] add CSS for `.today-greeting` (uses `var(--font-display)` if Plan 1 has shipped, otherwise body), `.today-card-grid` (CSS grid, 2-up on mobile, 3-up wider), `.today-trend-arrow` (stroke icon + token color)
- [x] write Vitest UI characterization snapshot covering all four state combinations from Task 1
- [x] run `pnpm test` — must pass before next task

### Task 3: Wire Today into the tab system

- [x] register Today in `app.js` tab switcher and in the `bindTabGroup` consumers if needed
- [x] update `features/bootstrap.js:88-95` so that for users whose `tab_order` does not yet include `today`, Today is prepended; for users who have explicitly removed it, respect that
- [x] update `tabs-dnd.js` to allow drag-reordering Today like any other tab
- [x] add `window.TodayDashboard` to `tests/architecture.globals.test.js` allowlist with justification
- [x] write Vitest case asserting Today is the default `data-tab` for a fresh user (empty `tab_order`)
- [x] write Vitest case asserting Today is preserved-removed for an explicit user opt-out
- [x] run `pnpm test` — must pass before next task

### Task 4: Live updates and SWR re-render

- [ ] subscribe Today to `BOOTSTRAP_UPDATED` `postMessage` from the SW (already emitted by SWR on `/api/bootstrap`)
- [ ] subscribe Today to the SWR cache change events for bp/weight/food (re-render when any underlying source freshens)
- [ ] subscribe Today to `online`/`offline` events; show offline banner state inside the dashboard if cached data is `>1h` old
- [ ] write Vitest case asserting render is called when BOOTSTRAP_UPDATED fires
- [ ] write Vitest case asserting offline-stale state is reached when cache age exceeds threshold
- [ ] run `pnpm test` — must pass before next task

### Task 5: Offline + empty-state polish

- [ ] when bootstrap cache is missing entirely (first run, offline), show a friendly empty Today with "Connect to load your day" rather than a broken layout
- [ ] when a feature is disabled in `features` map, omit its card entirely (don't show "calories: -" with no data)
- [ ] when `nextMed` is overdue, render with `--color-warning` border + "(overdue)" label
- [ ] write Vitest cases for first-run-offline, disabled-features, overdue-med states
- [ ] run `pnpm test` — must pass before next task

### Task 6: Verify acceptance criteria

- [ ] verify Today loads instantly on cold start (SW cache hit, no spinner)
- [ ] verify deep-link from Today card → correct destination tab
- [ ] verify all cards respect dark mode + token colors
- [ ] verify drag-reorder of Today works
- [ ] run full `pnpm test`, `go test ./...`, linter
- [ ] verify coverage for `features/today.js` ≥ 80%

### Task 7: Documentation

- [ ] update `docs/frontend.md` "Tabs and Navigation" with the Today tab pattern
- [ ] update `docs/features.md` with a Today section explaining the aggregation source and deep-link targets

## Technical Details

- Aggregation is pure, synchronous, side-effect free — pass `Date.now()` as third arg for testability
- "7-day trend" computed from SWR-cached series; if cache holds <2 points, status becomes `'missing'`
- No new endpoints in Phase 1 — backend untouched
- Phase-2 follow-up plan would add `GET /api/today` returning a server-side aggregate for cold-start speed; current plan is intentionally smaller-scope

## Post-Completion

**Manual verification**:
- Cold-start in iOS + Android Telegram, verify Today is first paint
- Toggle each feature off in settings, confirm Today omits the card
- Disconnect network, reload — confirm cached Today still renders

**External system updates**:
- Bot README / docs/features.md screenshot may need refresh
- Phase-2 backend aggregate endpoint — file as `2026-XX-XX-today-server-aggregate.md` if/when needed
