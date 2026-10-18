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
import { cancelReminderRecompute } from '../../../cloud/js/reminders.js';

const LOCAL_BOOT_SRC = readFileSync(
    fileURLToPath(new URL('../../../cloud/js/local-boot.js', import.meta.url)),
    'utf8',
).replace(/\bimport\(/g, '__imp(');

const MODULES = {
    '/js/apishim.js': () => import('../../../cloud/js/apishim.js'),
    '/js/sync.js': () => import('../../../cloud/js/sync.js'),
    '/js/local-policy.js': () => import('../../../cloud/js/local-policy.js'),
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
        // A write's debounced reminder recompute must not fire into the next test.
        cancelReminderRecompute({ accountId: 'local' });
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
                documentElement: { classList: { add() {} } },
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

// bd med-o7zq.3 — local mode's side-effect and egress policy: nothing leaves the
// device except calls to the providers the user configured with their own key.
// The shell's CSP enforces that on the device; this pins that the app no longer
// asks for anything else (relay, RxNav, egress PUT, server-only UI).
const STYLES_CSS = readFileSync(
    fileURLToPath(new URL('../../css/styles.css', import.meta.url)),
    'utf8',
);
// Just the local-mode visibility rule — jsdom applies <style> rules in
// getComputedStyle, but the whole kit stylesheet is not worth parsing here.
function localModeCss() {
    const start = STYLES_CSS.indexOf(':root.wg-local-vault .wg-cloud-only,');
    return STYLES_CSS.slice(start, STYLES_CSS.indexOf('}', start) + 1);
}

const BYOK_HOST = 'api.example-ai.test';

describe('local-only mode egress + side-effect policy (med-o7zq.3)', () => {
    let env;
    let fetched;
    let bridge;
    let schedule;

    // Off-device = anything the bundle cannot answer itself: an /api/* route
    // (our server) or an absolute URL other than the BYOK provider.
    const offDevice = () => fetched.filter((u) => u.startsWith('/api/')
        || (/^[a-z][a-z0-9+.-]*:/i.test(u) && new URL(u).hostname !== BYOK_HOST));

    beforeEach(async () => {
        await deleteDb();
        fetched = [];
        const recorder = vi.fn(async (url) => {
            fetched.push(String(url));
            return createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', recorder);
        env = loadFrontendEnv();
        env.window.fetch = recorder;
        // The iOS shell: the bridge foundation (native/index.js) and the
        // device scheduler (native/local-notifications.js ios impl).
        bridge = vi.fn(async (op) => (op === 'setEgressHosts' ? { changed: false } : null));
        schedule = vi.fn(async () => 0);
        const notifications = {
            isSupported: () => true, schedule, test: vi.fn(async () => {}),
            __native: { platform: 'ios', call: bridge },
        };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        const style = env.document.createElement('style');
        style.textContent = localModeCss();
        env.document.head.appendChild(style);
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
    });

    afterEach(() => {
        // A write's debounced reminder recompute must not fire into the next test.
        cancelReminderRecompute({ accountId: 'local' });
        env.cleanup();
        vi.unstubAllGlobals();
    });

    it('core flows (med, BP, weight, workout, food, reminders, export) make no off-device request', async () => {
        const { window } = env;
        const med = await window.apiCall('/api/medications', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
        });
        expect(med.id).toBeTruthy();
        await window.apiCall('/api/medications/log-past', 'POST', {
            medication_id: med.id, taken_at: new Date(Date.now() - 60_000).toISOString(),
        });
        await window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76, pulse: 64, measured_at: new Date().toISOString() });
        await window.apiCall('/api/weight', 'POST', { weight: 80 });

        const group = await window.apiCall('/api/workout/groups/create', 'POST', {
            name: 'Push Day', is_rotating: false, days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '18:00',
        });
        await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'A', rotation_order: 0 });
        expect(await window.apiCall('/api/workout/groups')).toHaveLength(1);

        await window.apiCall('/api/food/log', 'POST', {
            eaten_at: new Date().toISOString(), weight: 150, carbs: 10, protein: 8, fat: 3, calories: 99, name: 'Yogurt', barcode: '', per_100g: false,
        });

        // Reminder scheduling: the horizon goes to the device scheduler, with
        // name-free bodies by default.
        await window.apiCall('/api/bp/reminder/toggle', 'POST', { enabled: true });
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled(), { timeout: 5000 });
        const medItems = schedule.mock.calls.at(-1)[0].filter((i) => i.section === 'meds');
        expect(medItems.length).toBeGreaterThan(0);
        for (const i of medItems) expect(i.body).not.toContain('Metformin');

        const vault = JSON.parse(await window.CloudVault.exportAll({ includeSecrets: false }));
        expect(JSON.stringify(vault)).toContain('Metformin');

        expect(offDevice()).toEqual([]);
        // The med save made no RxNav lookup and stored no rxcui.
        expect((await window.apiCall('/api/medications'))[0].rxcui || '').toBe('');
    });

    it('the lock-screen text pref reschedules: Detailed names the medication', async () => {
        const { window } = env;
        await window.apiCall('/api/medications', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
        });
        const sel = window.document.getElementById('local-reminder-verbosity');
        await window.bindLocalReminderText();
        expect(sel.value).toBe('generic');
        schedule.mockClear();
        sel.value = 'detailed';
        sel.dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled(), { timeout: 5000 });
        const med = schedule.mock.calls.at(-1)[0].find((i) => i.section === 'meds');
        expect(med.body).toContain('Metformin');
        expect(sel.value).toBe('detailed');
        expect(await window.apiCall('/api/settings/reminder-delivery')).toMatchObject({ verbosity: 'detailed' });
        expect(offDevice()).toEqual([]);
    });

    it('a BYOK provider registers its host with the shell, never a server; the call reaches only it', async () => {
        const { window } = env;
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('setEgressHosts', { hosts: [] }));
        await window.apiCall('/api/settings/integrations', 'PATCH', {
            openai: { api_key: 'sk-test', url: `https://${BYOK_HOST}/v1` },
        });
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('setEgressHosts', { hosts: [BYOK_HOST] }));
        await window.apiCall(`/api/settings/integrations/models?scope=text&refresh=1`);
        expect(fetched.some((u) => new URL(u, 'wgapp://local/').hostname === BYOK_HOST)).toBe(true);
        expect(offDevice()).toEqual([]);
    });

    it('hides what needs our server and shows the local-mode copy', () => {
        const { document, window } = env;
        expect(document.documentElement.classList.contains('wg-local-vault')).toBe(true);
        const shown = (el) => window.getComputedStyle(el).display !== 'none';
        const hidden = [
            document.getElementById('health-import-miband').parentElement,
            document.getElementById('importexport-nxk-group'),
            document.getElementById('importexport-reset-sync-group'),
            document.getElementById('importexport-import-btn').closest('section'),
            document.getElementById('integrations-elevenlabs-api-key').closest('section'),
            document.getElementById('workout-group-share-btn'),
        ];
        for (const el of hidden) expect(shown(el), el.id || el.className).toBe(false);
        expect(shown(document.getElementById('local-reminder-verbosity').closest('section'))).toBe(true);
        // The settings home hides a row whose page has nothing left to show.
        expect(window.isSettingsSectionHidden(document.getElementById('importexport-nxk-group'))).toBe(true);
        expect(window.isSettingsSectionHidden(document.getElementById('local-reminder-verbosity').closest('section'))).toBe(false);
    });
});
