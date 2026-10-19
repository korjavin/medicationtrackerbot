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

describe('features/bp.js — row delete undoes from the toast (med-xso6.5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withSync: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('deleteBPReading hides the reading at once; Undo restores it and sends no DELETE', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            bp: {
                readingsRes: [
                    { id: 1, systolic: 120, diastolic: 78, measured_at: '2026-05-10T08:00:00.000Z' },
                    { id: 2, systolic: 128, diastolic: 82, measured_at: '2026-05-12T08:00:00.000Z' }
                ],
                goalRes: null,
                statsRes: null
            }
        });
        window.apiCall = vi.fn(async (_url, method) => (method === 'DELETE' ? { ok: true } : null));
        window.loadBPReadings = vi.fn();

        const ctl = window.deleteBPReading('1');
        await vi.waitFor(() => expect(cache.get('bp').readingsRes.map((r) => r.id)).toEqual([2]));
        expect(document.querySelector('.wg-toasts .wg-toast__text').textContent).toBe('Reading deleted');
        document.querySelector('.wg-toasts .wg-toast__undo').click();

        expect(await ctl.done).toBe('undone');
        expect(cache.get('bp').readingsRes.map((r) => r.id)).toEqual([1, 2]);
        expect((window.apiCall.mock.calls.filter(([, m]) => m === 'DELETE'))).toHaveLength(0);
    });

    it('journals the owed delete (fn + id only) while the window is open; boot replay sends it', async () => {
        const { window } = env;
        installApiCache(window, {
            bp: { readingsRes: [{ id: 1, systolic: 120, diastolic: 78, measured_at: '2026-05-10T08:00:00.000Z' }], goalRes: null, statsRes: null }
        });
        window.apiCall = vi.fn(async (_url, method) => (method === 'DELETE' ? { ok: true } : null));
        window.loadBPReadings = vi.fn();
        const journal = () => JSON.parse(window.localStorage.getItem('wg-pending-deletes') || '[]');

        const ctl = window.deleteBPReading('1');
        expect(journal().map(({ fn, arg }) => [fn, arg])).toEqual([['_deleteBPApi', '1']]);
        ctl.undo();
        await ctl.done;
        expect(journal()).toEqual([]);

        // A page killed inside the window leaves the entry; the next boot sends it.
        // Unknown function names are never called.
        window.localStorage.setItem('wg-pending-deletes', JSON.stringify([
            { id: 'a', fn: '_deleteBPApi', arg: '1', at: 1, ttl: 5000 },
            { id: 'b', fn: 'alert', arg: 'x', at: 1, ttl: 5000 },
        ]));
        await window.replayPendingDeletes();
        expect(journal()).toEqual([]);
        expect(window.apiCall.mock.calls.filter(([, m]) => m === 'DELETE')).toHaveLength(1);
    });

    it("replay leaves a live tab's open Undo window alone, and keeps a failed delete for a later boot", async () => {
        const { window } = env;
        installApiCache(window, { bp: { readingsRes: [], goalRes: null, statsRes: null } });
        window.loadBPReadings = vi.fn();
        window.apiCall = vi.fn(async () => null); // every DELETE fails
        const journal = () => JSON.parse(window.localStorage.getItem('wg-pending-deletes') || '[]');

        // Another tab opened this window a moment ago: the user may still Undo.
        window.localStorage.setItem('wg-pending-deletes', JSON.stringify([
            { id: 'live', fn: '_deleteBPApi', arg: '7', at: Date.now(), ttl: 5000 },
            { id: 'old', fn: '_deleteBPApi', arg: '8', at: 1, ttl: 5000 },
        ]));
        await window.replayPendingDeletes();

        const deletes = window.apiCall.mock.calls.filter(([, m]) => m === 'DELETE').map(([u]) => u);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]).toContain('8');
        expect(journal().map((e) => [e.id, e.tries])).toEqual([['live', undefined], ['old', 1]]);

        // Two more failed boots and the abandoned delete is given up.
        await window.replayPendingDeletes();
        await window.replayPendingDeletes();
        expect(journal().map((e) => e.id)).toEqual(['live']);
    });

    it('a second delete flushes the first: one Undo window, no snapshot resurrecting the other row', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            bp: {
                readingsRes: [
                    { id: 1, systolic: 120, diastolic: 78, measured_at: '2026-05-10T08:00:00.000Z' },
                    { id: 2, systolic: 128, diastolic: 82, measured_at: '2026-05-12T08:00:00.000Z' }
                ],
                goalRes: null,
                statsRes: null
            }
        });
        window.apiCall = vi.fn(async (_url, method) => (method === 'DELETE' ? { ok: true } : null));
        window.loadBPReadings = vi.fn();

        const first = window.deleteBPReading('1');
        await vi.waitFor(() => expect(cache.get('bp').readingsRes.map((r) => r.id)).toEqual([2]));
        const second = window.deleteBPReading('2');

        expect(await first.done).toBe('deleted');
        second.undo();
        expect(await second.done).toBe('undone');
        expect(cache.get('bp').readingsRes.map((r) => r.id)).toEqual([2]);
        expect(window.apiCall.mock.calls.filter(([, m]) => m === 'DELETE')).toHaveLength(1);
    });
});

// bd med-va47: see the matching weight suite — the delete's invalidateTags
// evicted the cache under deleteWithUndo's pending handle, so the reload had
// neither cache nor fetch and painted the offline state.
describe('features/bp.js — deleting rows never shows the offline state (med-va47)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withSync: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('second-last and last readings leave at once; the list ends on the normal empty state', async () => {
        const { window, document } = env;
        document.documentElement.classList.add('wg-local-vault');
        const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
        let server = [
            { id: 1, systolic: 120, diastolic: 78, measured_at: day(2) },
            { id: 2, systolic: 128, diastolic: 82, measured_at: day(1) }
        ];
        installApiCache(window, { bp: { readingsRes: server.slice(), goalRes: null, statsRes: null } });
        const gate = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'DELETE') {
                await gate.promise; // a slow local delete
                const id = Number(url.split('/').pop());
                server = server.filter((r) => r.id !== id);
                return { ok: true };
            }
            if (url.startsWith('/api/bp?')) return server.slice();
            return {};
        });
        const loads = [];
        window.requestTabRefresh = () => { loads.push(window.loadBPReadings()); };

        const list = document.getElementById('bp-list');
        const seen = [];
        new window.MutationObserver(() => seen.push(list.textContent)).observe(list, { childList: true, subtree: true });
        const rows = () => list.querySelectorAll('[data-reading-id]').length;

        await window.loadBPReadings();
        expect(rows()).toBe(2);

        const first = window.deleteBPReading('2');
        await vi.waitFor(() => expect(rows()).toBe(1));
        const second = window.deleteBPReading('1'); // flushes the first
        await vi.waitFor(() => expect(rows()).toBe(0));
        gate.resolve();
        expect(await first.done).toBe('deleted');
        expect(await second.flush()).toBe('deleted');

        await vi.waitFor(() => expect(list.querySelector('.wg-empty__title').textContent).toBe('No readings yet'));
        // Let every refresh the writes fired finish before the env is torn down.
        for (let n = -1; n !== loads.length;) { n = loads.length; await Promise.allSettled(loads); }
        expect(seen.some((t) => /No cached data|back online|Nothing to show/.test(t))).toBe(false);
    });

    // bd med-z075: the save's invalidation is held back while the delete's
    // handle is pending, and its GET used to be skipped too — the temp-id row
    // (no server stats) stayed until the Undo window closed.
    it("a reading saved during another row's Undo window lands with its server id and stats at once", async () => {
        const { window, document } = env;
        const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
        let server = [
            { id: 1, systolic: 120, diastolic: 78, measured_at: day(2) },
            { id: 2, systolic: 128, diastolic: 82, measured_at: day(1) }
        ];
        const cache = installApiCache(window, { bp: { readingsRes: server.slice(), goalRes: null, statsRes: { count: 2 } } });
        window.apiCall = vi.fn(async (url, method, body) => {
            if (method === 'DELETE') {
                const id = Number(url.split('/').pop());
                server = server.filter((r) => r.id !== id);
                return { ok: true };
            }
            if (method === 'POST') {
                const row = { ...body, id: 3 };
                server = [row, ...server];
                return row;
            }
            if (url.startsWith('/api/bp?')) return server.slice();
            if (url === '/api/bp/stats') return { count: server.length };
            return {};
        });
        const loads = [];
        window.requestTabRefresh = () => { loads.push(window.loadBPReadings()); };

        const list = document.getElementById('bp-list');
        const ids = () => [...list.querySelectorAll('[data-reading-id]')].map((el) => el.dataset.readingId).sort();

        await window.loadBPReadings();
        const del = window.deleteBPReading('2');
        await vi.waitFor(() => expect(ids()).toEqual(['1']));

        const t = new Date(Date.now() - 3600000);
        window.showBPRecordModal();
        document.getElementById('bp-datetime').value = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        document.getElementById('bp-systolic').value = '131';
        document.getElementById('bp-diastolic').value = '84';
        await window.handleBPSubmit({ preventDefault() {} });

        // Server id + server stats now; the held delete's row stays gone.
        expect(window.apiCall.mock.calls.filter(([, m]) => m === 'DELETE')).toHaveLength(0);
        expect(ids()).toEqual(['1', '3']);
        expect(cache.get('bp').statsRes).toEqual({ count: 3 });

        expect(await del.flush()).toBe('deleted');
        for (let n = -1; n !== loads.length;) { n = loads.length; await Promise.allSettled(loads); }
        expect(ids()).toEqual(['1', '3']);
        expect(cache.get('bp').statsRes).toEqual({ count: 2 });
    });
});
