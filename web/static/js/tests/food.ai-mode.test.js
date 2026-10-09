// Food Add sheet — Describe → review → Log (kit F5/F6, med-xso6.17).
//
// Replaces the old "Parse with AI" checkbox on the manual form. Pins:
//   1. Estimate parses the description through
//      window.CloudFoodAI.parseMealFromDescription with dryRun: true — nothing
//      is logged by the parse.
//   2. The review lists one row per parsed item; an `uncertain` item carries
//      a warn chip, a confident one does not.
//   3. Log commits the reviewed list through CloudFoodAI.logParsedItems, then
//      invalidates + reloads and shows the summary toast with Undo.
//   4. Undo on that toast fires DELETE per item; a partial failure surfaces
//      the retry affordance.
//   5. Removing a row in review drops it from what Log commits.
//   6. The trial-consent gate still wraps the parse (Allow retries once,
//      Deny surfaces the refusal and logs nothing).
//   7. The manual form has no AI checkbox any more.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';
import { idle } from './helpers/settle.js';

// Dry-run (parse-only) shape: totals + per-100g + uncertain (web/domain/foodai.js previewParsedMeal).
const PREVIEW = [
    { name: 'Grilled chicken', weight: 200, carbs: 0, protein: 60, fat: 8, calories: 312, carbs_100g: 0, protein_100g: 30, fat_100g: 4, uncertain: false },
    { name: 'White rice', weight: 158, carbs: 45, protein: 4, fat: 0, calories: 196, carbs_100g: 28.5, protein_100g: 2.5, fat_100g: 0, uncertain: true },
];
const SAVED = [
    { id: 21, name: 'Grilled chicken', weight: 200, carbs: 0, protein: 60, fat: 8, calories: 312 },
    { id: 22, name: 'White rice', weight: 158, carbs: 45, protein: 4, fat: 0, calories: 196 },
];

describe('Food Add sheet — Describe → review → Log (med-xso6.17)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withSync: true });
        env.window.safeAlert = vi.fn();
        env.window.loadFoodLogs = vi.fn();
        env.window.loadToday = vi.fn();
        env.window.initFoodProductsCache = vi.fn().mockResolvedValue(undefined);
        env.window.renderFoodAutocomplete = vi.fn();
        // The sheet's Recent list reads GET /api/food/log on open.
        env.window.apiCall = vi.fn(async () => null);
        env.window.DataStore = env.window.DataStore || {};
        env.window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.clearCached = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        try {
            env.document.querySelectorAll('.wg-food-photo-summary').forEach((el) => el.remove());
            env.window.localStorage.clear();
        } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    function stubAI(overrides = {}) {
        const ai = {
            parseMealFromDescription: vi.fn(async () => ({ status: 'parsed', items: PREVIEW.map((it) => ({ ...it })) })),
            logParsedItems: vi.fn(async () => ({ status: 'created', items: SAVED, failed: 0 })),
            ...overrides,
        };
        env.window.CloudFoodAI = ai;
        return ai;
    }

    async function estimate(text = '200g grilled chicken with a cup of rice') {
        const { document, window } = env;
        window.showAddFoodModal({ view: 'describe' });
        document.getElementById('food-add-describe-text').value = text;
        document.getElementById('food-add-primary-btn').click();
        await idle();
    }

    async function logReviewed() {
        env.document.getElementById('food-add-primary-btn').click();
        await idle();
    }

    it('Estimate parses the description with dryRun and logs nothing', async () => {
        const ai = stubAI();
        await estimate();

        expect(ai.parseMealFromDescription).toHaveBeenCalledTimes(1);
        const [description, opts] = ai.parseMealFromDescription.mock.calls[0];
        expect(description).toBe('200g grilled chicken with a cup of rice');
        expect(opts).toEqual(expect.objectContaining({ dryRun: true }));
        expect(ai.logParsedItems).not.toHaveBeenCalled();
        expect(env.window.apiCall).not.toHaveBeenCalledWith('/api/food/log', 'POST', expect.anything());
        expect(env.document.getElementById('food-add-sheet').dataset.view).toBe('review');
    });

    it('an empty description alerts and does not parse', async () => {
        const ai = stubAI();
        await estimate('   ');
        expect(env.window.safeAlert).toHaveBeenCalledWith('Please describe your meal.');
        expect(ai.parseMealFromDescription).not.toHaveBeenCalled();
    });

    it('review lists one row per item; only the uncertain one carries a warn chip', async () => {
        stubAI();
        await estimate();
        const { document } = env;

        const rows = document.querySelectorAll('#food-add-review-list .wg-food-add__review-row');
        expect(rows.length).toBe(2);
        expect(rows[0].querySelector('.wg-chip--warn')).toBeNull();
        const chip = rows[1].querySelector('.wg-chip--warn');
        expect(chip).not.toBeNull();
        expect(chip.textContent).toBe('estimate');
        expect(document.getElementById('food-add-review-total').textContent).toBe('508 kcal');
        expect(document.getElementById('food-add-primary-btn').textContent).toBe('Log 2 items');
    });

    it('Log commits the reviewed items via logParsedItems, reloads, and shows the Undo summary', async () => {
        const ai = stubAI();
        await estimate();
        await logReviewed();
        const { document, window } = env;

        expect(ai.logParsedItems).toHaveBeenCalledTimes(1);
        const [items, opts] = ai.logParsedItems.mock.calls[0];
        expect(items.map((it) => it.name)).toEqual(['Grilled chicken', 'White rice']);
        expect(items[1]).toEqual(expect.objectContaining({ weight: 158, carbs_100g: 28.5 }));
        expect(typeof opts.eatenAt).toBe('number');

        expect(window.DataStore.invalidateTags).toHaveBeenCalledWith(['food', 'gamification']);
        expect(window.loadFoodLogs).toHaveBeenCalled();
        expect(window.loadToday).toHaveBeenCalled();
        expect(document.getElementById('food-add-sheet').classList.contains('hidden')).toBe(true);

        const card = document.querySelector('.wg-food-photo-summary');
        expect(card).not.toBeNull();
        expect(card.querySelector('.wg-toast__text').firstChild.textContent).toBe('2 items logged');
        expect(card.textContent).toContain('from description');
        expect(card.querySelector('.wg-toast__undo')).not.toBeNull();
    });

    it('a row removed in review is not committed', async () => {
        const ai = stubAI();
        await estimate();
        env.window.FoodLog.addSheet.state.review.splice(0, 1);
        await logReviewed();
        const [items] = ai.logParsedItems.mock.calls[0];
        expect(items.map((it) => it.name)).toEqual(['White rice']);
    });

    it('Undo on the summary fires DELETE per item and shows "Removed N items"', async () => {
        stubAI();
        await estimate();
        await logReviewed();
        const { document, window } = env;
        const apiSpy = vi.fn(async () => ({ status: 'deleted' }));
        window.apiCall = apiSpy;
        window.loadFoodLogs.mockClear();

        document.querySelector('.wg-food-photo-summary .wg-toast__undo').click();
        await idle();

        const urls = apiSpy.mock.calls.filter(([, m]) => m === 'DELETE').map(([u]) => u).sort();
        expect(urls).toEqual(['/api/food/log/21', '/api/food/log/22']);
        expect(document.querySelector('.wg-food-photo-summary .wg-toast__text').textContent).toBe('Removed 2 items');
        expect(window.loadFoodLogs).toHaveBeenCalled();
    });

    it('partial undo failure surfaces the retry affordance', async () => {
        stubAI();
        await estimate();
        await logReviewed();
        const { document, window } = env;
        window.apiCall = vi.fn(async (url, method) => (method === 'DELETE' && url === '/api/food/log/22' ? null : { status: 'deleted' }));

        document.querySelector('.wg-food-photo-summary .wg-toast__undo').click();
        await idle();

        const err = document.querySelector('.wg-food-photo-summary.wg-toast--danger .wg-toast__text');
        expect(err).not.toBeNull();
        expect(err.textContent).toMatch(/could not undo/i);
        expect(document.querySelector('.wg-food-photo-summary.wg-toast--danger .wg-toast__undo')).not.toBeNull();
    });

    it('a failed Log rolls back and keeps the sheet open', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        stubAI({ logParsedItems: vi.fn(async () => { throw new Error('vault locked'); }) });
        await estimate();
        await logReviewed();
        const { document, window } = env;
        expect(document.querySelector('.wg-toast--danger .wg-toast__text').textContent).toContain('vault locked');
        expect(window.DataStore.invalidateTags).not.toHaveBeenCalled();
        expect(document.getElementById('food-add-sheet').classList.contains('hidden')).toBe(false);
    });

    // bd med-yor.2 Task 4: the trial gate can refuse the parse with
    // trial_consent_required; Allow reruns it once, Deny surfaces the refusal.
    it('trial_consent_required shows the consent dialog and retries the parse once after Allow', async () => {
        const consentErr = Object.assign(new Error('needs consent'), { code: 'trial_consent_required', scope: 'ai' });
        const parse = vi.fn()
            .mockRejectedValueOnce(consentErr)
            .mockResolvedValueOnce({ status: 'parsed', items: [] });
        stubAI({ parseMealFromDescription: parse });
        env.window.apiCall = vi.fn(async (url, method) => (
            url === '/api/settings/trial-consent' && method === 'PATCH'
                ? { ai: true, voice: null, tg: null, updated_at: 1 } : null));

        await estimate('two eggs');
        const dialog = env.document.querySelector('.wg-trial-consent-modal');
        expect(dialog).not.toBeNull();
        expect(parse).toHaveBeenCalledTimes(1);

        dialog.querySelector('[data-trial-consent-choice="allow"]').click();
        await idle();

        expect(parse).toHaveBeenCalledTimes(2);
        expect(env.window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: true });
    });

    it('declining consent surfaces the refusal, does not retry, and logs nothing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const consentErr = Object.assign(new Error('trial use needs your consent'), { code: 'trial_consent_required', scope: 'ai' });
        const ai = stubAI({ parseMealFromDescription: vi.fn().mockRejectedValue(consentErr) });
        env.window.apiCall = vi.fn(async () => ({ ai: false, voice: null, tg: null, updated_at: 1 }));

        await estimate('two eggs');
        env.document.querySelector('.wg-trial-consent-modal [data-trial-consent-choice="deny"]').click();
        await idle();

        expect(ai.parseMealFromDescription).toHaveBeenCalledTimes(1);
        expect(env.window.apiCall).toHaveBeenCalledWith('/api/settings/trial-consent', 'PATCH', { ai: false });
        expect(env.document.querySelector('.wg-toast--danger .wg-toast__text').textContent).toContain('trial use needs your consent');
        expect(ai.logParsedItems).not.toHaveBeenCalled();
        expect(env.window.DataStore.invalidateTags).not.toHaveBeenCalled();
        // Back on the describe pane so the text can be edited and retried.
        expect(env.document.getElementById('food-add-sheet').dataset.view).toBe('describe');
    });

    it('the manual form has no AI checkbox', () => {
        expect(env.document.getElementById('food-parse-ai')).toBeNull();
        expect(env.document.querySelector('#food-modal input[type="checkbox"]:not(.hidden)')).toBeNull();
    });
});
