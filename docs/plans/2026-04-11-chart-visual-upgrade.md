# Chart Visual Upgrade

## Overview
Polish all SVG charts (BP, Weight, Health vitals/sleep/steps) with gradient fills, smooth spline curves, draw animations, refined grid lines, and last-value emphasis. Extract shared chart utilities into a dedicated module to support these improvements and reduce duplication.

**Charts affected:**
- Blood Pressure chart (`web/static/js/features/bp.js` — `renderBPChart()`)
- Weight chart (`web/static/js/features/weight.js` — `renderWeightChart()`)
- Health vitals charts (`web/static/js/features/health.js` — `renderVitalsLineChart()`, `renderSleepChart()`, `renderStepsChart()`)

**Key improvements:**
1. SVG gradient fills under line charts (line color → transparent at baseline)
2. Smooth Catmull-Rom splines on BP chart (currently jagged line segments)
3. Line draw animation on chart load (stroke-dashoffset technique)
4. Refined grid lines (subtler, solid instead of dashed)
5. Last-value emphasis (larger dot + pulse animation + value label)

## Context
- All charts are hand-built SVG using `document.createElementNS` — no charting library
- `catmullRomSpline()` already exists in `weight.js:196-226` — needs extraction to shared module
- No bundler — plain `<script>` tags in `index.html` with dependency-order loading
- Design token system enforces no hardcoded colors and no inline JS styles
- Architecture tests in `web/static/js/tests/architecture.design-tokens.test.js` enforce these rules
- `--z-popover: 1002` CSS token exists but is unused (relevant if tooltips added later)
- Chart CSS classes already defined: `.chart-line`, `.chart-point`, `.chart-area`, `.chart-grid`, `.chart-goal-line`, `.chart-label`

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**
- Run tests after each change
- Maintain backward compatibility — charts must render identically for users who have data

## Testing Strategy
- **Unit tests**: test extracted chart utility functions (catmullRomSpline, gradient creation, animation helpers)
- **Architecture tests**: existing `architecture.design-tokens.test.js` must continue passing (no hardcoded colors, no inline styles)
- **Visual verification**: chart rendering is inherently visual — unit tests cover utility logic, manual verification covers visual output

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## Implementation Steps

### Task 1: Extract shared chart utilities to core/chart-utils.js
- [x] Create `web/static/js/core/chart-utils.js` with module comment header
- [x] Move `catmullRomSpline(points, segments)` from `weight.js:196-226` into chart-utils.js as `window.ChartUtils.catmullRomSpline`
- [x] Move `calculateYAxisTicks(yMin, yMax)` from `weight.js:228-260` into chart-utils.js
- [x] Add `ChartUtils.createGradient(svgNs, svg, id, color, opacity)` — creates `<linearGradient>` with top stop at given opacity and bottom stop at 0
- [x] Add `ChartUtils.animateLine(pathElement)` — measures `getTotalLength()`, sets `stroke-dasharray`/`stroke-dashoffset`, triggers draw animation
- [x] Add `ChartUtils.createLastValueDot(svgNs, svg, cx, cy, color)` — creates larger circle (r=6) with pulse animation class
- [x] Update `weight.js` to call `window.ChartUtils.catmullRomSpline` and `window.ChartUtils.calculateYAxisTicks` instead of local functions
- [x] Add `<script src="/static/js/core/chart-utils.js">` to `index.html` BEFORE feature scripts (after `core/modal-controller.js`, before `db.js`)
- [x] Update `window.*` globals allowlist in `tests/architecture.globals.test.js` for `window.ChartUtils`
- [x] Write tests for `catmullRomSpline()` (returns valid SVG path, handles edge cases: 0, 1, 2 points)
- [x] Write tests for `createGradient()` (returns gradient element with correct stops)
- [x] Write tests for `calculateYAxisTicks()` (correct tick values for various ranges)
- [x] Run `go test ./...` and JS architecture tests — must pass before next task

### Task 2: Add gradient fills to weight and BP charts
- [x] In `renderWeightChart()`: replace flat `rgba(59, 130, 246, 0.1)` fill with `ChartUtils.createGradient()` using `#3b82f6` at 0.25 opacity
- [x] In `renderBPChart()`: add gradient fill area under systolic line using BP classification color blend at 0.15 opacity
- [x] In `renderVitalsLineChart()`: replace flat `fill-opacity: 0.2` with `ChartUtils.createGradient()` using the parameterized color
- [x] Add CSS token `--color-chart-gradient-opacity: 0.25` in `:root` for consistent gradient strength
- [x] Verify gradient renders correctly with both light and dark Telegram themes
- [x] Write test verifying gradient CSS token exists in styles.css
- [x] Run architecture tests — must pass before next task

### Task 3: Smooth BP chart lines with splines
- [x] In `renderBPChart()`: replace straight `<line>` segments for systolic with a single spline path using `ChartUtils.catmullRomSpline()`
- [x] In `renderBPChart()`: replace straight `<line>` segments for diastolic with a single spline path
- [x] Preserve color-coding: apply a single dominant color to each spline path (use classification of latest reading, or most frequent classification)
- [x] Keep individual data points as color-coded circles (existing behavior)
- [x] Verify pulse line (if present) also uses spline smoothing
- [x] Write test verifying BP chart produces `<path>` elements (not `<line>`) when rendered
- [x] Run tests — must pass before next task

### Task 4: Refine grid lines across all charts
- [x] Add CSS class `.chart-grid-refined` with `stroke-opacity: 0.08; stroke-dasharray: none` (solid, very subtle)
- [x] Update `renderBPChart()` grid lines to use `.chart-grid-refined` class
- [x] Update `renderWeightChart()` grid lines to use `.chart-grid-refined` class
- [x] Update `renderVitalsLineChart()` grid lines to use refined style
- [x] Update `renderSleepChart()` grid lines to use refined style
- [x] Update `renderStepsChart()` grid lines to use refined style
- [x] Remove outermost grid lines (top/bottom boundaries) in all charts to eliminate "box" feel
- [x] Run architecture tests — must pass before next task

### Task 5: Add last-value emphasis to line charts
- [x] Add CSS class `.chart-point-latest` with `r: 6` and pulse animation keyframes in styles.css
- [x] Add `@keyframes chart-pulse { 0%,100% { opacity: 0.4; r: 10; } 50% { opacity: 0; r: 16; } }` for subtle ring pulse
- [x] In `renderWeightChart()`: make last data point use `.chart-point-latest` with value label (already has label — add pulse ring)
- [x] In `renderBPChart()`: add larger last systolic + diastolic points with value labels showing latest sys/dia reading
- [x] In `renderVitalsLineChart()`: add emphasis on rightmost data point
- [x] Ensure pulse animation uses CSS only (no JS animation loops)
- [x] Write test verifying `.chart-point-latest` and `@keyframes chart-pulse` exist in styles.css
- [x] Run tests — must pass before next task

### Task 6: Add line draw animation on chart load
- [x] Add CSS class `.chart-line-animated` with `stroke-dasharray`/`stroke-dashoffset` animation in styles.css
- [x] Add `@keyframes chart-draw { to { stroke-dashoffset: 0; } }` with `0.6s ease-out forwards`
- [x] In `ChartUtils.animateLine()`: call `getTotalLength()`, set CSS custom property `--line-length`, add `.chart-line-animated` class
- [x] Apply `ChartUtils.animateLine()` to weight chart main line path
- [x] Apply to BP chart systolic and diastolic spline paths
- [x] Apply to vitals chart line paths
- [x] Add `prefers-reduced-motion: reduce` media query that disables animation (sets `animation: none`)
- [x] Write test for `animateLine()` (sets correct attributes on path element)
- [x] Run full test suite — must pass before next task

### Task 7: Verify acceptance criteria
- [ ] Verify all 5 improvements implemented: gradients, smooth BP, grid refinement, last-value emphasis, draw animation
- [ ] Verify weight chart still renders correctly with goal line and diet plan line
- [ ] Verify BP chart color-coding still works per classification
- [ ] Verify health charts (vitals, sleep, steps) all render correctly
- [ ] Verify charts work with empty data (no regressions on empty state)
- [ ] Verify charts work with single data point (edge case)
- [ ] Run full test suite (`go test ./...`)
- [ ] Run JS architecture tests (design tokens, globals allowlist)
- [ ] Run linter — all issues must be fixed
- [ ] Test with both light and dark themes

### Task 8: [Final] Update documentation
- [ ] Update CLAUDE.md if any new patterns worth documenting (chart-utils module)
- [ ] Add `window.ChartUtils` to the Global Namespace Policy table in CLAUDE.md

## Technical Details

### Gradient Fill SVG Structure
```xml
<defs>
  <linearGradient id="grad-weight" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.25"/>
    <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
  </linearGradient>
</defs>
<path d="..." fill="url(#grad-weight)"/>
```

### Draw Animation CSS
```css
.chart-line-animated {
    stroke-dasharray: var(--line-length);
    stroke-dashoffset: var(--line-length);
    animation: chart-draw 0.6s ease-out forwards;
}
@keyframes chart-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
    .chart-line-animated { animation: none; stroke-dashoffset: 0; }
}
```

### Pulse Animation CSS
```css
.chart-point-pulse {
    animation: chart-pulse 2s ease-in-out infinite;
}
@keyframes chart-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0; }
}
```

### ChartUtils API
```js
window.ChartUtils = {
    catmullRomSpline(points, segments = 20),    // → SVG path string
    calculateYAxisTicks(yMin, yMax),             // → number[]
    createGradient(svgNs, svg, id, color, opacity), // → SVGGradientElement
    animateLine(pathElement),                    // → void (mutates element)
    createLastValueDot(svgNs, svg, cx, cy, color),  // → SVGElement group
};
```

### Script Load Order (updated)
```
... existing core scripts ...
core/chart-utils.js    ← NEW (after modal-controller.js, before db.js)
db.js
sync.js
... feature scripts ...
```

## Post-Completion

**Manual verification:**
- Open each tab (BP, Weight, Health) in Telegram WebApp and verify visual rendering
- Test with Telegram dark theme — gradients and animations should adapt
- Test on slow network — animations should not cause layout shift
- Verify on iOS Safari WebView (Telegram iOS) — SVG animations can behave differently
