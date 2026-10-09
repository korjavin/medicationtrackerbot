import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const STYLES_CSS = path.join(REPO_ROOT, 'web/static/css/styles.css');

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

describe('Settings Food Targets section (Phase 9, Task 6)', () => {
    it('renders the Food Targets card as a wg-card with a mono title and description', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const card = dom.window.document.getElementById('food-target-settings');
            expect(card).not.toBeNull();
            expect(card.classList.contains('wg-card')).toBe(true);
            expect(card.classList.contains('wg-settings-section')).toBe(true);

            const title = card.querySelector('.wg-settings-section__title');
            expect(title).not.toBeNull();
            expect(title.textContent.trim()).toBe('Food Targets');

            const desc = card.querySelector('.wg-settings-section__desc');
            expect(desc).not.toBeNull();
            expect(desc.textContent.toLowerCase()).toContain('calories');
            expect(desc.textContent.toLowerCase()).toContain('macronutrients');
        } finally {
            cleanup();
        }
    });

    it('drops paper-era .setting-item / .bp-inputs-row / .bp-input-group markup from the card', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const card = dom.window.document.getElementById('food-target-settings');
            expect(card.classList.contains('setting-item')).toBe(false);
            expect(card.querySelector('.bp-inputs-row')).toBeNull();
            expect(card.querySelector('.bp-input-group')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('lays out the four inputs in a 2×2 .wg-settings-number-grid', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const card = dom.window.document.getElementById('food-target-settings');
            const grid = card.querySelector('.wg-settings-number-grid');
            expect(grid).not.toBeNull();

            const fields = grid.querySelectorAll('.wg-settings-number-field');
            expect(fields.length).toBe(4);

            const ids = Array.from(grid.querySelectorAll('.wg-settings-number-field__input')).map((i) => i.id);
            expect(ids).toEqual([
                'food-target-calories',
                'food-target-carbs',
                'food-target-protein',
                'food-target-fat',
            ]);
        } finally {
            cleanup();
        }
    });

    it('each number field wraps its input in a .wg-gloss--inset with a mono label + unit tag', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const doc = dom.window.document;
            const card = doc.getElementById('food-target-settings');
            const fields = card.querySelectorAll('.wg-settings-number-field');

            const expectedUnits = {
                'food-target-calories': 'kcal',
                'food-target-carbs': 'g',
                'food-target-protein': 'g',
                'food-target-fat': 'g',
            };

            for (const field of fields) {
                const input = field.querySelector('input[type="number"]');
                expect(input).not.toBeNull();
                expect(input.classList.contains('wg-settings-number-field__input')).toBe(true);

                const label = field.querySelector('.wg-settings-number-field__label');
                expect(label).not.toBeNull();
                expect(label.getAttribute('for')).toBe(input.id);

                const wrap = input.closest('.wg-gloss--inset');
                expect(wrap).not.toBeNull();
                expect(wrap.classList.contains('wg-settings-number-field__wrap')).toBe(true);

                const unit = wrap.querySelector('.wg-settings-number-field__unit');
                expect(unit).not.toBeNull();
                expect(unit.textContent.trim()).toBe(expectedUnits[input.id]);
            }
        } finally {
            cleanup();
        }
    });

    it('the Targets page has no per-section Save buttons — the page bar carries the one Save (med-xso6.23)', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const page = dom.window.document.querySelector('[data-settings-page="targets"]');
            expect(page.querySelector('#food-target-settings')).not.toBeNull();
            expect(page.querySelector('#gamification-targets-settings')).not.toBeNull();
            expect(page.querySelectorAll('button').length).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('Food Targets markup carries no inline style= attributes', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const card = dom.window.document.getElementById('food-target-settings');
            expect(card.getAttribute('style')).toBeNull();
            const withInlineStyle = card.querySelectorAll('[style]');
            expect(withInlineStyle.length).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('defines .wg-settings-number-grid, .wg-settings-number-field, and .wg-settings-save-btn in styles.css', () => {
        const css = fs.readFileSync(STYLES_CSS, 'utf8');
        expect(css).toMatch(/\.wg-settings-number-grid\s*\{/);
        expect(css).toMatch(/\.wg-settings-number-field\s*\{/);
        expect(css).toMatch(/\.wg-settings-number-field__label\s*\{/);
        expect(css).toMatch(/\.wg-settings-number-field__wrap\s*\{/);
        expect(css).toMatch(/\.wg-settings-number-field__input\s*\{/);
        expect(css).toMatch(/\.wg-settings-number-field__unit\s*\{/);
        expect(css).toMatch(/\.wg-settings-save-btn\s*\{/);
    });
});
describe('Food Targets round-trip through loadFoodTargets / saveFoodTargets (Phase 9, Task 6)', () => {
    let consoleErrorSpy;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('loadFoodTargets pre-fills all four inputs from the fresh API payload', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.DataStore.getCached = vi.fn().mockResolvedValue(null);
            window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
            window.apiCall = vi.fn().mockResolvedValue({
                calories: 1700,
                carbs: 180,
                protein: 120,
                fat: 60,
            });

            await window.loadFoodTargets();

            expect(document.getElementById('food-target-calories').value).toBe('1700');
            expect(document.getElementById('food-target-carbs').value).toBe('180');
            expect(document.getElementById('food-target-protein').value).toBe('120');
            expect(document.getElementById('food-target-fat').value).toBe('60');
        } finally {
            cleanup();
        }
    });

    it('loadFoodTargets renders empty strings when targets are zero/empty', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.DataStore.getCached = vi.fn().mockResolvedValue(null);
            window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
            window.apiCall = vi.fn().mockResolvedValue({
                calories: 0, carbs: 0, protein: 0, fat: 0,
            });

            await window.loadFoodTargets();

            expect(document.getElementById('food-target-calories').value).toBe('');
            expect(document.getElementById('food-target-carbs').value).toBe('');
            expect(document.getElementById('food-target-protein').value).toBe('');
            expect(document.getElementById('food-target-fat').value).toBe('');
        } finally {
            cleanup();
        }
    });

    it('the Targets page Save writes Journey bands and food targets once, toasts once and closes (med-xso6.23)', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.featureSettings = { food: true, gamification: true };
            window.SettingsView.updateFeatureTabVisibility();

            document.getElementById('food-target-calories').value = '1900';
            document.getElementById('food-target-carbs').value = '200';
            document.getElementById('food-target-protein').value = '130';
            document.getElementById('food-target-fat').value = '70';
            document.getElementById('gam-target-steps-low').value = '6000';

            const apiCallSpy = vi.fn(async (url, method) => {
                if (method !== 'PUT') return { ok: true };
                // The Journey save's optimistic tab reload re-fills the food
                // inputs from the cached bundle mid-flight; the food POST must
                // still carry what the user typed.
                document.getElementById('food-target-calories').value = '1800';
                return { enabled: true, targets: [] };
            });
            window.apiCall = apiCallSpy;
            window.safeAlert = vi.fn();
            window.loadFoodLogs = vi.fn();
            const optimisticSpy = vi.spyOn(window.DataStore, 'applyOptimistic');

            const page = window.SettingsView.openSettingsPage('targets');
            expect(page.el.querySelector('#food-target-settings')).not.toBeNull();
            const saves = page.el.querySelectorAll('.wg-pagebar .wg-btn--primary');
            expect(saves.length).toBe(1);
            saves[0].click();
            await vi.waitFor(() => expect(page.el.isConnected).toBe(false));

            const put = apiCallSpy.mock.calls.find((c) => c[0] === '/api/gamification/targets' && c[1] === 'PUT');
            expect(put[2]).toEqual({ targets: [{ metric_key: 'steps', low_val: 6000 }] });
            const post = apiCallSpy.mock.calls.find((c) => c[0] === '/api/food/settings/targets' && c[1] === 'POST');
            expect(post[2]).toEqual({ calories: 1900, carbs: 200, protein: 130, fat: 70 });
            expect(optimisticSpy.mock.calls.map((c) => c[0])).toEqual(['gamification', 'food_targets']);
            expect(window.safeAlert).toHaveBeenCalledTimes(1);
            expect(window.safeAlert).toHaveBeenCalledWith('Targets saved');
            // The page body went back to the hidden store, ids intact.
            expect(document.querySelector('.wg-settings-pages #food-target-settings')).not.toBeNull();
        } finally {
            cleanup();
        }
    });

    it('a refused Journey band keeps the Targets page open and writes nothing', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.featureSettings = { food: true, gamification: true };
            window.SettingsView.updateFeatureTabVisibility();
            document.getElementById('gam-target-steps-low').value = '9000';
            document.getElementById('gam-target-steps-high').value = '100';
            window.apiCall = vi.fn().mockResolvedValue({ ok: true });
            window.safeAlert = vi.fn();

            const page = window.SettingsView.openSettingsPage('targets');
            expect(await window.SettingsView.saveTargets()).toBe(false);
            expect(window.apiCall).not.toHaveBeenCalled();
            expect(page.el.isConnected).toBe(true);
            page.close();
        } finally {
            cleanup();
        }
    });

    it('saveFoodTargets leaves the inputs populated after an API failure so the user can retry', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            document.getElementById('food-target-calories').value = '1800';
            document.getElementById('food-target-carbs').value = '190';
            document.getElementById('food-target-protein').value = '125';
            document.getElementById('food-target-fat').value = '65';

            window.apiCall = vi.fn().mockRejectedValue(new Error('offline'));
            window.safeAlert = vi.fn();
            window.loadFoodLogs = vi.fn();

            await window.saveFoodTargets();

            expect(document.getElementById('food-target-calories').value).toBe('1800');
            expect(document.getElementById('food-target-carbs').value).toBe('190');
            expect(document.getElementById('food-target-protein').value).toBe('125');
            expect(document.getElementById('food-target-fat').value).toBe('65');
            expect(window.safeAlert).toHaveBeenCalledWith('Failed to save food targets');
        } finally {
            cleanup();
        }
    });
});
