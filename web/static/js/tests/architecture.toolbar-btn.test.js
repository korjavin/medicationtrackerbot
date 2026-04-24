/**
 * architecture.toolbar-btn.test.js
 *
 * Pins the shared toolbar-row action button (`.wg-toolbar-btn` +
 * `.wg-toolbar-btn--primary`) introduced in Round-2 defects Task 2.
 *
 * The class unifies the "primary action pill sitting next to a
 * range/subtab track" pattern that five sections previously re-solved
 * locally (BP +Log, Weight +Log, Meds Add, Workouts Start, Food Add).
 * This test guards:
 *
 *   1. The shared `--wg-toolbar-btn-height` token is defined on :root
 *      and matches the 36px range-pill height.
 *   2. The `.wg-toolbar-btn` rule exists and specifies the expected
 *      sizing/padding/radius (so the --primary variant can stay
 *      color-only).
 *   3. The `.wg-toolbar-btn--primary` rule exists and carries the
 *      sun-gloss yellow fill — color only, no size override.
 *
 * It also records the per-section adoption TODO (migration tracked in
 * later Round-2 tasks #8, #10, #13b, #15 per the plan) so future work
 * can extend this test to assert actual DOM adoption once each section
 * flips to the shared class. The TODO is a string list on the suite so
 * grepping the test makes the migration visible.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

const CSS = fs.readFileSync(CSS_PATH, 'utf8');

// Section-level migration TODO. Each entry is a button that currently
// uses its own per-section `__add` class and is scheduled to adopt
// `.wg-toolbar-btn .wg-toolbar-btn--primary` in the listed Round-2 task.
// Entries are removed as their per-section task lands and DOM adoption is
// pinned by a dedicated test.
// Round-2 Task 5 (defect #8): `#add-bp-btn` — ADOPTED; DOM adoption pinned
// in `bp.render.test.js` and reasserted below.
// Round-2 Task 6 (defect #9): `#add-food-inline-btn` — ADOPTED; DOM
// adoption pinned in `food.toolbar-row.test.js` and reasserted below.
// Round-2 Task 7 (defect #10): `#add-btn` — ADOPTED; the button moved out
// of the subtab row and is now scoped to the Schedule subtab via
// `.wg-meds-schedule-header`. DOM adoption pinned in
// `meds.schedule-add.test.js` and reasserted below.
// Round-2 Task 10 (defect #13b): `#start-adhoc-workout-btn` — ADOPTED;
// DOM adoption pinned in `workout.design-parity.test.js` and reasserted
// below (source-level guard on index.html).
// Round-2 Task 12 (defect #15): `#add-weight-btn` — ADOPTED; the button
// moved out of the (deleted) `.wg-weight-header-row` into the
// range-selector row via `buildWeightInlineAddButton`. DOM adoption
// pinned in `weight.history.test.js` and reasserted below (source-level
// guard on features/weight.js).
//
// Array is empty because every per-section button has adopted the shared
// class. If a new section later re-introduces the pattern, add its entry
// here until its dedicated DOM-adoption test lands.
const TOOLBAR_BTN_MIGRATION_TODO = [];

function extractRule(css, selector) {
    const idx = css.indexOf(selector);
    if (idx === -1) return null;
    const braceStart = css.indexOf('{', idx);
    if (braceStart === -1) return null;
    const braceEnd = css.indexOf('}', braceStart);
    if (braceEnd === -1) return null;
    return css.slice(braceStart + 1, braceEnd);
}

function extractRootBlock(css) {
    const match = css.match(/:root\s*\{([^}]+)\}/);
    return match ? match[1] : '';
}

describe('Round-2 Task 2 — shared .wg-toolbar-btn class', () => {
    it('defines the --wg-toolbar-btn-height token at 36px (matches range-pill height)', () => {
        const root = extractRootBlock(CSS);
        expect(root).toMatch(/--wg-toolbar-btn-height\s*:\s*36px\s*;/);
    });

    it('defines .wg-toolbar-btn with expected size/padding/radius', () => {
        const rule = extractRule(CSS, '\n.wg-toolbar-btn {');
        expect(rule).not.toBeNull();
        // Size must flow through the shared token (no magic numbers).
        expect(rule).toMatch(/min-height\s*:\s*var\(--wg-toolbar-btn-height\)/);
        // Padding/gap/radius must resolve through design tokens, not hex.
        expect(rule).toMatch(/padding\s*:\s*var\(--space-xs\)\s+var\(--space-md\)/);
        expect(rule).toMatch(/gap\s*:\s*var\(--space-xs\)/);
        expect(rule).toMatch(/border-radius\s*:\s*var\(--wg-radius-gloss\)/);
        // align-self:center defeats stretch-inflation inside
        // align-items:stretch flex containers (root cause of defects #8/#10/#13b).
        expect(rule).toMatch(/align-self\s*:\s*center/);
        // Typography hooks into the shared UI font + weight.
        expect(rule).toMatch(/font-family\s*:\s*var\(--wg-font-ui\)/);
        expect(rule).toMatch(/font-weight\s*:\s*var\(--font-weight-bold\)/);
    });

    it('defines .wg-toolbar-btn--primary as a color-only variant (no size overrides)', () => {
        const rule = extractRule(CSS, '\n.wg-toolbar-btn--primary {');
        expect(rule).not.toBeNull();
        // Sun-gloss yellow fill + matching ink text.
        expect(rule).toMatch(/background\s*:\s*var\(--wg-gloss-bg-sun\)/);
        expect(rule).toMatch(/color\s*:\s*var\(--wg-ink\)/);
        expect(rule).toMatch(/box-shadow\s*:\s*var\(--wg-gloss-shadow-sun\)/);
        // Must NOT override size — min-height / padding / border-radius are
        // the base class's concern.
        expect(rule).not.toMatch(/min-height\s*:/);
        expect(rule).not.toMatch(/padding\s*:/);
        expect(rule).not.toMatch(/border-radius\s*:/);
    });

    it('has no hardcoded hex colors in the toolbar-btn rules (tokens only)', () => {
        const base = extractRule(CSS, '\n.wg-toolbar-btn {') || '';
        const primary = extractRule(CSS, '\n.wg-toolbar-btn--primary {') || '';
        expect(base).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(primary).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });

    // Adoption TODO — originally tracked five per-section buttons that
    // still used a one-off class. All five landed in Round-2 Tasks
    // 5/6/7/10/12 (defects #8/#9/#10/#13b/#15); the TODO is now drained.
    // If a new section reintroduces the pattern, add an entry to
    // TOOLBAR_BTN_MIGRATION_TODO with { file, button, oneOffClass, task }
    // until its dedicated DOM-adoption test lands.
    it('per-section adoption TODO is drained (all buttons use the shared class)', () => {
        expect(TOOLBAR_BTN_MIGRATION_TODO).toEqual([]);
    });

    // Round-2 Task 5 (defect #8): BP +Log button adopted the shared class.
    // Guard the source to keep the migration from regressing — if someone
    // resurrects `.wg-bp-range-selector__add` on `#add-bp-btn`, this breaks.
    it('BP buildBPInlineAddButton uses .wg-toolbar-btn + .wg-toolbar-btn--primary (not the old one-off)', () => {
        const BP_FEATURE_PATH = path.join(REPO_ROOT, 'web/static/js/features/bp.js');
        const src = fs.readFileSync(BP_FEATURE_PATH, 'utf8');
        // The className literal on `#add-bp-btn` must carry the shared classes.
        expect(src).toMatch(/btn\.className\s*=\s*['"]wg-toolbar-btn\s+wg-toolbar-btn--primary['"]/);
        // And must not reintroduce the per-section `__add` one-off on the button.
        expect(src).not.toMatch(/wg-bp-range-selector__add(?!-)/);
    });

    // The dead per-section `.wg-bp-range-selector__add` CSS rule was removed
    // along with the className migration. If it comes back, the migration
    // has regressed (two conflicting size stacks on the same button).
    it('CSS no longer defines the dead .wg-bp-range-selector__add rule', () => {
        // Match the rule opener `.wg-bp-range-selector__add {` (with space+brace)
        // so the surviving `.wg-bp-range-selector__add-label` — wait, that was
        // also removed; the new shared class is `.wg-toolbar-btn__label`.
        expect(CSS).not.toMatch(/\.wg-bp-range-selector__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-bp-range-selector__add-label\s*\{/);
    });

    // Round-2 Task 6 (defect #9): Food +Add inline pill adopted the shared
    // class. Source-level guard on index.html — a DOM-level adoption test
    // lives in `food.toolbar-row.test.js`.
    it('Food #add-food-inline-btn uses .wg-toolbar-btn + .wg-toolbar-btn--primary (not the old one-off)', () => {
        const INDEX_HTML_PATH = path.join(REPO_ROOT, 'web/static/index.html');
        const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
        // Find the button element and check its class attribute.
        const match = src.match(/<button\s+id="add-food-inline-btn"[^>]*class="([^"]+)"/);
        expect(match).not.toBeNull();
        const classAttr = match[1];
        expect(classAttr).toMatch(/\bwg-toolbar-btn\b/);
        expect(classAttr).toMatch(/\bwg-toolbar-btn--primary\b/);
        // The per-section one-off must not coexist with the shared class.
        expect(classAttr).not.toMatch(/\bwg-food-day-nav__add\b/);
    });

    it('CSS no longer defines the dead .wg-food-day-nav__add rule', () => {
        expect(CSS).not.toMatch(/\.wg-food-day-nav__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-food-day-nav__add-label\s*\{/);
    });

    // Round-2 Task 7 (defect #10): Meds #add-btn moved out of the subtab
    // row and into the Schedule subtab's `.wg-meds-schedule-header`.
    // Source-level guards mirror the BP/Food patterns above — DOM-level
    // visibility/placement assertions live in `meds.schedule-add.test.js`.
    it('Meds #add-btn uses .wg-toolbar-btn + .wg-toolbar-btn--primary and lives in the Schedule header', () => {
        const INDEX_HTML_PATH = path.join(REPO_ROOT, 'web/static/index.html');
        const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
        const match = src.match(/<button\s+id="add-btn"[^>]*class="([^"]+)"/);
        expect(match).not.toBeNull();
        const classAttr = match[1];
        expect(classAttr).toMatch(/\bwg-toolbar-btn\b/);
        expect(classAttr).toMatch(/\bwg-toolbar-btn--primary\b/);
        // The per-section one-offs must not coexist with the shared class.
        expect(classAttr).not.toMatch(/\bwg-meds-subtabs-row__add\b/);
        expect(classAttr).not.toMatch(/\bwg-gloss--sun\b/);
        // And the button must live inside the Schedule subtab's header
        // (so History/Inventory render without an Add control).
        const scheduleTabIdx = src.indexOf('id="med-schedule-tab"');
        const scheduleTabClose = src.indexOf('</div>', src.indexOf('<div id="med-list"', scheduleTabIdx));
        const addBtnIdx = src.indexOf('id="add-btn"');
        expect(scheduleTabIdx).toBeGreaterThan(-1);
        expect(addBtnIdx).toBeGreaterThan(scheduleTabIdx);
        expect(addBtnIdx).toBeLessThan(scheduleTabClose);
    });

    it('CSS no longer defines the dead .wg-meds-subtabs-row__add rule', () => {
        expect(CSS).not.toMatch(/\.wg-meds-subtabs-row__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-meds-subtabs-row__add-label\s*\{/);
    });

    // Round-2 Task 10 (defect #13b): Workouts #start-adhoc-workout-btn
    // adopted the shared class. Source-level guard on index.html — a
    // DOM-level adoption test lives in `workout.design-parity.test.js`.
    it('Workouts #start-adhoc-workout-btn uses .wg-toolbar-btn + .wg-toolbar-btn--primary (not the old one-off)', () => {
        const INDEX_HTML_PATH = path.join(REPO_ROOT, 'web/static/index.html');
        const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
        const match = src.match(/<button\s+id="start-adhoc-workout-btn"[^>]*class="([^"]+)"/);
        expect(match).not.toBeNull();
        const classAttr = match[1];
        expect(classAttr).toMatch(/\bwg-toolbar-btn\b/);
        expect(classAttr).toMatch(/\bwg-toolbar-btn--primary\b/);
        // The per-section one-off and the now-unused sun-gloss base must
        // not coexist with the shared class (the shared --primary variant
        // already carries the yellow fill).
        expect(classAttr).not.toMatch(/\bwg-workouts-subtabs-row__add\b/);
        expect(classAttr).not.toMatch(/\bwg-gloss--sun\b/);
    });

    it('CSS no longer defines the dead .wg-workouts-subtabs-row__add rule', () => {
        expect(CSS).not.toMatch(/\.wg-workouts-subtabs-row__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-workouts-subtabs-row__add-label\s*\{/);
    });

    // Round-2 Task 12 (defect #15): Weight +Log button was lifted out of
    // the (deleted) Latest-pane header row and moved inline into the
    // range-selector row via `buildWeightInlineAddButton` — mirrors BP's
    // `buildBPInlineAddButton`. Source-level guard on features/weight.js;
    // DOM-level adoption lives in `weight.history.test.js`.
    it('Weight buildWeightInlineAddButton uses .wg-toolbar-btn + .wg-toolbar-btn--primary (not the old one-off)', () => {
        const WEIGHT_FEATURE_PATH = path.join(REPO_ROOT, 'web/static/js/features/weight.js');
        const src = fs.readFileSync(WEIGHT_FEATURE_PATH, 'utf8');
        expect(src).toMatch(/btn\.className\s*=\s*['"]wg-toolbar-btn\s+wg-toolbar-btn--primary['"]/);
        // The per-section one-off must not come back on #add-weight-btn.
        expect(src).not.toMatch(/wg-weight-header-row__add/);
        // The Latest-pane renderer and its classifier went with the
        // pane — don't resurrect them.
        expect(src).not.toMatch(/renderWeightCurrentCard\s*\(/);
        expect(src).not.toMatch(/classifyWeightTrend\s*\(/);
    });

    it('CSS no longer defines the dead .wg-weight-header-row + Latest-pane rules', () => {
        expect(CSS).not.toMatch(/\.wg-weight-header-row\s*\{/);
        expect(CSS).not.toMatch(/\.wg-weight-header-row__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-weight-header-row__add-label\s*\{/);
        expect(CSS).not.toMatch(/\.wg-weight-current-card\s*\{/);
        expect(CSS).not.toMatch(/\.wg-weight-current-card__[a-z-]+\s*\{/);
        expect(CSS).not.toMatch(/\.wg-weight-trend\s*\{/);
        expect(CSS).not.toMatch(/\.wg-weight-trend--(good|bad|flat)\s*\{/);
    });

    // Round-2 Task 10 (defect #13a): a new outline/ghost secondary
    // variant was introduced alongside the Workouts "Next workout" card
    // restyle. Same contract as --primary: color only, no size overrides.
    it('defines .wg-toolbar-btn--secondary as a color-only variant (no size overrides)', () => {
        const rule = extractRule(CSS, '\n.wg-toolbar-btn--secondary {');
        expect(rule).not.toBeNull();
        // Transparent / outline on the teal stage, with the shared
        // hairline border token — no hex colors.
        expect(rule).toMatch(/background\s*:\s*transparent/);
        expect(rule).toMatch(/color\s*:\s*var\(--wg-fg-1\)/);
        expect(rule).toMatch(/border\s*:\s*1px\s+solid\s+var\(--wg-border-hairline\)/);
        // No size overrides — sizing lives on the base class.
        expect(rule).not.toMatch(/min-height\s*:/);
        expect(rule).not.toMatch(/padding\s*:/);
        expect(rule).not.toMatch(/border-radius\s*:/);
        // No raw hex colors.
        expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});
