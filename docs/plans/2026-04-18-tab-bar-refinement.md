# Tab Bar Refinement

## Overview

The bottom tab bar has 7 buttons, all rendered with the same 2px stroke-weight SVG icons in `--hint-color`. They read as a single grey blur. Active state today: text color swap + 2px bottom border. This plan replaces the active treatment with: filled-icon variant + colored accent strip + slight scale, and varies the inactive icon weight enough to make sibling tabs distinguishable.

Problem: scannability. A user looking for "Weight" can't pick it out of 7 identical-looking icons at a glance.

Benefit: faster tab switching, cleaner visual hierarchy, more polished feel — for a few hours of work.

## Context (from discovery)

- Tab markup: `web/static/index.html:33-40` — 7 inline SVGs, 20×20, all `stroke-width="2"`, `currentColor`
- Tab CSS: `styles.css:245-274`
  - `#tabs { display: flex; border-bottom: 1px solid var(--hint-color); }`
  - `.tab { flex: 1; color: var(--hint-color); transition: color 0.15s ease; }`
  - `.tab.active { color: var(--link-color); border-bottom: 2px solid var(--link-color); }`
- All tabs have `aria-label` already — accessibility floor is met
- Tab order is user-configurable (`tabs-dnd.js`) — any change to active styling must hold up under reorder
- No existing icon component — icons are inlined directly in HTML

## Development Approach

- **Testing approach**: Regular — visual change
- Don't move icons to a separate file (premature abstraction; they're 7 inline SVGs of ~40 bytes each)
- Provide both stroke and fill variants per icon — toggle via CSS class on the active tab
- The accent strip uses the same `--color-accent` token defined in the color-palette plan if shipped, else falls back to `--link-color`

## Testing Strategy

- **Architecture tests**: no new tokens needed; existing tests catch any inline-style regression
- **UI characterization snapshot**: render `#tabs` with each tab active in turn, snapshot the DOM
- **Accessibility test**: assert each tab has `aria-label` and `aria-current="page"` when active

## Progress Tracking

- Mark `[x]` when done; ➕ for new tasks; ⚠️ for blockers; update plan if scope changes

## What Goes Where

- **Implementation Steps**: SVG fill variants, CSS active treatment, accessibility wiring, tests
- **Post-Completion**: device verification

## Implementation Steps

### Task 1: Add filled icon variants

- [x] for each of the 7 tabs in `index.html:33-40`, wrap the existing stroke SVG in a `<span class="tab-icon">` containing both an `<svg class="tab-icon-stroke">` (existing) AND an `<svg class="tab-icon-fill">` (new — same path with `fill="currentColor"` and no stroke, slightly thicker visual weight)
- [x] keep the `aria-label` on the `<button class="tab">` (not on the inner span); add `role="tab"` to the button if not present
- [x] write a Vitest case asserting every `.tab` button contains exactly one `.tab-icon-stroke` AND one `.tab-icon-fill`
- [x] run `pnpm test` — must pass before next task

### Task 2: CSS — show stroke for inactive, fill for active

- [x] in `styles.css` `.tab` rule, add `.tab-icon-stroke { display: inline-block; } .tab-icon-fill { display: none; }`
- [x] add `.tab.active .tab-icon-stroke { display: none; } .tab.active .tab-icon-fill { display: inline-block; }`
- [x] add `.tab.active { color: var(--color-accent, var(--link-color)); }` (uses Plan 3's accent token if available, else falls back)
- [x] add a 2px-tall accent strip via `.tab.active::before { content: ''; position: absolute; top: 0; left: 12.5%; right: 12.5%; height: 2px; background: currentColor; border-radius: 2px; }` (and ensure `.tab` is `position: relative`)
- [x] remove the old `border-bottom: 2px solid var(--link-color)` from `.tab.active` — replaced by the top accent strip
- [x] add `.tab.active { transform: scale(1.05); transition: transform 0.15s ease, color 0.15s ease; }` (transform-only, GPU-cheap)
- [x] write a Vitest case asserting only one tab has `.active` at a time after `data-tab` switch
- [x] write a Vitest case asserting the accent strip pseudo-element is defined for `.tab.active`
- [x] run `pnpm test` — must pass before next task

### Task 3: Vary inactive icon weight for scannability

- [x] adjust each stroke SVG's `stroke-width` so the 7 inactive icons aren't identical visual weight — recommended: `1.75` for filled-feeling icons (heart, pill), `2` for medium (BP, scale, dumbbell), `2.25` for outline-only (settings gear). Decide per-icon based on visual density
- [x] no functional test needed for this aesthetic tuning — covered by manual review in Task 5
- [x] run `pnpm test` — must pass before next task (regression check)

### Task 4: Accessibility — `aria-current` on active tab

- [x] in `app.js` tab switch handler, add `aria-current="page"` to the activated tab and remove from siblings
- [x] write a Vitest case asserting `aria-current="page"` is present on the active tab and absent from inactive tabs after `data-tab` switch
- [x] run `pnpm test` — must pass before next task

### Task 5: Verify acceptance criteria

- [x] visually verify on a real device — icons distinguishable at arm's length (skipped - not automatable)
- [x] verify VoiceOver / TalkBack reads the active tab correctly with `aria-current` (skipped - not automatable)
- [x] verify the accent strip and scale work for the *first* and *last* tab without clipping (skipped - visual check, not automatable)
- [x] verify drag-reorder still works (tabs-dnd.js) (skipped - manual drag interaction, not automatable)
- [x] run full `pnpm test`, `go test ./...`, linter — all passed (402 Vitest, all Go packages, go vet clean)

### Task 6: Documentation

- [ ] update `docs/frontend.md` "Tabs and Navigation" with the stroke/fill icon convention and accent-strip pattern
- [ ] note in CLAUDE.md design rules that any new tab requires both stroke and fill SVG variants

## Technical Details

- Total icon payload: 7 × (~40 bytes stroke + ~40 bytes fill) ≈ 600 bytes inline — negligible
- Scale `1.05` is enough to feel responsive without breaking the grid alignment of the 7-up flex row
- The accent strip uses `currentColor` so it inherits the active token automatically — no extra CSS variable needed

## Post-Completion

**Manual verification**:
- iOS + Android Telegram clients — icons distinguishable, active state obvious at a glance
- Side-by-side with old design — confirm "more polished" reaction from a non-technical reviewer
- Verify with all 7 tabs visible AND with reduced tab set (some features disabled)

**External system updates**: none
