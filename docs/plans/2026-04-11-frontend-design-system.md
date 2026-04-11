# Frontend Design System & Visual Refresh

## Overview
Establish a proper design token system and modernize the visual appearance of the Telegram Mini App frontend. Currently the app has 7 CSS variables (all Telegram theme mirrors), 48 hardcoded colors, 14 button variants, 22 font sizes, 67+ inline styles in JS, and emoji-only tab icons. The goal is to create a consistent, maintainable design foundation and then apply a clean minimal aesthetic (Apple Health / iOS Settings style).

**No dark mode changes** — user explicitly excluded dark scheme work.

## Context (from discovery)
- Primary CSS file: `web/static/css/style.css` (2051 lines)
- JS files with heavy inline styles: `app.js` (82 DOM manipulations), `food.js` (56 inline styles), `bp.js` (5), `weight.js` (6)
- Custom elements: `web/static/js/components/mt-elements.js` (mt-modal, mt-setting-toggle)
- Architecture test: `tests/architecture.globals.test.js` (global namespace allowlist)
- Tab icons: 7 emoji-based buttons in `index.html`
- No bundler — vanilla JS with `<script>` tags in dependency order

## Development Approach
- **Testing approach**: Architecture tests (extend existing globals test to validate design token usage)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change
- Maintain backward compatibility — visual output should improve, not break

## Testing Strategy
- **Architecture tests**: Extend `tests/architecture.globals.test.js` or create new `tests/architecture.design-tokens.test.js` to lint for:
  - No hardcoded hex colors in CSS (must use variables)
  - No inline `style.cssText` assignments in JS (must use CSS classes)
  - Button classes use consolidated system
- **Manual verification**: After each task, open the app in Telegram to confirm visual correctness

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## Implementation Steps

### Task 1: Define design tokens (CSS custom properties)
- [x] Add color tokens to `:root` in `style.css`: `--color-success`, `--color-warning`, `--color-danger`, `--color-info`, and all BP classification colors, chart colors, sync status colors, toast colors
- [x] Add spacing tokens: `--space-xs: 4px`, `--space-sm: 8px`, `--space-md: 12px`, `--space-lg: 16px`, `--space-xl: 24px`, `--space-2xl: 32px`
- [x] Add border-radius tokens: `--radius-sm: 6px`, `--radius-md: 10px`, `--radius-lg: 14px`, `--radius-xl: 18px`, `--radius-pill: 999px`
- [x] Add shadow tokens: `--shadow-sm`, `--shadow-md`, `--shadow-lg` (3 levels)
- [x] Add typography tokens: `--font-size-xs: 11px`, `--font-size-sm: 13px`, `--font-size-md: 15px`, `--font-size-lg: 18px`, `--font-size-xl: 24px`, `--font-weight-normal: 400`, `--font-weight-medium: 500`, `--font-weight-bold: 600`
- [x] Add z-index tokens: `--z-dropdown: 100`, `--z-overlay: 1000`, `--z-modal: 1001`, `--z-popover: 1002`, `--z-toast: 1100`
- [x] Create `tests/architecture.design-tokens.test.js` that verifies `:root` block contains all expected token names
- [x] Run tests — must pass before next task

### Task 2: Replace hardcoded colors in CSS with tokens
- [x] Replace all hardcoded hex colors in `style.css` with the corresponding CSS variable tokens from Task 1
- [x] Preserve Telegram theme variable references (`var(--tg-theme-*)`) — only replace app-specific hardcoded colors
- [x] Add test in `tests/architecture.design-tokens.test.js`: scan `style.css` for remaining hardcoded hex values (allowlist only Telegram fallback defaults in `:root`)
- [x] Run tests — must pass before next task

### Task 3: Consolidate button system
- [x] Define 4 button base classes: `.btn` (base reset), `.btn-primary`, `.btn-secondary`, `.btn-danger`
- [x] Define 3 size modifiers: `.btn-sm`, `.btn-md` (default), `.btn-lg`
- [x] Define shape modifiers: `.btn-pill`, `.btn-icon` (square icon-only)
- [x] Migrate existing 14 button classes to use the new system — update CSS selectors
- [x] Update all JS files that create buttons dynamically to use new class names
- [x] Update `index.html` button references
- [x] Add test: scan CSS for old button class names (should not exist except as aliases during migration)
- [x] Run tests — must pass before next task

### Task 4: Replace spacing/radius/shadow hardcoded values in CSS
- [x] Replace padding/margin/gap values in `style.css` with spacing tokens (map each value to nearest token)
- [x] Replace border-radius values with radius tokens
- [x] Replace box-shadow values with shadow tokens
- [x] Replace font-size values with typography tokens (map each to nearest)
- [x] Replace z-index values with z-index tokens
- [x] Add test: scan `style.css` for hardcoded `px` values in padding/margin/gap/border-radius/box-shadow/z-index properties (allowlist exceptions like `1px` borders, `0`, `100%`)
- [x] Run tests — must pass before next task

### Task 5: Migrate inline styles from app.js to CSS classes
- [x] Audit all `style.cssText`, `style.property`, and inline `style=` in `app.js`
- [x] Create utility classes in `style.css` for repeated patterns: `.flex-between`, `.flex-center`, `.text-center`, `.text-hint`, `.empty-state`, `.hidden`, `.mt-sm`, `.mb-md`, etc.
- [x] Create component classes for domain-specific patterns: `.med-item-header`, `.intake-log-entry`, `.stat-value`, etc.
- [x] Replace all inline style assignments in `app.js` with `classList.add()` / `className` assignments
- [x] Verify no `style.cssText` or `style.` property assignments remain in `app.js` (except `style.display` for show/hide if needed)
- [x] Add test: grep `app.js` for `\.style\.` and `\.style\s*=` — must return zero matches (or allowlisted exceptions)
- [x] Run tests — must pass before next task

### Task 6: Migrate inline styles from food.js
- [x] Audit all 56 inline style assignments in `features/food.js`
- [x] Create CSS classes for food-specific patterns: `.food-group-time`, `.food-group-totals`, `.food-log-item`, `.food-checkbox-wrap`, `.food-checkbox`, `.food-item-body`, `.food-item-meta`, `.food-action-icons`, `.food-floating-btn`, `.food-meal-header`, `.food-meal-info`, `.food-meal-name`, `.food-meal-actions`, `.food-nutrition-row`, `.food-summary-wrapper`, `.food-summary-details`, `.food-select-btn`, `.food-db-actions-row`, `.food-db-info`, `.food-db-name`, `.food-db-macros`, `.food-db-meta`, `.food-meal-badge`
- [x] Replace all inline style assignments with CSS classes
- [x] Add test: grep `food.js` for `\.style\.` — must return zero matches (or allowlisted exceptions for dynamic progress bar width/background)
- [x] Run tests — must pass before next task

### Task 7: Migrate inline styles from bp.js, weight.js, and remaining JS files
- [ ] Audit and migrate inline styles in `features/bp.js`
- [ ] Audit and migrate inline styles in `features/weight.js`
- [ ] Scan all other JS files in `web/static/js/` for inline style assignments and migrate
- [ ] Add test: grep all JS files under `web/static/js/` for `\.style\.` — must return zero matches (or allowlisted exceptions for dynamic values like chart positioning)
- [ ] Run tests — must pass before next task

### Task 8: Replace emoji tab icons with inline SVGs
- [ ] Design/source 7 SVG icons (16-20px, single-path, monochrome): blood drop (BP), scale (weight), dumbbell (workouts), utensils (food), moon/heart (health), pill (medications), gear (settings)
- [ ] Replace emoji text in tab buttons in `index.html` with inline SVG elements
- [ ] Add `aria-label` attributes to each tab button (e.g., `aria-label="Blood Pressure"`)
- [ ] Style SVGs to use `currentColor` so they inherit `color` from `.tab` / `.tab.active` CSS
- [ ] Ensure tab active/inactive states work with SVG icons (color transitions)
- [ ] Remove `user-scalable=no` from viewport meta tag
- [ ] Run tests — must pass before next task

### Task 9: Visual polish — cards, spacing, and hierarchy
- [ ] Increase base card padding from 16px to `var(--space-lg)` and card gap from 12px to `var(--space-md)`
- [ ] Add subtle border (`1px solid rgba(0,0,0,0.06)`) to cards for definition without heavy shadows
- [ ] Improve heading hierarchy: increase h1/section title size contrast, add `letter-spacing: -0.01em` for tighter headings
- [ ] Add `transition: background-color 0.15s ease` to interactive elements (buttons, cards, list items)
- [ ] Add `transition: opacity 0.2s ease, transform 0.2s ease` to modal open (via CSS class toggle)
- [ ] Add `transition: color 0.15s ease` to tab switches
- [ ] Increase touch target sizes to minimum 44x44px where needed
- [ ] Review overall spacing rhythm — ensure consistent use of spacing tokens throughout
- [ ] Run tests — must pass before next task

### Task 10: Verify acceptance criteria
- [ ] Verify all 48 hardcoded colors replaced with tokens
- [ ] Verify all 14 button classes consolidated to new system
- [ ] Verify all 67+ inline styles migrated to CSS classes
- [ ] Verify 7 emoji icons replaced with SVG
- [ ] Verify `user-scalable=no` removed
- [ ] Verify all tab buttons have `aria-label`
- [ ] Run full test suite: `go test ./...`
- [ ] Run architecture tests
- [ ] Verify test coverage meets project standard

### Task 11: [Final] Update documentation
- [ ] Update CLAUDE.md if new CSS patterns or conventions need documenting
- [ ] Add design token reference comment block at top of `style.css`

## Technical Details

### Design Token Naming Convention
```
--color-{semantic}        →  --color-success, --color-danger
--color-{component}-{variant}  →  --color-bp-normal, --color-bp-grade1
--space-{size}            →  --space-sm, --space-lg
--radius-{size}           →  --radius-md, --radius-pill
--shadow-{size}           →  --shadow-sm, --shadow-lg
--font-size-{size}        →  --font-size-sm, --font-size-xl
--font-weight-{name}      →  --font-weight-medium
--z-{layer}               →  --z-modal, --z-toast
```

### Button System Architecture
```
.btn              → base reset (border:none, cursor:pointer, font-family, transition)
.btn-primary      → var(--button-color) bg, var(--button-text-color) text
.btn-secondary    → var(--secondary-bg-color) bg, var(--text-color) text
.btn-danger       → var(--color-danger) bg, white text
.btn-sm           → smaller padding, smaller font
.btn-md           → default (no class needed)
.btn-lg           → larger padding, larger font
.btn-pill         → border-radius: var(--radius-pill)
.btn-icon         → square, icon-only (equal width/height)
```

### SVG Icon Requirements
- Viewbox: `0 0 24 24`
- Stroke-based (not filled), `stroke="currentColor"`, `stroke-width="2"`
- Single `<svg>` element per icon, no external references
- Size controlled by CSS (`width: 20px; height: 20px` on `.tab svg`)

### Utility Class Inventory (anticipated)
```
Layout:    .flex-row, .flex-col, .flex-between, .flex-center, .flex-wrap
Spacing:   .mt-{size}, .mb-{size}, .p-{size}, .gap-{size}
Text:      .text-center, .text-hint, .text-sm, .text-bold, .text-danger
Display:   .hidden, .block, .inline-flex
State:     .empty-state, .loading-state
```

## Post-Completion

**Manual verification**:
- Open app in Telegram on iOS and Android — verify theme integration still works
- Check all 7 tabs render correctly with new SVG icons
- Verify modals animate smoothly on open/close
- Confirm card styles and spacing feel "clean minimal"
- Test with Telegram light theme — colors and contrast should be correct
- Verify weight ruler, BP chart, and food autocomplete still function correctly after style migration
