// Settings weight-unit segmented control (Plan 2026-04-29, Task 7).
//
// The Settings screen exposes a KG/LB segmented control bound to the user's
// saved preference. Click handlers PATCH /api/settings/weight-unit and update
// in-memory + cached state so dashboards rerender in the chosen unit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Settings weight-unit segmented control (Task 7)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('renders the segmented control with kg + lb buttons in the Units section', () => {
        const { document } = env;
        const sections = document.querySelectorAll('#settings-view .wg-settings-section');
        const unitsCard = Array.from(sections).find(
            (c) => c.querySelector('.wg-settings-section__title')?.textContent?.trim() === 'Units'
        );
        expect(unitsCard).toBeDefined();
        expect(unitsCard.classList.contains('wg-card')).toBe(true);

        const root = unitsCard.querySelector('#weight-unit-segmented');
        expect(root).not.toBeNull();
        expect(root.getAttribute('role')).toBe('radiogroup');

        const kgBtn = root.querySelector('.wg-settings-segmented__btn[data-unit="kg"]');
        const lbBtn = root.querySelector('.wg-settings-segmented__btn[data-unit="lb"]');
        expect(kgBtn).not.toBeNull();
        expect(lbBtn).not.toBeNull();
    });

    it('clicking lb dispatches PATCH /api/settings/weight-unit with {unit:"lb"}', async () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';

        const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
        window.apiCall = apiCallSpy;
        window.reloadCurrentTab = vi.fn();

        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');
        lbBtn.click();
        // Flush microtasks so the async click handler resolves before assertions.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const patchCalls = apiCallSpy.mock.calls.filter(
            (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
        );
        expect(patchCalls.length).toBe(1);
        expect(patchCalls[0][2]).toEqual({ unit: 'lb' });
    });

    it('updates window.weightUnitPreference + cached settings_bundle on PATCH success', async () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';

        window.apiCall = vi.fn().mockResolvedValue({ ok: true });

        const cachedBundle = { weightUnitPreference: 'kg', tabOrder: [], foodTargets: {} };
        window.DataStore.getCached = vi.fn(async (key) => key === 'settings_bundle' ? cachedBundle : null);
        const setCachedSpy = vi.fn().mockResolvedValue(undefined);
        window.DataStore.setCached = setCachedSpy;
        window.reloadCurrentTab = vi.fn();

        document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]').click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('lb');
        const setCalls = setCachedSpy.mock.calls.filter((c) => c[0] === 'settings_bundle');
        expect(setCalls.length).toBe(1);
        expect(setCalls[0][1].weightUnitPreference).toBe('lb');
    });

    it('updates the aria-pressed state to reflect the chosen unit on success', async () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.apiCall = vi.fn().mockResolvedValue({ ok: true });
        window.reloadCurrentTab = vi.fn();

        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');
        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');

        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(lbBtn.getAttribute('aria-pressed')).toBe('true');
        expect(kgBtn.getAttribute('aria-pressed')).toBe('false');
        expect(lbBtn.classList.contains('wg-settings-segmented__btn--active')).toBe(true);
    });

    it('calls reloadCurrentTab so dashboards rerender in the new unit', async () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.apiCall = vi.fn().mockResolvedValue({ ok: true });
        const reloadSpy = vi.fn();
        window.reloadCurrentTab = reloadSpy;

        document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]').click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it('reverts aria-pressed and leaves preference unchanged when PATCH fails', async () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.apiCall = vi.fn().mockResolvedValue(null);
        window.reloadCurrentTab = vi.fn();

        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');
        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');

        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('kg');
        expect(kgBtn.getAttribute('aria-pressed')).toBe('true');
        expect(lbBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('does not PATCH when clicking the already-active unit', async () => {
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        const apiCallSpy = vi.fn().mockResolvedValue({ ok: true });
        window.apiCall = apiCallSpy;
        window.reloadCurrentTab = vi.fn();

        document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]').click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const patchCalls = apiCallSpy.mock.calls.filter(
            (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
        );
        expect(patchCalls.length).toBe(0);
    });
});
