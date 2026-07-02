# Gamification 7 — Concentric Rings (one big glanceable day view)

## Overview

Phase B of the gamification redesign (depends on Phase A,
`2026-07-02-gamification-6-sync-honesty.md`). Today the five rings render as five
separate 36px arcs stacked in a list — a table with icons, not a picture of the day.
The proven power of Apple's Activity Rings is the **single large concentric object**:
gestalt closure (a nearly-full arc begs to be finished), sub-second glanceability with
zero reading, one visual answering "how is my day".

This plan replaces the ring *list* with one large concentric ring stack (~180px) on
the Today tile and the Journey screen: outer→inner arcs in canonical ring order, a
legend beside it carrying the labels / goals / checks / sync-pending states from
Phase A. Scoring, API, and data flow are untouched — this is purely a presentation
change over the existing `RingScore.{Progress,Closed,Goal,SyncPending}` fields.

## Context (from discovery)

- Existing arc component: `web/static/js/components/wg-ring.js` (`window.WGRing`) —
  fixed `viewBox 0 0 36 36`, radius `15.9155` (circumference ≈ 100 so dash math is a
  percentage), JS sets only `--ring-progress`, CSS owns dash offset/color; `closed`
  forces full ring + check path. Covered by `tests/wg-ring.test.js` (the documented
  web-component exception to integration-first testing, CLAUDE.md rule 8).
- Consumers: Today rings tile `web/static/js/features/today.js` (`renderRingsTile`
  ~1039-1202: header, "your move", five `wg-journey-ring` rows, "View Journey →");
  Journey rings card `web/static/js/features/journey.js` (~160-235).
- Canonical ring order: adherence, movement, vitals, nourishment, mind
  (`internal/domain/gamification/scoring/scoring.go:33-39`, mirrored in
  `today.js:1007-1011`, `journey.js:28-34`).
- Guards that will trip: `tests/architecture.globals.test.js` (new `window.*` global
  needs an allowlist entry), design-token test (no hardcoded colors), SW precache
  list (new JS file), `web/static/index.html` script-tag load order.
- Phase A adds `sync_pending` to the ring view model; the legend must render it.

## Development Approach

- **Testing approach**: NO unit tests, except the one geometry test allowed by the
  web-component exception (same posture as `tests/wg-ring.test.js` in plan 5).
- Presentation-only: no backend, API, or scoring changes.
- All colors/sizes via `--wg-*` tokens; per-ring accent colors become tokens if they
  don't already exist.
- Keep `wg-ring` (single arc) — Journey/other surfaces may still use it; the stack is
  a sibling component, not a rewrite.
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: none, except `tests/wg-ring-stack.test.js` (arc geometry / radius
  spacing / closed-forces-full-arc — the web-component exception).
- **Integration tests**: none — the feature suites already exercising the Today tile
  and Journey render paths cover the swap; extend their existing `describe` blocks
  only if a render assertion breaks, do not add new suites (CLAUDE.md rule 8).
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: component + two consumer rewires + guards + docs.
- **Post-Completion**: visual QA on phone-sized viewport and Android emulator.

## Implementation Steps

### Task 1: `wg-ring-stack` web component

- [x] create `web/static/js/components/wg-ring-stack.js`: one SVG rendering up to 5
      concentric arcs, outer→inner in the order given; per-arc inputs
      `progress` (0..1), `closed`, `sync-pending`, color token name; reuse the
      wg-ring dash math (radius per ring computed so stroke widths + gaps fill a
      fixed viewBox; default rendered size ≈ 180px via CSS token)
- [x] closed arc renders full + slightly brighter (token variant); sync-pending arc
      renders dimmed track only (no accusatory empty progress arc); open arc renders
      its real `progress`
- [x] center of the stack shows "N/5" closed count (or a check glyph when all
      actionable rings are closed) — text via slot/attr so consumers control copy
- [x] JS sets only CSS custom properties (`--ring-N-progress` etc.); CSS owns dash
      offsets and colors (same contract as `wg-ring`)
- [x] add per-ring accent color tokens to the Wandergeek token sheet if absent
      (one token per ring, reused by the legend)
- [x] register the element, add script tag to `web/static/index.html` in component
      load order, add the file to the SW precache list, add the new global to
      `tests/architecture.globals.test.js` allowlist with justification
- [x] `tests/wg-ring-stack.test.js`: geometry math (radii don't overlap for 5 rings,
      progress→dash-offset mapping, closed forces full arc, sync-pending renders no
      progress arc)

### Task 2: Today tile rewire

- [x] `today.js` `renderRingsTile`: replace the five-row ring list with
      `wg-ring-stack` (left) + a compact legend (right): per ring — icon, label,
      check when closed, goal sub-line, "syncs later" sub-line when `sync_pending`
- [x] keep the Phase-A headline ("N of 5 rings closed · M waiting for sync"), the
      "your move" prompt, and the "View Journey →" affordance exactly as they are
- [x] tile stays tappable → Journey deeplink; legend rows keep their per-section
      logging deeplinks from the "your move" wiring

### Task 3: Journey rings card rewire

- [x] `journey.js`: replace the rings list with the same `wg-ring-stack` + legend
      composition (larger size token acceptable here)
- [x] keep the "Close each ring daily" why-line and per-ring goal strings

### Task 4: Verify acceptance criteria

- [ ] verify Overview requirements: one large concentric stack on Today + Journey,
      legend carries goals/checks/sync states, no scoring/API changes
- [ ] `pnpm test` passes (architecture guards: globals allowlist, design tokens,
      SW precache; existing today/journey feature suites)
- [ ] `go test ./...` still passes (should be untouched)
- [ ] frontend lint clean

### Task 5: Update documentation

- [ ] `docs/frontend.md`: note `wg-ring-stack` alongside `wg-ring` in the components
      inventory
- [ ] `docs/gamification.md` §14.3: rings presentation updated (concentric stack)

## Technical Details

- ViewBox math: with 5 rings, stroke width `w` and gap `g` must satisfy
  `5(w+g) ≤ R_outer − R_hole`; compute radii top-down from the outer radius; each
  ring keeps the "circumference = 100 units" trick locally (per-ring `pathLength`
  attribute is the lazy way to keep dash math a percentage regardless of radius —
  prefer it over per-radius circumference constants).
- Order outer→inner = canonical scoring order (adherence outermost), matching the
  legend top-to-bottom.
- No overfill support: `Progress` is range-membership `r ∈ [0,1]` by construction,
  so >100% cannot occur; clamp defensively.

## Post-Completion

**Manual verification:**
- Phone-width browser + Android emulator: stack legible at 180px, arcs
  distinguishable for adjacent rings, dimmed sync-pending state reads as "waiting",
  not "failed"; dark/light token themes both checked.
