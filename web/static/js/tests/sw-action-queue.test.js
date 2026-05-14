// Integration tests for the Service Worker failed-action queue.
// Task 4 of the SW handler unification plan: when a notification-handler
// POST inside sw.js fails, sw-api-helper.js writes an {endpoint, method,
// body} envelope into the pending_sw_actions Dexie store; SyncManager's
// drainSwActionQueue replays each entry against apiCallDirect on the
// next online sync, marking entries synced / errored / rejected with
// the same isPermanentSyncError split the BP and weight queues use.
//
// See docs/plans/2026-05-13-sw-handler-unification.md, Task 4.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadDbEnv } from './helpers/db-harness.js';
import { allowConsoleNoise } from './helpers/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SYNC_JS = path.join(REPO_ROOT, 'web/static/js/sync.js');

function evalWithSourceURL(window, source, scriptPath) {
    window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

// Build a JSDOM environment with a real(ish) SwActionQueue (in-memory,
// matching the db.js semantics) and a stubbed apiCallDirect we can drive
// per test. Other MedTrackerDB stores return zero counts.
function loadDrainEnv({ apiCallDirect } = {}) {
    const dom = new JSDOM(
        '<!doctype html><html><body><div id="offline-banner" class="hidden"></div><div id="sync-status-bar"></div></body></html>',
        { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true }
    );
    const { window } = dom;

    // In-memory queue state mirrors db.js SwActionQueueStore semantics.
    const rows = new Map();
    let nextId = 1;
    const STALE_CLAIM_MS = 5 * 60 * 1000;
    const swActionQueue = {
        rows,
        async save(action) {
            const localId = nextId++;
            const record = {
                localId,
                endpoint: action.endpoint,
                method: action.method || 'POST',
                body: action.body ?? null,
                syncStatus: 'pending',
                createdAt: Date.now(),
            };
            rows.set(localId, record);
            return record;
        },
        async getPending() {
            return [...rows.values()].filter(
                (r) => r.syncStatus === 'pending' || r.syncStatus === 'error'
            );
        },
        // Mirror the atomic claim transaction in db.js: revert stale
        // 'syncing' orphans to 'pending', then move pending/error rows
        // into 'syncing' as a single step. We synchronously snapshot
        // and mutate the Map so two concurrent callers cannot both
        // observe the same row in pending/error state.
        async claimPending() {
            const now = Date.now();
            const claimed = [];
            for (const [id, r] of [...rows.entries()]) {
                if (r.syncStatus === 'syncing'
                    && (!r.claimedAt || (now - r.claimedAt) > STALE_CLAIM_MS)) {
                    rows.set(id, { ...r, syncStatus: 'pending', claimedAt: null });
                }
            }
            for (const [id, r] of [...rows.entries()]) {
                if (r.syncStatus === 'pending' || r.syncStatus === 'error') {
                    const next = { ...r, syncStatus: 'syncing', claimedAt: now };
                    rows.set(id, next);
                    claimed.push({ ...next });
                }
            }
            return claimed;
        },
        async markSynced(localId) {
            rows.delete(localId);
        },
        async markError(localId, errorMessage) {
            const r = rows.get(localId);
            if (r) rows.set(localId, { ...r, syncStatus: 'error', errorMessage, claimedAt: null });
        },
        async markRejected(localId, errorMessage) {
            const r = rows.get(localId);
            if (r) rows.set(localId, { ...r, syncStatus: 'rejected', errorMessage, claimedAt: null });
        },
        async getPendingCount() {
            return [...rows.values()].filter(
                (r) => r.syncStatus === 'pending'
                    || r.syncStatus === 'error'
                    || r.syncStatus === 'syncing'
            ).length;
        },
        async getRejectedCount() {
            return [...rows.values()].filter((r) => r.syncStatus === 'rejected').length;
        },
        async clear() { rows.clear(); },
    };

    const zeroCounts = {
        async getPendingCount() { return 0; },
        async getRejectedCount() { return 0; },
        async getPending() { return []; },
    };

    window.MedTrackerDB = {
        BPStore: zeroCounts,
        WeightStore: zeroCounts,
        IntakeQueueStore: zeroCounts,
        SwActionQueue: swActionQueue,
    };
    window.apiCallDirect = apiCallDirect || vi.fn().mockResolvedValue({ ok: true });

    const src = fs.readFileSync(SYNC_JS, 'utf8');
    evalWithSourceURL(window, src, SYNC_JS);
    window.SyncManager.isOnline = true;

    return {
        window,
        swActionQueue,
        cleanup: () => dom.window.close(),
    };
}

describe('SwActionQueue store (db.js)', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('save() writes a pending envelope with createdAt and method default POST', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const { SwActionQueue } = window.MedTrackerDB;
            const before = Date.now();
            const rec = await SwActionQueue.save({
                endpoint: '/api/medications/skip',
                body: { intake_id: 7 },
            });
            const after = Date.now();

            expect(rec.endpoint).toBe('/api/medications/skip');
            expect(rec.method).toBe('POST');
            expect(rec.body).toEqual({ intake_id: 7 });
            expect(rec.syncStatus).toBe('pending');
            expect(rec.createdAt).toBeGreaterThanOrEqual(before);
            expect(rec.createdAt).toBeLessThanOrEqual(after);
            expect(rec.localId).toBeGreaterThan(0);

            const pending = await SwActionQueue.getPending();
            expect(pending).toHaveLength(1);
            expect(pending[0].endpoint).toBe('/api/medications/skip');

            expect(await SwActionQueue.getPendingCount()).toBe(1);
            expect(await SwActionQueue.getRejectedCount()).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('save() preserves an explicit null body (for no-body POSTs like /api/bp/reminder/snooze)', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const { SwActionQueue } = window.MedTrackerDB;
            const rec = await SwActionQueue.save({
                endpoint: '/api/bp/reminder/snooze',
                method: 'POST',
                body: null,
            });
            expect(rec.body).toBeNull();
            const pending = await SwActionQueue.getPending();
            expect(pending[0].body).toBeNull();
        } finally {
            cleanup();
        }
    });

    it('markSynced() removes the row; getPending excludes it after', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const { SwActionQueue, db } = window.MedTrackerDB;
            const rec = await SwActionQueue.save({
                endpoint: '/api/medications/skip',
                body: { intake_id: 7 },
            });

            await SwActionQueue.markSynced(rec.localId);

            const row = await db.pending_sw_actions.get(rec.localId);
            expect(row).toBeUndefined();
            expect(await SwActionQueue.getPendingCount()).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('markError() keeps the row in pending (transient failures are retried)', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const { SwActionQueue } = window.MedTrackerDB;
            const rec = await SwActionQueue.save({
                endpoint: '/api/medications/skip',
                body: { intake_id: 7 },
            });

            await SwActionQueue.markError(rec.localId, 'network blip');

            const pending = await SwActionQueue.getPending();
            expect(pending).toHaveLength(1);
            expect(pending[0].syncStatus).toBe('error');
            expect(pending[0].errorMessage).toBe('network blip');
            expect(await SwActionQueue.getPendingCount()).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('markRejected() removes the row from pending and adds it to rejected count', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const { SwActionQueue } = window.MedTrackerDB;
            const rec = await SwActionQueue.save({
                endpoint: '/api/medications/skip',
                body: { intake_id: 7 },
            });

            await SwActionQueue.markRejected(rec.localId, '401 Unauthorized');

            expect(await SwActionQueue.getPendingCount()).toBe(0);
            expect(await SwActionQueue.getRejectedCount()).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('claimPending() atomically moves pending and error rows into syncing state', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const { SwActionQueue } = window.MedTrackerDB;
            const a = await SwActionQueue.save({
                endpoint: '/api/medications/skip',
                body: { intake_id: 7 },
            });
            const b = await SwActionQueue.save({
                endpoint: '/api/bp/reminder/snooze',
                method: 'POST',
                body: null,
            });
            await SwActionQueue.markError(b.localId, 'previous blip');

            const claimed = await SwActionQueue.claimPending();
            expect(claimed).toHaveLength(2);
            expect(claimed.every((r) => r.syncStatus === 'syncing')).toBe(true);
            expect(claimed.every((r) => typeof r.claimedAt === 'number')).toBe(true);

            // A second claim sees no rows — the originals are already in
            // 'syncing' state, which is the cross-tab race protection.
            const second = await SwActionQueue.claimPending();
            expect(second).toHaveLength(0);

            // getPendingCount still reflects them (in-flight is pending).
            expect(await SwActionQueue.getPendingCount()).toBe(2);

            // Caller completes the replay loop: success deletes, transient
            // failure transitions back to 'error' so the next claim picks
            // it up.
            await SwActionQueue.markSynced(a.localId);
            await SwActionQueue.markError(b.localId, 'still flaky');

            const third = await SwActionQueue.claimPending();
            expect(third).toHaveLength(1);
            expect(third[0].localId).toBe(b.localId);
        } finally {
            cleanup();
        }
    });

    it('claimPending() reclaims stale syncing orphans (crashed-tab recovery)', async () => {
        const { window, cleanup } = loadDbEnv();
        try {
            const { SwActionQueue, db } = window.MedTrackerDB;
            const rec = await SwActionQueue.save({
                endpoint: '/api/medications/skip',
                body: { intake_id: 7 },
            });
            // Simulate a tab that claimed the row but then crashed: row
            // is in 'syncing' state with a claim timestamp well in the
            // past.
            const longAgo = Date.now() - (10 * 60 * 1000);
            await db.pending_sw_actions.update(rec.localId, {
                syncStatus: 'syncing',
                claimedAt: longAgo,
            });

            const claimed = await SwActionQueue.claimPending();
            expect(claimed).toHaveLength(1);
            expect(claimed[0].localId).toBe(rec.localId);
            expect(claimed[0].syncStatus).toBe('syncing');
            expect(claimed[0].claimedAt).toBeGreaterThan(longAgo);
        } finally {
            cleanup();
        }
    });
});

describe('SyncManager.drainSwActionQueue (sync.js)', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('drains queued envelopes via apiCallDirect with the original endpoint, method, body', async () => {
        const apiCallDirect = vi.fn().mockResolvedValue({ ok: true });
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });
            await swActionQueue.save({
                endpoint: '/api/bp/reminder/snooze',
                method: 'POST',
                body: null,
            });

            await window.SyncManager.drainSwActionQueue();

            expect(apiCallDirect).toHaveBeenCalledTimes(2);
            expect(apiCallDirect).toHaveBeenCalledWith(
                '/api/medications/skip', 'POST', { intake_id: 7 }
            );
            expect(apiCallDirect).toHaveBeenCalledWith(
                '/api/bp/reminder/snooze', 'POST', null
            );

            // Both entries deleted on success.
            expect(swActionQueue.rows.size).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('marks transient (5xx, network) failures as error and leaves them in pending for retry', async () => {
        const transient = Object.assign(new Error('Bad Gateway'), { status: 502 });
        const apiCallDirect = vi.fn().mockRejectedValue(transient);
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            const rec = await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });

            await window.SyncManager.drainSwActionQueue();

            const row = swActionQueue.rows.get(rec.localId);
            expect(row).toBeDefined();
            expect(row.syncStatus).toBe('error');
            expect(row.errorMessage).toBe('Bad Gateway');
            expect(await swActionQueue.getPendingCount()).toBe(1);
            expect(await swActionQueue.getRejectedCount()).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('marks permanent 4xx failures as rejected and removes them from pending', async () => {
        const permanent = Object.assign(new Error('Bad Request'), { status: 400 });
        const apiCallDirect = vi.fn().mockRejectedValue(permanent);
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            const rec = await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });

            await window.SyncManager.drainSwActionQueue();

            const row = swActionQueue.rows.get(rec.localId);
            expect(row).toBeDefined();
            expect(row.syncStatus).toBe('rejected');
            expect(row.errorMessage).toBe('Bad Request');
            expect(await swActionQueue.getPendingCount()).toBe(0);
            expect(await swActionQueue.getRejectedCount()).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('treats 401 as transient (auth expiry — will succeed after re-login)', async () => {
        const authExpired = Object.assign(new Error('Unauthorized'), { status: 401 });
        const apiCallDirect = vi.fn().mockRejectedValue(authExpired);
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            const rec = await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });

            await window.SyncManager.drainSwActionQueue();

            const row = swActionQueue.rows.get(rec.localId);
            expect(row.syncStatus).toBe('error');
            expect(await swActionQueue.getPendingCount()).toBe(1);
            expect(await swActionQueue.getRejectedCount()).toBe(0);
        } finally {
            cleanup();
        }
    });

    it('updateStatus aggregates SwActionQueue counts into totalPending and totalRejected', async () => {
        const { window, swActionQueue, cleanup } = loadDrainEnv();
        try {
            await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });
            const second = await swActionQueue.save({
                endpoint: '/api/bp/reminder/snooze',
                method: 'POST',
                body: null,
            });
            await swActionQueue.markRejected(second.localId, 'gone');

            const cb = vi.fn();
            window.SyncManager.onStatusChange(cb);
            await window.SyncManager.updateStatus();

            const status = cb.mock.calls[0][0];
            expect(status.pendingCount).toBe(1);
            expect(status.rejectedCount).toBe(1);
        } finally {
            cleanup();
        }
    });

    it('returns early when offline (no apiCallDirect calls, queue untouched)', async () => {
        const apiCallDirect = vi.fn();
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });

            window.SyncManager.isOnline = false;
            await window.SyncManager.drainSwActionQueue();

            expect(apiCallDirect).not.toHaveBeenCalled();
            expect(swActionQueue.rows.size).toBe(1);
        } finally {
            cleanup();
        }
    });

    // Race: two app windows open, both reach drainSwActionQueue() at the
    // same instant. claimPending() runs in a Dexie 'rw' transaction so
    // only one drain can pick up a given envelope; the other observes
    // zero rows. Otherwise non-idempotent endpoints (snooze/skip/cancel)
    // would be POSTed twice.
    it('two concurrent drains claim each queued action exactly once', async () => {
        const apiCallDirect = vi.fn().mockResolvedValue({ ok: true });
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });
            await swActionQueue.save({
                endpoint: '/api/workout/sessions/3/snooze',
                method: 'POST',
                body: { minutes: 60 },
            });

            await Promise.all([
                window.SyncManager.drainSwActionQueue(),
                window.SyncManager.drainSwActionQueue(),
            ]);

            // Each envelope POSTed exactly once across both drains.
            expect(apiCallDirect).toHaveBeenCalledTimes(2);
            expect(swActionQueue.rows.size).toBe(0);
        } finally {
            cleanup();
        }
    });

    // After a successful replay, the visible tab needs to refresh —
    // drainSwActionQueue invalidates the DataStore tags affected by each
    // queued endpoint, mirroring the invalidateTags calls the main-thread
    // mutation paths already use.
    it('invalidates DataStore tags after a successful drain', async () => {
        const apiCallDirect = vi.fn().mockResolvedValue({ ok: true });
        const invalidateTags = vi.fn().mockResolvedValue(undefined);
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            window.DataStore = { invalidateTags };

            await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });
            await swActionQueue.save({
                endpoint: '/api/workout/sessions/3/snooze',
                method: 'POST',
                body: { minutes: 60 },
            });
            await swActionQueue.save({
                endpoint: '/api/bp/reminder/snooze',
                method: 'POST',
                body: null,
            });

            await window.SyncManager.drainSwActionQueue();

            expect(invalidateTags).toHaveBeenCalledTimes(1);
            const tags = invalidateTags.mock.calls[0][0];
            expect(tags).toEqual(expect.arrayContaining(['medications', 'history', 'workout', 'bp']));
        } finally {
            cleanup();
        }
    });

    // apiCallDirect advances the change cursor silently after each POST,
    // so the normal change-poll path will not repaint the visible tab
    // for replayed writes. After a successful drain the visible tab
    // must therefore be refreshed explicitly — mirrors the loadX()
    // call that main-thread mutation sites issue after invalidateTags.
    it('refreshes the visible tab after a successful drain', async () => {
        const apiCallDirect = vi.fn().mockResolvedValue({ ok: true });
        const invalidateTags = vi.fn().mockResolvedValue(undefined);
        const requestTabRefresh = vi.fn();
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            window.DataStore = { invalidateTags, requestTabRefresh };

            await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });

            await window.SyncManager.drainSwActionQueue();

            expect(requestTabRefresh).toHaveBeenCalledTimes(1);
            const tags = requestTabRefresh.mock.calls[0][0];
            expect(tags).toEqual(expect.arrayContaining(['medications', 'history']));
        } finally {
            cleanup();
        }
    });

    // Fallback path when DataStore is missing requestTabRefresh: the
    // drain still triggers a visible refresh via the global helper.
    it('falls back to window.requestTabRefresh when DataStore.requestTabRefresh is absent', async () => {
        const apiCallDirect = vi.fn().mockResolvedValue({ ok: true });
        const invalidateTags = vi.fn().mockResolvedValue(undefined);
        const requestTabRefresh = vi.fn();
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            window.DataStore = { invalidateTags };
            window.requestTabRefresh = requestTabRefresh;

            await swActionQueue.save({
                endpoint: '/api/bp/reminder/snooze',
                method: 'POST',
                body: null,
            });

            await window.SyncManager.drainSwActionQueue();

            expect(requestTabRefresh).toHaveBeenCalledTimes(1);
            expect(requestTabRefresh).toHaveBeenCalledWith({
                changedTags: expect.arrayContaining(['bp']),
                source: 'sw-action-drain',
            });
        } finally {
            cleanup();
        }
    });

    // If every replay fails, no tags should be invalidated — otherwise
    // we'd churn caches without any data actually changing server-side.
    it('does not invalidate tags when every replay fails', async () => {
        const apiCallDirect = vi.fn().mockRejectedValue(
            Object.assign(new Error('Bad Gateway'), { status: 502 })
        );
        const invalidateTags = vi.fn().mockResolvedValue(undefined);
        const { window, swActionQueue, cleanup } = loadDrainEnv({ apiCallDirect });
        try {
            window.DataStore = { invalidateTags };

            await swActionQueue.save({
                endpoint: '/api/medications/skip',
                method: 'POST',
                body: { intake_id: 7 },
            });

            await window.SyncManager.drainSwActionQueue();

            expect(invalidateTags).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});

// Verifies sw-api-helper.js writes into the pending_sw_actions store via the
// raw IndexedDB API (it cannot use Dexie from a SW context). We drive the
// helper inside a vm sandbox with a stubbed indexedDB.open that records the
// add() payload.
describe('sw-api-helper enqueueFailedAction (raw IDB write)', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    it('writes endpoint/method/body/syncStatus=pending/createdAt into pending_sw_actions', async () => {
        const fs2 = await import('node:fs');
        const vm = await import('node:vm');
        const HELPER_PATH = path.join(REPO_ROOT, 'web/static/js/sw-api-helper.js');
        const HELPER_SOURCE = fs2.readFileSync(HELPER_PATH, 'utf-8');

        const addCalls = [];
        const fakeDb = {
            objectStoreNames: { contains: (name) => name === 'pending_sw_actions' },
            close: () => {},
            transaction(_storeName, _mode) {
                const tx = {};
                const store = {
                    add(record) {
                        addCalls.push(record);
                        const req = { onsuccess: null, onerror: null, result: 99 };
                        setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
                        // Fire tx.oncomplete shortly after.
                        setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
                        return req;
                    },
                };
                tx.objectStore = () => store;
                return tx;
            },
        };
        const fakeIndexedDB = {
            open(_name) {
                const req = { onsuccess: null, onerror: null, onblocked: null, result: fakeDb };
                setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
                return req;
            },
        };

        const selfObj = {};
        const sandbox = {
            self: selfObj,
            fetch: () => { throw new Error('not used'); },
            indexedDB: fakeIndexedDB,
            setTimeout, clearTimeout, Promise, JSON, Error, TypeError,
        };
        sandbox.globalThis = sandbox;
        // sw-api-helper.js calls `root.indexedDB.open(...)` where root is self.
        selfObj.indexedDB = fakeIndexedDB;

        vm.createContext(sandbox);
        vm.runInContext(HELPER_SOURCE, sandbox, { filename: HELPER_PATH });

        const ok = await selfObj.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body: { intake_id: 7 },
        });

        expect(ok).toBe(true);
        expect(addCalls).toHaveLength(1);
        expect(addCalls[0]).toMatchObject({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body: { intake_id: 7 },
            syncStatus: 'pending',
        });
        expect(typeof addCalls[0].createdAt).toBe('number');
    });

    it('returns false (does not throw) when indexedDB.open fails — failure mode of last resort', async () => {
        const fs2 = await import('node:fs');
        const vm = await import('node:vm');
        const HELPER_PATH = path.join(REPO_ROOT, 'web/static/js/sw-api-helper.js');
        const HELPER_SOURCE = fs2.readFileSync(HELPER_PATH, 'utf-8');

        const fakeIndexedDB = {
            open(_name) {
                const req = { onsuccess: null, onerror: null, onblocked: null, error: new Error('quota') };
                setTimeout(() => req.onerror && req.onerror(), 0);
                return req;
            },
        };

        const selfObj = {};
        const sandbox = {
            self: selfObj,
            fetch: () => { throw new Error('not used'); },
            indexedDB: fakeIndexedDB,
            setTimeout, clearTimeout, Promise, JSON, Error, TypeError,
        };
        sandbox.globalThis = sandbox;
        selfObj.indexedDB = fakeIndexedDB;

        vm.createContext(sandbox);
        vm.runInContext(HELPER_SOURCE, sandbox, { filename: HELPER_PATH });

        const ok = await selfObj.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body: { intake_id: 7 },
        });

        expect(ok).toBe(false);
    });

    it('notifies open clients via postMessage(SW_ACTION_QUEUED) after a successful enqueue', async () => {
        const fs2 = await import('node:fs');
        const vm = await import('node:vm');
        const HELPER_PATH = path.join(REPO_ROOT, 'web/static/js/sw-api-helper.js');
        const HELPER_SOURCE = fs2.readFileSync(HELPER_PATH, 'utf-8');

        const fakeDb = {
            objectStoreNames: { contains: (name) => name === 'pending_sw_actions' },
            close: () => {},
            transaction(_storeName, _mode) {
                const tx = {};
                const store = {
                    add(_record) {
                        const req = { onsuccess: null, onerror: null, result: 1 };
                        setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
                        setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
                        return req;
                    },
                };
                tx.objectStore = () => store;
                return tx;
            },
        };
        const fakeIndexedDB = {
            open(_name) {
                const req = { onsuccess: null, onerror: null, onblocked: null, result: fakeDb };
                setTimeout(() => req.onsuccess && req.onsuccess({ target: req }), 0);
                return req;
            },
        };

        const postMessage = vi.fn();
        const fakeClients = {
            matchAll: vi.fn().mockResolvedValue([{ postMessage }]),
        };

        const selfObj = { clients: fakeClients };
        const sandbox = {
            self: selfObj,
            fetch: () => { throw new Error('not used'); },
            indexedDB: fakeIndexedDB,
            setTimeout, clearTimeout, Promise, JSON, Error, TypeError,
        };
        sandbox.globalThis = sandbox;
        selfObj.indexedDB = fakeIndexedDB;

        vm.createContext(sandbox);
        vm.runInContext(HELPER_SOURCE, sandbox, { filename: HELPER_PATH });

        const ok = await selfObj.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body: { intake_id: 7 },
        });

        expect(ok).toBe(true);
        expect(fakeClients.matchAll).toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledWith({ type: 'SW_ACTION_QUEUED' });
    });

    it('returns false when pending_sw_actions store is missing (DB not yet upgraded to v6)', async () => {
        const fs2 = await import('node:fs');
        const vm = await import('node:vm');
        const HELPER_PATH = path.join(REPO_ROOT, 'web/static/js/sw-api-helper.js');
        const HELPER_SOURCE = fs2.readFileSync(HELPER_PATH, 'utf-8');

        const fakeDb = {
            objectStoreNames: { contains: () => false },
            close: () => {},
        };
        const fakeIndexedDB = {
            open(_name) {
                const req = { onsuccess: null, onerror: null, result: fakeDb };
                setTimeout(() => req.onsuccess && req.onsuccess(), 0);
                return req;
            },
        };

        const selfObj = {};
        const sandbox = {
            self: selfObj,
            fetch: () => { throw new Error('not used'); },
            indexedDB: fakeIndexedDB,
            setTimeout, clearTimeout, Promise, JSON, Error, TypeError,
        };
        sandbox.globalThis = sandbox;
        selfObj.indexedDB = fakeIndexedDB;

        vm.createContext(sandbox);
        vm.runInContext(HELPER_SOURCE, sandbox, { filename: HELPER_PATH });

        const ok = await selfObj.SwApi.enqueueFailedAction({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body: { intake_id: 7 },
        });

        expect(ok).toBe(false);
    });
});
