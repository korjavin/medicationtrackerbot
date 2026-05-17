// Plan 2026-05-17 Task 5 — Optimistic write conversion for BP save + delete.
//
// handleBPSubmit + _deleteBPApi must update the cached `bp` payload BEFORE
// the network round-trip resolves, then roll back on POST/DELETE failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

// Wires a Map-backed ApiCache into the env so DataStore.applyOptimistic
// reads/writes are observable in tests. Mirrors the helper used by the
// food/workout optimistic suites.
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
        BPStore: {
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

describe('features/bp.js — optimistic write conversion', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('handleBPSubmit prepends the new reading into the cached bp payload before the POST resolves', async () => {
        const { window, document } = env;
        const existing = {
            id: 1,
            measured_at: '2026-05-10T08:00:00.000Z',
            systolic: 120,
            diastolic: 78
        };
        const cache = installApiCache(window, {
            bp: {
                readingsRes: [existing],
                goalRes: { systolic: 120, diastolic: 80 },
                statsRes: { avgSys: 120 }
            }
        });

        window.showBPRecordModal();
        document.getElementById('bp-datetime').value = '2026-05-17T10:30';
        document.getElementById('bp-systolic').value = '128';
        document.getElementById('bp-diastolic').value = '82';
        document.getElementById('bp-pulse').value = '67';
        document.getElementById('bp-site').value = 'right_arm';
        document.getElementById('bp-position').value = 'seated';
        document.getElementById('bp-notes').value = 'Morning';

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/bp') {
                postCalledSignal();
                return pending.promise;
            }
            if (!method || method === 'GET') {
                if (url.startsWith('/api/bp?days=')) return cache.get('bp')?.readingsRes || [];
                if (url === '/api/bp/goal') return { systolic: 120, diastolic: 80 };
                if (url === '/api/bp/stats') return { avgSys: 120 };
            }
            return null;
        });
        window.loadBPReadings = vi.fn();

        const handlerDone = window.handleBPSubmit({ preventDefault() {} });
        await postCalled;

        const bp = cache.get('bp');
        expect(bp).toBeTruthy();
        expect(bp.readingsRes.length).toBe(2);
        // Newly-added reading sits at the front of the array (prepended).
        expect(bp.readingsRes[0].systolic).toBe(128);
        expect(bp.readingsRes[0].diastolic).toBe(82);
        expect(bp.readingsRes[0]._optimistic).toBe(true);
        // Goal + stats survive the optimistic write so the chart + averages
        // don't blank out while the POST is in flight.
        expect(bp.goalRes).toEqual({ systolic: 120, diastolic: 80 });
        expect(bp.statsRes).toEqual({ avgSys: 120 });

        pending.resolve({ status: 'created', id: 777 });
        await handlerDone;
    });

    it('handleBPSubmit rolls back the optimistic write when the POST returns null', async () => {
        const { window, document } = env;
        const existing = {
            id: 1,
            measured_at: '2026-05-10T08:00:00.000Z',
            systolic: 120,
            diastolic: 78
        };
        const cache = installApiCache(window, {
            bp: {
                readingsRes: [existing],
                goalRes: { systolic: 120, diastolic: 80 },
                statsRes: {}
            }
        });

        window.showBPRecordModal();
        document.getElementById('bp-datetime').value = '2026-05-17T11:00';
        document.getElementById('bp-systolic').value = '135';
        document.getElementById('bp-diastolic').value = '90';
        document.getElementById('bp-pulse').value = '70';

        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/bp') return null;
            return null;
        });
        window.loadBPReadings = vi.fn();

        await window.handleBPSubmit({ preventDefault() {} });

        // Rollback restores the prior snapshot — the optimistic 135/90 reading
        // must not survive a failed POST. applyOptimistic also invalidates the
        // tag, so the cache entry may either be the restored snapshot or
        // missing entirely; both prove the optimistic state was discarded.
        const bp = cache.get('bp');
        if (bp) {
            expect(bp.readingsRes.length).toBe(1);
            expect(bp.readingsRes[0].systolic).toBe(120);
        }
    });

    it('_deleteBPApi removes the target reading from the cached bp payload before the DELETE resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            bp: {
                readingsRes: [
                    { id: 1, systolic: 120, diastolic: 78, measured_at: '2026-05-10T08:00:00.000Z' },
                    { id: 2, systolic: 128, diastolic: 82, measured_at: '2026-05-12T08:00:00.000Z' }
                ],
                goalRes: { systolic: 120, diastolic: 80 },
                statsRes: { avgSys: 124 }
            }
        });

        let deleteCalledSignal;
        const deleteCalled = new Promise((r) => { deleteCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'DELETE' && url === '/api/bp/1') {
                deleteCalledSignal();
                return pending.promise;
            }
            return null;
        });
        window.loadBPReadings = vi.fn();
        window.SyncManager = { updateStatus: () => {} };

        const handlerDone = window._deleteBPApi(1);
        await deleteCalled;

        const bp = cache.get('bp');
        expect(bp).toBeTruthy();
        expect(bp.readingsRes.length).toBe(1);
        expect(bp.readingsRes[0].id).toBe(2);
        // Goal + stats are not invalidated by the optimistic write — they
        // recompute on the post-commit refetch.
        expect(bp.goalRes).toEqual({ systolic: 120, diastolic: 80 });

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('_deleteBPApi rolls back the optimistic filter when the DELETE returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            bp: {
                readingsRes: [
                    { id: 1, systolic: 120, diastolic: 78, measured_at: '2026-05-10T08:00:00.000Z' },
                    { id: 2, systolic: 128, diastolic: 82, measured_at: '2026-05-12T08:00:00.000Z' }
                ],
                goalRes: {},
                statsRes: {}
            }
        });

        window.apiCall = vi.fn(async () => null);
        window.loadBPReadings = vi.fn();
        window.SyncManager = { updateStatus: () => {} };

        await window._deleteBPApi(1);

        const bp = cache.get('bp');
        // Either the prior snapshot is restored (both readings visible) or
        // the cache was invalidated and is missing; either proves the
        // optimistic mutation did not survive the failed DELETE.
        if (bp) {
            expect(bp.readingsRes.length).toBe(2);
            expect(bp.readingsRes.map(r => r.id).sort()).toEqual([1, 2]);
        }
    });
});
