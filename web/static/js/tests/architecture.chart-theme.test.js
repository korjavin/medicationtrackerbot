/**
 * architecture.chart-theme.test.js
 *
 * Round-2 Task 13 / defect #16 — Weight chart card + axis labels must
 * match the BP chart. Rather than duplicating the surface, grid, and
 * axis-tick styling across every chart component, this plan introduced a
 * shared chart theme in :root (--wg-chart-card-*, --wg-chart-guide-*,
 * --wg-chart-axis-tick-*). This test pins:
 *
 *   1. The shared tokens exist in :root.
 *   2. The BP + Weight chart card surfaces consume --wg-chart-card-*.
 *   3. The BP + Weight grid/guide lines consume --wg-chart-guide-*.
 *   4. The BP + Weight axis-tick labels consume --wg-chart-axis-tick-*.
 *   5. No hardcoded whites / hex / rgba literals leak into those rules.
 *
 * Failing this test means someone re-introduced per-chart color/padding
 * and broke the "Weight chart looks like a legacy off-white pane with
 * unreadable axis labels" bug (defect #16).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');

let css;
beforeAll(() => {
    css = fs.readFileSync(CSS_PATH, 'utf8');
});

function extractRootBlock(source) {
    const match = source.match(/:root\s*\{([^}]+)\}/);
    return match ? match[1] : '';
}

function extractRule(source, selector) {
    // Escape CSS special chars for regex; the selectors we care about use
    // only dots, hyphens, letters, and the __ separator, so a literal match
    // is safe enough when we anchor the opening brace right after. Replace
    // any whitespace the caller wrote in the selector (e.g. a literal
    // newline between two compound parts) with \s+ so we match the CSS
    // regardless of how it's wrapped.
    const escaped = selector
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
    const re = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`);
    const m = source.match(re);
    return m ? m[1].trim() : null;
}

function extractWeightTickRule(source) {
    // The weight chart tick labels share a compound selector: match it
    // tolerantly so whitespace/newlines between the two selectors don't
    // break the test when the CSS is reformatted.
    const re = /\.wg-weight-chart__y-tick-label\s*,\s*\.wg-weight-chart__x-tick-label\s*\{([^}]+)\}/;
    const m = source.match(re);
    return m ? m[1].trim() : null;
}

const SHARED_CHART_TOKENS = [
    '--wg-chart-card-bg',
    '--wg-chart-card-border',
    '--wg-chart-card-radius',
    '--wg-chart-card-pad',
    '--wg-chart-guide-stroke',
    '--wg-chart-guide-stroke-width',
    '--wg-chart-guide-dasharray',
    '--wg-chart-axis-tick-color',
    '--wg-chart-axis-tick-size',
];

describe('architecture — shared chart theme (Round-2 Task 13 / defect 16)', () => {
    it('declares every --wg-chart-* token in :root', () => {
        const root = extractRootBlock(css);
        for (const token of SHARED_CHART_TOKENS) {
            expect(root).toContain(`${token}:`);
        }
    });

    describe('chart card surfaces consume --wg-chart-card-*', () => {
        it('.wg-bp-chart-card uses --wg-chart-card-bg / border / radius / pad', () => {
            const rule = extractRule(css, '.wg-bp-chart-card');
            expect(rule).not.toBeNull();
            expect(rule).toContain('var(--wg-chart-card-bg)');
            expect(rule).toContain('var(--wg-chart-card-border)');
            expect(rule).toContain('var(--wg-chart-card-radius)');
            expect(rule).toContain('var(--wg-chart-card-pad)');
        });

        it('.wg-weight-chart-panel uses --wg-chart-card-bg / border / radius / pad', () => {
            const rule = extractRule(css, '.wg-weight-chart-panel');
            expect(rule).not.toBeNull();
            expect(rule).toContain('var(--wg-chart-card-bg)');
            expect(rule).toContain('var(--wg-chart-card-border)');
            expect(rule).toContain('var(--wg-chart-card-radius)');
            expect(rule).toContain('var(--wg-chart-card-pad)');
        });

        it('neither card rule hardcodes a hex color or rgb()/rgba() literal', () => {
            const blocks = ['.wg-bp-chart-card', '.wg-weight-chart-panel']
                .map((sel) => extractRule(css, sel))
                .filter(Boolean);
            expect(blocks.length).toBe(2);
            for (const block of blocks) {
                expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
                expect(block).not.toMatch(/\brgba?\(/);
            }
        });
    });

    describe('chart grid/guide lines consume --wg-chart-guide-*', () => {
        it('.wg-bp-chart__guide uses --wg-chart-guide-stroke / stroke-width / dasharray', () => {
            const rule = extractRule(css, '.wg-bp-chart__guide');
            expect(rule).not.toBeNull();
            expect(rule).toContain('var(--wg-chart-guide-stroke)');
            expect(rule).toContain('var(--wg-chart-guide-stroke-width)');
            expect(rule).toContain('var(--wg-chart-guide-dasharray)');
        });

        it('.wg-weight-chart__guide uses --wg-chart-guide-stroke / stroke-width / dasharray', () => {
            const rule = extractRule(css, '.wg-weight-chart__guide');
            expect(rule).not.toBeNull();
            expect(rule).toContain('var(--wg-chart-guide-stroke)');
            expect(rule).toContain('var(--wg-chart-guide-stroke-width)');
            expect(rule).toContain('var(--wg-chart-guide-dasharray)');
        });

        it('neither guide rule hardcodes a hex color or rgb()/rgba() literal', () => {
            const blocks = ['.wg-bp-chart__guide', '.wg-weight-chart__guide']
                .map((sel) => extractRule(css, sel))
                .filter(Boolean);
            expect(blocks.length).toBe(2);
            for (const block of blocks) {
                expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
                expect(block).not.toMatch(/\brgba?\(/);
            }
        });
    });

    describe('chart axis tick labels consume --wg-chart-axis-tick-*', () => {
        it('.wg-bp-chart__axis-tick uses --wg-chart-axis-tick-color and --wg-chart-axis-tick-size', () => {
            const rule = extractRule(css, '.wg-bp-chart__axis-tick');
            expect(rule).not.toBeNull();
            expect(rule).toContain('var(--wg-chart-axis-tick-color)');
            expect(rule).toContain('var(--wg-chart-axis-tick-size)');
        });

        it('.wg-weight-chart__y-tick-label / __x-tick-label consume the same shared tokens as BP', () => {
            const rule = extractWeightTickRule(css);
            expect(rule).not.toBeNull();
            expect(rule).toContain('var(--wg-chart-axis-tick-color)');
            expect(rule).toContain('var(--wg-chart-axis-tick-size)');
        });

        it('the weight chart tick rule no longer uses the dim --wg-fg-4 fill or the mono font (regressing defect #16)', () => {
            const rule = extractWeightTickRule(css);
            expect(rule).not.toBeNull();
            // --wg-fg-4 (0.42 alpha) was the unreadable color the defect
            // report called out. The shared token maps to --wg-fg-3 (0.55
            // alpha), matching BP's tick fill.
            expect(rule).not.toContain('var(--wg-fg-4)');
            // The mono font was a second regression vector — BP uses the
            // system UI font (font-family: inherit) for ticks and reads
            // better against the teal card.
            expect(rule).not.toContain('var(--wg-font-mono)');
            expect(rule).toContain('font-family: inherit');
        });

        it('neither axis-tick rule hardcodes a hex color or rgb()/rgba() literal', () => {
            const rules = [
                extractRule(css, '.wg-bp-chart__axis-tick'),
                extractWeightTickRule(css),
            ].filter(Boolean);
            expect(rules.length).toBe(2);
            for (const block of rules) {
                expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
                expect(block).not.toMatch(/\brgba?\(/);
            }
        });
    });
});
