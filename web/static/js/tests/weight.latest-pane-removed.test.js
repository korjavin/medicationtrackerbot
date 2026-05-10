// Round-2 Task 12 (defect #15) — dedicated DOM pin for the Weight screen's
// removed Latest pane + relocated +Log button.
//
// The Round-2 plan calls for a test asserting that (a) no element with the
// old Latest-pane class is present and (b) `+ Log` lives inside the
// range-toolbar row. `weight.history.test.js` also covers this alongside
// its history-list assertions; this file gives the defect its own short,
// targeted regression so grepping by defect number surfaces the pin.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_PATH = path.join(REPO_ROOT, 'web/static/index.html');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');
const WEIGHT_JS_PATH = path.join(REPO_ROOT, 'web/static/js/features/weight.js');

describe('Weight — Latest pane removed + +Log in toolbar (Round-2 Task 12, #15)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('no #weight-current-card or .wg-weight-header-row exist anywhere in #weight-view', () => {
        const { document } = env;
        const view = document.getElementById('weight-view');
        expect(view).not.toBeNull();
        // Legacy Latest-pane element and its wrapper row must be gone.
        expect(view.querySelector('#weight-current-card')).toBeNull();
        expect(view.querySelector('.wg-weight-header-row')).toBeNull();
        expect(view.querySelector('.wg-weight-current-card')).toBeNull();
        expect(view.querySelector('.wg-weight-trend')).toBeNull();
    });

    it('#weight-view starts with the stale-data chip then the goal card (chart takes over the top area)', () => {
        // The local-first read-resilience plan (Task 6) inserted a small
        // right-aligned wg-stale-badge slot at the very top of the view so
        // every priority section gets a uniform freshness chip. The slot is
        // hidden by default and is only painted once a cached/fresh load has
        // landed; the goal card and chart still anchor the layout below.
        const { document } = env;
        const view = document.getElementById('weight-view');
        const order = Array.from(view.children).map((el) => el.id || el.tagName);
        expect(order[0]).toBe('weight-stale-badge');
        expect(order[1]).toBe('weight-goal-card');
        expect(order[2]).toBe('weight-range-selector');
        expect(order[3]).toBe('weightChart');
    });

    it('renderWeightRangeSelector emits #add-weight-btn inside the toolbar row with shared classes', () => {
        const { document, window } = env;
        window.renderWeightRangeSelector({ active: '30d', onChange: () => {} });

        const row = document.querySelector('#weight-view .wg-weight-range-selector');
        expect(row).not.toBeNull();

        const cta = document.getElementById('add-weight-btn');
        expect(cta).not.toBeNull();
        expect(row.contains(cta)).toBe(true);

        // Shared Round-2 Task 2 toolbar classes — color-only --primary.
        expect(cta.classList.contains('wg-toolbar-btn')).toBe(true);
        expect(cta.classList.contains('wg-toolbar-btn--primary')).toBe(true);

        // None of the Phase-5 / paper-era one-offs must come back.
        expect(cta.classList.contains('wg-weight-header-row__add')).toBe(false);
        expect(cta.classList.contains('wg-weight-add-cta')).toBe(false);
        expect(cta.classList.contains('wg-gloss--sun')).toBe(false);
    });

    it('clicking #add-weight-btn invokes window.showWeightModal', () => {
        const { document, window } = env;
        window.renderWeightRangeSelector({ active: '30d', onChange: () => {} });

        const spy = vi.fn();
        window.showWeightModal = spy;
        document.getElementById('add-weight-btn').click();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('index.html no longer declares the Latest pane or its header row', () => {
        const html = fs.readFileSync(INDEX_PATH, 'utf8');
        expect(html).not.toMatch(/id="weight-current-card"/);
        expect(html).not.toMatch(/class="wg-weight-header-row"/);
        // #add-weight-btn is now generated at runtime by
        // buildWeightInlineAddButton, so the static declaration must
        // not be reintroduced.
        expect(html).not.toMatch(/id="add-weight-btn"/);
    });

    it('styles.css no longer declares any Latest-pane rules', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        expect(css).not.toMatch(/\.wg-weight-header-row\s*\{/);
        expect(css).not.toMatch(/\.wg-weight-header-row__add\s*\{/);
        expect(css).not.toMatch(/\.wg-weight-header-row__add-label\s*\{/);
        expect(css).not.toMatch(/\.wg-weight-current-card\s*\{/);
        expect(css).not.toMatch(/\.wg-weight-trend\s*\{/);
        // Retired tokens.
        expect(css).not.toMatch(/--wg-weight-current-value-size\s*:/);
        expect(css).not.toMatch(/--wg-weight-current-unit-size\s*:/);
        expect(css).not.toMatch(/--wg-weight-current-card-pad\s*:/);
        expect(css).not.toMatch(/--wg-weight-trend-size\s*:/);
        expect(css).not.toMatch(/--wg-weight-trend-icon-size\s*:/);
    });

    it('features/weight.js no longer defines renderWeightCurrentCard or classifyWeightTrend', () => {
        const src = fs.readFileSync(WEIGHT_JS_PATH, 'utf8');
        expect(src).not.toMatch(/function\s+renderWeightCurrentCard\s*\(/);
        expect(src).not.toMatch(/function\s+classifyWeightTrend\s*\(/);
        expect(src).not.toMatch(/function\s+formatWeightTimestamp\s*\(/);
        expect(src).not.toMatch(/const\s+WEIGHT_TREND_ARROWS\b/);
    });
});
