// Round-2 Task 8 (#11a + #11b) — Meds → History "Next scheduled intake" pane.
//
// Pins:
//   • #11a: #next-intake-trigger is the FIRST block of #med-history-tab,
//     rendered above the .wg-meds-filters row and the #history-list.
//   • #11b: renderNextIntakeTrigger emits the new Wandergeek markup —
//     `.wg-meds-next-intake-card` surface + kicker/time/meta spans +
//     a `.wg-toolbar-btn.wg-toolbar-btn--primary` CTA.
//   • CSS contract: the restyled pane uses tokens only — no
//     `linear-gradient(` and no raw hex colors in any
//     `.wg-meds-next-intake-card*` rule (the legacy `.next-intake-*`
//     selectors are gone from the stylesheet).
//
// Behavior is covered by app.medication-history.test.js — this file is
// the design-parity pin.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CSS_PATH = path.join(REPO_ROOT, 'web/static/css/styles.css');
const APP_JS_PATH = path.join(REPO_ROOT, 'web/static/js/app.js');

describe('Meds → History next-intake pane (Round-2 Task 8)', () => {
    let consoleLogSpy;
    let consoleErrorSpy;

    beforeEach(() => {
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
    });

    it('#11a: #next-intake-trigger is the first child of #med-history-tab, before filters and list', () => {
        const { document, cleanup } = loadFrontendEnv();
        try {
            const tab = document.getElementById('med-history-tab');
            expect(tab).not.toBeNull();

            const children = Array.from(tab.children).filter((el) => el.nodeType === 1);
            const triggerIdx = children.findIndex((el) => el.id === 'next-intake-trigger');
            const filtersIdx = children.findIndex((el) => el.classList && el.classList.contains('wg-meds-filters'));
            const listIdx = children.findIndex((el) => el.id === 'history-list');

            expect(triggerIdx).toBeGreaterThanOrEqual(0);
            expect(filtersIdx).toBeGreaterThanOrEqual(0);
            expect(listIdx).toBeGreaterThanOrEqual(0);
            expect(triggerIdx).toBeLessThan(filtersIdx);
            expect(filtersIdx).toBeLessThan(listIdx);
        } finally {
            cleanup();
        }
    });

    it('#11b: renderNextIntakeTrigger emits Wandergeek markup (kicker, time, meta, toolbar-btn CTA)', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.DataStore.fetchFresh = vi.fn().mockResolvedValue(null);
            window.DataStore.getCached = vi.fn().mockResolvedValue({
                scheduled_at: new Date('2026-04-24T14:30:00').toISOString(),
                medication_names: ['Aspirin', 'Vitamin D']
            });

            await window.renderNextIntakeTrigger();

            const card = document.querySelector('#next-intake-trigger .wg-meds-next-intake-card');
            expect(card).not.toBeNull();

            // Legacy gradient-card classes must be gone from the rendered tree.
            expect(document.querySelector('#next-intake-trigger .next-intake-card')).toBeNull();
            expect(document.querySelector('#next-intake-trigger .next-intake-action')).toBeNull();
            expect(document.querySelector('#next-intake-trigger .btn-pill')).toBeNull();

            const kicker = card.querySelector('.wg-meds-next-intake-card__kicker');
            const time = card.querySelector('.wg-meds-next-intake-card__time');
            const meta = card.querySelector('.wg-meds-next-intake-card__meta');
            expect(kicker).not.toBeNull();
            expect(time).not.toBeNull();
            expect(meta).not.toBeNull();
            expect(kicker.textContent).toBe('Next scheduled intake');
            expect(meta.textContent).toContain('Aspirin, Vitamin D at ');

            const cta = card.querySelector('button.wg-toolbar-btn.wg-toolbar-btn--primary');
            expect(cta).not.toBeNull();
            expect(cta.classList.contains('wg-meds-next-intake-card__cta')).toBe(true);
            const label = cta.querySelector('.wg-toolbar-btn__label');
            expect(label).not.toBeNull();
            expect(label.textContent).toBe('Take Now');
        } finally {
            cleanup();
        }
    });

    it('#11b: .wg-meds-next-intake-card* CSS uses tokens only (no gradient, no hex colors)', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');

        // Extract every `.wg-meds-next-intake-card*` rule block.
        const blockRe = /\.wg-meds-next-intake-card[^{]*\{([^}]*)\}/g;
        const blocks = [];
        let match;
        while ((match = blockRe.exec(css)) !== null) {
            blocks.push({ head: match[0].slice(0, match[0].indexOf('{')).trim(), body: match[1] });
        }
        // Must have at least the 5 rules we added.
        expect(blocks.length).toBeGreaterThanOrEqual(5);

        for (const b of blocks) {
            expect(b.body, `linear-gradient found in ${b.head}`).not.toMatch(/linear-gradient\(/i);
            // Hex colors (#abc or #aabbcc) — any hex in the value is a violation.
            // The token convention is `var(--wg-*)` or similar.
            expect(b.body, `hex color found in ${b.head}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
            // Raw rgb()/rgba() also not expected on the restyled pane (tokens carry transparency via vars).
            expect(b.body, `raw rgba/rgb literal found in ${b.head}`).not.toMatch(/\brgba?\s*\(/);
        }
    });

    it('legacy .next-intake-* rules are removed from styles.css', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf8');
        // The old selectors must not be defined anywhere in the stylesheet.
        expect(css).not.toMatch(/^\s*\.next-intake-card\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-intake-title\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-intake-countdown\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-intake-details\s*\{/m);
        expect(css).not.toMatch(/^\s*\.next-intake-action\s*\{/m);
    });

    it('legacy .next-intake-* / btn-pill class assignments are gone from renderNextIntakeTrigger', () => {
        const source = fs.readFileSync(APP_JS_PATH, 'utf8');
        // Isolate the renderNextIntakeTrigger function body.
        const fnStart = source.indexOf('async function renderNextIntakeTrigger()');
        expect(fnStart).toBeGreaterThan(-1);
        // Grab ~3000 chars forward — big enough to span the full function.
        const fnSlice = source.slice(fnStart, fnStart + 3000);

        expect(fnSlice).not.toMatch(/['"]next-intake-card['"]/);
        expect(fnSlice).not.toMatch(/['"]next-intake-title['"]/);
        expect(fnSlice).not.toMatch(/['"]next-intake-countdown['"]/);
        expect(fnSlice).not.toMatch(/['"]next-intake-details['"]/);
        expect(fnSlice).not.toMatch(/['"]next-intake-action['"]/);
        expect(fnSlice).not.toMatch(/['"]btn-pill['"]/);

        // New classes present.
        expect(fnSlice).toMatch(/['"]wg-meds-next-intake-card['"]/);
        expect(fnSlice).toMatch(/wg-toolbar-btn wg-toolbar-btn--primary/);
    });
});
