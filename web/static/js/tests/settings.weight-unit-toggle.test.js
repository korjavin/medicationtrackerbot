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

    it('does not revert UI when an older failed PATCH coincides with the latest unit (A-B-A regression)', async () => {
        // Race regression: with rapid kg→lb→kg→lb clicks, the latest intent is
        // 'lb' and the queued first PATCH is also 'lb'. If the first PATCH
        // fails while seq=3 (lb) is the latest intent, a unit-equality stale
        // guard would mistake the failed older PATCH for the latest one and
        // revert UI to kg, silently undoing clicks 2 and 3. A monotonic intent
        // id keeps revert/reload tied to the actual latest click.
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.reloadCurrentTab = vi.fn();
        // Stub cache so the queued PATCHes don't choke on missing helpers.
        window.DataStore.getCached = vi.fn(async () => null);
        window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
        window.DataStore.setCachedWithTags = vi.fn().mockResolvedValue(undefined);

        const inflight = [];
        window.apiCall = vi.fn(() => new Promise((resolve) => {
            inflight.push(resolve);
        }));

        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');
        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');

        // Click sequence: lb (intent 1), kg (intent 2), lb (intent 3). Each
        // optimistic update flips window.weightUnitPreference synchronously, so
        // by the time the queue starts processing, the latest intent is 'lb'.
        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        kgBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('lb');

        // First queued PATCH (lb, seq=1) fails. Older intent — should NOT
        // revert window.weightUnitPreference.
        inflight[0](null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('lb');
        expect(lbBtn.getAttribute('aria-pressed')).toBe('true');

        // Second queued PATCH (kg, seq=2) succeeds. Still older intent — does
        // not own reload, but does write its unit to cache (queue order).
        inflight[1]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Final PATCH (lb, seq=3) succeeds and is the latest intent — its
        // cache write and reload should win.
        inflight[2]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('lb');
        expect(window.reloadCurrentTab).toHaveBeenCalledTimes(1);
    });

    it('serializes rapid kg/lb clicks so the server sees them in click order', async () => {
        // Race regression: when both PATCHes fan out concurrently, the server
        // can apply them in arrival order opposite to click order, leaving its
        // state on the older intent while the client shows the newer one. The
        // queue must wait for each PATCH to resolve before sending the next.
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.reloadCurrentTab = vi.fn();

        const inflight = [];
        const apiCallSpy = vi.fn(() => new Promise((resolve) => {
            inflight.push(resolve);
        }));
        window.apiCall = apiCallSpy;

        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');
        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');

        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        kgBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Only the first PATCH is in flight; the second waits for it.
        const initialPatchCalls = apiCallSpy.mock.calls.filter(
            (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
        );
        expect(initialPatchCalls.length).toBe(1);
        expect(initialPatchCalls[0][2]).toEqual({ unit: 'lb' });

        // Resolve the first PATCH; the queued kg PATCH should now fire.
        inflight[0]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const allPatchCalls = apiCallSpy.mock.calls.filter(
            (c) => c[0] === '/api/settings/weight-unit' && c[1] === 'PATCH'
        );
        expect(allPatchCalls.length).toBe(2);
        expect(allPatchCalls[1][2]).toEqual({ unit: 'kg' });

        inflight[1]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('reverts to last server-confirmed unit (not optimistic state) when latest PATCH fails after a chain', async () => {
        // Regression: with initial kg, rapid lb→kg both PATCHes failing, the
        // captured 'previous' from the second click is the optimistic 'lb' set
        // by the first click — not the actual server state ('kg'). Reverting
        // to that captured value would strand UI on 'lb' even though the
        // server stayed on 'kg' and the user's final intent was 'kg'.
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.reloadCurrentTab = vi.fn();
        window.DataStore.getCached = vi.fn(async () => null);
        window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
        window.DataStore.setCachedWithTags = vi.fn().mockResolvedValue(undefined);

        const inflight = [];
        window.apiCall = vi.fn(() => new Promise((resolve) => {
            inflight.push(resolve);
        }));

        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');
        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');

        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        kgBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Both PATCHes fail. First isn't latest, so its failure must not
        // revert. Second IS latest, but reverting to the optimistic 'lb'
        // captured at click time would be wrong — server is still 'kg'.
        inflight[0](null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        inflight[1](null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('kg');
        expect(kgBtn.getAttribute('aria-pressed')).toBe('true');
        expect(lbBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('protects the rollback baseline from stale hydration while PATCHes are pending', async () => {
        // Race regression: with rapid lb→kg, after PATCH(lb) succeeds (server=lb,
        // lastCommitted=lb), a stale BOOTSTRAP_UPDATED carrying the pre-PATCH
        // server value (kg) calls commitAuthoritativeWeightUnit('kg'). If the
        // queued PATCH(kg) then fails, a naive baseline that lets hydration
        // clobber lastCommitted would revert UI to kg even though the server
        // is still at lb. The pending-patches guard keeps lastCommitted on the
        // last successful queued PATCH (lb) until the queue drains.
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.reloadCurrentTab = vi.fn();
        window.DataStore.getCached = vi.fn(async () => null);
        window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
        window.DataStore.setCachedWithTags = vi.fn().mockResolvedValue(undefined);

        const inflight = [];
        window.apiCall = vi.fn(() => new Promise((resolve) => {
            inflight.push(resolve);
        }));

        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');
        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');

        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        kgBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // First queued PATCH (lb) succeeds — server is now lb.
        inflight[0]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Stale BOOTSTRAP_UPDATED arrives carrying the pre-PATCH server value.
        // With the guard, this must NOT advance lastCommitted to 'kg' while
        // PATCH(kg) is still queued.
        window.commitAuthoritativeWeightUnit('kg');

        // Second queued PATCH (kg) fails.
        inflight[1](null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // UI must revert to 'lb' (last successful PATCH), not 'kg' (stale hydration).
        expect(window.weightUnitPreference).toBe('lb');
        expect(lbBtn.getAttribute('aria-pressed')).toBe('true');
        expect(kgBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('rejects stale BOOTSTRAP_UPDATED hydration that arrives after the PATCH queue drains', async () => {
        // Race regression: a SW background bootstrap fetch that hit the server
        // BEFORE the local PATCH but resolves AFTER the PATCH success can fire
        // BOOTSTRAP_UPDATED with the pre-PATCH unit once the queue is already
        // drained (weightUnitPendingPatches=0). With only the pending-PATCH
        // guard, both window.weightUnitPreference and weightUnitLastCommitted
        // were rolled back to the stale value even though the server had moved
        // on. The in-session locally-mutated flag must reject the disagreeing
        // hydration so the UI keeps the just-committed unit.
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.reloadCurrentTab = vi.fn();
        window.DataStore.getCached = vi.fn(async () => null);
        window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
        window.DataStore.setCachedWithTags = vi.fn().mockResolvedValue(undefined);

        let resolvePatch;
        window.apiCall = vi.fn(() => new Promise((resolve) => { resolvePatch = resolve; }));

        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');
        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');

        lbBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // PATCH(lb) succeeds. lastCommitted=lb, locallyMutated=true, queue drains.
        resolvePatch({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Stale BOOTSTRAP_UPDATED arrives with the pre-PATCH server value.
        // The reconcile guard must override it back to 'lb'.
        window.commitAuthoritativeWeightUnit('kg');

        expect(window.weightUnitPreference).toBe('lb');
        expect(lbBtn.getAttribute('aria-pressed')).toBe('true');
        expect(kgBtn.getAttribute('aria-pressed')).toBe('false');
    });

    it('exposes commitAuthoritativeWeightUnit so out-of-band confirmations sync the revert target', async () => {
        // Regression: lastCommitted only advanced inside Settings PATCHes, so
        // a modal-submit PATCH (kg→lb) followed by a Settings PATCH (lb→kg)
        // failing reverted UI to the stale lastCommitted='lb' even though
        // the server was at 'kg'. The helper lets out-of-band paths nudge
        // both window.weightUnitPreference and lastCommitted in lockstep.
        const { window, document } = env;
        expect(typeof window.commitAuthoritativeWeightUnit).toBe('function');

        // Seed via the helper as if Settings (lb) PATCH had succeeded.
        window.commitAuthoritativeWeightUnit('lb');

        // Modal submit PATCH for kg succeeds out-of-band — moves lastCommitted to 'kg'.
        window.commitAuthoritativeWeightUnit('kg');
        expect(window.weightUnitPreference).toBe('kg');

        // User clicks Settings → lb. PATCH fails. Revert must land on 'kg'
        // (current server state), not stale 'lb'.
        window.reloadCurrentTab = vi.fn();
        window.DataStore.getCached = vi.fn(async () => null);
        window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
        window.DataStore.setCachedWithTags = vi.fn().mockResolvedValue(undefined);
        window.apiCall = vi.fn().mockResolvedValue(null);

        document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]').click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('kg');
        const kgBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="kg"]');
        const lbBtn = document.querySelector('#weight-unit-segmented .wg-settings-segmented__btn[data-unit="lb"]');
        expect(kgBtn.getAttribute('aria-pressed')).toBe('true');
        expect(lbBtn.getAttribute('aria-pressed')).toBe('false');
    });
});
