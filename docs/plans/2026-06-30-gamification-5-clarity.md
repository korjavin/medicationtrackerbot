# Gamification Plan 5 — Clarity (honest rings, concrete goals, truthful ladder)

## Overview

The gamification MVP (Plans 1–4) shipped a working scoring engine and three
surfaces, but the **user-facing model is confusing and in places dishonest**. A
real user reported, verbatim:

- "they are not rings but bars" — the metaphor is "close the ring," drawn as flat bars.
- "some say *closed for today* but not full, like no chance" — closing a ring does **not** fill its bar.
- "nourishment — should I eat more? less? all not clear" — the calorie *range* is never shown.
- "insights ladder says *unlocked* but what unlocked, where to see?" — tiers 2–4 advertise analytics that don't exist yet.

Root cause of the central complaint: **the bar fill is a relative scoreboard**
(`hp ÷ highest-scoring-ring-today`), while **"closed" is an independent binary
flag** (any non-floor award). So a ring can be closed (success) yet show a short,
un-fillable bar. The fill never represents progress toward closing.

This plan makes the daily loop **clear and truthful** with the smallest diff that
holds:

1. **Honest fill** — closed = full; open rings show real progress toward closing.
2. **Concrete goals** — each ring states what closes it, with the user's actual numbers ("Eat near 1,800–2,200 kcal", "Sleep 7–9h").
3. **Truthful insight ladder** — tier 1 (built) links to what it shows; tiers 2–4 read "Unlocks at Lvl N · soon" instead of a false "Unlocked".
4. **Discoverable Journey** — an obvious "View Journey →" entry plus a short one-card "How this works" explainer (the never-built first-run explainer, minimal).
5. **Real rings** — replace the bars with an SVG arc that visibly closes; this also makes the existing "Rings" copy *correct* (no rename needed).

**Decisions already made with the user:** real closing rings (not rename); honest
ladder labels (keep the ladder, mark Phase-2 tiers "soon", don't hide them).

## Context (from discovery)

**Backend (`internal/domain/gamification/`, `internal/store/gamification/`)**
- `store/gamification/repo.go:87` — `RingScore{Ring, HP, Closed}` (the per-ring read aggregate). **Gets two new fields: `Progress float64`, `Goal string`.**
- `domain/gamification/summary.go:118` — `ringScores()` builds `[]RingScore` from the ledger; `closed` derived from non-floor awards (`summary.go:126`). **Where Progress + Goal get populated.**
- `domain/gamification/scoreday.go:53` — `ScoreDay` runs the pure scorers (which already compute each ring's range-membership `r`); the read paths re-score today/yesterday (Plan 4, §14.4). **Source of real per-ring progress.**
- `domain/gamification/journey.go`, `service.go` — journey read model + service (`s.cfg` effective bands, food targets via the food store) used to build Goal strings.
- `server/gamification_handlers.go:71` — `ringsView` (slim Today payload) and the summary/journey handlers; pass the new fields through verbatim (snake_case JSON, Critical Rule #1).
- `scoring/scoring.go` — `RangeMembership` (trapezoid `r ∈ [0,1]`), `ScoreNourishment:484`, bands; pure, unchanged.

**Frontend (`web/static/js/`)**
- `features/today.js` — `renderRingsTile()` (1042–1179), `ringFillTrack()` (1026–1038, the relative-fill bar), `RING_TILE_META` (1000–1006). The "N of 5 rings closed" headline (1067) + "your move" picker (1095) stay.
- `features/journey.js` — `renderRings()` (127–190), `progressBar()` (66–75), `RINGS` meta (28–34), `LADDER` (42–47), `renderLadder()` (223–254). Per-ring "Closed for today" sub-line (178–180).
- `web/static/index.html` — `#journey-view` (408–414); the Journey targets editor (577–700, BP/HR/stress/sleep/steps only).
- `css/styles.css:5185–5289` — `.wg-journey-bar__*` bar styles (header comment literally says "horizontal gloss-inset bars").
- `components/wg-bottom-nav.js:30–40` — comment documenting why Journey is not a nav slot (stays true; we add an in-tile entry, not a nav slot — CLAUDE.md rule 6).
- `components/` — home for the new `wg-ring` web component.

**Patterns to follow**
- Domain service is the single code path (Critical Rule #1); handlers pass JSON through.
- Frontend visuals via `--wg-*` tokens only (Critical Rule #3); no inline `.style.` except the existing CSS-var set pattern (`fill.style.setProperty('--fill-pct', …)` → becomes `--ring-progress`).
- New web component: register in load order, SW precache list, and `tests/architecture.globals.test.js` allowlist if it exposes a `window.*` global.
- Web components are the documented exception to integration-first testing (CLAUDE.md rule 8) → one pure-unit test for the ring's arc math.

## Development Approach

- **Testing approach**: NO unit tests except the one documented exception — the new `wg-ring` web component (arc-geometry math) gets a small pure-unit test, matching the existing component-test posture. No backend unit tests: the `RingScore` JSON contract is internal (both producer and consumer change together in this plan), and the gamification series (Plans 2–3) deliberately authored none; verification is build + lint + existing suite + manual smoke.
- Complete each task fully before the next; small focused changes.
- Maintain backward compatibility: new JSON fields are additive; old clients ignore them.
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: only `tests/wg-ring.test.js` (component arc math). Nothing else.
- **Integration tests**: none added — no new real boundary that manual smoke + the existing suite don't already guarantee. The existing `go test ./...` and `pnpm test` must stay green.
- **E2E tests**: none (project has no e2e suite for these screens).

## Progress Tracking

- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.
- Keep this file in sync with actual work.

## What Goes Where

- **Implementation Steps** (checkboxes): code + the one component test, all automatable by the agent.
- **Post-Completion** (no checkboxes): manual browser/emulator smoke of the four confusions, doc cross-check.

## Implementation Steps

### Task 1: Backend — honest per-ring `Progress` (idea #1)
- [x] add `Progress float64 \`json:"progress"\`` to `RingScore` in `internal/store/gamification/repo.go:87` (0..1; 1.0 = closed/full)
- [x] in `internal/domain/gamification/`, add a service helper that returns the day's **per-ring max range-membership `r`** for a user-day, reusing the same loaders + pure scorers `ScoreDay` already runs (no new persistence, no schema change — the scorers compute `r` today and throw it away)
- [x] populate `RingScore.Progress` in `summary.go` `ringScores()` for **today's rings**: `Closed → 1.0`; open ring → its real membership `r` from the helper; no data → `0` (period/`PeriodRings` keep `Progress` 0 — the gauge is a daily-loop affordance, not a weekly one)
- [x] ensure `ringsView` (`server/gamification_handlers.go:71`), the summary, journey, and `/api/bootstrap` payloads all carry `progress` (verify by reading the structs — most flow through `RingScore` automatically)

*Ponytail note: progress is computed on-read alongside the existing Plan-4 re-score; on single-user SQLite the extra pure-compute is negligible. If read latency ever matters, have `ScoreDay` return the membership map instead of recomputing — same numbers, one pass.*

### Task 2: Backend — concrete per-ring `Goal` label (idea #2, fixes nourishment)
- [x] add `Goal string \`json:"goal"\`` to `RingScore` (`repo.go:87`)
- [x] build the goal text in the domain service from the user's **effective bands** (`s.cfg` + overrides) and **food targets** (food store), one short imperative string per ring:
  - adherence → `"Take all doses on time"`
  - movement → from the steps band, e.g. `"Move toward ~8,000 steps"`
  - vitals → from the BP band, e.g. `"Keep BP in range · <130/80"`
  - nourishment → from the calorie target ± tolerance, e.g. `"Eat near target · 1,800–2,200 kcal"` (this is the line that answers "more or less?")
  - mind → from the sleep band, e.g. `"Sleep 7–9h"`
- [x] populate `Goal` in `ringScores()` (pass the effective config + food targets in); keep strings token-free plain text (frontend renders them as the ring subtitle)

### Task 3: Frontend — `wg-ring` SVG arc component (idea #5)
- [x] create `web/static/js/components/wg-ring.js`: a web component rendering an SVG circle whose stroke-dasharray draws an arc from `progress` (0..1); inputs `progress`, `closed`, `label`, `value`; full circle + check affordance when `closed`/`progress>=1`; colors/stroke via `--wg-*` tokens only
- [x] register it in the frontend load order and the Service Worker precache list; add to `tests/architecture.globals.test.js` allowlist **only if** it exposes a `window.*` global (prefer a pure custom element with no global)
- [x] `tests/wg-ring.test.js` (the documented component-test exception): assert the arc geometry — `progress=0` → empty arc, `progress=1`/`closed` → full circle + done state, a mid value → proportional dash offset

### Task 4: Frontend — Today rings tile: real rings + goals + clear Journey entry (ideas #1, #2, #4)
- [x] in `features/today.js` `renderRingsTile()` (1042–1179), replace each `ringFillTrack()` bar (1026–1038, 1169) with a `wg-ring` fed by the ring's `progress` + `closed`
- [x] render the per-ring `goal` string as the ring's subtitle (replaces the generic verb)
- [x] keep the "N of 5 rings closed" headline (1067), the per-ring check on closed, the "your move" first-open-ring prompt (1095) and its logging deep-link with `stopPropagation` (1100)
- [x] add an explicit **"View Journey →"** affordance on the tile (chevron/link) so the card's navigation is discoverable, distinct from the "your move" logging deep-link
- [x] retire the now-unused `ringFillTrack` if no other caller remains (grep first)

### Task 5: Frontend — Journey screen: rings + goals + honest ladder + explainer (ideas #1, #2, #3, #4)
- [x] in `features/journey.js` `renderRings()` (127–190), swap `progressBar()` (66–75) for `wg-ring` using `progress` + `closed`; show `goal` as each ring's sub-line; closed ring → full ring + "Closed for today" note (keep 178–180), open ring → partial arc + its goal (never a misleading short bar)
- [x] rework `renderLadder()` (223–254) + `LADDER` (42–47) per the **honest-labels** decision: tier 1 (built) shows `"Unlocked → view"` and navigates to the rings/streak it describes; tiers 2–4 show `"Unlocks at Lvl N · soon"` instead of `"Unlocked"` — `"Unlocked"` only ever appears where there is a real destination
- [x] add a short **"How this works"** intro card to `#journey-view` (collapsible or a one-card blurb) covering, in plain language: HP, what a ring is, what *closing* a ring means, levels, and that the insight ladder unlocks deeper personal analytics (some coming soon) — the minimal first-run explainer the design (§14, principle #7) called for but never shipped
- [x] retire the now-unused `progressBar()` if no other caller remains (grep first) — still used by `renderHeader()`'s level-to-next-level bar (a different concept than the closing rings), so it stays

### Task 6: Verify acceptance criteria
- [ ] each of the user's four confusions is resolved on-screen: rings are rings; a closed ring is a *full* ring; every ring shows a concrete goal incl. the nourishment calorie range; the ladder no longer says "Unlocked" for anything without a destination
- [ ] `go test ./...` passes
- [ ] `pnpm test` passes (incl. the new `wg-ring` test and the architecture guards: globals allowlist, design tokens, SW precache)
- [ ] frontend + Go linters clean

### Task 7: [Final] Update documentation
- [ ] update `docs/gamification.md` §14.3 (Frontend surfaces) to describe: SVG rings, `RingScore.Progress`/`Goal`, the honest ladder labels, and the Journey "How this works" card — replacing the "horizontal bars" / relative-fill description
- [ ] update any stale "bars" wording in `css/styles.css` header comments (5185–5289) and `wg-bottom-nav.js` if needed

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`.*

## Technical Details

**`RingScore` (new shape)** — additive, snake_case JSON:
```go
type RingScore struct {
    Ring     string  `json:"ring"`
    HP       int     `json:"hp"`
    Closed   bool    `json:"closed"`
    Progress float64 `json:"progress"` // 0..1; 1.0 == closed/full. Today's rings only.
    Goal     string  `json:"goal"`     // "Sleep 7–9h", "Eat near 1,800–2,200 kcal", …
}
```

**Progress semantics** (the fix for "closed but not full"):
- `Closed` ⇒ `Progress = 1.0` (full ring). The two can no longer disagree.
- Open ring ⇒ `Progress = r`, the day's best range-membership from the pure scorer (real "how close to closing").
- No data ⇒ `Progress = 0` (empty ring).
- `PeriodRings` leave `Progress = 0`; the arc gauge is rendered only for *today's* rings.

**Goal strings** are built server-side from the user's *effective* bands + food
targets so there is one source of truth and the frontend stays dumb. Plain text,
no tokens, ≤ ~30 chars.

**Frontend fill swap**: `hp ÷ max_today` (relative scoreboard, the bug) is gone;
the ring arc is driven by `progress`. CSS var renamed `--fill-pct` → `--ring-progress`.

## Post-Completion

**Manual verification** (browser + Android emulator smoke — the project convention
for the gamification series, which ships no automated UI tests):
- Open Today with a partially-completed day: confirm closed rings render as *full* rings with a check, open rings as partial arcs, each with its goal text.
- Confirm the nourishment ring shows the calorie range and that under- *and* over-eating both read as "not closed" (no "eat less = better").
- Tap "View Journey →": confirm it opens the Journey; confirm "your move" still deep-links to the logging section, not the Journey.
- On Journey: confirm the ladder shows tier 1 "Unlocked → view" (navigates) and tiers 2–4 "Unlocks at Lvl N · soon"; confirm the "How this works" card explains HP/rings/closing/levels/insights.

**Doc cross-check**: re-read `docs/gamification.md` §8 (insight ladder) and §14.3
after the change to ensure the doc matches the now-honest UI.
