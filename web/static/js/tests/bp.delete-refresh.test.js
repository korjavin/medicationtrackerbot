// Phase 3 round-2 Task 1 — delete-refresh ordering guard.
//
// Round 1 added `await loadBPReadings()` to handleBPSubmit but left both
// branches of `_deleteBPApi` calling it without `await`. The visible bug:
// after deleting a reading, the history list stayed stale until a tab
// switch re-mounted BP. These tests pin the awaited ordering so the
// regression cannot reappear silently.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('_deleteBPApi awaits loadBPReadings before resolving', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('local_ branch: _deleteBPApi promise does not resolve until loadBPReadings resolves', async () => {
        const { window } = env;

        let resolveLoad;
        const loadBPSpy = vi.fn(() => new Promise((resolve) => { resolveLoad = resolve; }));
        window.loadBPReadings = loadBPSpy;

        window.MedTrackerDB = {
            BPStore: {
                confirmDelete: async () => undefined,
                getAll: async () => []
            }
        };
        window.SyncManager = { updateStatus: () => {} };

        const p = window._deleteBPApi('local_5');
        // Prevent unhandled-rejection noise if the test aborts early.
        p.catch(() => {});

        // Yield enough microtasks for the `await confirmDelete` hop to settle
        // and for execution inside _deleteBPApi to reach `await loadBPReadings()`.
        for (let i = 0; i < 10; i += 1) await Promise.resolve();

        expect(loadBPSpy).toHaveBeenCalledTimes(1);

        let deleteResolved = false;
        p.then(() => { deleteResolved = true; });

        // Yield again: _deleteBPApi must still be pending on the reload.
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
        expect(deleteResolved).toBe(false);

        resolveLoad();
        await p;
        expect(deleteResolved).toBe(true);
    });

    it('server-delete branch: _deleteBPApi promise does not resolve until loadBPReadings resolves', async () => {
        const { window } = env;

        let resolveLoad;
        const loadBPSpy = vi.fn(() => new Promise((resolve) => { resolveLoad = resolve; }));
        window.loadBPReadings = loadBPSpy;

        window.apiCall = async () => ({ ok: true });
        window.DataStore.invalidateTags = async () => undefined;
        window.MedTrackerDB = {
            BPStore: {
                confirmDelete: async () => undefined,
                getAll: async () => []
            }
        };
        window.SyncManager = { updateStatus: () => {} };

        const p = window._deleteBPApi(42);
        p.catch(() => {});

        // Yield microtasks for the internal awaits (apiCall, invalidateTags,
        // getAll) to settle and execution to reach `await loadBPReadings()`.
        for (let i = 0; i < 30; i += 1) await Promise.resolve();

        expect(loadBPSpy).toHaveBeenCalledTimes(1);

        let deleteResolved = false;
        p.then(() => { deleteResolved = true; });

        for (let i = 0; i < 4; i += 1) await Promise.resolve();
        expect(deleteResolved).toBe(false);

        resolveLoad();
        await p;
        expect(deleteResolved).toBe(true);
    });

    it('server-delete error path: apiCall returning null skips loadBPReadings and leaves the list untouched', async () => {
        const { window } = env;

        const loadBPSpy = vi.fn().mockResolvedValue(undefined);
        window.loadBPReadings = loadBPSpy;

        // apiCall swallows network/5xx errors and returns null (see core/api.js).
        window.apiCall = vi.fn().mockResolvedValue(null);
        window.DataStore.invalidateTags = vi.fn().mockResolvedValue(undefined);

        await window._deleteBPApi(42);

        expect(window.apiCall).toHaveBeenCalledWith('/api/bp/42', 'DELETE');
        // The rollback path now invokes invalidateTags(['bp']) so the next
        // read re-fetches authoritative data after discarding the optimistic
        // filter (Plan 2026-05-17 Task 5). The contract worth pinning is that
        // loadBPReadings stays untouched on POST/DELETE failure.
        expect(loadBPSpy).not.toHaveBeenCalled();
    });
});
