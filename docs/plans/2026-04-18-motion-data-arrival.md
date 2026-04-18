# Motion on Data Arrival

## Overview

Add purposeful motion to the moments where data appears: chart line draw-in, stat-card stagger on tab activation, count-up animation on hero numerals, and a subtle pulse on the "next med" indicator when it transitions to overdue. These are CSS-only — no JS animation library, no framework. Respect `prefers-reduced-motion` everywhere.

Problem: today, charts and stat cards snap into place. The app reads as static. The data that just refreshed is indistinguishable from the data that's been on screen for an hour.

Benefit: makes refreshes feel responsive, draws the eye to the data the user came to see, signals "this is fresh". Low effort, high delight, no architectural risk.

## Context (from discovery)

- Existing animations: `chart-pulse` (2s infinite, opacity), `chart-draw` (0.6s stroke-dasharray), `modal-enter` (0.2s), `spin` (1s linear infinite) — all in `styles.css`
- `core/chart-utils.js` exposes `animateLine(path)` already (referenced at lines 342, 352, 366) — it sets a stroke-dashoffset transition
- Charts are hand-built SVG, no Chart.js — full control
- No motion library in `vendor/` (only `dexie.min.js`, `zxing.min.js`) — keep it that way
- `prefers-reduced-motion` is currently NOT respected anywhere in `styles.css` — this is a regression to fix as part of this plan
- Hero numerals live in `.weight-display-input`, BP `<text>`, workout hero card, food calorie totals
- "Next intake" indicator: `#next-intake-trigger` in `index.html:64`

## Development Approach

- **Testing approach**: Regular
- All motion is CSS — no JS scheduling, no `requestAnimationFrame`
- Wrap every new `@keyframes` consumer in `@media (prefers-reduced-motion: no-preference)` so reduced-motion users get instant transitions
- Stagger via `animation-delay: calc(var(--idx) * 60ms)` set inline on the element via a CSS custom property (allowed — it's a custom property, not a `style.color =` violation)

## Testing Strategy

- **Architecture tests**: extend `architecture.design-tokens.test.js` to assert all new `@keyframes` are paired with a `prefers-reduced-motion` guard
- **Unit tests**: count-up animator (the only JS piece) is pure-tested with synthetic timestamps
- **Architecture rule**: no new `.style.animation = …` JS assignments — everything via CSS classes

## Progress Tracking

- Mark `[x]` when done; ➕ for new tasks; ⚠️ for blockers; update plan if scope changes

## What Goes Where

- **Implementation Steps**: keyframes, stagger utility, count-up helper, reduced-motion guards, tests
- **Post-Completion**: device verification, especially low-end Android

## Implementation Steps

### Task 1: Reduced-motion baseline + architecture guard

- [ ] add a global `@media (prefers-reduced-motion: reduce)` block to `styles.css` that sets `animation-duration: 0.01ms !important; transition-duration: 0.01ms !important;` for `*, *::before, *::after`
- [ ] write a Vitest case in `architecture.motion.test.js` parsing `styles.css` and asserting:
  - every `@keyframes` rule has a name
  - the global reduced-motion block exists with the `*` selector and zero-duration overrides
- [ ] write a Vitest case asserting no JS file in `web/static/js/` contains `.style.animation` or `.style.transition` assignments (extend the existing inline-style architecture test if appropriate)
- [ ] run `pnpm test` — must pass before next task

### Task 2: Stat-card stagger on tab activation

- [ ] add `@keyframes card-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }` in `styles.css`
- [ ] add `.card-rise` class applying `animation: card-rise 0.4s var(--ease-out, ease-out) both; animation-delay: calc(var(--stagger-idx, 0) * 60ms);`
- [ ] in `app.js` tab activation handler, add a helper `applyStaggeredEntry(container)` that walks `.stat-card, .empty-state, .action-row` children and assigns `style.setProperty('--stagger-idx', i)` + adds `.card-rise` class (custom-property assignment is allowed by the architecture rule; only `.style.color`-style assignments are banned)
- [ ] call the helper from each tab's first-render path (BP, Weight, Workouts, Food, Health, Meds, Today if Plan 2 has shipped)
- [ ] write Vitest case for `applyStaggeredEntry` asserting children get the correct `--stagger-idx` and `card-rise` class
- [ ] run `pnpm test` — must pass before next task

### Task 3: Count-up on hero numerals

- [ ] add `web/static/js/core/count-up.js` exporting `countUp(el, fromValue, toValue, durationMs, formatter)` — uses `requestAnimationFrame` with eased interpolation (cubic-bezier-equivalent), respects `window.matchMedia('(prefers-reduced-motion: reduce)').matches` (sets final value instantly)
- [ ] expose as `window.CountUp`; add to `tests/architecture.globals.test.js` allowlist with justification
- [ ] use `countUp` in `features/weight.js` for `.weight-display-input` (when value freshens, count from previous to new), in `features/bp.js` for the BP chart numeric labels, in `workout.js` for hero card stats, in `features/food.js` for calorie totals
- [ ] write Vitest cases for `countUp`: basic ramp, instant-completion under reduced-motion, formatter applied, abort on re-call
- [ ] run `pnpm test` — must pass before next task

### Task 4: Chart line draw + last-point pulse

- [ ] verify `chart-utils.js` `animateLine` and CSS `chart-draw` already work; add `prefers-reduced-motion` guard around `chart-draw` so reduced-motion users see the line instantly
- [ ] add `chart-last-point-pulse` keyframe (subtle 1.0 → 1.4 → 1.0 scale on the last data circle, 2s, ease-in-out, infinite) — applied only to `.chart-last-point.is-fresh` (added when render is from a network freshening, removed after 6s)
- [ ] in `features/bp.js` and `features/weight.js`, when SWR `onFresh` fires, add `.is-fresh` to the last-point element; remove after 6s via `setTimeout`
- [ ] write Vitest case for the freshness-class lifecycle (added on fresh, removed after timeout)
- [ ] run `pnpm test` — must pass before next task

### Task 5: Overdue-med pulse

- [ ] add `@keyframes overdue-pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--color-warning); } 50% { box-shadow: 0 0 0 6px transparent; } }`
- [ ] add `.med-overdue` class applying the pulse; toggled in the next-intake renderer in `app.js` when the time is past due
- [ ] respect reduced-motion (the global rule from Task 1 covers it)
- [ ] write Vitest case asserting `.med-overdue` is added when `nextIntakeAt < now` and removed otherwise
- [ ] run `pnpm test` — must pass before next task

### Task 6: Verify acceptance criteria

- [ ] verify on a Pixel 4a or similar low-end Android — animations stay above 30 FPS (DevTools performance tab)
- [ ] verify reduced-motion (Settings → Accessibility → Reduce Motion on iOS, or Chrome flag) — all animations collapse to instant
- [ ] verify offline mode still renders cached data without animation glitches
- [ ] run full `pnpm test`, `go test ./...`, linters

### Task 7: Documentation

- [ ] update `docs/frontend.md` adding a "Motion" section listing the keyframes catalogue, the reduced-motion baseline, and the count-up helper
- [ ] CLAUDE.md design rule: motion goes through `@keyframes` + CSS classes, never `.style.animation` JS assignment

## Technical Details

- 60ms stagger × max 8 cards = 480ms total — under the 500ms perceptual threshold
- Count-up duration: 600ms cap; on values that change by <5%, skip animation (snap)
- `requestAnimationFrame` deltas — accumulate elapsed ms manually rather than counting frames (frame rate is variable)
- `box-shadow` pulses are GPU-cheap; avoid animating `width`/`height`/`top`/`left` (layout-triggering)

## Post-Completion

**Manual verification**:
- Pixel 4a or similar low-end Android — chart draws + stat-card stagger remain smooth
- iOS reduced-motion accessibility setting — confirm everything snaps instantly
- Verify no animation triggers when the same value re-renders (no thrash on repeated SWR-fresh callbacks)

**External system updates**: none
