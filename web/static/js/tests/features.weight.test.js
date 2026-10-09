// Plan 2026-05-17 Task 5 — Optimistic write conversion for Weight save + delete.
//
// handleWeightSubmit + _deleteWeightApi must update the cached `weight`
// payload BEFORE the network round-trip resolves, then roll back on failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function installApiCache(window, seed = {}) {
    const map = new Map(Object.entries(seed));
    window.MedTrackerDB = {
        ...(window.MedTrackerDB || {}),
        ApiCache: {
            async get(key) { return map.has(key) ? map.get(key) : null; },
            async set(key, value) { map.set(key, value); },
            async clear(key) { map.delete(key); },
            async keys(prefix) {
                const all = [...map.keys()];
                return typeof prefix === 'string' && prefix
                    ? all.filter((k) => k.startsWith(prefix))
                    : all;
            }
        },
        WeightStore: {
            getPending: async () => [],
            getRejected: async () => [],
            getAll: async () => [],
            confirmDelete: async () => undefined
        }
    };
    return map;
}

function deferred() {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return { promise, resolve: resolveFn, reject: rejectFn };
}

describe('features/weight.js — optimistic write conversion', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('handleWeightSubmit prepends the new log into the cached weight payload before the POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            weight: {
                logsRes: [
                    { id: 5, weight: 80.0, measured_at: '2026-05-10T08:00:00.000Z' }
                ],
                goalRes: { target_weight: 75.0 }
            }
        });

        // The modal needs to be open + a unit selected so handleWeightSubmit
        // can read weightModalUnit from the form state.
        if (typeof window.showWeightRecordModal === 'function') {
            window.showWeightRecordModal();
        }
        document.getElementById('weight-datetime').value = '2026-05-17T08:00';
        document.getElementById('weight-value').value = '79.5';
        document.getElementById('weight-notes').value = 'After run';

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/weight') {
                postCalledSignal();
                return pending.promise;
            }
            if (!method || method === 'GET') {
                if (url.startsWith('/api/weight?')) return cache.get('weight')?.logsRes || [];
                if (url === '/api/weight/goal') return { target_weight: 75.0 };
            }
            return null;
        });
        // Suppress side-effects from the unit-preference path; we're only
        // asserting the optimistic cache write here.
        window.setWeightUnitPreference = vi.fn();
        window.loadWeightLogs = vi.fn();
        window.SyncManager = { isOnline: true, updateStatus: () => {} };

        const handlerDone = window.handleWeightSubmit({ preventDefault() {} });
        await postCalled;

        const w = cache.get('weight');
        expect(w).toBeTruthy();
        expect(w.logsRes.length).toBe(2);
        expect(w.logsRes[0].weight).toBe(79.5);
        expect(w.logsRes[0]._optimistic).toBe(true);
        // Goal survives so the latest tile + chart don't blank out while the
        // POST is in flight.
        expect(w.goalRes).toEqual({ target_weight: 75.0 });

        pending.resolve({ status: 'created', id: 999 });
        await handlerDone;
    });

    it('handleWeightSubmit rolls back the optimistic write when the POST returns null', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            weight: {
                logsRes: [
                    { id: 5, weight: 80.0, measured_at: '2026-05-10T08:00:00.000Z' }
                ],
                goalRes: {}
            }
        });

        if (typeof window.showWeightRecordModal === 'function') {
            window.showWeightRecordModal();
        }
        document.getElementById('weight-datetime').value = '2026-05-17T09:00';
        document.getElementById('weight-value').value = '85.5';

        window.apiCall = vi.fn(async () => null);
        window.setWeightUnitPreference = vi.fn();
        window.loadWeightLogs = vi.fn();
        window.SyncManager = { isOnline: true, updateStatus: () => {} };

        await window.handleWeightSubmit({ preventDefault() {} });

        const w = cache.get('weight');
        // Rollback restores the prior snapshot OR the cache was invalidated.
        // Either way, the optimistic 85.5 row must not survive.
        if (w) {
            expect(w.logsRes.length).toBe(1);
            expect(w.logsRes[0].weight).toBe(80.0);
        }
    });

    it('_deleteWeightApi removes the target log from the cached weight payload before the DELETE resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            weight: {
                logsRes: [
                    { id: 1, weight: 80.0, measured_at: '2026-05-10T08:00:00.000Z' },
                    { id: 2, weight: 79.5, measured_at: '2026-05-12T08:00:00.000Z' }
                ],
                goalRes: { target_weight: 75.0 }
            }
        });

        let deleteCalledSignal;
        const deleteCalled = new Promise((r) => { deleteCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'DELETE' && url === '/api/weight/1') {
                deleteCalledSignal();
                return pending.promise;
            }
            return null;
        });
        window.loadWeightLogs = vi.fn();
        window.SyncManager = { updateStatus: () => {} };

        const handlerDone = window._deleteWeightApi(1);
        await deleteCalled;

        const w = cache.get('weight');
        expect(w).toBeTruthy();
        expect(w.logsRes.length).toBe(1);
        expect(w.logsRes[0].id).toBe(2);
        expect(w.goalRes).toEqual({ target_weight: 75.0 });

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('_deleteWeightApi rolls back the optimistic filter when the DELETE returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            weight: {
                logsRes: [
                    { id: 1, weight: 80.0, measured_at: '2026-05-10T08:00:00.000Z' },
                    { id: 2, weight: 79.5, measured_at: '2026-05-12T08:00:00.000Z' }
                ],
                goalRes: {}
            }
        });

        window.apiCall = vi.fn(async () => null);
        window.loadWeightLogs = vi.fn();
        window.SyncManager = { updateStatus: () => {} };

        await window._deleteWeightApi(1);

        const w = cache.get('weight');
        if (w) {
            expect(w.logsRes.length).toBe(2);
            expect(w.logsRes.map(l => l.id).sort()).toEqual([1, 2]);
        }
    });
});

// med-v83g: the goal editor is the app's in-page safePrompt (numeric keypad),
// never a native prompt().
describe('features/weight.js — target-weight goal dialog', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('edits the goal through the styled dialog and POSTs the new target', async () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.prompt = vi.fn();
        window.apiCall = vi.fn(async () => null);
        window.renderWeightGoalCard([{ measured_at: new Date().toISOString(), weight: 80 }], { goal: 75, goal_direction: 'lose', highest_weight: 85 });

        document.querySelector('.wg-weight-goal-card__action').click();
        const modal = document.querySelector('mt-modal.mt-confirm-modal');
        expect(modal).not.toBeNull();
        const input = modal.querySelector('.mt-confirm-modal__input');
        expect(input.value).toBe('75');
        expect(input.getAttribute('inputmode')).toBe('decimal');

        input.value = '72.5';
        modal.querySelector('.mt-confirm-modal__confirm').click();
        await vi.waitFor(() => {
            if (window.apiCall.mock.calls.length === 0) throw new Error('not posted yet');
        });
        expect(window.apiCall).toHaveBeenCalledWith('/api/weight/goal', 'POST', { target_weight: 72.5 });
        expect(window.prompt).not.toHaveBeenCalled();
        expect(document.querySelector('.mt-confirm-modal')).toBeNull();
    });

    it('a Goal Line reading already past the target says "At goal", never "N kg to goal"', () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.renderWeightGoalCard([{ measured_at: new Date().toISOString(), weight: 77 }], { goal: 78 }, {
            enabled: true,
            goal: {
                status: 'preliminary', distance_to_goal: 1, trend_weight: null, start_ref_source: 'first_reading',
                progress: { done_kg: 7, total_kg: 7, fraction: 1 },
            },
        });
        const texts = [...document.querySelectorAll('.wg-weight-goal-card__delta')].map((n) => n.textContent);
        expect(texts).toEqual(['At goal', 'Current 77.0 kg']);
        expect(document.querySelector('.wg-weight-goal-card__fill').style.getPropertyValue('--fill-pct')).toBe('100%');
    });

    it('cancelling the dialog leaves the goal untouched', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn(async () => null);
        window.renderWeightGoalCard([], null);

        document.querySelector('.wg-weight-goal-card__action').click();
        document.querySelector('.mt-confirm-modal__cancel').click();
        await Promise.resolve();
        await Promise.resolve();
        expect(window.apiCall).not.toHaveBeenCalled();
    });
});

describe('features/weight.js — row delete undoes from the toast (med-xso6.5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withSync: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('deleteWeightLog hides the log at once; Undo restores it and sends no DELETE', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            weight: {
                logsRes: [
                    { id: 1, weight: 80.2, measured_at: '2026-05-10T08:00:00.000Z' },
                    { id: 2, weight: 80.0, measured_at: '2026-05-12T08:00:00.000Z' }
                ],
                goalRes: null,
                lineRes: null
            }
        });
        window.apiCall = vi.fn(async (_url, method) => (method === 'DELETE' ? { ok: true } : null));
        window.loadWeightLogs = vi.fn();

        const ctl = window.deleteWeightLog('1');
        await vi.waitFor(() => expect(cache.get('weight').logsRes.map((l) => l.id)).toEqual([2]));
        expect(document.querySelector('.wg-toasts .wg-toast__text').textContent).toBe('Weight deleted');
        document.querySelector('.wg-toasts .wg-toast__undo').click();

        expect(await ctl.done).toBe('undone');
        expect(cache.get('weight').logsRes.map((l) => l.id)).toEqual([1, 2]);
        expect((window.apiCall.mock.calls.filter(([, m]) => m === 'DELETE'))).toHaveLength(0);
    });
});
