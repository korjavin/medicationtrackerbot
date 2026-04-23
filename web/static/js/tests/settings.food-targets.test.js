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
const WG_SETTINGS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-settings.js');

function loadIndex() {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const dom = new JSDOM(html, { url: 'https://example.test/' });
    return { dom, cleanup: () => dom.window.close() };
}

function loadWGSettings() {
    const dom = new JSDOM('<!DOCTYPE html>', { url: 'https://example.test/', runScripts: 'outside-only' });
    const { window } = dom;
    const src = fs.readFileSync(WG_SETTINGS_JS, 'utf8');
    window.eval(src);
    return { window, cleanup: () => dom.window.close() };
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

    it('renders the Save button as wg-gloss + wg-gloss--sun + wg-settings-save-btn (no btn-secondary)', () => {
        const { dom, cleanup } = loadIndex();
        try {
            const btn = dom.window.document.getElementById('save-food-targets-btn');
            expect(btn).not.toBeNull();
            expect(btn.classList.contains('wg-gloss')).toBe(true);
            expect(btn.classList.contains('wg-gloss--sun')).toBe(true);
            expect(btn.classList.contains('wg-settings-save-btn')).toBe(true);
            expect(btn.classList.contains('btn-secondary')).toBe(false);
            expect(btn.classList.contains('btn')).toBe(false);
            expect(btn.textContent.trim()).toBe('Save Targets');
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

describe('WGSettings.numberField factory (Phase 9, Task 6)', () => {
    it('is exposed on window.WGSettings', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            expect(typeof window.WGSettings.numberField).toBe('function');
        } finally {
            cleanup();
        }
    });

    it('renders a .wg-settings-number-field with label + inset wrap + numeric input', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.numberField({
                id: 'food-target-calories',
                label: 'Calories',
                unit: 'kcal',
                placeholder: '1700',
            });
            expect(el.classList.contains('wg-settings-number-field')).toBe(true);

            const label = el.querySelector('.wg-settings-number-field__label');
            expect(label).not.toBeNull();
            expect(label.textContent).toBe('Calories');
            expect(label.getAttribute('for')).toBe('food-target-calories');

            const wrap = el.querySelector('.wg-gloss--inset');
            expect(wrap).not.toBeNull();
            expect(wrap.classList.contains('wg-settings-number-field__wrap')).toBe(true);

            const input = wrap.querySelector('input');
            expect(input).not.toBeNull();
            expect(input.type).toBe('number');
            expect(input.id).toBe('food-target-calories');
            expect(input.getAttribute('placeholder')).toBe('1700');
            expect(input.getAttribute('min')).toBe('0');

            const unit = wrap.querySelector('.wg-settings-number-field__unit');
            expect(unit).not.toBeNull();
            expect(unit.textContent).toBe('kcal');
        } finally {
            cleanup();
        }
    });

    it('omits the label element when no label is provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.numberField({ id: 'x' });
            expect(el.querySelector('.wg-settings-number-field__label')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('omits the unit tag when no unit is provided', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.numberField({ id: 'x', label: 'Raw' });
            expect(el.querySelector('.wg-settings-number-field__unit')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('escapes text content (no HTML injection via label/unit)', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.numberField({
                id: 'x',
                label: '<img src=x onerror=pwn>',
                unit: '<script>alert(1)</script>',
            });
            expect(el.querySelector('.wg-settings-number-field__label img')).toBeNull();
            expect(el.querySelector('.wg-settings-number-field__unit script')).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('handles no args gracefully (empty field skeleton)', () => {
        const { window, cleanup } = loadWGSettings();
        try {
            const el = window.WGSettings.numberField();
            expect(el.classList.contains('wg-settings-number-field')).toBe(true);
            const input = el.querySelector('input[type="number"]');
            expect(input).not.toBeNull();
            expect(input.id).toBe('');
        } finally {
            cleanup();
        }
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

    it('clicking the Save Targets button POSTs the input values to /api/food/settings/targets', async () => {
        const { window, document, cleanup } = loadFrontendEnv();
        try {
            window.DataStore.getCached = vi.fn().mockResolvedValue(null);
            window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

            document.getElementById('food-target-calories').value = '1900';
            document.getElementById('food-target-carbs').value = '200';
            document.getElementById('food-target-protein').value = '130';
            document.getElementById('food-target-fat').value = '70';

            const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
            window.apiCall = apiCallSpy;
            window.safeAlert = vi.fn();
            window.loadFoodLogs = vi.fn();

            const saveBtn = document.getElementById('save-food-targets-btn');
            saveBtn.click();
            await new Promise((r) => setTimeout(r, 0));

            const postCall = apiCallSpy.mock.calls.find(
                (c) => c[0] === '/api/food/settings/targets' && c[1] === 'POST'
            );
            expect(postCall).toBeDefined();
            expect(postCall[2]).toEqual({
                calories: 1900,
                carbs: 200,
                protein: 130,
                fat: 70,
            });
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
