# Typography + Identity Pass

## Overview

Replace the generic system-font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, …`) with an intentional pairing that gives the app visual identity. Health metrics (BP, weight, calories, workout stats) are the hero content — they get an oversized, tabular-figures treatment with a distinctive display face. Body and UI labels get a quiet, well-hinted sans for readability inside the Telegram WebApp viewport.

Problem: today the UI looks indistinguishable from any other Bootstrap-era web app. Numerals — the data the user actually came to see — are rendered in the same weight as button labels.

Benefit: instantly recognizable identity, a clear visual hierarchy where the numbers dominate, and zero impact on offline-first architecture (fonts are a static asset).

## Context (from discovery)

- Font stack defined in `web/static/index.html:25-27` (inline fallback) and `web/static/css/styles.css` `body` rule (lines ~210)
- Heading sizes: `h1` 24px / `h2` 18px / `h3` 15px, all `--font-weight-bold` (`styles.css:210-242`)
- Big numerals already exist:
  - `.weight-display-input` 48px/700 (`styles.css:1288`)
  - BP chart values as SVG `<text>` (`features/bp.js:417-430`)
  - Workout hero card numerals (`workout.js:1945-1971`)
  - Food calorie totals (`features/food.js`)
- Design tokens already include `--font-size-{xs|sm|md|lg|xl}` and `--font-weight-{normal|medium|bold}` (validated by `tests/architecture.design-tokens.test.js`)
- Service Worker precaches all static assets — fonts must be added to `STATIC_ASSETS` in `sw.js` and to `architecture.sw-precache.test.js` allowlist

## Development Approach

- **Testing approach**: Regular (code first, then tests) — visual changes are hard to TDD
- Self-host fonts under `web/static/fonts/` (do NOT load from Google Fonts — breaks offline + adds tracking)
- Use `font-display: swap` so the system fallback paints instantly, the custom face replaces on load
- Add new tokens (`--font-display`, `--font-body`, `--font-numeric`) before touching consumers, so the architecture test stays green throughout

## Testing Strategy

- **Unit / architecture tests** (Vitest): extend `architecture.design-tokens.test.js` to require the three new font tokens; extend `architecture.sw-precache.test.js` to require font files in the precache list
- No e2e tests in this project today — manual visual verification on iOS Telegram and Android Telegram (the two real targets) is required and listed in Post-Completion

## Progress Tracking

- Mark `[x]` when done
- ➕ for newly discovered tasks
- ⚠️ for blockers
- Update plan if scope changes

## What Goes Where

- **Implementation Steps**: token additions, @font-face rules, SW precache list, consuming rules in styles.css
- **Post-Completion**: device testing, screenshots for review

## Implementation Steps

### Task 1: Pick and self-host the type pairing

- [ ] decide pairing — recommended: **Fraunces** (display, supports optical sizes + tabular figures) + **Inter** (body) OR **Instrument Serif** (display) + **Geist** (body). Document the choice at the top of `web/static/css/styles.css` in a comment block
- [ ] download the WOFF2 subsets (Latin only, regular + bold + medium for body, regular + 600 for display) into `web/static/fonts/`
- [ ] add `@font-face` rules at the top of `web/static/css/styles.css` with `font-display: swap`
- [ ] write Vitest case in `architecture.fonts.test.js` asserting `web/static/fonts/` contains the expected `.woff2` files and that `styles.css` declares one `@font-face` per file
- [ ] run `pnpm test` — must pass before next task

### Task 2: Add font tokens and rewire consumers

- [ ] add `--font-display`, `--font-body`, `--font-numeric` (with `font-feature-settings: "tnum" 1, "lnum" 1`) to `:root` in `styles.css`
- [ ] update `body { font-family: var(--font-body) }` in `styles.css` and remove the inline fallback in `index.html`
- [ ] apply `font-family: var(--font-display)` to `h1, h2, h3` and `font-feature-settings: "ss01" 1` if the chosen face supports stylistic alternates
- [ ] extend `architecture.design-tokens.test.js` REQUIRED_TOKENS array with the three new font tokens
- [ ] write a Vitest case asserting `body` rule references `var(--font-body)` (not a literal stack)
- [ ] run `pnpm test` — must pass before next task

### Task 3: Promote numerals to hero treatment

- [ ] add `.numeric-hero` utility class in `styles.css` — `font-family: var(--font-numeric); font-variant-numeric: tabular-nums lining-nums; font-size: clamp(2rem, 8vw, 3.5rem); font-weight: 600; letter-spacing: -0.02em; line-height: 1;`
- [ ] add `.numeric-unit` companion class for the trailing unit ("mmHg", "kg", "kcal") at ~40% size, lower weight, hint color
- [ ] apply `.numeric-hero` to `.weight-display-input` (replaces hard-coded 48px)
- [ ] apply `.numeric-hero` to BP chart `<text>` elements in `features/bp.js:417-430` (set `font-family` attribute or wrap render call)
- [ ] apply `.numeric-hero` to workout hero card stats in `workout.js:1945-1971`
- [ ] apply `.numeric-hero` to food daily total in `features/food.js`
- [ ] write Vitest UI characterization snapshot covering each of the four touchpoints (BP, weight, food, workout)
- [ ] run `pnpm test` — must pass before next task

### Task 4: Add fonts to the offline shell

- [ ] add the WOFF2 paths to `STATIC_ASSETS` in `web/static/sw.js`
- [ ] update `tests/architecture.sw-precache.test.js` allowlist
- [ ] bump SW cache version (forces precache refresh on existing installs)
- [ ] write Vitest case asserting the font paths are members of `STATIC_ASSETS`
- [ ] run `pnpm test` — must pass before next task

### Task 5: Verify acceptance criteria

- [ ] verify fonts load offline (DevTools → Network → Offline → reload — no FOIT for >500ms)
- [ ] verify numerals are tabular (typing different digits doesn't shift width — visible in weight modal)
- [ ] verify Telegram theme dark mode still legible
- [ ] run full `pnpm test` and `go test ./...`
- [ ] run linters

### Task 6: Documentation

- [ ] update `docs/frontend.md` "Design Token System" section with the new font tokens
- [ ] add a one-liner to CLAUDE.md design-token rule referencing `var(--font-*)` for any new typographic surface

## Technical Details

- Font files target ~40-60KB each at WOFF2; total budget ~200KB precached
- `font-feature-settings: "tnum" 1` is per-rule, not inherited — apply on the `.numeric-hero` class itself
- Telegram theme variables (`--tg-theme-text-color`) continue to drive color; this plan only touches family/weight/feature-settings

## Post-Completion

**Manual verification**:
- Open in iOS Telegram and Android Telegram clients — confirm font loads, no flash of invisible text, numerals are tabular
- Take before/after screenshots of: BP tab landing, Weight modal, Workouts hero card, Food daily total
- Verify in light + dark Telegram themes

**External system updates**: none
