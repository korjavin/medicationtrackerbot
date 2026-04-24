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
const TOOLBAR_BTN_MIGRATION_TODO = [
    { file: 'web/static/js/features/bp.js',  button: '#add-bp-btn', oneOffClass: '.wg-bp-range-selector__add',  task: 'Round-2 Task 5 (defect #8)' },
    { file: 'web/static/index.html',          button: '#add-btn',    oneOffClass: '.wg-meds-subtabs-row__add',    task: 'Round-2 Task 7 (defect #10)' },
    { file: 'web/static/index.html',          button: '#start-adhoc-workout-btn', oneOffClass: '.wg-workouts-subtabs-row__add', task: 'Round-2 Task 10 (defect #13b)' },
    { file: 'web/static/index.html',          button: '#add-weight-btn', oneOffClass: '.wg-weight-header-row__add', task: 'Round-2 Task 12 (defect #15)' },
    { file: 'web/static/index.html',          button: '#add-food-inline-btn', oneOffClass: '.wg-food-day-nav__add', task: 'Round-2 (follow-up, defect #9)' },
];

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

    // Adoption TODO — documented here so the migration stays visible.
    // Once each per-section task lands and the one-off class is replaced
    // with `.wg-toolbar-btn .wg-toolbar-btn--primary`, extend this suite
    // to assert DOM adoption per file.
    it('records the per-section adoption TODO (migration tracked in Round-2 follow-up tasks)', () => {
        expect(TOOLBAR_BTN_MIGRATION_TODO.length).toBeGreaterThan(0);
        for (const entry of TOOLBAR_BTN_MIGRATION_TODO) {
            expect(entry.file).toMatch(/^web\/static\//);
            expect(entry.button).toMatch(/^#/);
            expect(entry.oneOffClass).toMatch(/^\.wg-/);
            expect(entry.task).toMatch(/Round-2/);
        }
    });
});
