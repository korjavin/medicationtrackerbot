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
import { allowConsoleNoise } from './helpers/setup.js';
import { recordsToVault, vaultToRecords } from '../../../domain/vault.js';

const LOCAL_BOOT_SRC = readFileSync(
    fileURLToPath(new URL('../../../cloud/js/local-boot.js', import.meta.url)),
    'utf8',
).replace(/\bimport\(/g, '__imp(');

// The shared golden vault (docs/vault-format.md): what every runtime's
// importer pins, so a backup from the local bundle is the same format.
const VAULT_FIXTURE = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../../tests/fixtures/vault-v1.json', import.meta.url)),
    'utf8',
));

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
        // use the global fetch, the feature modules the window's. A 503 is what
        // any stray call would meet offline (med-o7zq.3 pins that there is none).
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

    // bd med-o7zq.5: the on-device store is the only copy outside the
    // iPhone's backup, so a weekly toast suggests exporting one.
    it('reminds to export a backup at most weekly, only once there is data; an export restarts the week', async () => {
        const { window } = env;
        const { nudgeLocalBackup, BACKUP_NUDGE_MS } = await import('../../../cloud/js/local-policy.js');
        const KEY = 'wg:local-backup-nudge-at';
        const toast = vi.fn();
        window.safeToast = toast;
        window.switchTab = vi.fn();
        window.SettingsView = { openSettingsPage: vi.fn() };

        // The boot started the week.
        const start = Number(window.localStorage.getItem(KEY));
        expect(start).toBeGreaterThan(0);
        const due = start + BACKUP_NUDGE_MS;
        expect(await nudgeLocalBackup({ win: window, now: due })).toBe(false); // nothing stored yet

        await window.apiCall('/api/weight', 'POST', { weight: 80 });
        expect(await nudgeLocalBackup({ win: window, now: due - 1 })).toBe(false);
        expect(await nudgeLocalBackup({ win: window, now: due })).toBe(true);
        expect(await nudgeLocalBackup({ win: window, now: due + 1 })).toBe(false); // next one a week on
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls[0][0]).toContain('only on this iPhone');
        toast.mock.calls[0][2].action.onClick();
        expect(window.switchTab).toHaveBeenCalledWith('settings');
        expect(window.SettingsView.openSettingsPage).toHaveBeenCalledWith('backup');

        const before = Date.now();
        await window.CloudVault.exportAll({ includeSecrets: false, win: window });
        expect(Number(window.localStorage.getItem(KEY))).toBeGreaterThanOrEqual(before);
        expect(fetched.filter((u) => u.includes('/api/'))).toEqual([]);
    });

    // bd med-o7zq.6: restore into local mode, and the local bundle's export is
    // the one vault format — what a move to a cloud account imports there.
    it('restores the golden vault fixture, and its local export is what the cloud importer reads', async () => {
        const { window } = env;
        await window.apiCall('/api/weight', 'POST', { weight: 99 }); // replaced by the restore
        cancelReminderRecompute({ accountId: 'local' });
        await window.CloudVault.importAll(JSON.stringify(VAULT_FIXTURE), { win: window });
        const json = await window.CloudVault.exportAll({ win: window });
        const exported = JSON.parse(json);
        const now = Date.parse(exported.exported_at);
        expect(exported.data).toEqual(recordsToVault(vaultToRecords(VAULT_FIXTURE, { now }), { now }).data);
        const weights = (await window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight);
        expect(weights.sort()).toEqual(VAULT_FIXTURE.data.weight.logs.map((r) => r.weight).sort());
        // The cloud's importAll runs this same conversion on the file.
        expect(vaultToRecords(exported, { now }).length).toBe(vaultToRecords(VAULT_FIXTURE, { now }).length);
        // Restoring its own export again changes nothing.
        await window.CloudVault.importAll(json, { win: window });
        expect(JSON.parse(await window.CloudVault.exportAll({ win: window })).data).toEqual(exported.data);
        expect(fetched.filter((u) => u.includes('/api/'))).toEqual([]);
        expect(await pendingRows()).toEqual([]);
    });

    it('rejects a file that is not a v1 vault before anything is replaced', async () => {
        const { window } = env;
        await window.apiCall('/api/weight', 'POST', { weight: 80 });
        cancelReminderRecompute({ accountId: 'local' });
        await expect(window.CloudVault.importAll(JSON.stringify({ ...VAULT_FIXTURE, version: 2 }), { win: window }))
            .rejects.toThrow(/v1 backup/);
        expect((await window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight)).toEqual([80]);
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
        // Boot reschedules the device's reminders (the lapse-notice refill);
        // let it land before the test reads the schedule or tears the db down.
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
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
        schedule.mockClear();
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

    it('coming back to the front refills the device schedule (the lapse notice\'s promise)', async () => {
        schedule.mockClear();
        env.document.dispatchEvent(new env.window.Event('visibilitychange'));
        await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
        expect(offDevice()).toEqual([]);
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
            document.getElementById('integrations-elevenlabs-api-key').closest('section'),
            document.getElementById('workout-group-share-btn'),
        ];
        for (const el of hidden) expect(shown(el), el.id || el.className).toBe(false);
        expect(shown(document.getElementById('local-reminder-verbosity').closest('section'))).toBe(true);
        // Restore and the move to a cloud account work here (bd med-o7zq.6).
        expect(shown(document.getElementById('importexport-import-btn').closest('section'))).toBe(true);
        expect(shown(document.getElementById('importexport-local-move-group'))).toBe(true);
        // The settings home hides a row whose page has nothing left to show.
        expect(window.isSettingsSectionHidden(document.getElementById('importexport-nxk-group'))).toBe(true);
        expect(window.isSettingsSectionHidden(document.getElementById('local-reminder-verbosity').closest('section'))).toBe(false);
    });
});

describe('local-only mode native integration (med-o7zq.9)', () => {
    let env;
    let fetched;
    let bridge;
    let schedule;
    let permission;
    const HEALTH_UUID = '11111111-2222-4333-8444-555555555555';

    const offDevice = () => fetched.filter((u) => u.startsWith('/api/') || /^[a-z][a-z0-9+.-]*:/i.test(u));

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
        // Mirrors the shell's real contract. window.LocalNotifications is
        // web/static/js/native/local-notifications.js (ios impl), each method one
        // wgNative op answered in ios/App/Notifications.swift handle():
        //   permission() / requestPermission() → notifications.permission /
        //     .requestPermission → 'granted' | 'denied' | 'default'
        //   schedule(items) → notifications.schedule {items} → Int, how many it
        //     added (0 without permission; it adds at most 64)
        //   test() → notifications.test → true
        // __native.call is native/index.js call(op, args), answered in
        // ios/App/Shell.swift: setEgressHosts {hosts} → {changed},
        // local.reset → true.
        bridge = vi.fn(async (op) => (op === 'setEgressHosts' ? { changed: false } : true));
        schedule = vi.fn(async (items) => (permission === 'granted' ? Math.min(items.length, 64) : 0));
        permission = 'default';
        const notifications = {
            isSupported: () => true,
            schedule,
            test: vi.fn(async () => {}),
            permission: vi.fn(async () => permission),
            requestPermission: vi.fn(async () => {
                permission = 'granted';
                return permission;
            }),
            __native: { platform: 'ios', call: bridge },
        };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        // The shell's Health (native/health.js ios impl): one BP reading on the
        // first anchored page, nothing after.
        const start = Date.now() - 60 * 60 * 1000;
        env.window.Health = {
            isSupported: () => true,
            requestAuthorization: vi.fn(async () => true),
            query: vi.fn(async ({ type, anchor }) => {
                const samples = type === 'bp' && !anchor
                    ? [{ uuid: HEALTH_UUID, start, systolic: 121, diastolic: 79 }]
                    : [];
                return { samples, anchor: 'a1', returned: samples.length, more: false };
            }),
        };
        env.window.localStorage.setItem('wg.health.enabled', 'true');
        env.window.localStorage.setItem('wg.health.asked', JSON.stringify(['bp', 'weight', 'sleep', 'workout']));
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
    });

    afterEach(() => {
        cancelReminderRecompute({ accountId: 'local' });
        env.cleanup();
        vi.unstubAllGlobals();
    });

    it('Apple Health readings land in the on-device store with nothing sent anywhere', async () => {
        const { window, document } = env;
        await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
        expect((await window.apiCall('/api/bp?days=60'))[0]).toMatchObject({ systolic: 121, diastolic: 79 });
        expect(document.getElementById('health-import-row')).toBeTruthy();
        expect(offDevice()).toEqual([]);
        expect(await pendingRows()).toEqual([]);
    });

    it('asks for notification permission, then schedules; a denial says where to turn it on', async () => {
        const { window, document } = env;
        await window.bindLocalNotifications();
        const state = document.getElementById('local-notify-state');
        const enable = document.getElementById('local-notify-enable');
        const test = document.getElementById('local-notify-test');
        expect(state.textContent).toContain('until you allow');
        expect(enable.hidden).toBe(false);
        expect(test.hidden).toBe(true);

        schedule.mockClear();
        enable.click();
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
        await vi.waitFor(() => expect(state.textContent).toContain('on for this iPhone'));
        expect(enable.hidden).toBe(true);
        expect(test.hidden).toBe(false);

        permission = 'denied';
        await window.refreshLocalNotifyState();
        expect(state.textContent).toContain('iOS Settings');
        expect(enable.hidden).toBe(true);
        expect(offDevice()).toEqual([]);
    });

    it('right after Allow the card says "Scheduling…", not the pre-permission outcome', async () => {
        const { window, document } = env;
        await window.apiCall('/api/medications', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
        });
        cancelReminderRecompute({ accountId: 'local' });
        // Before permission: reminders to set, iOS takes none of them.
        schedule.mockClear();
        document.dispatchEvent(new window.Event('visibilitychange'));
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
        await window.bindLocalNotifications();
        const state = document.getElementById('local-notify-state');
        expect(state.textContent).toContain('until you allow');

        // The rescheduling after Allow is held until released.
        let release;
        schedule.mockImplementationOnce((items) => new Promise((resolve) => { release = () => resolve(items.length); }));
        document.getElementById('local-notify-enable').click();
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        await vi.waitFor(() => expect(state.textContent).toContain('Scheduling reminders'));
        expect(state.textContent).not.toContain('accepted none');
        expect(state.classList.contains('status-error')).toBe(false);
        release();
        await vi.waitFor(() => expect(state.textContent).toBe('Reminders are on for this iPhone.'));
    });

    it('a failed device schedule shows on the card, and "on" waits for one that took', async () => {
        const { window, document } = env;
        permission = 'granted';
        await window.bindLocalNotifications();
        const state = document.getElementById('local-notify-state');
        const front = () => document.dispatchEvent(new window.Event('visibilitychange'));

        // The bridge rejects (a UNUserNotificationCenter add threw); reminders.js
        // also logs it.
        allowConsoleNoise();
        schedule.mockRejectedValueOnce(new Error('The operation couldn’t be completed'));
        front();
        await vi.waitFor(() => expect(state.textContent).toContain("Reminders couldn't be scheduled: The operation couldn’t be completed"));
        expect(state.classList.contains('status-error')).toBe(true);

        // Granted, reminders to set, but iOS took none of them.
        await window.apiCall('/api/medications', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: JSON.stringify({ type: 'daily', times: ['09:00'] }),
        });
        cancelReminderRecompute({ accountId: 'local' });
        schedule.mockResolvedValueOnce(0);
        front();
        await vi.waitFor(() => expect(state.textContent).toContain('iOS accepted none of them'));

        // The next schedule takes: now it is on.
        front();
        await vi.waitFor(() => expect(state.textContent).toBe('Reminders are on for this iPhone.'));
        expect(state.classList.contains('status-success')).toBe(true);
        expect(state.classList.contains('status-error')).toBe(false);
        expect(offDevice()).toEqual([]);
    });

    it('erase wipes this origin\'s records and storage, then the shell\'s share, and starts over', async () => {
        const { window } = env;
        await window.apiCall('/api/weight', 'POST', { weight: 80 });
        cancelReminderRecompute({ accountId: 'local' });
        window.localStorage.setItem('wg.health.anchors', JSON.stringify({ bp: 'a1' }));
        const replace = vi.fn();
        await window.CloudVault.eraseDevice({
            win: {
                localStorage: window.localStorage,
                sessionStorage: window.sessionStorage,
                LocalNotifications: window.LocalNotifications,
                location: { replace },
            },
        });
        expect(await localRecordsPort().listRaw('weight')).toEqual([]);
        expect(window.localStorage.getItem('wg.health.anchors')).toBeNull();
        expect(bridge).toHaveBeenCalledWith('local.reset');
        expect(replace).toHaveBeenCalledWith('/');
        expect(offDevice()).toEqual([]);
    });

    it('restore replaces the records the file carries and re-reads Apple Health from the start', async () => {
        const { window } = env;
        // The boot import has finished: its tally is written last.
        await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem('wg.health.last'))?.total).toBe(1));
        await window.apiCall('/api/weight', 'POST', { weight: 80 });
        const backup = await window.CloudVault.exportAll({ includeSecrets: false, win: window });
        await window.apiCall('/api/weight', 'POST', { weight: 70 });
        cancelReminderRecompute({ accountId: 'local' });
        expect(JSON.parse(window.localStorage.getItem('wg.health.anchors'))).toEqual({ bp: 'a1' });
        const tally = window.localStorage.getItem('wg.health.last');
        expect(JSON.parse(tally).total).toBe(1);

        await window.CloudVault.importAll(backup, { win: window });
        expect((await window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight)).toEqual([80]);
        expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1);
        // The anchors described the replaced records; the on/off choice and the
        // Settings row's tally ("N readings so far") stay.
        expect(JSON.parse(window.localStorage.getItem('wg.health.anchors'))).toEqual({});
        expect(window.localStorage.getItem('wg.health.enabled')).toBe('true');
        expect(window.localStorage.getItem('wg.health.last')).toBe(tally);
        expect(offDevice()).toEqual([]);
    });

    it('a restore that fails leaves the records and anchors as they were and Apple Health importing', async () => {
        const { window, document } = env;
        // The boot import has finished: its tally is written last.
        await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem('wg.health.last'))?.total).toBe(1));
        await window.apiCall('/api/weight', 'POST', { weight: 80 });
        const backup = await window.CloudVault.exportAll({ includeSecrets: false, win: window });
        await window.apiCall('/api/weight', 'POST', { weight: 70 });
        cancelReminderRecompute({ accountId: 'local' });
        const anchors = window.localStorage.getItem('wg.health.anchors');

        // The store refuses the replace (quota, a blocked database).
        const clear = vi.spyOn(globalThis.IDBObjectStore.prototype, 'clear')
            .mockImplementationOnce(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
        await expect(window.CloudVault.importAll(backup, { win: window })).rejects.toThrow(/Quota/);
        clear.mockRestore();
        expect((await window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight).sort()).toEqual([70, 80]);
        expect(window.localStorage.getItem('wg.health.anchors')).toBe(anchors);

        // Coming back to the front still imports.
        const calls = window.Health.query.mock.calls.length;
        await vi.waitFor(() => {
            document.dispatchEvent(new window.Event('visibilitychange'));
            expect(window.Health.query.mock.calls.length).toBeGreaterThan(calls);
        });
        expect(offDevice()).toEqual([]);
    });

    it('Move to a cloud account hands over to the shell\'s invite screen and keeps the records', async () => {
        const { window } = env;
        await window.apiCall('/api/weight', 'POST', { weight: 80 });
        cancelReminderRecompute({ accountId: 'local' });
        await window.CloudVault.openCloudAccount({ win: window });
        expect(bridge).toHaveBeenCalledWith('local.leave');
        expect((await localRecordsPort().list('weight')).map((r) => r.weight)).toEqual([80]);
        expect(offDevice()).toEqual([]);
    });

    it('erase waits out an Apple Health import in flight, and none starts after it', async () => {
        const { window, document } = env;
        // The boot import has landed; the next one blocks inside Health until released.
        await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
        let open;
        const gate = new Promise((resolve) => { open = resolve; });
        const health = window.Health;
        health.query.mockImplementation(async ({ type }) => {
            if (type !== 'bp') return { samples: [], anchor: 'a2', returned: 0, more: false };
            await gate;
            const samples = [{ uuid: '66666666-7777-4888-9999-aaaaaaaaaaaa', start: Date.now() - 1000, systolic: 130, diastolic: 85 }];
            return { samples, anchor: 'a2', returned: 1, more: false };
        });
        // Coming to the front starts that import, once the boot one has finished.
        await vi.waitFor(() => {
            document.dispatchEvent(new window.Event('visibilitychange'));
            expect(health.query).toHaveBeenCalledWith(expect.objectContaining({ type: 'bp', anchor: 'a1' }));
        });
        cancelReminderRecompute({ accountId: 'local' });

        const replace = vi.fn();
        const erased = window.CloudVault.eraseDevice({
            win: {
                localStorage: window.localStorage,
                sessionStorage: window.sessionStorage,
                LocalNotifications: window.LocalNotifications,
                location: { replace },
            },
        });
        open(); // the import finishes its writes while erase waits for it
        await erased;
        expect(await localRecordsPort().listRaw('bp')).toEqual([]);
        expect(window.localStorage.getItem('wg.health.anchors')).toBeNull();

        const calls = health.query.mock.calls.length;
        document.dispatchEvent(new window.Event('visibilitychange'));
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        expect(health.query.mock.calls.length).toBe(calls);
        expect(await localRecordsPort().listRaw('bp')).toEqual([]);
        expect(replace).toHaveBeenCalledWith('/');
    });
});

// bd med-o7zq.16 — the anonymous trial is one opt-in switch (the `anon` trial
// consent). Off, our server's base domain is not in the shell's CSP host list
// and nothing calls it; on, it is, and aiclient gets the attest transport.
describe('local-only mode anonymous trial opt-in (med-o7zq.16)', () => {
    const TRIAL_BASE = 'trial-base.example.test';
    let env;
    let fetched;
    let bridge;

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
        // The shell: setEgressHosts {hosts} → {changed} (Shell.swift); no
        // device reminders here. window.Attest is native/attest.js's ios impl,
        // answered by ios/App/Attest.swift; an attested key, so no enrollment
        // runs at boot.
        bridge = vi.fn(async (op) => (op === 'setEgressHosts' ? { changed: false } : null));
        const notifications = { isSupported: () => false, __native: { platform: 'ios', call: bridge } };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        env.window.Attest = {
            isSupported: () => true,
            status: vi.fn(async () => ({ supported: true, base: TRIAL_BASE, attested: true })),
            enroll: vi.fn(),
            assert: vi.fn(),
        };
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('setEgressHosts', { hosts: [] }));
    });

    afterEach(async () => {
        const { setTrialTransport } = await import('../../../cloud/js/aiclient.js');
        setTrialTransport(null);
        env.cleanup();
        vi.unstubAllGlobals();
    });

    const toBase = () => fetched.filter((u) => /^https?:/.test(u) && new URL(u).hostname === TRIAL_BASE);

    it('off by default: the base domain is absent from the host list and never called', async () => {
        const { window } = env;
        expect(await window.CloudVault.trial.status()).toEqual({ on: false });
        for (const [op, args] of bridge.mock.calls) {
            if (op === 'setEgressHosts') expect(args.hosts).not.toContain(TRIAL_BASE);
        }
        // Without a key or the trial, meal parsing asks for a key, sends nothing.
        await expect(window.CloudFoodAI.parseMealFromDescription('two eggs')).rejects.toMatchObject({ code: 'no_api_key' });
        expect(toBase()).toEqual([]);
        expect(window.Attest.enroll).not.toHaveBeenCalled();
    });

    it('the Settings switch runs the local consent, adds the base domain, and turning it off removes it', async () => {
        const { window, document } = env;
        await window.SettingsIntegrations._renderLocalTrial();
        const section = document.getElementById('integrations-local-trial');
        expect(section.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('integrations-local-trial-toggle').checked).toBe(false);

        const turningOn = window.SettingsIntegrations._setLocalTrial(true);
        const modal = await vi.waitFor(() => {
            const el = document.querySelector('.wg-trial-consent-modal[data-trial-consent-scope="anon"]');
            expect(el).not.toBeNull();
            return el;
        });
        // Local copy: through our server, what it keeps, per install, reinstall forfeits.
        expect(modal.textContent).toMatch(/through our server/i);
        expect(modal.textContent).toMatch(/App Attest/);
        expect(modal.textContent).toMatch(/per install/i);
        expect(modal.textContent).toMatch(/reinstalling the app gives up the rest/i);
        modal.querySelector('[data-trial-consent-choice="allow"]').click();
        await turningOn;

        expect((await window.apiCall('/api/settings/trial-consent')).anon).toBe(true);
        expect(bridge).toHaveBeenLastCalledWith('setEgressHosts', { hosts: [TRIAL_BASE] });
        expect(await window.CloudVault.trial.status()).toMatchObject({ on: true });
        expect(document.getElementById('integrations-local-trial-toggle').checked).toBe(true);

        await window.SettingsIntegrations._setLocalTrial(false);
        expect((await window.apiCall('/api/settings/trial-consent')).anon).toBe(false);
        expect(bridge).toHaveBeenLastCalledWith('setEgressHosts', { hosts: [] });
        expect(await window.CloudVault.trial.status()).toEqual({ on: false });
        expect(toBase()).toEqual([]);
    });

    it('stays hidden where the shell has no App Attest (the Simulator)', async () => {
        const { window, document } = env;
        window.Attest.status = vi.fn(async () => ({ supported: false, base: TRIAL_BASE, attested: false }));
        expect(await window.CloudVault.trial.status()).toBeNull();
        await window.SettingsIntegrations._renderLocalTrial();
        expect(document.getElementById('integrations-local-trial').classList.contains('hidden')).toBe(true);
    });
});

// bd med-o7zq.20 — the operator's food database rides the same trial switch:
// fooddb.js's operator lookups go through local-trial.js to the base domain's
// attest-gated GET /api/attest/food/* routes. Off, nothing is asked and the
// Add sheet says why.
describe('local-only mode food database through the trial (med-o7zq.20)', () => {
    const TRIAL_BASE = 'trial-base.example.test';
    const EAN = '4600000000001';
    const settle = async (n = 5) => {
        for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
    };
    let env;
    let fetched;
    let foodReply;

    beforeEach(async () => {
        await deleteDb();
        fetched = [];
        foodReply = () => new Response('{}', { status: 404 });
        const recorder = vi.fn(async (url, init = {}) => {
            fetched.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
            const u = String(url);
            if (u === `https://${TRIAL_BASE}/api/attest/challenge`) {
                return new Response(JSON.stringify({ challenge: 'c1', expires_in: 300 }), { status: 200 });
            }
            if (u.startsWith(`https://${TRIAL_BASE}/api/attest/food/`)) return foodReply(u);
            return createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', recorder);
        env = loadFrontendEnv();
        env.window.fetch = recorder;
        // fooddb.js decodes product names with the global document (the page's).
        vi.stubGlobal('document', env.document);
        env.window.safeToast = vi.fn();
        const bridge = vi.fn(async (op) => (op === 'setEgressHosts' ? { changed: false } : null));
        const notifications = { isSupported: () => false, __native: { platform: 'ios', call: bridge } };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        env.window.Attest = {
            isSupported: () => true,
            status: vi.fn(async () => ({ supported: true, base: TRIAL_BASE, attested: true })),
            enroll: vi.fn(),
            assert: vi.fn(async (challenge, digest) => ({ keyId: 'key-1', assertion: `sig:${challenge}:${digest}` })),
        };
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('setEgressHosts', { hosts: [] }));
    });

    afterEach(async () => {
        // The trial transport is module state: leave it off for the next test.
        await env.window.apiCall('/api/settings/trial-consent', 'PATCH', { anon: false });
        await env.window.CloudVault.trial.apply();
        const { setTrialTransport } = await import('../../../cloud/js/aiclient.js');
        setTrialTransport(null);
        env.cleanup();
        vi.unstubAllGlobals();
    });

    async function trialOn() {
        await env.window.apiCall('/api/settings/trial-consent', 'PATCH', { anon: true });
        await env.window.CloudVault.trial.apply();
        expect(await env.window.CloudVault.trial.status()).toMatchObject({ on: true });
    }

    async function scan(code) {
        env.window.FoodLog.addSheet.open();
        await settle();
        expect(env.window.handleDecodedValue(code)).toBe(true);
    }

    const toServer = () => fetched.filter(({ url }) => url.startsWith('/api/')
        || (/^https?:/.test(url) && new URL(url).hostname === TRIAL_BASE));
    const foodGets = () => fetched.filter(({ url, method }) => method === 'GET'
        && url.startsWith(`https://${TRIAL_BASE}/api/attest/food/`));
    const OFF_COPY = 'No food database in device-only mode. Turn on the free trial in Settings → AI & integrations, or add your own food DB.';

    it('off: an unknown barcode says the food database is missing, opens the manual form, and asks no server', async () => {
        const { window, document } = env;
        await scan(EAN);
        await vi.waitFor(() => expect(window.safeToast).toHaveBeenCalledWith(OFF_COPY, 'info'));
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('food-barcode').value).toBe(EAN);

        // A text search that misses locally says the same, not "Nothing found".
        window.FoodLog.addSheet.open();
        await settle();
        await window.FoodLog.addSheet.runSearch('oats', false);
        await vi.waitFor(() => expect(document.getElementById('food-add-search-status').textContent).toBe(OFF_COPY));
        expect(toServer()).toEqual([]);
        expect(window.Attest.assert).not.toHaveBeenCalled();
    });

    it('on: a scan is one signed GET of the barcode route, and the product is picked', async () => {
        const { createHash } = await import('node:crypto');
        const { window, document } = env;
        foodReply = () => new Response(JSON.stringify({
            name: 'Choco bar', barcode: EAN, kcal100g: 500, carbs: 60, protein: 6, fat: 25,
        }), { status: 200, headers: { 'X-Attest-Challenge': 'c2' } });
        await trialOn();
        await scan(EAN);
        await vi.waitFor(() => expect(document.getElementById('food-add-search').value).toBe('Choco bar'));

        const path = `/api/attest/food/barcode/${EAN}`;
        expect(foodGets().map((r) => r.url)).toEqual([`https://${TRIAL_BASE}${path}`]);
        const digest = createHash('sha256').update(`${path}\n`).digest('base64');
        expect(window.Attest.assert).toHaveBeenCalledWith('c1', digest);
        expect(foodGets()[0].headers).toEqual({
            'X-Attest-Key-Id': 'key-1', 'X-Attest-Challenge': 'c1', 'X-Attest-Assertion': `sig:c1:${digest}`,
        });
        expect(document.getElementById('food-modal').classList.contains('hidden')).toBe(true);
    });

    it('on: a text search after a local miss is one GET of the search route and renders its results', async () => {
        const { window, document } = env;
        foodReply = () => new Response(JSON.stringify({ results: [{ name: 'Rolled oats', kcal100g: 370 }] }), { status: 200 });
        await trialOn();
        window.FoodLog.addSheet.open();
        await settle();
        await window.FoodLog.addSheet.runSearch('oats', false);
        await vi.waitFor(() => expect(document.getElementById('food-add-results').textContent).toContain('Rolled oats'));
        expect(foodGets().map((r) => r.url)).toEqual([`https://${TRIAL_BASE}/api/attest/food/search?q=oats&limit=20`]);
    });

    it('on: today\'s lookups spent (429 install-day) says the lookups are paused, and asks no more', async () => {
        const { window, document } = env;
        foodReply = () => new Response(JSON.stringify({
            error: 'trial_budget_exhausted', scope: 'install-day', resets_at: new Date(Date.now() + 3600e3).toISOString(),
        }), { status: 429 });
        await trialOn();
        window.FoodLog.addSheet.open();
        await settle();
        await window.FoodLog.addSheet.runSearch('oats', false);
        const status = document.getElementById('food-add-search-status');
        await vi.waitFor(() => expect(status.textContent).toBe('Food lookups paused until tomorrow.'));

        await scan(EAN);
        await vi.waitFor(() => expect(window.safeToast).toHaveBeenCalledWith('Food lookups paused until tomorrow.', 'info'));
        expect(foodGets()).toHaveLength(1);
    });
});
