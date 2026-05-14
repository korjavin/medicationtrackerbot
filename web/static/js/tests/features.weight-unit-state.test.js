// Tests for features/weight-unit-state.js — the kg/lb preference state machine
// extracted from app.js (Plan 2026-05-13, Task 2).
//
// The state-machine module owns five pieces of state that used to live as
// module-level lets in app.js: the serial PATCH tail promise, the monotonic
// intent counter, the failure-revert baseline, the pending-PATCH count, and
// the locally-mutated flag. These tests exercise the regression scenarios
// documented in the original comments — A→B→A tail-PATCH failure must revert
// to the last server-confirmed value (not the optimistic click-time value),
// stale BOOTSTRAP_UPDATED hydration carrying the pre-PATCH server unit must
// be rejected once a local PATCH succeeded, and concurrent clicks during an
// in-flight PATCH must preserve queue order.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/weight-unit-state.js (Plan 2026-05-13, Task 2)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.WeightUnitState._resetForTesting();
        // Stub cache so PATCH paths don't choke on missing helpers.
        env.window.DataStore.getCached = vi.fn(async () => null);
        env.window.DataStore.setCached = vi.fn().mockResolvedValue(undefined);
        env.window.DataStore.setCachedWithTags = vi.fn().mockResolvedValue(undefined);
        env.window.reloadCurrentTab = vi.fn();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('exposes the public WeightUnitState surface on window', () => {
        const { window } = env;
        expect(typeof window.WeightUnitState).toBe('object');
        expect(typeof window.WeightUnitState.commitAuthoritative).toBe('function');
        expect(typeof window.WeightUnitState.applySegmentedState).toBe('function');
        expect(typeof window.WeightUnitState.applyAuthoritative).toBe('function');
        expect(typeof window.WeightUnitState.reconcile).toBe('function');
        expect(typeof window.WeightUnitState.setPreference).toBe('function');
        // Backwards-compat shims kept for tests + features/weight.js.
        expect(typeof window.commitAuthoritativeWeightUnit).toBe('function');
        expect(typeof window.setWeightUnitPreference).toBe('function');
    });

    it('reverts to lastCommitted (not the optimistic click-time value) when an A→B→A tail PATCH fails', async () => {
        // Regression: an A→B→A sequence whose tail PATCH fails would revert UI
        // to B (the optimistic state captured when the tail click was issued)
        // if the revert target were the click-time snapshot. The fix anchors
        // revert on the last server-confirmed unit (lastCommitted), so the UI
        // lands on A — the unit the server is actually at after the tail
        // PATCH fails.
        const { window } = env;
        window.weightUnitPreference = 'kg';

        const inflight = [];
        window.apiCall = vi.fn(() => new Promise((resolve) => {
            inflight.push(resolve);
        }));

        // Click 1: kg→lb (optimistic preference flips to lb, intent 1 queued).
        window.WeightUnitState.setPreference('lb');
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Click 2: lb→kg (intent 2 queued).
        window.WeightUnitState.setPreference('kg');
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Click 3: kg→lb (intent 3 queued).
        window.WeightUnitState.setPreference('lb');
        await new Promise((resolve) => setTimeout(resolve, 0));

        // PATCH #1 (lb) succeeds → lastCommitted=lb, server=lb.
        inflight[0]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // PATCH #2 (kg) succeeds → lastCommitted advances to kg (pendingPatches still > 0).
        inflight[1]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // PATCH #3 (lb) fails. This IS the latest intent → revert path runs.
        // Revert target must be lastCommitted ('kg' from PATCH #2), not the
        // optimistic 'lb' captured at click time.
        inflight[2](null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.weightUnitPreference).toBe('kg');
    });

    it('rejects stale BOOTSTRAP_UPDATED hydration that disagrees with a locally-committed unit', async () => {
        // Regression: a SW background bootstrap fetch issued BEFORE the local
        // PATCH but resolved AFTER it can fire BOOTSTRAP_UPDATED with the
        // pre-PATCH unit once the PATCH queue is already drained
        // (pendingPatches=0). Without the locallyMutated guard, that
        // hydration would clobber the just-committed unit.
        const { window } = env;
        window.weightUnitPreference = 'kg';
        window.apiCall = vi.fn().mockResolvedValue({ ok: true });

        // Local PATCH succeeds → lastCommitted=lb, locallyMutated=true, queue
        // drains.
        await window.WeightUnitState.setPreference('lb');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(window.weightUnitPreference).toBe('lb');

        // Stale BOOTSTRAP_UPDATED arrives carrying the pre-PATCH 'kg'. The
        // reconcile guard must reject it.
        const effective = window.WeightUnitState.commitAuthoritative('kg');
        expect(effective).toBe('lb');
        expect(window.weightUnitPreference).toBe('lb');
    });

    it('preserves PATCH arrival order when concurrent clicks fire during an in-flight PATCH', async () => {
        // The patchTail promise chain serializes the queued work so the server
        // sees PATCHes in click order — two concurrent in-flight PATCHes
        // could otherwise land in arrival order opposite to click order
        // (leaving the server on the older intent while the cache shows the
        // newer one).
        const { window } = env;
        window.weightUnitPreference = 'kg';

        const observed = [];
        const inflight = [];
        window.apiCall = vi.fn((url, method, body) => new Promise((resolve) => {
            observed.push(body.unit);
            inflight.push(resolve);
        }));

        window.WeightUnitState.setPreference('lb');
        await new Promise((resolve) => setTimeout(resolve, 0));
        window.WeightUnitState.setPreference('kg');
        await new Promise((resolve) => setTimeout(resolve, 0));
        window.WeightUnitState.setPreference('lb');
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Only the first PATCH should be in flight — the others wait on the
        // tail.
        expect(observed).toEqual(['lb']);
        inflight[0]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(observed).toEqual(['lb', 'kg']);
        inflight[1]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(observed).toEqual(['lb', 'kg', 'lb']);
        inflight[2]({ ok: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('applyAuthoritative returns the reconciled effective unit and paints the segmented control to match', async () => {
        // Hydration UI/state desync fix (already in the original code): a
        // single call commit + paints the toggle in lockstep with the
        // reconciled value, so callers can't accidentally paint the raw
        // incoming unit while commit reconciled internally.
        const { window, document } = env;
        window.weightUnitPreference = 'kg';
        window.apiCall = vi.fn().mockResolvedValue({ ok: true });

        // Local PATCH lb → lastCommitted=lb, locallyMutated=true.
        await window.WeightUnitState.setPreference('lb');
        await new Promise((resolve) => setTimeout(resolve, 0));

        // applyAuthoritative('kg') with a locally-mutated lb commit → returns
        // 'lb' and paints lb.
        const effective = window.WeightUnitState.applyAuthoritative('kg');
        expect(effective).toBe('lb');

        const root = document.getElementById('weight-unit-segmented');
        if (root) {
            const lbBtn = root.querySelector('.wg-settings-segmented__btn[data-unit="lb"]');
            const kgBtn = root.querySelector('.wg-settings-segmented__btn[data-unit="kg"]');
            expect(lbBtn.getAttribute('aria-pressed')).toBe('true');
            expect(kgBtn.getAttribute('aria-pressed')).toBe('false');
        }
    });

    it('skips the PATCH (silent no-op) when offline', async () => {
        // PATCH has no offline-queue fallback in sync.js, so the click must
        // not even fire an apiCall — otherwise an "internet required" alert
        // would surface after a useless round-trip.
        const { window } = env;
        window.weightUnitPreference = 'kg';
        window.SyncManager = { ...(window.SyncManager || {}), isOnline: false };
        const apiCallSpy = vi.fn();
        window.apiCall = apiCallSpy;

        const result = await window.WeightUnitState.setPreference('lb');
        expect(result).toBe(false);
        expect(apiCallSpy).not.toHaveBeenCalled();
        expect(window.weightUnitPreference).toBe('kg');
    });

    it('reconcile passes the incoming unit through when no local PATCH has happened yet', () => {
        // First-boot hydration: bootstrap arrives, locallyMutated=false, so
        // the incoming unit owns the UI (no local commit to defend).
        const { window } = env;
        window.weightUnitPreference = 'kg';
        const effective = window.WeightUnitState.commitAuthoritative('lb');
        expect(effective).toBe('lb');
        expect(window.weightUnitPreference).toBe('lb');
    });
});
