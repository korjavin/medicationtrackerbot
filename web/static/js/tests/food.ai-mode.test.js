// "Parse with AI" food-modal mode (Plan 2026-05-17, Task 5).
//
// Pins the modal-level integration contract for the AI parse flow:
//   1. Regression: with the AI checkbox OFF, Save still POSTs to /api/food/log
//      via apiCall (existing manual path is untouched).
//   2. With the AI checkbox ON, Save POSTs the description text + ISO eaten_at
//      to /api/food/log/from-description via fetch (the new endpoint).
//   3. A multi-item response renders the shared food-photo-summary card with
//      one row per item.
//   4. Clicking Undo on that card triggers undoFoodAIItems, which fires the
//      expected DELETE /api/food/log/:id calls and transitions the card to
//      the "Removed N items" success state.
//   5. Partial undo failure surfaces the retry affordance (mirrors the photo
//      undo retry test in food.upload-photo.test.js).
//   6. Toggling AI mode applies the .wg-food-modal--ai-mode class on the
//      modal root (no inline .style.* assignments) and clears any stale
//      macro/weight/calories values entered before the toggle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

const SAMPLE_ITEMS = [
    { id: 21, name: 'Grilled chicken', weight: 200, carbs: 0,  protein: 60, fat: 8, calories: 330 },
    { id: 22, name: 'White rice',      weight: 158, carbs: 45, protein: 4,  fat: 0, calories: 200 },
];

describe('Food modal — "Parse with AI" mode (Plan 2026-05-17, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();

        env.window.userInitData = '';
        env.window.safeAlert = vi.fn();
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        // showAddFoodModal kicks off initFoodProductsCache().then(renderFoodAutocomplete)
        // which would otherwise resolve after the JSDOM env is closed and throw
        // an unhandled rejection ("Cannot read properties of undefined" on
        // document). Stub both so the autocomplete-init Promise resolves cleanly.
        env.window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        env.window.renderFoodAutocomplete = vi.fn();
        env.window.DataStore = env.window.DataStore || {};
        env.window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.clearCached = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.advanceCursorSilently = vi.fn();

        const video = env.document.getElementById('food-scanner-video');
        if (video) {
            video.pause = vi.fn();
            video.srcObject = null;
        }
    });

    afterEach(() => {
        try {
            env.document.querySelectorAll('.wg-food-photo-summary').forEach((el) => el.remove());
            env.window.localStorage.clear();
        } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('AI checkbox off: Save posts to /api/food/log (regression guard for the manual path)', async () => {
        const { document, window } = env;

        window.showAddFoodModal();
        document.getElementById('food-parse-ai').checked = false;
        document.getElementById('food-datetime').value = '2026-05-17T12:00';
        document.getElementById('food-name').value = 'Apple';
        document.getElementById('food-weight').value = '180';
        document.getElementById('food-per-100g').checked = false;
        document.getElementById('food-carbs').value = '25';
        document.getElementById('food-protein').value = '0';
        document.getElementById('food-fat').value = '0';
        document.getElementById('food-calories').value = '95';

        const apiSpy = vi.fn().mockResolvedValue({ ok: true });
        window.apiCall = apiSpy;
        const fetchSpy = vi.fn();
        window.fetch = fetchSpy;

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        expect(apiSpy).toHaveBeenCalledWith(
            '/api/food/log',
            'POST',
            expect.objectContaining({ name: 'Apple', weight: 180, calories: 95 })
        );
        // The AI endpoint goes through fetch(), not apiCall; ensure it wasn't hit.
        const aiFetch = fetchSpy.mock.calls.find(([url]) => url === '/api/food/log/from-description');
        expect(aiFetch).toBeUndefined();
    });

    it('AI checkbox on: Save posts description + ISO eaten_at to /api/food/log/from-description', async () => {
        const { document, window } = env;

        window.showAddFoodModal();
        document.getElementById('food-parse-ai').checked = true;
        // The bound change handler clears macro/weight fields, but here we
        // also exercise it explicitly so the wrapper class is applied.
        document.getElementById('food-parse-ai').dispatchEvent(new window.Event('change'));

        document.getElementById('food-datetime').value = '2026-05-17T13:00';
        document.getElementById('food-name').value = '200g grilled chicken with a cup of rice';

        const apiSpy = vi.fn();
        window.apiCall = apiSpy;
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            async json() { return { items: SAMPLE_ITEMS }; },
            async text() { return JSON.stringify({ items: SAMPLE_ITEMS }); },
        });
        window.fetch = fetchSpy;

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const aiCall = fetchSpy.mock.calls.find(
            ([url, opts]) => url === '/api/food/log/from-description' && opts && opts.method === 'POST'
        );
        expect(aiCall).toBeDefined();

        const body = JSON.parse(aiCall[1].body);
        expect(body.description).toBe('200g grilled chicken with a cup of rice');
        expect(typeof body.eaten_at).toBe('string');
        // eaten_at should be an ISO-8601 string parseable as a Date.
        expect(Number.isNaN(new Date(body.eaten_at).getTime())).toBe(false);

        // Manual endpoint must not be hit on the AI path.
        expect(apiSpy).not.toHaveBeenCalledWith('/api/food/log', 'POST', expect.anything());
    });

    it('AI multi-item response renders the summary card with one row per item', async () => {
        const { document, window } = env;

        window.showAddFoodModal();
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-parse-ai').dispatchEvent(new window.Event('change'));
        document.getElementById('food-datetime').value = '2026-05-17T13:00';
        document.getElementById('food-name').value = 'two-item meal';

        window.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            async json() { return { items: SAMPLE_ITEMS }; },
            async text() { return JSON.stringify({ items: SAMPLE_ITEMS }); },
        });

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();
        const rows = card.querySelectorAll('.wg-food-photo-summary__item');
        expect(rows.length).toBe(SAMPLE_ITEMS.length);

        // Cache invalidation + list refresh fired (same as photo flow).
        expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['food']);
        expect(window.loadFoodLogs).toHaveBeenCalled();
        expect(window.loadToday).toHaveBeenCalled();
    });

    it('Undo on the AI summary card fires DELETE per item and shows "Removed N items"', async () => {
        const { document, window } = env;

        window.showAddFoodModal();
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-parse-ai').dispatchEvent(new window.Event('change'));
        document.getElementById('food-datetime').value = '2026-05-17T13:00';
        document.getElementById('food-name').value = 'two-item meal';

        const fetchSpy = vi.fn().mockImplementation((url, opts) => {
            if (opts && opts.method === 'POST') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    async json() { return { items: SAMPLE_ITEMS }; },
                    async text() { return JSON.stringify({ items: SAMPLE_ITEMS }); },
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                async json() { return {}; },
                async text() { return ''; },
            });
        });
        window.fetch = fetchSpy;

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-food-photo-summary__undo');
        expect(undoBtn).not.toBeNull();

        window.loadFoodLogs.mockClear();
        window.loadToday.mockClear();

        undoBtn.click();
        await flushPromises();
        await flushPromises();

        const deleteCalls = fetchSpy.mock.calls.filter(
            ([, opts]) => opts && opts.method === 'DELETE',
        );
        expect(deleteCalls.length).toBe(SAMPLE_ITEMS.length);
        const urls = deleteCalls.map(([url]) => url).sort();
        expect(urls).toEqual(['/api/food/log/21', '/api/food/log/22']);

        // Card transitions to the success state.
        const stillCard = document.querySelector('.wg-food-photo-summary');
        expect(stillCard).not.toBeNull();
        const message = stillCard.querySelector('.wg-food-photo-summary__message');
        expect(message).not.toBeNull();
        expect(message.textContent).toBe('Removed 2 items');

        // List refresh fired on the Undo success path.
        expect(window.loadFoodLogs).toHaveBeenCalled();
        expect(window.loadToday).toHaveBeenCalled();
    });

    it('Partial undo failure surfaces the retry affordance', async () => {
        const { document, window } = env;

        window.showAddFoodModal();
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-parse-ai').dispatchEvent(new window.Event('change'));
        document.getElementById('food-datetime').value = '2026-05-17T13:00';
        document.getElementById('food-name').value = 'two-item meal';

        const fetchSpy = vi.fn().mockImplementation((url, opts) => {
            if (opts && opts.method === 'POST') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    async json() { return { items: SAMPLE_ITEMS }; },
                    async text() { return JSON.stringify({ items: SAMPLE_ITEMS }); },
                });
            }
            if (opts && opts.method === 'DELETE' && url === '/api/food/log/22') {
                return Promise.resolve({ ok: false, status: 500, async text() { return ''; }, async json() { return {}; } });
            }
            return Promise.resolve({ ok: true, status: 200, async text() { return ''; }, async json() { return {}; } });
        });
        window.fetch = fetchSpy;

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-food-photo-summary__undo');

        undoBtn.click();
        await flushPromises();
        await flushPromises();

        const errorMsg = document.querySelector('.wg-food-photo-summary__message--error');
        expect(errorMsg).not.toBeNull();
        expect(errorMsg.textContent).toMatch(/could not undo/i);

        const retry = document.querySelector('.wg-food-photo-summary__retry');
        expect(retry).not.toBeNull();
    });

    it('AI checkbox toggle applies the wrapper class and clears stale macro/weight fields', () => {
        const { document, window } = env;

        window.showAddFoodModal();

        // Pre-populate the manual fields, as if the user started filling them
        // before flipping to AI mode.
        document.getElementById('food-weight').value = '180';
        document.getElementById('food-carbs').value = '25';
        document.getElementById('food-protein').value = '8';
        document.getElementById('food-fat').value = '2';
        document.getElementById('food-calories').value = '300';
        document.getElementById('food-barcode').value = '1234567890123';

        const modal = document.getElementById('food-modal');
        expect(modal.classList.contains('wg-food-modal--ai-mode')).toBe(false);

        // Flip AI mode on via the bound change listener.
        const checkbox = document.getElementById('food-parse-ai');
        checkbox.checked = true;
        checkbox.dispatchEvent(new window.Event('change'));

        // Wrapper class is the visibility lever — must be applied via class
        // toggling, not inline styles.
        expect(modal.classList.contains('wg-food-modal--ai-mode')).toBe(true);
        // None of the affected fields should carry an inline style attribute.
        ['food-weight', 'food-barcode', 'food-carbs', 'food-protein', 'food-fat', 'food-calories'].forEach((id) => {
            const el = document.getElementById(id);
            expect(el.getAttribute('style')).toBeNull();
            // Stale values cleared on toggle.
            expect(el.value).toBe('');
        });

        // Flip back off — wrapper class is removed.
        checkbox.checked = false;
        checkbox.dispatchEvent(new window.Event('change'));
        expect(modal.classList.contains('wg-food-modal--ai-mode')).toBe(false);
    });

    it('Edit mode disables the AI checkbox and routes Save through the manual update path even if the box is force-checked', async () => {
        const { document, window } = env;

        window.FoodLog.setLog(99, {
            id: 99,
            name: 'Apple',
            weight: 150,
            carbs: 20,
            protein: 1,
            fat: 0,
            calories: 80,
            eaten_at: '2026-05-17T12:00:00Z',
        });

        window.editFoodLog(99);

        const checkbox = document.getElementById('food-parse-ai');
        expect(checkbox.disabled).toBe(true);

        // Force the checkbox to "checked" to simulate a stale UI state; the
        // saveFoodLog guard must still take the manual PUT path because an
        // edit has a non-empty #food-id.
        checkbox.disabled = false;
        checkbox.checked = true;

        const fetchSpy = vi.fn();
        window.fetch = fetchSpy;
        const apiSpy = vi.fn().mockResolvedValue({ status: 'updated' });
        window.apiCall = apiSpy;

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(apiSpy).toHaveBeenCalledWith('/api/food/log/99', 'PUT', expect.anything());
    });

    it('Add modal resets the AI checkbox to enabled', () => {
        const { document, window } = env;

        // Open in edit mode first — that disables the checkbox.
        window.FoodLog.setLog(100, { id: 100, name: 'Pear', weight: 100, carbs: 15, protein: 0, fat: 0, calories: 60, eaten_at: '2026-05-17T12:00:00Z' });
        window.editFoodLog(100);
        expect(document.getElementById('food-parse-ai').disabled).toBe(true);

        // Now open the Add modal — the checkbox must be re-enabled.
        window.showAddFoodModal();
        expect(document.getElementById('food-parse-ai').disabled).toBe(false);
    });
});
