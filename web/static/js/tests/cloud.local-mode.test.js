// bd med-o7zq.2 — iOS local-only mode: the app boots through
// web/cloud/js/local-boot.js and runs against the durable on-device records
// port (sync.js localRecordsPort) with no account and no sync engine. Every
// write used to go through writeRecord, which bootstraps GET
// /api/sync/snapshot, queues a 'pending' op and flushes it — so a "local" app
// over the cloud port would fail fetches and pile up pending rows forever.
//
// Runs the REAL local-boot.js body (a classic script, like cloud-boot.js) in
// the frontend harness window, its dynamic imports resolved to the real
// modules, over a real (fake-indexeddb) store.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { localRecordsPort } from '../../../cloud/js/sync.js';
import { openDb } from '../../../cloud/js/localdb.js';

const LOCAL_BOOT_SRC = readFileSync(
    fileURLToPath(new URL('../../../cloud/js/local-boot.js', import.meta.url)),
    'utf8',
).replace(/\bimport\(/g, '__imp(');

const MODULES = {
    '/js/apishim.js': () => import('../../../cloud/js/apishim.js'),
    '/js/sync.js': () => import('../../../cloud/js/sync.js'),
};

function deleteDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('medtracker-cloud');
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
    });
}

async function pendingRows() {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const req = db.transaction('pending', 'readonly').objectStore('pending').getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

describe('local-only mode boot + records port (med-o7zq.2)', () => {
    let env;
    let fetched;

    beforeEach(async () => {
        await deleteDb();
        fetched = [];
        // Everything that could leave the device — sync.js and the domain ports
        // use the global fetch, the feature modules the window's. Non-sync calls
        // (e.g. the RxNav lookup on a med save, med-o7zq.3's policy) degrade on
        // a 503 the way they do offline.
        const recorder = vi.fn(async (url) => {
            fetched.push(String(url));
            return createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', recorder);
        env = loadFrontendEnv();
        env.window.fetch = recorder;
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
    });

    afterEach(() => {
        env.cleanup();
        vi.unstubAllGlobals();
    });

    it('logs, reads, edits and deletes BP, weight and a med intake with zero sync traffic', async () => {
        const { window } = env;

        // BP
        const bp = await window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76, pulse: 64, measured_at: new Date().toISOString() });
        expect(bp.id).toBeTruthy();
        await window.apiCall(`/api/bp/${bp.id}`, 'PUT', { systolic: 150, diastolic: 95, pulse: 64 });
        let bps = await window.apiCall('/api/bp?days=60');
        expect(bps).toHaveLength(1);
        expect(bps[0].systolic).toBe(150);
        await window.apiCall(`/api/bp/${bp.id}`, 'DELETE');
        bps = await window.apiCall('/api/bp?days=60');
        expect(bps).toHaveLength(0);

        // Weight (an edit is what handleWeightSubmit does: POST ?replaces=<id>,
        // then DELETE the replaced row)
        const w = await window.apiCall('/api/weight', 'POST', { weight: 80 });
        const w2 = await window.apiCall(`/api/weight?replaces=${w.id}`, 'POST', { weight: 79.5 });
        await window.apiCall(`/api/weight/${w.id}`, 'DELETE');
        let ws = await window.apiCall('/api/weight?days=0&limit=1000');
        expect(ws.map((r) => r.weight)).toEqual([79.5]);
        await window.apiCall(`/api/weight/${w2.id}`, 'DELETE');
        ws = await window.apiCall('/api/weight?days=0&limit=1000');
        expect(ws).toHaveLength(0);

        // Medication + intake: log, read, edit, delete.
        const HOUR = 60 * 60 * 1000;
        const med = await window.apiCall('/api/medications', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: JSON.stringify({ type: 'as_needed' }), inventory_count: 5,
        });
        const intake = await window.apiCall('/api/medications/log-past', 'POST', {
            medication_id: med.id, taken_at: new Date(Date.now() - HOUR).toISOString(),
        });
        expect(intake.status).toBe('TAKEN');
        expect((await window.apiCall('/api/medications'))[0].inventory_count).toBe(4);
        const editedAt = new Date(Date.now() - HOUR / 2).toISOString();
        const upd = await window.apiCall('/api/intakes/update', 'POST', {
            updates: [{ id: intake.id, status: 'TAKEN', taken_at: editedAt }],
        });
        expect(upd.updated).toBe(1);
        const history = await window.apiCall(`/api/history?days=1&med_id=${med.id}`);
        expect(history.find((h) => h.id === intake.id)).toMatchObject({ status: 'TAKEN', taken_at: editedAt });
        // Delete: only a future PENDING dose can be deleted (past ones are history).
        const future = await window.apiCall('/api/medications/log-past', 'POST', {
            medication_id: med.id, taken_at: new Date(Date.now() + HOUR).toISOString(),
        });
        await window.apiCall('/api/medications/cancel-intake', 'POST', { intake_ids: [future.id] });
        const del = await window.apiCall('/api/medications/delete-intake', 'POST', { intake_ids: [future.id] });
        expect(del.deleted_count).toBe(1);
        // Durable: the rows are in the on-device store, the delete as a tombstone.
        const raw = await localRecordsPort().listRaw('intake');
        expect(raw.find((r) => r.recordId === future.id)).toMatchObject({ deleted: true });
        expect(raw.find((r) => r.recordId === intake.id)).toMatchObject({ taken_at: editedAt });

        expect(fetched.filter((u) => u.includes('/api/sync'))).toEqual([]);
        expect(await pendingRows()).toEqual([]);
    });

    it('serves apiCallDirect /api/* reads from the local store too', async () => {
        await env.window.apiCall('/api/bp', 'POST', { systolic: 120, diastolic: 80, pulse: 60, measured_at: new Date().toISOString() });
        const direct = await env.window.apiCallDirect('/api/bp?days=60');
        expect(direct).toHaveLength(1);
        expect(fetched.filter((u) => u.includes('/api/'))).toEqual([]);
    });
});

describe('local-boot apiCallDirect ordering (med-o7zq.2)', () => {
    beforeEach(deleteDb);

    it('wraps the apiCallDirect core/api.js assigns later in the parse, not an earlier one', async () => {
        let onReady;
        const win = {
            location: { origin: 'wgapp://local' },
            document: {
                readyState: 'loading',
                addEventListener(type, cb) { if (type === 'DOMContentLoaded') onReady = cb; },
            },
        };
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(win, (spec) => MODULES[spec]());
        // The imports resolve while the parser is still in the body scripts...
        await vi.waitFor(() => expect(win.offlineAwareApiCall).toBeTypeOf('function'));
        // ...then core/api.js runs and assigns its own apiCallDirect.
        const network = vi.fn(async () => 'network');
        win.apiCallDirect = network;
        onReady();
        await win.MedTrackerCloudReady;
        expect(await win.apiCallDirect('/api/bp?days=60')).toEqual([]);
        expect(await win.apiCallDirect('/static/x.json')).toBe('network');
        expect(network).toHaveBeenCalledTimes(1);
    });
});

describe('localRecordsPort contract (med-o7zq.2)', () => {
    beforeEach(deleteDb);

    it('putIfAbsent is atomic under concurrency: one winner, returned to every caller', async () => {
        const port = localRecordsPort();
        const results = await Promise.all(Array.from({ length: 12 }, (_, n) => (
            port.putIfAbsent('intake', { recordId: 'intake-slot-1', clientTs: 0, deleted: false, n })
        )));
        expect(new Set(results.map((r) => r.n))).toEqual(new Set([results[0].n]));
        const raw = await port.listRaw('intake');
        expect(raw).toHaveLength(1);
        expect(raw[0]).toMatchObject({ n: results[0].n, clientTs: 0, recordType: 'intake' });
    });

    it('a tombstone occupies the slot; put outranks the version it replaces', async () => {
        const port = localRecordsPort();
        await port.put('intake', { recordId: 'i1', clientTs: 5000, deleted: false });
        await port.del('intake', 'i1');
        expect(await port.list('intake')).toEqual([]);
        const kept = await port.putIfAbsent('intake', { recordId: 'i1', clientTs: 0, deleted: false });
        expect(kept.deleted).toBe(true);

        const first = await port.put('bp', { recordId: 'b1', clientTs: Date.now() + 60_000 });
        const edit = await port.put('bp', { recordId: 'b1', clientTs: 1 });
        expect(edit.clientTs).toBe(first.clientTs + 1);
        expect(await pendingRows()).toEqual([]);
    });
});
