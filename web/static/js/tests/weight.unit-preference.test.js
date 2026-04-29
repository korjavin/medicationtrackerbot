// Smart weight unit preference (Plan 2026-04-29, Task 4).
//
// The weight modal honors the user's saved weight-unit preference
// (window.weightUnitPreference, hydrated from /api/bootstrap into the
// settings_bundle cache). On open, the toggle starts in the saved unit;
// on submit, if the user chose a different unit, we PATCH the new value
// back to the server and update the in-memory + cached preference so
// subsequent opens reflect the latest choice. Storage stays in kg —
// preference is purely a display/input UX hint.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('weight modal: unit-preference inference (Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    describe('modal open defaults to saved preference', () => {
        it('defaults to kg when window.weightUnitPreference is "kg" (existing behavior)', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            window.showWeightModal();

            const kgBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="kg"]');
            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');
            expect(kgBtn.getAttribute('aria-pressed')).toBe('true');
            expect(lbBtn.getAttribute('aria-pressed')).toBe('false');
            expect(document.getElementById('weight-value').min).toBe('30');
            expect(document.getElementById('weight-value').max).toBe('300');
        });

        it('defaults to lb when window.weightUnitPreference is "lb"', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            window.showWeightModal();

            const kgBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="kg"]');
            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');
            expect(lbBtn.getAttribute('aria-pressed')).toBe('true');
            expect(kgBtn.getAttribute('aria-pressed')).toBe('false');
            expect(document.getElementById('weight-value').min).toBe('66');
            expect(document.getElementById('weight-value').max).toBe('660');
        });

        it('editWeightLog converts the stored kg value into lb when preference is lb', () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';

            window.editWeightLog({
                id: 7, weight: 80.0, measured_at: '2026-04-20T08:00:00Z', notes: ''
            });

            const lbBtn = document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]');
            expect(lbBtn.getAttribute('aria-pressed')).toBe('true');
            const displayed = parseFloat(document.getElementById('weight-value').value);
            // 80 kg ≈ 176.4 lb (1 kg ≈ 2.2046 lb).
            expect(displayed).toBeCloseTo(80 / 0.45359237, 1);
        });
    });

    describe('handleWeightSubmit PATCHes /api/settings/weight-unit when the chosen unit differs', () => {
        function commonMocks(window, postResponse) {
            const apiCallSpy = vi.fn(async (url, method) => {
                if (method === 'PATCH') return { ok: true };
                if (method === 'DELETE') return true;
                return postResponse;
            });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadWeightLogs = vi.fn();
            return apiCallSpy;
        }

        it('PATCHes when the user toggles kg → lb before submitting (preference was kg)', async () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            const apiCallSpy = commonMocks(window, { id: 1 });

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '75.0';

            // Flip the modal to lb (re-displays input value as lb).
            document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]').click();

            await window.handleWeightSubmit({ preventDefault() {} });

            const patchCalls = apiCallSpy.mock.calls.filter(
                (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
            );
            expect(patchCalls.length).toBe(1);
            expect(patchCalls[0][2]).toEqual({ unit: 'lb' });
            expect(window.weightUnitPreference).toBe('lb');
        });

        it('PATCHes when the user toggles lb → kg before submitting (preference was lb)', async () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            const apiCallSpy = commonMocks(window, { id: 1 });

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '170.0';

            // Flip back to kg before submit (preference was lb, so this differs).
            document.querySelector('.wg-weight-modal__unit-btn[data-unit="kg"]').click();

            await window.handleWeightSubmit({ preventDefault() {} });

            const patchCalls = apiCallSpy.mock.calls.filter(
                (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
            );
            expect(patchCalls.length).toBe(1);
            expect(patchCalls[0][2]).toEqual({ unit: 'kg' });
            expect(window.weightUnitPreference).toBe('kg');
        });

        it('does NOT PATCH when the submitted unit matches the saved preference (kg → kg)', async () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';
            const apiCallSpy = commonMocks(window, { id: 1 });

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '75.0';

            await window.handleWeightSubmit({ preventDefault() {} });

            const patchCalls = apiCallSpy.mock.calls.filter(
                (c) => c[0] === '/api/settings/weight-unit'
            );
            expect(patchCalls.length).toBe(0);
            expect(window.weightUnitPreference).toBe('kg');
        });

        it('does NOT PATCH when the submitted unit matches the saved preference (lb → lb)', async () => {
            const { window, document } = env;
            window.weightUnitPreference = 'lb';
            const apiCallSpy = commonMocks(window, { id: 1 });

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            // Modal already opened in lb because preference is lb.
            document.getElementById('weight-value').value = '170.0';

            await window.handleWeightSubmit({ preventDefault() {} });

            const patchCalls = apiCallSpy.mock.calls.filter(
                (c) => c[0] === '/api/settings/weight-unit'
            );
            expect(patchCalls.length).toBe(0);
            expect(window.weightUnitPreference).toBe('lb');
        });

        it('updates the cached settings_bundle so reload preserves the new preference', async () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';

            const cachedBundle = { weightUnitPreference: 'kg', tabOrder: [], foodTargets: {} };
            window.DataStore.getCached = vi.fn(async (key) => key === 'settings_bundle' ? cachedBundle : null);
            const setCachedSpy = vi.fn().mockResolvedValue(undefined);
            window.DataStore.setCached = setCachedSpy;

            const apiCallSpy = commonMocks(window, { id: 1 });

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '75.0';
            document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]').click();

            await window.handleWeightSubmit({ preventDefault() {} });

            const setCalls = setCachedSpy.mock.calls.filter((c) => c[0] === 'settings_bundle');
            expect(setCalls.length).toBe(1);
            expect(setCalls[0][1].weightUnitPreference).toBe('lb');
            // Sanity: PATCH was issued.
            expect(apiCallSpy.mock.calls.some(
                (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
            )).toBe(true);
        });

        it('does not update window.weightUnitPreference when the PATCH fails', async () => {
            const { window, document } = env;
            window.weightUnitPreference = 'kg';

            const apiCallSpy = vi.fn(async (url, method) => {
                if (method === 'PATCH') return null;
                if (method === 'DELETE') return true;
                return { id: 1 };
            });
            window.apiCall = apiCallSpy;
            window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);
            window.loadWeightLogs = vi.fn();

            window.showWeightModal();
            document.getElementById('weight-datetime').value = '2026-04-22T08:15';
            document.getElementById('weight-value').value = '75.0';
            document.querySelector('.wg-weight-modal__unit-btn[data-unit="lb"]').click();

            await window.handleWeightSubmit({ preventDefault() {} });

            // PATCH attempted but failed → preference stays at the previous value.
            expect(apiCallSpy.mock.calls.some(
                (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
            )).toBe(true);
            expect(window.weightUnitPreference).toBe('kg');
        });
    });
});
