/**
 * architecture.toolbar-btn.test.js
 *
 * `.wg-toolbar-btn` (+ `--primary` / `--secondary`) is a legacy button
 * system on its way out: UI kit v2 replaces it with `.wg-btn`. Its remaining
 * uses are allowlisted, per file, with the bead that removes each, in
 * architecture.no-legacy-buttons.test.js (med-xso6.11) — that list only
 * shrinks, and it is what stops new uses. This file no longer pins where the
 * class is adopted; it keeps:
 *
 *   1. the rule's contract while the rule still exists (token-sized, the
 *      variants colour-only) — skipped once the screen beads delete it;
 *   2. the "dead one-off rules stay dead" checks from the Round-2 migration.
 *
 * Retire this file (med-xso6.28) once the last wg-toolbar-btn is gone.
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

const RULE_PRESENT = CSS.includes('\n.wg-toolbar-btn {');

describe.skipIf(!RULE_PRESENT)('legacy .wg-toolbar-btn rule contract (while it exists)', () => {
    it('defines the --wg-toolbar-btn-height token at 36px (matches range-pill height)', () => {
        const root = extractRootBlock(CSS);
        expect(root).toMatch(/--wg-toolbar-btn-height\s*:\s*36px\s*;/);
    });

    it('defines .wg-toolbar-btn with expected size/padding/radius', () => {
        const rule = extractRule(CSS, '\n.wg-toolbar-btn {');
        expect(rule).not.toBeNull();
        expect(rule).toMatch(/min-height\s*:\s*var\(--wg-toolbar-btn-height\)/);
        expect(rule).toMatch(/padding\s*:\s*var\(--space-xs\)\s+var\(--space-md\)/);
        expect(rule).toMatch(/gap\s*:\s*var\(--space-xs\)/);
        expect(rule).toMatch(/border-radius\s*:\s*var\(--wg-radius-gloss\)/);
        // align-self:center defeats stretch-inflation inside
        // align-items:stretch flex containers (root cause of defects #8/#10/#13b).
        expect(rule).toMatch(/align-self\s*:\s*center/);
        expect(rule).toMatch(/font-family\s*:\s*var\(--wg-font-ui\)/);
        expect(rule).toMatch(/font-weight\s*:\s*var\(--font-weight-bold\)/);
    });

    it('--primary and --secondary are colour-only variants (no size overrides, no hex)', () => {
        const primary = extractRule(CSS, '\n.wg-toolbar-btn--primary {') || '';
        const secondary = extractRule(CSS, '\n.wg-toolbar-btn--secondary {') || '';
        for (const rule of [primary, secondary]) {
            expect(rule).not.toMatch(/min-height\s*:/);
            expect(rule).not.toMatch(/padding\s*:/);
            expect(rule).not.toMatch(/border-radius\s*:/);
            expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        }
    });
});

describe('Round-2 one-off button rules stay dead', () => {
    it('CSS no longer defines the per-section __add one-offs', () => {
        expect(CSS).not.toMatch(/\.wg-bp-range-selector__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-bp-range-selector__add-label\s*\{/);
        expect(CSS).not.toMatch(/\.wg-food-day-nav__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-food-day-nav__add-label\s*\{/);
        expect(CSS).not.toMatch(/\.wg-meds-subtabs-row__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-meds-subtabs-row__add-label\s*\{/);
        expect(CSS).not.toMatch(/\.wg-workouts-subtabs-row__add\s*\{/);
        expect(CSS).not.toMatch(/\.wg-workouts-subtabs-row__add-label\s*\{/);
        expect(CSS).not.toMatch(/\.wg-workouts-history-header\s*[,{]/);
        expect(CSS).not.toMatch(/\.wg-workouts-history-header__add\s*[,{]/);
        expect(CSS).not.toMatch(/\.wg-workouts-history-header__add-label\s*[,{]/);
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

    it('the retired one-off markup and renderers stay gone', () => {
        const indexHtml = fs.readFileSync(path.join(REPO_ROOT, 'web/static/index.html'), 'utf8');
        expect(indexHtml).not.toMatch(/id="start-adhoc-workout-btn"/);
        expect(indexHtml).not.toMatch(/class="wg-workouts-history-header"/);
        const bp = fs.readFileSync(path.join(REPO_ROOT, 'web/static/js/features/bp.js'), 'utf8');
        expect(bp).not.toMatch(/wg-bp-range-selector__add(?!-)/);
        const weight = fs.readFileSync(path.join(REPO_ROOT, 'web/static/js/features/weight.js'), 'utf8');
        expect(weight).not.toMatch(/wg-weight-header-row__add/);
        expect(weight).not.toMatch(/renderWeightCurrentCard\s*\(/);
        expect(weight).not.toMatch(/classifyWeightTrend\s*\(/);
    });
});
