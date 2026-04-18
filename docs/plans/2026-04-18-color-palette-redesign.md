# Color Palette Redesign

## Overview

Replace the generic `#667eea → #764ba2` indigo/purple gradient palette with an intentional health-data system. Pick one of two directions — **deep-teal + warm-coral dual-tone** OR **monochromatic ink-on-cream with a single signal accent** — and apply it consistently to chart strokes, hero cards, status bars, and the active tab.

Problem: the current `--color-chart-primary` / `--color-chart-secondary` and the `--color-hero-pink-*` / `--color-hero-blue-*` gradients are visually generic and culturally unmoored from "health". Users see the same purple gradient on every Bootstrap-era app. There's no signature color.

Benefit: a recognizable palette that feels designed-for-context. Dominant colors with sharp accents (per the design-aesthetic guidelines) outperform timid evenly-distributed palettes.

## Context (from discovery)

- 94 design tokens in `:root` (`web/static/css/styles.css:40-208`), validated by `tests/architecture.design-tokens.test.js`
- Architecture test forbids hardcoded hex outside `:root` (allowlist: `#fff`, `#000`, `var()` fallbacks)
- Chart tokens: `--color-chart-primary: #667eea`, `--color-chart-secondary: #764ba2`, `--color-chart-accent: #4ECDC4`, `--color-chart-highlight: #ffd700`, `--color-chart-plan: #67e8f9`
- Hero tokens: `--color-hero-pink-start/end`, `--color-hero-blue-start/end`
- BP classification tokens are already meaningful (`#22c55e` optimal → `#dc2626` grade-3) and should stay — clinical convention
- Gradient sites: `linear-gradient` at `styles.css:1432, 1441, 1448, 1454, 1526-1540, 2786, 3357`
- Telegram theme variables (`--tg-theme-*`) drive base bg/text colors — the new palette must coexist with both light and dark Telegram themes

## Development Approach

- **Testing approach**: Regular — color choices need eyes-on review
- Touch tokens only — never the consumers. Every existing rule already references the token, so swapping a hex value in `:root` ripples everywhere.
- **Do NOT touch BP classification colors** (`--color-bp-*`) — those are clinically meaningful (red = hypertensive crisis)
- Keep the same token names; only change the values. This means no consumer churn and no architecture-test churn.

## Testing Strategy

- **Architecture tests**: ensure new hex values still come from `:root` only (existing test catches this)
- **Contrast tests** (new): add a Vitest case computing WCAG AA contrast for each `--color-chart-*` against both light and dark Telegram theme bg — fail if any drops below 3:1 for non-text or 4.5:1 for text
- No e2e tests — manual visual review required

## Progress Tracking

- Mark `[x]` when done; ➕ for new tasks; ⚠️ for blockers; update plan if scope changes

## What Goes Where

- **Implementation Steps**: token value swaps, contrast tests, dark-mode overrides
- **Post-Completion**: visual review across BP/weight/workouts/food, screenshots

## Implementation Steps

### Task 1: Pick the direction

- [ ] decide between **A: deep-teal + warm-coral dual-tone** (recommended — signals "health" without medicalising) OR **B: monochromatic ink-on-cream + single accent** (more editorial / journal-feel)
- [ ] document the choice and the full hex specification at the top of `web/static/css/styles.css` in the Design Token System comment block
- [ ] no test in this task — decision-only

### Task 2: Swap chart tokens

- [ ] update `--color-chart-primary`, `--color-chart-secondary`, `--color-chart-accent`, `--color-chart-highlight`, `--color-chart-plan` to the new palette in `styles.css:64-71`
- [ ] update the same tokens inside the `@media (prefers-color-scheme: dark) :root` override block to dark-mode-appropriate variants (lift L by 10-15 in OKLCH for visibility on dark bg)
- [ ] add Vitest case `architecture.color-contrast.test.js` parsing token values and asserting WCAG-AA against `--bg-color` light AND dark fallbacks
- [ ] run `pnpm test` — must pass before next task

### Task 3: Swap hero gradient tokens

- [ ] retire `--color-hero-pink-*` and `--color-hero-blue-*` OR repurpose them with new hex values from the chosen palette
- [ ] if retiring: scan `styles.css` for any `var(--color-hero-pink-*)` / `var(--color-hero-blue-*)` consumer and migrate to a new token name; update `architecture.design-tokens.test.js` REQUIRED_TOKENS array
- [ ] if repurposing: just swap the hex values and leave token names alone (preferred — less churn)
- [ ] run `pnpm test` — must pass before next task

### Task 4: Status bar + workout palette

- [ ] swap `--color-workout-*`, `--color-status-*-{bg-start,bg-end,text,border}` token values to the new palette family (offline = warm-coral, syncing = teal-accent, pending = neutral-warm)
- [ ] verify contrast in both Telegram themes
- [ ] update `architecture.color-contrast.test.js` to cover the status tokens
- [ ] run `pnpm test` — must pass before next task

### Task 5: Active-tab accent

- [ ] update `.tab.active` accent color (currently `var(--link-color)` which mirrors `--tg-theme-link-color: #2481cc`) to use a new dedicated `--color-accent` token, defaulting to the hero color
- [ ] add `--color-accent` to REQUIRED_TOKENS in `architecture.design-tokens.test.js`
- [ ] write a Vitest case asserting `.tab.active` references `var(--color-accent)`
- [ ] run `pnpm test` — must pass before next task

### Task 6: Verify acceptance criteria

- [ ] visually verify BP chart, weight chart, workout hero, food cards, status bars in light + dark Telegram themes
- [ ] verify BP classification colors are unchanged (clinical correctness)
- [ ] run full `pnpm test`, `go test ./...`, linters
- [ ] verify no orphan tokens remain

### Task 7: Documentation

- [ ] update the comment block at the top of `web/static/css/styles.css` listing the palette rationale (so future maintainers don't blindly swap it back to defaults)
- [ ] note the chosen palette in `docs/frontend.md` "Design Token System"

## Technical Details

- Recommended Direction A palette (concrete starting point):
  - `--color-chart-primary: #0d9488` (teal-600)
  - `--color-chart-secondary: #f97066` (warm coral)
  - `--color-chart-accent: #fcd34d` (warm amber, sparing)
  - `--color-chart-highlight: #134e4a` (deep teal for outline / focus)
  - `--color-chart-plan: #5eead4` (soft teal for planned/dashed states)
- Dark-mode lift example: `#0d9488` → `#2dd4bf` for visibility on dark bg
- Use OKLCH (`oklch(70% 0.15 180)`) for the contrast computation — perceptually uniform; CSS still ships hex for compatibility

## Post-Completion

**Manual verification**:
- Side-by-side before/after screenshots: BP tab, Weight tab, Workouts tab, Food tab, Settings, status bar states
- Verify in light + dark Telegram themes on iOS + Android
- Walk a non-technical reviewer through the change to confirm "feels different / feels designed"

**External system updates**:
- README + docs/features.md screenshots refresh
- pitch.html (marketing page) likely uses the same tokens — verify it still looks intentional
