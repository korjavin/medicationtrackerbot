// "Parse with AI" food-modal mode (Plan 2026-05-17, Task 5).
//
// Pins the modal-level integration contract for the AI parse flow:
//   1. Regression: with the AI checkbox OFF, Save still POSTs to /api/food/log
//      via apiCall (existing manual path is untouched).
//   2. With the AI checkbox ON, Save parses the description text + eaten_at
//      via window.CloudFoodAI.parseMealFromDescription (browser-direct).
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
import { idle } from './helpers/settle.js';

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
        env = loadFrontendEnv({ withSync: true });

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

        const video = env.document.getElementById('food-scanner-video');
        if (video) {
            video.pause = vi.fn();
            video.srcObject = null;
        }
    });

    afterEach(() => {
        // Unconditional — a test that installs fake timers and then times out
        // never reaches its own restore, and faked timers leaking into the next
        // test hang it too (the med-tc1.9 cross-test-leak lesson).
        vi.useRealTimers();
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
        const parse = vi.fn();
        window.CloudFoodAI = { parseMealFromDescription: parse };

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        expect(apiSpy).toHaveBeenCalledWith(
            '/api/food/log',
            'POST',
            expect.objectContaining({ name: 'Apple', weight: 180, calories: 95 })
        );
        // The AI path goes through CloudFoodAI, not apiCall; ensure it wasn't hit.
        expect(parse).not.toHaveBeenCalled();
    });

    it('AI checkbox on: Save parses description + eaten_at via CloudFoodAI', async () => {
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
        const parse = vi.fn(async () => ({ items: SAMPLE_ITEMS, failed: 0 }));
        window.CloudFoodAI = { parseMealFromDescription: parse };

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        expect(parse).toHaveBeenCalledTimes(1);
        const [description, opts] = parse.mock.calls[0];
        expect(description).toBe('200g grilled chicken with a cup of rice');
        // eaten_at arrives as a Date built from the modal's datetime input.
        // Realm-safe check: the Date is constructed inside the JSDOM window,
        // so Node-realm instanceof never matches — probe behaviour instead.
        expect(typeof opts.eatenAt.toISOString).toBe('function');
        expect(Number.isNaN(opts.eatenAt.getTime())).toBe(false);

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

        window.CloudFoodAI = { parseMealFromDescription: vi.fn(async () => ({ items: SAMPLE_ITEMS, failed: 0 })) };

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-toast__text').firstChild.textContent).toBe(`${SAMPLE_ITEMS.length} items logged`);

        // Cache invalidation + list refresh fired (same as photo flow).
        expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['food', 'gamification']);
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

        window.CloudFoodAI = { parseMealFromDescription: vi.fn(async () => ({ items: SAMPLE_ITEMS, failed: 0 })) };
        const apiSpy = vi.fn(async () => ({ status: 'deleted' }));
        window.apiCall = apiSpy;

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-toast__undo');
        expect(undoBtn).not.toBeNull();

        window.loadFoodLogs.mockClear();
        window.loadToday.mockClear();

        undoBtn.click();
        await flushPromises();
        await flushPromises();

        const deleteCalls = apiSpy.mock.calls.filter(
            ([, method]) => method === 'DELETE',
        );
        expect(deleteCalls.length).toBe(SAMPLE_ITEMS.length);
        const urls = deleteCalls.map(([url]) => url).sort();
        expect(urls).toEqual(['/api/food/log/21', '/api/food/log/22']);

        // Card transitions to the success state.
        const stillCard = document.querySelector('.wg-food-photo-summary');
        expect(stillCard).not.toBeNull();
        const message = stillCard.querySelector('.wg-toast__text');
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

        window.CloudFoodAI = { parseMealFromDescription: vi.fn(async () => ({ items: SAMPLE_ITEMS, failed: 0 })) };
        window.apiCall = vi.fn().mockImplementation((url, method) => {
            if (method === 'DELETE' && url === '/api/food/log/22') {
                return Promise.resolve(null);
            }
            return Promise.resolve({ status: 'deleted' });
        });

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const card = document.querySelector('.wg-food-photo-summary');
        const undoBtn = card.querySelector('.wg-toast__undo');

        undoBtn.click();
        await flushPromises();
        await flushPromises();

        const errorMsg = document.querySelector('.wg-food-photo-summary.wg-toast--danger .wg-toast__text');
        expect(errorMsg).not.toBeNull();
        expect(errorMsg.textContent).toMatch(/could not undo/i);

        const retry = document.querySelector('.wg-food-photo-summary.wg-toast--danger .wg-toast__undo');
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

    it('AI toggle on clears any prior product_id/is_meal/link so the manual path can\'t resubmit a stale selection after toggling off', async () => {
        const { document, window } = env;

        window.showAddFoodModal();

        // Simulate a prior autocomplete selection: the hidden product_id/is_meal
        // are set and the link chip is visible.
        document.getElementById('food-log-product-id').value = '777';
        document.getElementById('food-log-is-meal').value = 'true';
        const linkContainer = document.getElementById('food-product-link-container');
        const link = document.createElement('a');
        link.className = 'food-product-link';
        link.textContent = '→ View in Products';
        linkContainer.replaceChildren(link);
        linkContainer.classList.remove('hidden');

        // Flip AI mode on.
        const checkbox = document.getElementById('food-parse-ai');
        checkbox.checked = true;
        checkbox.dispatchEvent(new window.Event('change'));

        expect(document.getElementById('food-log-product-id').value).toBe('');
        expect(document.getElementById('food-log-is-meal').value).toBe('');
        expect(linkContainer.classList.contains('hidden')).toBe(true);
        expect(linkContainer.children.length).toBe(0);

        // Flip back off, fill the manual fields, hit Save — the payload must
        // NOT carry the stale product_id from before the round-trip.
        checkbox.checked = false;
        checkbox.dispatchEvent(new window.Event('change'));

        document.getElementById('food-datetime').value = '2026-05-17T12:00';
        document.getElementById('food-name').value = 'something else';
        document.getElementById('food-weight').value = '100';
        document.getElementById('food-per-100g').checked = false;
        document.getElementById('food-carbs').value = '10';
        document.getElementById('food-protein').value = '5';
        document.getElementById('food-fat').value = '1';
        document.getElementById('food-calories').value = '80';

        const apiSpy = vi.fn().mockResolvedValue({ ok: true });
        window.apiCall = apiSpy;

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();
        await flushPromises();

        const postCall = apiSpy.mock.calls.find(
            ([url, method]) => url === '/api/food/log' && method === 'POST'
        );
        expect(postCall).toBeDefined();
        const payload = postCall[2];
        expect(payload).not.toHaveProperty('product_id');
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

    it('Entering AI mode cancels a pending barcode-search debounce so it can\'t autofill product_id', async () => {
        const { document, window } = env;

        window.showAddFoodModal();

        // Capture barcode searches so we can assert none of them runs after
        // the toggle. The pending debounce should be cancelled outright.
        // (A match for the pre-toggle barcode would autofill product_id.)
        const search = vi.fn(async () => [
            { id: 999, name: 'Stale', barcode: '1234567890123', carbs_100g: 1, protein_100g: 1, fat_100g: 1, energy_kcal_100g: 100 }
        ]);
        window.CloudFoodSearch = { search, remoteConfigured: async () => true };

        // med-tc1.10 — DRIVE the 800ms debounce instead of out-waiting it. The
        // old `setTimeout(r, 900)` was both the suite's slowest single line and
        // a wall-clock bet that a cancelled timer had had its chance to misfire.
        // Fake timers turn "the debounce window has fully elapsed" into a fact,
        // and advanceTimersByTimeAsync drains microtasks between each fired
        // timer, so an uncancelled debounce would have run its whole async body
        // (fetch → stream read → autofill) before the assertions below.
        // Installed after showAddFoodModal so only the debounce is faked, and
        // scoped to setTimeout/clearTimeout ONLY: vitest's default toFake also
        // takes setImmediate, which idle() below rides on. afterEach restores.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        // Simulate the user typing a barcode that schedules a debounce.
        const barcodeInput = document.getElementById('food-barcode');
        barcodeInput.value = '1234567890123';
        barcodeInput.dispatchEvent(new window.Event('input'));

        // Before the 800ms debounce fires, flip AI mode on.
        const checkbox = document.getElementById('food-parse-ai');
        checkbox.checked = true;
        checkbox.dispatchEvent(new window.Event('change'));

        await vi.advanceTimersByTimeAsync(900);
        await idle();

        // No search request was issued — pending debounce was cancelled.
        expect(search).not.toHaveBeenCalled();

        // product_id stays empty — autofillFoodProduct never ran.
        expect(document.getElementById('food-log-product-id').value).toBe('');
        // Barcode field was cleared by the AI-mode toggle.
        expect(barcodeInput.value).toBe('');
    });

    // bd med-yor.2 Task 4: in cloud mode the trial gate can refuse the parse
    // with trial_consent_required; the call site routes through
    // TrialConsent.retryAfterConsent so Allow reruns the parse exactly once
    // and a refusal surfaces the error without any retry.
    it('cloud AI parse shows the consent dialog on trial_consent_required and retries once after Allow', async () => {
        const { document, window } = env;

        const consentErr = Object.assign(new Error('needs consent'), {
            code: 'trial_consent_required', scope: 'ai',
        });
        const parse = vi.fn()
            .mockRejectedValueOnce(consentErr)
            .mockResolvedValueOnce({ items: [], failed: 0 });
        window.CloudFoodAI = { parseMealFromDescription: parse };
        window.apiCall = vi.fn(async (url, method, body) => {
            if (url === '/api/settings/trial-consent' && method === 'PATCH') {
                return { ai: true, voice: null, tg: null, updated_at: 1 };
            }
            return null;
        });

        window.showAddFoodModal();
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = '2026-05-17T13:00';
        document.getElementById('food-name').value = 'two eggs';

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();

        const dialog = document.querySelector('.wg-trial-consent-modal');
        expect(dialog).not.toBeNull();
        expect(parse).toHaveBeenCalledTimes(1);

        dialog.querySelector('[data-trial-consent-choice="allow"]').click();
        await flushPromises();
        await flushPromises();

        expect(parse).toHaveBeenCalledTimes(2);
        expect(window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: true });
        expect(window.safeAlert).not.toHaveBeenCalled();
    });

    it('cloud AI parse surfaces the refusal and does NOT retry when the consent dialog is declined', async () => {
        const { document, window } = env;
        // The refusal path logs the surfaced parse error; that's the assert
        // target here, not noise leaking from an unrelated code path.
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const consentErr = Object.assign(new Error('trial use needs your consent'), {
            code: 'trial_consent_required', scope: 'ai',
        });
        const parse = vi.fn().mockRejectedValue(consentErr);
        window.CloudFoodAI = { parseMealFromDescription: parse };
        window.apiCall = vi.fn(async () => ({ ai: false, voice: null, tg: null, updated_at: 1 }));

        window.showAddFoodModal();
        document.getElementById('food-parse-ai').checked = true;
        document.getElementById('food-datetime').value = '2026-05-17T13:00';
        document.getElementById('food-name').value = 'two eggs';

        document.getElementById('food-modal-save-btn').click();
        await flushPromises();

        const dialog = document.querySelector('.wg-trial-consent-modal');
        expect(dialog).not.toBeNull();
        dialog.querySelector('[data-trial-consent-choice="deny"]').click();
        await flushPromises();
        await flushPromises();

        expect(parse).toHaveBeenCalledTimes(1);
        expect(window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: false });
        expect(window.safeAlert).toHaveBeenCalledWith(expect.stringContaining('trial use needs your consent'));
        // Refusal prevents transmission: nothing was invalidated or reloaded.
        expect(window.DataStore.invalidateTags).not.toHaveBeenCalled();
        expect(window.loadFoodLogs).not.toHaveBeenCalled();
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
