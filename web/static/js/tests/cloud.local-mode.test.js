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
    afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi
} from 'vitest';
import { loadFrontendEnv, createMockResponse } from './helpers/frontend-harness.js';
import { localRecordsPort } from '../../../cloud/js/sync.js';
import { openDb } from '../../../cloud/js/localdb.js';
import { cancelReminderRecompute } from '../../../cloud/js/reminders.js';
import { createApiRouter, installApiShim, materializationSettled } from '../../../cloud/js/apishim.js';
import { LOCAL_EFFECTS, shellPost, BASE_POST_PATHS, registerLocalEgress, egressIdle } from '../../../cloud/js/local-policy.js';
import { createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';
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

// The last test's install-time ledger-cut write may still be running; let it
// settle so it never lands in the fresh store (bd med-o7zq.40).
async function deleteDb() {
    await materializationSettled();
    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('medtracker-cloud');
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
    });
}

// The boot's egress registration (local-policy registerLocalEgress) reads
// window.document after the shell's setEgressHosts reply; let it finish before
// a test can end and afterEach unstubs the window (bd med-umqb). The call
// must have started first: egressIdle only waits for registrations in flight.
async function egressSettled(bridge) {
    await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('setEgressHosts', expect.anything()));
    const { egressIdle } = await import('../../../cloud/js/local-policy.js');
    await egressIdle();
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
        // Stock ledger (med-wi09.13): the starting count is an audit stamped at
        // creation, so a dose dated an hour before it is already inside it.
        expect((await window.apiCall('/api/medications'))[0].inventory_count).toBe(5);
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

    // bd med-ta2n.4: the W4 protect-your-data nudge replaces the weekly
    // toast. GET /api/protection/status is what the Today card and the
    // Settings chip read; the clock is faked, the store is the real one.
    describe('W4 protection status (fake clock)', () => {
        const DAY = 24 * 60 * 60 * 1000;
        const T0 = Date.parse('2026-10-01T09:00:00Z');
        const LEGACY = 'wg:local-backup-nudge-at';
        const status = () => env.window.apiCall('/api/protection/status');
        const at = (ms) => vi.setSystemTime(ms);
        const addRecords = async (n, from = 0) => {
            for (let i = from; i < from + n; i += 1) {
                await localRecordsPort().put('weight', { recordId: `w4-${i}`, clientTs: Date.now(), deleted: false, weight: 80 });
            }
        };
        beforeEach(async () => {
            vi.useFakeTimers({ toFake: ['Date'], now: T0 });
            await env.window.apiCall('/api/firstrun/complete', 'POST');
        });
        afterEach(() => { vi.useRealTimers(); });

        it('19 records at day 6: no nudge; the 20th: nudge, the count live', async () => {
            await addRecords(19);
            at(T0 + 6 * DAY);
            expect(await status()).toMatchObject({
                records: 19, firstRunAt: T0, lastBackupAt: null, dismissedCount: 0, lastDismissedAt: null, synced: false, nudge: false,
            });
            await addRecords(1, 19);
            expect(await status()).toMatchObject({ records: 20, nudge: true });
            expect(fetched.filter((u) => u.includes('/api/'))).toEqual([]);
        });

        it('day 7 with one record: nudge; × snoozes 14 days; after the second × never again while unprotected', async () => {
            await addRecords(1);
            at(T0 + 7 * DAY - 1);
            expect((await status()).nudge).toBe(false);
            at(T0 + 7 * DAY);
            expect((await status()).nudge).toBe(true);

            const first = Date.now();
            await env.window.apiCall('/api/protection/dismiss', 'POST');
            expect(await status()).toMatchObject({ nudge: false, dismissedCount: 1, lastDismissedAt: first });
            at(first + 14 * DAY - 1);
            expect((await status()).nudge).toBe(false);
            at(first + 14 * DAY);
            expect((await status()).nudge).toBe(true);

            await env.window.apiCall('/api/protection/dismiss', 'POST');
            at(Date.now() + 365 * DAY);
            // The chip still reads "Unprotected": no backup exists.
            expect(await status()).toMatchObject({ nudge: false, dismissedCount: 2, lastBackupAt: null });
            const rec = (await localRecordsPort().list('protection'))[0];
            expect(rec).toMatchObject({ recordId: 'protection', nudgeDismissedAt: [first, first + 14 * DAY] });
        });

        it('a backup ends the nudge once the file leaves the device; the file says it is a backup', async () => {
            await addRecords(20);
            expect((await status()).nudge).toBe(true);
            at(T0 + DAY);
            // Built but not saved (Backup ready dismissed): nothing changes.
            const json = await env.window.CloudVault.exportAll({ includeSecrets: false, win: env.window });
            expect(JSON.parse(json).data.protection).toEqual({ last_backup_at: '2026-10-02T09:00:00Z', nudge_dismissed_at: [] });
            expect(await status()).toMatchObject({ nudge: true, lastBackupAt: null });
            expect(await localRecordsPort().list('protection')).toEqual([]);
            // A completed Share (importexport.js stampLastBackup, confirmed).
            await env.window.CloudVault.markBackup({ win: env.window });
            expect(await status()).toMatchObject({ nudge: false, lastBackupAt: T0 + DAY });
        });

        it('a Save to device (wg.backup.last, maybe a cancelled picker) is a free 14-day snooze, never a backup', async () => {
            await addRecords(20);
            env.window.localStorage.setItem('wg.backup.last', String(T0));
            at(T0 + 14 * DAY - 1);
            expect(await status()).toMatchObject({
                nudge: false, lastBackupAt: null, lastSavedAt: T0, dismissedCount: 0, lastDismissedAt: null,
            });
            at(T0 + 14 * DAY);
            expect((await status()).nudge).toBe(true);
            await env.window.apiCall('/api/protection/dismiss', 'POST');
            // Read only: the Backup page's "last N days ago" keeps its stamp.
            expect(env.window.localStorage.getItem('wg.backup.last')).toBe(String(T0));
        });

        it('an existing user: the old toast stamp is a free 14-day snooze, removed once the record is written', async () => {
            env.window.localStorage.setItem(LEGACY, String(T0));
            await addRecords(20);
            at(T0 + 14 * DAY - 1);
            expect(await status()).toMatchObject({ nudge: false, dismissedCount: 0, lastDismissedAt: T0 });
            at(T0 + 14 * DAY);
            expect((await status()).nudge).toBe(true);
            await env.window.apiCall('/api/protection/dismiss', 'POST');
            expect(env.window.localStorage.getItem(LEGACY)).toBeNull();
            expect((await status()).dismissedCount).toBe(1); // the legacy stamp never cost a dismissal
        });
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
        // The export itself is a backup (bd med-ta2n.4): the file carries it.
        const withoutBackup = (d) => { const c = { ...d }; delete c.protection; return c; };
        expect(exported.data.protection).toEqual({ ...VAULT_FIXTURE.data.protection, last_backup_at: expect.any(String) });
        expect(Date.parse(exported.data.protection.last_backup_at)).toBeLessThanOrEqual(now);
        // The restore ends with the legacy pass (bd med-0xad.4): the fixture's
        // bot-era sleep session stays as the ledger (bd med-0xad.9) beside its sleep day.
        const [night] = VAULT_FIXTURE.data.vitals.sleep;
        expect(exported.data.vitals.sleep).toHaveLength(2);
        expect(exported.data.vitals.sleep).toEqual(expect.arrayContaining([night, {
            ...night, timezone_offset: -120, total_minutes: 450, source: 'miband', source_id: night.day,
        }]));
        const want = withoutBackup(recordsToVault(vaultToRecords(VAULT_FIXTURE, { now }), { now }).data);
        want.vitals = { ...want.vitals, sleep: exported.data.vitals.sleep };
        expect(withoutBackup(exported.data)).toEqual(want);
        const weights = (await window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight);
        expect(weights.sort()).toEqual(VAULT_FIXTURE.data.weight.logs.map((r) => r.weight).sort());
        // The cloud's importAll runs this same conversion on the file.
        expect(vaultToRecords(exported, { now }).length).toBe(vaultToRecords(VAULT_FIXTURE, { now }).length + 1); // + the day row
        // Restoring its own export again changes nothing.
        await window.CloudVault.importAll(json, { win: window });
        expect(withoutBackup(JSON.parse(await window.CloudVault.exportAll({ win: window })).data)).toEqual(withoutBackup(exported.data));
        expect(fetched.filter((u) => u.includes('/api/'))).toEqual([]);
        expect(await pendingRows()).toEqual([]);
    });

    // bd med-o7zq.38: a merge keeps what is here and adds the file's records;
    // the default replace still wipes.
    it("merge keeps this device's weight and adds the fixture's records; replace still wipes", async () => {
        const { window } = env;
        await window.apiCall('/api/weight', 'POST', { weight: 99 });
        cancelReminderRecompute({ accountId: 'local' });
        const fixtureWeights = VAULT_FIXTURE.data.weight.logs.map((r) => r.weight);
        const weights = async () => (await window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight).sort();
        await window.CloudVault.importAll(JSON.stringify(VAULT_FIXTURE), { win: window, mode: 'merge' });
        expect(await weights()).toEqual([99, ...fixtureWeights].sort());
        expect((await window.apiCall('/api/bootstrap')).needs_first_run).toBe(false);
        await window.CloudVault.importAll(JSON.stringify(VAULT_FIXTURE), { win: window });
        expect(await weights()).toEqual([...fixtureWeights].sort());
        expect(fetched.filter((u) => u.includes('/api/'))).toEqual([]);
    });

    // bd med-o7zq.38: the merge reads the records inside replaceAllRecords'
    // lock, so a write (a background Health import) issued while it reads
    // queues behind the replace instead of being reverted by it.
    it('a write that lands while a merge reads the store survives the merge', async () => {
        const { window } = env;
        await window.apiCall('/api/weight', 'POST', { weight: 99 });
        cancelReminderRecompute({ accountId: 'local' });
        const getAll = globalThis.IDBObjectStore.prototype.getAll;
        let late = null;
        const spy = vi.spyOn(globalThis.IDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
            if (!late && this.name === 'records') late = window.apiCall('/api/weight', 'POST', { weight: 55 });
            return getAll.apply(this, args);
        });
        try {
            await window.CloudVault.importAll(JSON.stringify(VAULT_FIXTURE), { win: window, mode: 'merge' });
        } finally {
            spy.mockRestore();
        }
        expect(late).not.toBe(null);
        await late;
        const weights = (await window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight);
        expect(weights).toEqual(expect.arrayContaining([99, 55, ...VAULT_FIXTURE.data.weight.logs.map((r) => r.weight)]));
        expect(weights).toHaveLength(2 + VAULT_FIXTURE.data.weight.logs.length);
    });

    // bd med-o7zq.41 / med-wi09.12: there is no boot-time dose sweep any more
    // (doses are derived), so a restore right after install leaves no intake of
    // a medication the store does not have; the boot writes only the ledger
    // cut, which a restore keeps (not vault-managed), and local mode derives
    // due doses from it without any server.
    it('a restore after install leaves no dose rows behind; due doses are derived from the local ledger cut', async () => {
        const { window } = env;
        const DAY = 24 * 60 * 60 * 1000;
        // The boot in beforeEach already wrote the ledger cut on the real clock:
        // start from it, so the cut never lies after the faked days below.
        const t0 = Date.now();
        vi.useFakeTimers({ toFake: ['Date'], now: t0 });
        // Every hour, created a day before: a dose is due today in any zone.
        const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
        const addMed = (name) => window.apiCall('/api/medications', 'POST', {
            name, dosage: '1mg', schedule: JSON.stringify({ type: 'daily', times: hours }),
        });
        const install = () => installApiShim({ accountId: 'local' }, {
            recordsPort: localRecordsPort, effects: LOCAL_EFFECTS, rxnorm: null, registerEgress: async () => null, win: window,
        });
        try {
            const med = await addMed('Old store med');
            cancelReminderRecompute({ accountId: 'local' });
            vi.setSystemTime(t0 + DAY);
            install();
            await window.CloudVault.importAll(JSON.stringify(VAULT_FIXTURE), { win: window });
            await materializationSettled();
            expect((await localRecordsPort().listRaw('medication')).map((m) => m.recordId)).not.toContain(med.id);
            expect((await localRecordsPort().listRaw('intake')).filter((i) => i.medication_id === med.id)).toEqual([]);
            expect(await localRecordsPort().list('ledgercut')).toHaveLength(1);

            const fresh = await addMed('Restored store med');
            cancelReminderRecompute({ accountId: 'local' });
            vi.setSystemTime(t0 + 2 * DAY);
            const now = t0 + 2 * DAY;
            const doses = await window.apiCall(`/api/doses?from=${new Date(now - DAY).toISOString()}&to=${new Date(now).toISOString()}`);
            expect(doses.some((d) => String(d.medId) === String(fresh.id) && d.state === 'due')).toBe(true);
            expect((await localRecordsPort().listRaw('intake')).filter((i) => i.medication_id === fresh.id)).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    // bd med-suu2: a device-only install restored from a backup must not
    // onboard again; restoring a blank backup leaves onboarding pending.
    it('a restore of a non-empty vault clears needs_first_run; a blank vault does not', async () => {
        const { window } = env;
        cancelReminderRecompute({ accountId: 'local' });
        expect((await window.apiCall('/api/bootstrap')).needs_first_run).toBe(true);
        const blank = { format: 'medtracker-vault', version: 1, exported_at: '2026-07-08T12:00:00Z', data: {} };
        await window.CloudVault.importAll(JSON.stringify(blank), { win: window });
        expect((await window.apiCall('/api/bootstrap')).needs_first_run).toBe(true);
        await window.CloudVault.importAll(JSON.stringify(VAULT_FIXTURE), { win: window });
        expect((await window.apiCall('/api/bootstrap')).needs_first_run).toBe(false);
        // A later blank restore cannot clear the flag (firstrun is not vault-managed).
        await window.CloudVault.importAll(JSON.stringify(blank), { win: window });
        expect((await window.apiCall('/api/bootstrap')).needs_first_run).toBe(false);
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

describe('native egress callback settlement ownership', () => {
    it.each(['ios', 'android'])('%s foundation has no 15s cancellation contract; registration stays serialized until its real reply', async (platform) => {
        const env = loadFrontendEnv();
        const pending = [];
        const reload = vi.fn();
        let shim;
        if (platform === 'ios') {
            env.window.webkit = { messageHandlers: { wgNative: { postMessage: (message) => new Promise((resolve) => pending.push({ message, resolve })) } } };
        } else {
            const bridge = new env.window.EventTarget();
            bridge.postMessage = (raw) => {
                const message = JSON.parse(raw);
                pending.push({ message, resolve: (result) => bridge.dispatchEvent(new env.window.MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) })) });
            };
            env.window.wgNative = bridge;
        }
        // REAL production call(): WK reply Promise / Android correlated reply,
        // neither with a JS timeout or cancellation op (native/index.js:77).
        env.window.eval(readFileSync(fileURLToPath(new URL('../native/index.js', import.meta.url)), 'utf8'));
        const win = { document: env.document, location: { reload }, LocalNotifications: { __native: env.window.LocalNotifications.__native } };
        const start = LOCAL_BOOT_SRC.indexOf('const registerEgress = ') + 'const registerEgress = '.length;
        const callback = LOCAL_BOOT_SRC.slice(start, LOCAL_BOOT_SRC.indexOf('        const shimCall =')).trim().replace(/;$/, '');
        const registerEgress = new Function('window', 'policy', 'domReady', 'return (' + callback + ');')(win, { registerLocalEgress }, Promise.resolve()); // eslint-disable-line no-new-func
        vi.useFakeTimers();
        try {
            shim = installApiShim({ accountId: 'native-egress-' + platform }, {
                records: createInMemoryRecordsPort(), effects: LOCAL_EFFECTS, rxnorm: null,
                win, registerEgress, registerEgressTimeoutMs: 0,
            });
            let settled = false;
            const first = shim.aiProviderRegistration(); first.then(() => { settled = true; });
            await vi.waitFor(() => expect(pending).toHaveLength(1));
            expect(pending[0].message.op).toBe('setEgressHosts');
            await vi.advanceTimersByTimeAsync(15001);
            expect(settled).toBe(false);
            expect(reload).not.toHaveBeenCalled();
            await shim('/api/settings/integrations', 'PATCH', { openai: { api_key: 'fixture-native-key', url: 'https://api.openai.com/v1' } });
            await vi.advanceTimersByTimeAsync(0);
            expect(pending).toHaveLength(1); // second callback has not overtaken it
            pending[0].resolve({ changed: true });
            expect(await first).toEqual({ state: 'reloading' });
            expect(reload).toHaveBeenCalledOnce(); // existing native automatic reload
            await vi.waitFor(() => expect(pending).toHaveLength(2));
            expect(JSON.stringify(pending[1].message)).not.toContain('fixture-native-key');
            pending[1].resolve({ changed: false });
            expect(await shim.aiProviderRegistration()).toEqual({ state: 'registered' });
        } finally {
            for (const entry of pending) entry.resolve({ changed: false });
            if (shim) await shim.aiProviderRegistration();
            await egressIdle();
            cancelReminderRecompute({ accountId: 'native-egress-' + platform });
            vi.useRealTimers();
            env.cleanup();
        }
    });
});

describe('local-boot apiCallDirect ordering (med-o7zq.2)', () => {
    beforeEach(deleteDb);

    it('captures native exact-response metadata before imports; a later meta change cannot grant Check reach', async () => {
        let raw = '["https://a.example"]';
        let release;
        const imports = new Promise((resolve) => { release = resolve; });
        let captured;
        let registrationTimeout;
        const win = {
            location: { origin: 'wgapp://local' },
            document: {
                documentElement: { classList: { add() {} } },
                querySelector() { return { content: raw }; },
                readyState: 'complete',
            },
        };
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        const shim = () => Promise.resolve(null);
        shim.unifyLegacy = async () => {};
        const modules = {
            '/js/apishim.js': { installApiShim: (_ctx, options) => { captured = options.documentPolicy; registrationTimeout = options.registerEgressTimeoutMs; return shim; } },
            '/js/sync.js': { localRecordsPort: () => ({}) },
            '/js/local-policy.js': {
                LOCAL_EFFECTS: {}, LOCAL_PROTECTION: {}, LOCAL_FOOD_DB: null, LOCAL_VAULT: {},
                registerLocalEgress: async () => ({ changed: false, hosts: [] }),
                showLeaveToastOnce() {}, pickupLeaveStash: async () => {}, keepLocalRemindersFresh() {}, startLocalHealthImport() {},
                mountLocalLockRow: async () => {}, mountLocalFeedback: async () => {},
            },
        };
        run(win, async (spec) => { await imports; return modules[spec]; });
        raw = '["https://b.example"]';
        release();
        await win.MedTrackerCloudReady;
        expect(captured).toEqual({ origins: '["https://a.example"]', origin: 'wgapp://local' });
        expect(Object.isFrozen(captured)).toBe(true);
        expect(registrationTimeout).toBe(0);
    });

    it('wraps the apiCallDirect core/api.js assigns later in the parse, not an earlier one', async () => {
        let onReady;
        const win = {
            location: { origin: 'wgapp://local' },
            document: {
                documentElement: { classList: { add() {} } },
                querySelector() { return null; },
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
        await egressSettled(bridge);
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
        // Kit S8 (med-ckm5.8): a Generic / Detailed choice pair, no <select>.
        const group = window.document.getElementById('local-reminder-verbosity');
        const pressed = () => group.querySelector('.wg-choice[aria-pressed="true"]').dataset.value;
        const preview = window.document.getElementById('local-reminder-preview');
        await window.bindLocalReminderText();
        expect(pressed()).toBe('generic');
        expect(preview.textContent).toBe('Medication time');
        schedule.mockClear();
        group.querySelector('.wg-choice[data-value="detailed"]').click();
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled(), { timeout: 5000 });
        const med = schedule.mock.calls.at(-1)[0].find((i) => i.section === 'meds');
        expect(med.body).toContain('Metformin');
        await vi.waitFor(() => expect(group.querySelector('.wg-choice').disabled).toBe(false));
        expect(pressed()).toBe('detailed');
        expect(preview.textContent).toContain('Time to take');
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
        // Restore and Erase work here; the Move section needs move.stash (below).
        expect(shown(document.getElementById('importexport-import-btn').closest('section'))).toBe(true);
        expect(shown(document.getElementById('importexport-local-erase-group'))).toBe(true);
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
    // The boot's shell.ops answer: nativeHas memoises it for the page, and the
    // boot already asks (pickupLeaveStash), so a test can't change it later.
    let bootShellOps = true;
    // The Apple Health boot import (one BP reading); off where a test needs a
    // vault with no records.
    let healthOn = true;
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
        bridge = vi.fn(async (op) => (op === 'shell.ops' ? bootShellOps : op === 'setEgressHosts' ? { changed: false } : true));
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
            // has(op): native/index.js foundation.has, answered from the boot's shell.ops.
            __native: { platform: 'ios', call: bridge, has: vi.fn(async (op) => Array.isArray(bootShellOps) && bootShellOps.includes(op)) },
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
        if (healthOn) env.window.localStorage.setItem('wg.health.enabled', 'true');
        env.window.localStorage.setItem('wg.health.asked', JSON.stringify(['bp', 'weight', 'sleep', 'workout', 'steps', 'hr', 'spo2']));
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await vi.waitFor(() => expect(schedule).toHaveBeenCalled());
        await egressSettled(bridge);
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
        // Kit S8: denied swaps the status card for O3's warn note.
        expect(document.getElementById('local-notify-card').hidden).toBe(true);
        expect(document.querySelector('#local-notify-note .wg-note--warn[data-notify-denied]')).not.toBeNull();
        expect(offDevice()).toEqual([]);
    });

    it('uses the capability copy: the Android shell gets Android wording, no iPhone/iOS', async () => {
        const { window, document } = env;
        window.LocalNotifications.copy = {
            os: 'Android',
            device: 'phone',
            settingsPath: 'Android Settings → Apps → Med Tracker → Notifications (and Alarms & reminders)',
        };
        permission = 'denied';
        await window.bindLocalNotifications();
        const text = document.getElementById('local-notify-state').textContent;
        expect(text).toContain('Android Settings → Apps');
        expect(text).not.toMatch(/iOS|iPhone/);
        permission = 'granted';
        await window.refreshLocalNotifyState();
        expect(document.getElementById('local-notify-state').textContent).not.toMatch(/iOS|iPhone/);
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
        expect(document.getElementById('local-notify-chip').classList.contains('wg-chip--warn')).toBe(false);
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
        const chip = document.getElementById('local-notify-chip');
        expect(chip.textContent).toBe('Off');
        expect(chip.classList.contains('wg-chip--warn')).toBe(true);

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
        expect(chip.textContent).toBe('On');
        expect(chip.classList.contains('wg-chip--ok')).toBe(true);
        expect(chip.classList.contains('wg-chip--warn')).toBe(false);
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

    // W5 (bd med-ta2n.5): the Settings Move row and the Backup page's Move
    // section are gone — the move runs from P3. Slot ① is the "Sync & backup"
    // card, its chip off GET /api/protection/status.
    it('Sync & backup card: Unprotected, then "Saved" after a Save to device, then "Backed up"; no Move row anywhere', async () => {
        const { window, document } = env;
        expect(document.getElementById('settings-local-move-row')).toBeNull();
        expect(document.getElementById('settings-local-move-btn')).toBeNull();
        expect(document.getElementById('importexport-local-move-group')).toBeNull();
        expect(document.body.textContent).not.toMatch(/Move to a cloud account/);
        const card = document.getElementById('settings-sync-card');
        expect(card.closest('[data-settings-slot]').dataset.settingsSlot).toBe('mode-card');
        await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
        const chip = document.getElementById('settings-sync-chip');
        window.paintSyncCard();
        // The static markup already says Unprotected: wait for the painted (shown) chip.
        await vi.waitFor(() => expect(chip.classList.contains('wg-settings-hidden')).toBe(false));
        expect(chip.textContent).toBe('Unprotected');
        expect(chip.classList.contains('wg-chip--warn')).toBe(true);
        const n = await window.CloudVault.userContentCount();
        expect(document.getElementById('settings-sync-meta').textContent)
            .toBe(`${n === 1 ? '1 record' : `${n} records`} · only on this iPhone`);
        // Save to device never reports a cancelled picker: not a backup, but not "Unprotected" forever.
        window.localStorage.setItem('wg.backup.last', String(Date.now()));
        window.paintSyncCard();
        await vi.waitFor(() => expect(chip.textContent).toBe('Saved · today'));
        expect(chip.classList.contains('wg-chip--warn')).toBe(false);
        // A confirmed Share (CloudVault.markBackup) is the backup.
        await window.CloudVault.markBackup();
        window.paintSyncCard();
        await vi.waitFor(() => expect(chip.textContent).toBe('Backed up · today'));
        expect(chip.classList.contains('wg-chip--ok')).toBe(true);
        expect(offDevice()).toEqual([]);
    });

    it('W5 Sync in a pre-v3 shell (no invite.pending): the no-invite state, no slot read', async () => {
        const { window, document } = env;
        await window.paintSyncSection();
        expect(document.getElementById('settings-sync-none').hidden).toBe(false);
        expect(document.getElementById('settings-sync-waiting').hidden).toBe(true);
        expect(document.getElementById('settings-sync-how').hidden).toBe(true); // no shell base
        expect(document.getElementById('settings-sync-open-group').hidden).toBe(true); // Path 0 needs the base
        expect(document.getElementById('importexport-sync-group').textContent).toMatch(/Sync needs an invite for now/);
        expect(bridge).not.toHaveBeenCalledWith('invite.pending');
    });

    // bd med-ta2n.18: Telegram is a sync feature — the row sells it and Turn
    // on sync opens the W5 page; telegram.js never loads, nothing leaves.
    it('Telegram row: "Needs sync", the offer page, Turn on sync → Sync & backup, with no request off the device', async () => {
        const { window, document } = env;
        await window.SettingsIntegrations.load();
        const row = document.getElementById('integrations-telegram-row');
        expect(row.hidden).toBe(false);
        expect(row.textContent).toMatch(/Needs sync/);
        const page = window.SettingsView.openSettingsPage('telegram');
        expect(page.el.textContent).toMatch(/Do almost everything from your messenger/);
        page.el.querySelector('[data-action="telegram-turn-on-sync"]').click();
        await vi.waitFor(() => expect(document.querySelector('.wg-settings-pages [data-settings-page="backup"]')).toBeNull());
        expect(fetched.filter((u) => u.includes('/api/telegram'))).toEqual([]);
        expect(offDevice()).toEqual([]);
    });

    // bd med-ta2n.6 — F1 "Have an invite?" (features/invite.js), opened by the
    // W1 footer's wg:invite-open. Paste reads window.Clipboard, Scan decodes
    // window.Barcode frames (both stubbed); a valid invite becomes the claim URL
    // and goes to the P3 route (bd med-ta2n.7): records here → "Turn on sync?",
    // none → "Your invite is here"; either one's button is
    // CloudVault.moveToCloud({url}) = move.stash (always, #1244 review) then
    // local.leave {url} (contract med-ta2n.7 §7-8, A7 gates).
    describe('F1 invite sheet in a v3 shell', () => {
        const CLAIM = 'https://abc.app.example.com/#claim=0a1b2c';
        const NOT_INVITE = /That isn't an invite link/;
        beforeAll(() => { bootShellOps = ['ping', 'shell.ops', 'move.stash', 'local.leave', 'invite.pending']; });
        afterAll(() => { bootShellOps = true; });

        const leaveOps = () => bridge.mock.calls
            .filter(([op]) => op === 'move.stash' || op === 'local.leave')
            .map(([op, args]) => (op === 'local.leave' ? [op, args] : [op]));
        const sheet = (document) => document.getElementById('invite-sheet');
        const act = (document, name) => sheet(document).querySelector(`[data-invite-action="${name}"]`);
        // P3 "Turn on sync?" (records here) and "Your invite is here" (none).
        const sync = (document) => vi.waitFor(() => {
            const s = document.getElementById('invite-sync-sheet');
            if (!s) throw new Error('no P3 sheet');
            return s;
        });
        const ready = (document) => vi.waitFor(() => {
            const s = document.getElementById('invite-ready');
            if (!s) throw new Error('no invite-ready screen');
            return s;
        });
        const tap = (root, name) => root.querySelector(`[data-invite-action="${name}"]`).click();
        function openSheet(window, { clipboard = null } = {}) {
            // The shell's deployment base (native/attest.js ios impl, attest.status).
            window.Attest = { isSupported: () => true, status: vi.fn(async () => ({ supported: false, base: 'app.example.com', attested: false })) };
            window.Clipboard = { readText: vi.fn(async () => clipboard) };
            window.document.dispatchEvent(new window.CustomEvent('wg:invite-open'));
            expect(sheet(window.document)).not.toBeNull();
        }

        describe('with no records on this device', () => {
            beforeAll(() => { healthOn = false; });
            afterAll(() => { healthOn = true; });

            it('Paste of each accepted form → "Your invite is here" → Sign in: an (empty) stash, then local.leave {url}', async () => {
                const { window, document } = env;
                for (const form of [
                    'https://app.example.com/i/abc#0a1b2c', // landing (what L1 copies)
                    'medtracker://i/abc#0a1b2c', // scheme
                    CLAIM, // claim
                    'https://abc.app.example.com/#claim=0a1b2c\nabc\nRECOVERY-CODE', // a QR-ish multi-line paste: first line only
                ]) {
                    bridge.mockClear();
                    openSheet(window, { clipboard: form });
                    expect(sheet(document).textContent).toMatch(/Paste the link you were sent, or scan its QR code/);
                    act(document, 'paste').click();
                    const screen = await ready(document);
                    expect(sheet(document)).toBeNull(); // F1 handed over
                    expect(screen.textContent).toMatch(/Your account is ready/);
                    expect(screen.textContent).toMatch(/Sign in with Face ID/);
                    expect(leaveOps()).toEqual([]);
                    tap(screen, 'sign-in');
                    // #1244: always stashed, so an older stash can never reach the new account.
                    await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: CLAIM }]]));
                    expect(window.Clipboard.readText).toHaveBeenCalledTimes(1);
                    // The shell navigates away; the overlay stays until then.
                    document.getElementById('invite-ready').remove();
                }
                expect(offDevice()).toEqual([]);
            });

            it('Scan goes through the same parser; garbage keeps the sheet with the field error', async () => {
                const { window, document } = env;
                const stop = vi.fn();
                window.MediaCapture = { openCameraStream: vi.fn(async () => ({ getTracks: () => [{ stop }] })) };
                window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
                const decoded = ['https://evil.example/i/abc#0a1b2c', 'medtracker://i/abc#0a1b2c'];
                window.Barcode = { supportsLiveScan: () => true, scan: vi.fn(async () => ({ format: 'qr_code', rawValue: decoded.shift() })) };
                openSheet(window);
                act(document, 'scan').click();
                await vi.waitFor(() => expect(sheet(document).querySelector('.wg-error').textContent).toMatch(NOT_INVITE));
                expect(stop).toHaveBeenCalled(); // the camera is released on a decode
                expect(leaveOps()).toEqual([]);
                act(document, 'scan').click();
                tap(await ready(document), 'sign-in');
                await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: CLAIM }]]));
                expect(window.Barcode.scan).toHaveBeenCalledWith(expect.objectContaining({ formats: ['qr_code'] }));
            });

            // bd med-r1j2.10 (AD13): a denied camera says so, offers the system
            // setting (its hint where the shell can't open it), and the paste
            // field takes the link instead.
            it('Scan with the camera denied: AD13 note + Allow camera in Settings, then the pasted link still works', async () => {
                const { window, document } = env;
                const denied = Object.assign(new Error('denied'), { name: 'MediaCaptureError', code: 'PERMISSION_DENIED' });
                const openSettings = vi.fn(async () => ({ opened: false, hint: 'Turn on Camera in iOS Settings → Med Tracker.' }));
                window.MediaCapture = { openCameraStream: vi.fn(async () => { throw denied; }), openSettings };
                window.Barcode = { supportsLiveScan: () => true, scan: vi.fn() };
                openSheet(window);
                act(document, 'scan').click();
                const off = await vi.waitFor(() => {
                    const n = document.getElementById('invite-camera-off');
                    if (!n) throw new Error('no AD13 note yet');
                    return n;
                });
                expect(off.textContent).toContain('The camera is off for this app.');
                expect(off.textContent).toContain('Paste the link from your other device instead.');
                expect(window.Barcode.scan).not.toHaveBeenCalled();
                tap(off, 'camera-settings');
                await vi.waitFor(() => expect(off.textContent).toContain('Turn on Camera in iOS Settings → Med Tracker.'));
                expect(openSettings).toHaveBeenCalledTimes(1);
                const input = document.getElementById('invite-sheet-input');
                expect(input.closest('[hidden]')).toBeNull();
                input.value = 'https://app.example.com/i/abc#0a1b2c';
                act(document, 'submit').click();
                tap(await ready(document), 'sign-in');
                await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: CLAIM }]]));
            });
        });

        it('with records: "Turn on sync?" with the live count, then move.stash, then local.leave {url}', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            await window.apiCall('/api/weight', 'POST', { weight: 80 });
            cancelReminderRecompute({ accountId: 'local' });
            openSheet(window, { clipboard: 'https://app.example.com/i/abc#0a1b2c' });
            act(document, 'paste').click();
            const p3 = await sync(document);
            const n = await window.CloudVault.userContentCount();
            expect(n).toBeGreaterThanOrEqual(2);
            expect(p3.textContent).toMatch(/Turn on sync\?/);
            expect(p3.textContent).toContain(`Your ${n} records move to your account`);
            expect(p3.textContent).toMatch(/This iPhone keeps working offline/);
            expect(p3.textContent).toMatch(/Sign in with Face ID/);
            expect(leaveOps()).toEqual([]);
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: CLAIM }]]));
        });

        it('entered from Settings (wg:invite-open {kit}): the claim fragment gains &kit=1', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            window.Attest = { isSupported: () => true, status: vi.fn(async () => ({ base: 'app.example.com' })) };
            window.Clipboard = { readText: vi.fn(async () => CLAIM) };
            document.dispatchEvent(new window.CustomEvent('wg:invite-open', { detail: { kit: true } }));
            act(document, 'paste').click();
            tap(await sync(document), 'turn-on-sync');
            await vi.waitFor(() => expect(leaveOps().at(-1)).toEqual(['local.leave', { url: `${CLAIM}&kit=1` }]));
        });

        // W5 page Sync section (bd med-ta2n.5): no invite → its own Paste runs
        // F1's paste inside the tap; the base landing is "How to get an invite".
        it('W5 Sync, no invite: Paste reads the clipboard in the tap → P3 → the claim gains &kit=1', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            window.Attest = { isSupported: () => true, status: vi.fn(async () => ({ base: 'app.example.com' })) };
            window.Clipboard = { readText: vi.fn(async () => CLAIM) };
            await window.paintSyncSection();
            expect(document.getElementById('settings-sync-none').hidden).toBe(false);
            expect(document.getElementById('settings-sync-waiting').hidden).toBe(true);
            const how = document.getElementById('settings-sync-how');
            expect(how.hidden).toBe(false);
            expect(how.getAttribute('href')).toBe('https://app.example.com/');
            document.getElementById('settings-sync-paste').click();
            expect(window.Clipboard.readText).toHaveBeenCalledTimes(1); // same tap: WebKit's Paste callout
            tap(await sync(document), 'turn-on-sync');
            await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: `${CLAIM}&kit=1` }]]));
        });

        // bd med-r1j2.5 Path 0 (AD10): "Already have an account? Open it" →
        // the address page → local.leave {url: <account>/unlock}. No move.stash:
        // the local vault stays as it is, nothing is merged or erased.
        it('W5 Open my account: a strict address, then local.leave to /unlock with no stash', async () => {
            const { window, document } = env;
            const UNLOCK = 'https://anna.app.example.com/unlock';
            window.Attest = { isSupported: () => true, status: vi.fn(async () => ({ base: 'app.example.com' })) };
            await window.paintSyncSection();
            expect(document.getElementById('settings-sync-open-group').hidden).toBe(false);
            document.getElementById('settings-sync-open').click();
            const input = document.getElementById('open-account-input');
            const page = input.closest('.wg-page');
            expect(page.querySelector('.wg-pagebar__title').textContent).toBe('Open my account');
            expect(page.textContent).toMatch(/Open your account on this iPhone/);
            expect(page.textContent).toMatch(/On your other device: Settings → Devices & connectors/);
            expect(page.textContent).toMatch(/Nothing on this iPhone changes/);
            const go = page.querySelector('[data-invite-action="open-account"]');
            expect(go.closest('.wg-pagefoot')).not.toBeNull();
            expect(go.disabled).toBe(true);
            const field = input.closest('.wg-field');
            const type = (v) => {
                input.value = v;
                input.dispatchEvent(new window.Event('input'));
                input.dispatchEvent(new window.Event('change'));
            };
            // The shell base arrives async; a valid address enables the sun.
            await vi.waitFor(() => { type('anna.app.example.com'); expect(go.disabled).toBe(false); });
            for (const bad of ['anna', 'anna.app.example.com.evil.com', 'https://u@anna.app.example.com', 'anna.app.example.com:8443', 'http://anna.app.example.com']) {
                type(bad);
                expect(field.classList.contains('wg-field--error')).toBe(true);
                expect(field.querySelector('.wg-error').textContent).toBe('Not a full address. It ends in .app.example.com');
                expect(go.disabled).toBe(true);
                go.click();
            }
            expect(leaveOps()).toEqual([]);
            type('https://anna.app.example.com/settings');
            expect(field.classList.contains('wg-field--error')).toBe(false);
            go.click();
            await vi.waitFor(() => expect(leaveOps()).toEqual([['local.leave', { url: UNLOCK }]]));
            expect(offDevice()).toEqual([]);
        });

        it('W5 Open my account offline: an in-page error and no leave', async () => {
            const { window, document } = env;
            window.Attest = { isSupported: () => true, status: vi.fn(async () => ({ base: 'app.example.com' })) };
            await window.paintSyncSection();
            document.getElementById('settings-sync-open').click();
            const input = document.getElementById('open-account-input');
            const go = input.closest('.wg-page').querySelector('[data-invite-action="open-account"]');
            await vi.waitFor(() => {
                input.value = 'anna.app.example.com';
                input.dispatchEvent(new window.Event('input'));
                expect(go.disabled).toBe(false);
            });
            Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
            go.click();
            await vi.waitFor(() => expect(input.closest('.wg-field').querySelector('.wg-error').textContent).toMatch(/You're offline/));
            expect(leaveOps()).toEqual([]);
        });

        // W5 "Request an invite" (bd med-ta2n.14): the shell POSTs email + note
        // to its own base (bridge op base.post, med-ta2n.24 §A) — the page's CSP
        // never lists our server for it. The admin approves in Telegram, the
        // invite arrives by email.
        describe('W5 Request an invite', () => {
            const BASE = 'app.example.com';
            let shellOps;
            let answer;
            beforeAll(() => { shellOps = bootShellOps; bootShellOps = [...bootShellOps, 'base.post']; });
            afterAll(() => { bootShellOps = shellOps; });

            const posts = () => bridge.mock.calls.filter(([op]) => op === 'base.post').map(([, args]) => args);
            const requestSheet = (document) => document.getElementById('invite-request-sheet');
            const requestAct = (document, a) => requestSheet(document).querySelector(`[data-invite-action="${a}"]`);
            async function openRequest({ window, document }) {
                const prior = bridge.getMockImplementation();
                // base.post → {status, headers, body}; an op error rejects with its string.
                bridge.mockImplementation(async (op, args) => {
                    if (op !== 'base.post') return prior(op, args);
                    if (answer instanceof Error) throw answer;
                    return answer;
                });
                window.Attest = { isSupported: () => true, status: vi.fn(async () => ({ supported: false, base: BASE, attested: false })) };
                await window.paintSyncSection();
                const button = document.getElementById('settings-sync-request');
                expect(button.hidden).toBe(false);
                // IM3 (bd med-er5x): one invite link on the Sync card.
                expect(button.textContent).toBe('No invite? Request one');
                expect(document.getElementById('settings-sync-how').hidden).toBe(true);
                button.click();
                return requestSheet(document);
            }
            const fill = (document, email, note = '') => {
                document.getElementById('invite-request-email').value = email;
                document.getElementById('invite-request-note').value = note;
                requestAct(document, 'send-request').click();
            };

            it('hidden where the shell has no base.post, even with a base', async () => {
                const { window, document } = env;
                window.LocalNotifications.__native.has = vi.fn(async (op) => op !== 'base.post');
                window.Attest = { isSupported: () => true, status: vi.fn(async () => ({ supported: false, base: BASE, attested: false })) };
                await window.paintSyncSection();
                expect(document.getElementById('settings-sync-request').hidden).toBe(true);
                expect(document.getElementById('settings-sync-how').hidden).toBe(false); // the landing link stays
                // Opened anyway (the W1 entry, a stale page): "not open here" + the landing link, no op call.
                window.InviteSheet.request();
                fill(document, 'a@b.example');
                const off = await vi.waitFor(() => {
                    const n = requestSheet(document).querySelector('[data-invite-request="off"]');
                    expect(n).not.toBeNull();
                    return n;
                });
                expect(off.querySelector('a').getAttribute('href')).toBe(`https://${BASE}/`);
                expect(posts()).toEqual([]);
                requestAct(document, 'not-now').click();
            });

            it('IM3 Sync card carries the four facts; IM2 · W4 (lead copy) leads with the copy and its privacy fact', async () => {
                const { window, document } = env;
                const cardFacts = [...document.querySelectorAll('#settings-sync-facts li b')].map((b) => b.textContent);
                expect(cardFacts).toEqual(['Your records on every device', 'A copy off this phone', 'Only you can open it', 'Open it in any browser']);
                expect(document.querySelector('#settings-sync-facts li').textContent)
                    .toBe('Your records on every devicePhone and tablet stay in step. To add one, scan a code from this phone.');
                window.InviteSheet.request({ lead: 'copy', eyebrow: '43 records on this phone' });
                const sheet = requestSheet(document);
                expect(sheet.querySelector('.wg-sheethead .wg-eyebrow').textContent).toBe('43 records on this phone');
                expect([...sheet.querySelectorAll('[data-invite-facts] li b')].map((b) => b.textContent))
                    .toEqual(['A copy off this phone', 'Only you can open it', 'Your records on every device', 'Open it in any browser']);
                // No header ×: Not now is the one close (Iris, PR #1346).
                expect(requestAct(document, 'close')).toBeNull();
                requestAct(document, 'not-now').click();
                expect(requestSheet(document)).toBeNull();
            });

            it('the shell sends email + note, 202 → "Request sent", Done closes; the page fetches nothing', async () => {
                answer = { status: 202, headers: {}, body: '' };
                const sheet = await openRequest(env);
                const { document } = env;
                expect(sheet.textContent).toMatch(/Request an invite/);
                // IM2 (bd med-er5x): what an account adds, every device first,
                // then the corrected hint, the form and the fine print, which is
                // the request's privacy statement (what we get) + the batches line.
                expect(sheet.querySelector('.wg-sheethead .wg-eyebrow').textContent).toBe('Sync');
                const facts = [...sheet.querySelectorAll('[data-invite-facts] li')].map((li) => li.textContent);
                expect(facts).toEqual([
                    'Your records on every devicePhone and tablet stay in step. To add one, scan a code from this phone.',
                    "A copy off this phoneLose or reset it, sign back in, and it's all there.",
                    "Only you can open itEncrypted on your device before it syncs. We store it but can't read it.",
                    'Open it in any browserOn a laptop or a work computer, whenever you need it.',
                ]);
                expect(sheet.querySelector('[data-invite-facts] + .wg-hint').textContent)
                    .toBe('Telegram, AI-assistant connectors and sharing need an account too. Everything else works on this phone.');
                expect(sheet.querySelector('.wg-sheet__body .wg-shell__fine').textContent)
                    .toBe("We get your email and note, nothing from your records. Invites go out in small batches; we'll write to this address when yours is ready.");
                expect(sheet.textContent).not.toMatch(/Sync is invite-only for now/);
                expect(document.getElementById('invite-request-note').maxLength).toBe(500);
                const before = fetched.length;
                fill(document, '  Someone@Example.org ', 'friend of the admin');
                const done = await vi.waitFor(() => {
                    const n = sheet.querySelector('[data-invite-request="sent"]');
                    expect(n).not.toBeNull();
                    return n;
                });
                expect(done.textContent).toBe("Request sent — if it's approved, your invite arrives by email.");
                expect(posts()).toHaveLength(1);
                expect(posts()[0].path).toBe('/api/invite-requests');
                expect(posts()[0].headers).toEqual({});
                expect(JSON.parse(posts()[0].body)).toEqual({ email: 'Someone@Example.org', note: 'friend of the admin' });
                expect(fetched.slice(before)).toEqual([]);
                requestAct(document, 'done').click();
                expect(requestSheet(document)).toBeNull();
            });

            it('a bad email stays local with the field error; the server\'s invalid_email shows the same', async () => {
                answer = { status: 400, headers: {}, body: '{"error":"invalid_email"}' };
                const sheet = await openRequest(env);
                const { document } = env;
                fill(document, 'not an email');
                expect(sheet.querySelector('.wg-field--error').textContent).toMatch(/Enter an email address like name@example.com/);
                expect(posts()).toEqual([]);
                fill(document, 'a@b.example');
                await vi.waitFor(() => expect(posts()).toHaveLength(1));
                await vi.waitFor(() => expect(sheet.querySelector('.wg-field--error')).not.toBeNull());
                expect(sheet.querySelector('[data-invite-request="sent"]')).toBeNull();
            });

            it('429 → try again in an hour; 404 → not open here, with the landing link; the op\'s "network" → retry copy', async () => {
                const { document } = env;
                answer = { status: 429, headers: { 'Retry-After': '3600' }, body: '{"error":"rate_limited"}' };
                const sheet = await openRequest(env);
                fill(document, 'a@b.example');
                await vi.waitFor(() => expect(sheet.textContent).toMatch(/Too many requests right now — try again in an hour./));

                answer = { status: 404, headers: {}, body: '{"error":"not_enabled"}' };
                fill(document, 'a@b.example');
                const off = await vi.waitFor(() => {
                    const n = sheet.querySelector('[data-invite-request="off"]');
                    expect(n).not.toBeNull();
                    return n;
                });
                expect(off.textContent).toMatch(/Requests aren't open in the app right now./);
                expect(off.querySelector('a').getAttribute('href')).toBe(`https://${BASE}/`);

                answer = new Error('network');
                fill(document, 'a@b.example');
                await vi.waitFor(() => expect(sheet.textContent).toMatch(/Couldn't send the request. Check your connection and try again./));
                expect(sheet.querySelector('[data-invite-request="off"]')).toBeNull();
                requestAct(document, 'not-now').click();
                expect(requestSheet(document)).toBeNull();
            });
        });

        // An invite in the shell slot → "An invite is waiting" + Turn on sync →
        // P3 (its A7 offline gate) → the move; the stash leaves the W4 record here.
        it('W5 Sync, an invite waiting: Turn on sync → P3 → move.stash (no protection) then local.leave {url&kit=1}', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            await window.apiCall('/api/protection/dismiss', 'POST'); // a W4 record exists
            let stashed = null;
            bridge.mockImplementation(async (op, args) => {
                if (op === 'shell.ops') return bootShellOps;
                if (op === 'invite.pending') return { url: CLAIM, receivedAt: Date.now() };
                if (op === 'move.stash') { stashed = args.vault; return true; }
                return op === 'setEgressHosts' ? { changed: false } : true;
            });
            await window.paintSyncSection();
            expect(document.getElementById('settings-sync-none').hidden).toBe(true);
            const waiting = document.getElementById('settings-sync-waiting');
            expect(waiting.hidden).toBe(false);
            expect(waiting.textContent).toMatch(/An invite is waiting/);
            // Offline at P3's button: nothing stashed, no op (A7).
            Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
            document.getElementById('settings-sync-turn-on').click();
            const p3 = await sync(document);
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(p3.querySelector('.wg-error').hidden).toBe(false));
            expect(leaveOps()).toEqual([]);
            Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: `${CLAIM}&kit=1` }]]));
            expect(JSON.parse(stashed).data).not.toHaveProperty('protection');
            expect(bridge).not.toHaveBeenCalledWith('invite.clear');
        });

        // A stash the shell refuses must never be followed by the leave: the
        // account would open with none of these records.
        it('a rejected move.stash stops before local.leave; the P3 sheet says why', async () => {
            const { window, document } = env;
            allowConsoleNoise();
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            bridge.mockImplementation(async (op) => {
                if (op === 'shell.ops') return bootShellOps;
                if (op === 'move.stash') throw new Error('too large');
                return op === 'setEgressHosts' ? { changed: false } : true;
            });
            openSheet(window, { clipboard: CLAIM });
            act(document, 'paste').click();
            const p3 = await sync(document);
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(p3.querySelector('.wg-error').textContent).toMatch(/too large/));
            expect(leaveOps()).toEqual([['move.stash']]);
        });

        // bd med-ta2n.31: the tapped button shows work in progress until the shell
        // navigates; a failed move restores it; a second tap does nothing.
        it('Turn on sync is busy while the move runs, restored when it fails, and a second tap is a no-op (med-ta2n.31)', async () => {
            const { window, document } = env;
            allowConsoleNoise();
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            let fail;
            bridge.mockImplementation((op) => {
                if (op === 'shell.ops') return Promise.resolve(bootShellOps);
                if (op === 'move.stash') return new Promise((_, reject) => { fail = reject; });
                return Promise.resolve(op === 'setEgressHosts' ? { changed: false } : true);
            });
            openSheet(window, { clipboard: CLAIM });
            act(document, 'paste').click();
            const p3 = await sync(document);
            const go = p3.querySelector('[data-invite-action="turn-on-sync"]');
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(go.disabled).toBe(true));
            expect(go.classList.contains('wg-btn--busy')).toBe(true);
            expect(go.textContent).toBe('Moving your data…');
            await vi.waitFor(() => expect(typeof fail).toBe('function'));
            go.click();
            expect(bridge.mock.calls.filter(([op]) => op === 'move.stash')).toHaveLength(1);
            fail(new Error('too large'));
            await vi.waitFor(() => expect(go.disabled).toBe(false));
            expect(go.classList.contains('wg-btn--busy')).toBe(false);
            expect(go.textContent).toBe('Turn on sync');
            expect(p3.querySelector('.wg-error').textContent).toMatch(/too large/);
        });

        it('Not now closes "Turn on sync?" with nothing stashed', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            openSheet(window, { clipboard: CLAIM });
            act(document, 'paste').click();
            tap(await sync(document), 'not-now');
            expect(document.getElementById('invite-sync-sheet')).toBeNull();
            expect(leaveOps()).toEqual([]);
        });

        it('offline at Turn on sync → in-page error on the sheet, no stash, no op', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            openSheet(window, { clipboard: CLAIM });
            act(document, 'paste').click();
            const p3 = await sync(document);
            Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(p3.querySelector('.wg-error').textContent).toMatch(/You're offline/));
            expect(leaveOps()).toEqual([]);
        });

        it('the P3 sheet cannot be dismissed while the move runs', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            let stashed;
            bridge.mockImplementation(async (op) => {
                if (op === 'shell.ops') return bootShellOps;
                if (op === 'move.stash') return new Promise((r) => { stashed = r; });
                return op === 'setEgressHosts' ? { changed: false } : true;
            });
            openSheet(window, { clipboard: CLAIM });
            act(document, 'paste').click();
            const p3 = await sync(document);
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(stashed).toBeTypeOf('function'));
            tap(p3, 'not-now');
            expect(document.getElementById('invite-sync-sheet')).not.toBeNull();
            stashed(true);
            await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: CLAIM }]]));
        });

        it('garbage → inline error, the sheet stays and the field is shown; nothing leaves', async () => {
            const { window, document } = env;
            openSheet(window, { clipboard: 'hello there' });
            act(document, 'paste').click();
            const error = sheet(document).querySelector('.wg-error');
            await vi.waitFor(() => expect(error.hidden).toBe(false));
            expect(error.textContent).toMatch(NOT_INVITE);
            expect(sheet(document).querySelector('[data-invite-field]').closest('.wg-field').hidden).toBe(false);
            expect(leaveOps()).toEqual([]);
        });

        it('denied clipboard → "or paste it here" field; Continue parses what was typed', async () => {
            const { window, document } = env;
            openSheet(window, { clipboard: null });
            act(document, 'paste').click();
            const input = sheet(document).querySelector('[data-invite-field]');
            await vi.waitFor(() => expect(input.closest('.wg-field').hidden).toBe(false));
            expect(sheet(document).textContent).toMatch(/or paste it here/);
            expect(sheet(document).querySelector('.wg-error').hidden).toBe(true);
            expect(leaveOps()).toEqual([]);
            input.value = '  MedTracker://I/ABC#0a1b2c ';
            act(document, 'submit').click();
            await vi.waitFor(() => expect(sheet(document)).toBeNull());
            await vi.waitFor(() => expect(document.getElementById('invite-sync-sheet') || document.getElementById('invite-ready')).not.toBeNull());
            const next = document.getElementById('invite-sync-sheet') || document.getElementById('invite-ready');
            tap(next, next.id === 'invite-ready' ? 'sign-in' : 'turn-on-sync');
            await vi.waitFor(() => expect(leaveOps().at(-1)).toEqual(['local.leave', { url: CLAIM }]));
        });

        it('offline → in-page error, no stash, no op', async () => {
            const { window, document } = env;
            Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
            openSheet(window, { clipboard: CLAIM });
            act(document, 'paste').click();
            await vi.waitFor(() => expect(sheet(document).querySelector('.wg-error').textContent).toMatch(/You're offline/));
            expect(leaveOps()).toEqual([]);
        });

        it('Not now while the clipboard read is pending: the late text never leaves', async () => {
            const { window, document } = env;
            openSheet(window);
            let resolve;
            window.Clipboard.readText.mockImplementation(() => new Promise((r) => { resolve = r; }));
            act(document, 'paste').click();
            act(document, 'not-now').click();
            resolve(CLAIM);
            await new Promise((r) => { setTimeout(r, 20); });
            expect(sheet(document)).toBeNull();
            expect(leaveOps()).toEqual([]);
        });

        it('the shell rejecting the URL ("invalid url") shows the error on the P3 sheet', async () => {
            const { window, document } = env;
            await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
            bridge.mockImplementation(async (op) => {
                if (op === 'shell.ops') return bootShellOps;
                if (op === 'local.leave') throw new Error('invalid url');
                return op === 'setEgressHosts' ? { changed: false } : true;
            });
            openSheet(window, { clipboard: CLAIM });
            act(document, 'paste').click();
            const p3 = await sync(document);
            tap(p3, 'turn-on-sync');
            await vi.waitFor(() => expect(p3.querySelector('.wg-error').textContent).toMatch(NOT_INVITE));
        });

        // Boot routing (InviteSheet.boot, called by auth-bootstrap.js before
        // W1 mounts): ONE invite.pending read per page.
        describe('a pending invite in the slot at boot', () => {
            const slotted = (slot) => bridge.mockImplementation(async (op) => {
                if (op === 'shell.ops') return bootShellOps;
                if (op === 'invite.pending') return slot;
                return op === 'setEgressHosts' ? { changed: false } : true;
            });
            const pendingReads = () => bridge.mock.calls.filter(([op]) => op === 'invite.pending').length;

            it('records here → "Turn on sync?" with the live count; Turn on sync → move.stash then local.leave {url}', async () => {
                const { window, document } = env;
                await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
                for (let i = 0; i < 42; i++) await window.apiCall('/api/weight', 'POST', { weight: 70 + i / 10 });
                cancelReminderRecompute({ accountId: 'local' });
                slotted({ url: CLAIM, receivedAt: Date.now() });
                const gate = window.InviteSheet.boot();
                await gate;
                expect(window.InviteSheet.boot()).toBe(gate); // a second bootstrap reads nothing again
                const p3 = await sync(document);
                const n = await window.CloudVault.userContentCount();
                expect(n).toBeGreaterThanOrEqual(43);
                expect(p3.textContent).toContain(`Your ${n} records move to your account`);
                expect(pendingReads()).toBe(1);
                tap(p3, 'turn-on-sync');
                await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: CLAIM }]]));
                expect(bridge).not.toHaveBeenCalledWith('invite.clear');
                expect(offDevice()).toEqual([]);
            });

            it('a slot older than 14 days is cleared and ignored', async () => {
                const { window, document } = env;
                await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
                slotted({ url: CLAIM, receivedAt: Date.now() - 15 * 24 * 60 * 60 * 1000 });
                await window.InviteSheet.boot();
                expect(bridge).toHaveBeenCalledWith('invite.clear');
                expect(document.getElementById('invite-sync-sheet')).toBeNull();
            });

            it('no slot + ?invite=1 → F1 opens, and the flag is stripped', async () => {
                const { window, document } = env;
                window.history.replaceState(null, '', '/?invite=1');
                slotted(null);
                await window.InviteSheet.boot();
                expect(window.location.search).toBe('');
                await vi.waitFor(() => expect(sheet(document)).not.toBeNull());
            });

            // iOS flow QA (bd med-w6gx.23.8): a bridge slowed past the 3 s probe
            // on a cold start dropped the shell's ?invite=1, landing on W1 alone.
            it('?invite=1 waits out a capability probe slower than 3 s: F1 still opens', async () => {
                const { window, document } = env;
                window.history.replaceState(null, '', '/?invite=1');
                slotted(null);
                let answer;
                window.LocalNotifications.__native.has = vi.fn(() => new Promise((r) => { answer = r; }));
                const gate = window.InviteSheet.boot();
                await new Promise((r) => { setTimeout(r, 3200); });
                answer(true);
                await gate;
                await vi.waitFor(() => expect(sheet(document)).not.toBeNull());
            });

            // ...but not for good: a shell that never answers holds W1 for at
            // most FORCED_PROBE_MS (a white screen is worse than a missed F1).
            it('?invite=1 gives up on a shell that never answers after 15 s', async () => {
                const { window } = env;
                window.history.replaceState(null, '', '/?invite=1');
                slotted(null);
                window.LocalNotifications.__native.has = vi.fn(() => new Promise(() => {}));
                const timers = vi.spyOn(window, 'setTimeout');
                let done = false;
                const gate = window.InviteSheet.boot().then(() => { done = true; });
                await vi.waitFor(() => expect(timers.mock.calls.some((c) => c[1] === 15000)).toBe(true));
                expect(done).toBe(false);
                timers.mock.calls.find((c) => c[1] === 15000)[0]();
                await gate;
                expect(done).toBe(true);
            });

            describe('with no records on this device (the Play-referrer first launch)', () => {
                beforeAll(() => { healthOn = false; });
                afterAll(() => { healthOn = true; });

                // The boot promise is what auth-bootstrap.js waits on before
                // WGFirstRun.mount (features.auth-bootstrap.test.js); the W1
                // footer's own slot check hides "Have an invite?" (med-ta2n.1).
                it('"Your invite is here" holds the W1 gate until Use without sync; the slot is kept', async () => {
                    const { window, document } = env;
                    window.LocalNotifications.copy = { os: 'Android', device: 'phone' };
                    slotted({ url: CLAIM, receivedAt: Date.now() });
                    let released = false;
                    window.InviteSheet.boot().then(() => { released = true; });
                    const screen = await ready(document);
                    expect(screen.textContent).toMatch(/Your invite is here/);
                    expect(screen.textContent).toMatch(/Sign in with your fingerprint/);
                    expect(screen.querySelector('[data-invite-action="sign-in"]').textContent).toBe('Sign in with fingerprint');
                    await new Promise((r) => { setTimeout(r, 20); });
                    expect(released).toBe(false);
                    tap(screen, 'without-sync');
                    await vi.waitFor(() => expect(released).toBe(true));
                    expect(document.getElementById('invite-ready')).toBeNull();
                    expect(bridge).not.toHaveBeenCalledWith('invite.clear');
                    expect(leaveOps()).toEqual([]);
                });

                it('Sign in → move.stash then local.leave {url}', async () => {
                    const { window, document } = env;
                    slotted({ url: CLAIM, receivedAt: Date.now() });
                    let released = false;
                    window.InviteSheet.boot().then(() => { released = true; });
                    const screen = await ready(document);
                    tap(screen, 'sign-in');
                    await vi.waitFor(() => expect(leaveOps()).toEqual([['move.stash'], ['local.leave', { url: CLAIM }]]));
                    // Navigation is the end state: the button stays busy and the sheet stays locked.
                    const btn = screen.querySelector('[data-invite-action="sign-in"]');
                    expect(btn.classList.contains('wg-btn--busy')).toBe(true);
                    expect(btn.disabled).toBe(true);
                    await new Promise((r) => { setTimeout(r, 20); });
                    tap(screen, 'without-sync');
                    await new Promise((r) => { setTimeout(r, 20); });
                    expect(document.getElementById('invite-ready')).not.toBeNull();
                    expect(released).toBe(false);
                });
            });
        });

        // bd med-r1j2.4 (AD9): the add-device hand-off reaching the local app (a
        // /d/ link in the slot, or pasted) → "Join and erase". Invariant: nothing
        // here is erased — not on Cancel, not for an expired code, not on Join
        // (the shell finishes only once the joined account boots unlocked:
        // cloud-boot.js finishJoinErase → local.erase). No move stash: no merge.
        describe('add-device hand-off: "Join and erase" (med-r1j2.4)', () => {
            const FRAG = 'AbC_d-1234567890123456.QUJDREVGR0hJSktMTU5PUA';
            const HANDOFF = `https://app.example.com/d/abc#${FRAG}`;
            const JOIN = `https://abc.app.example.com/claim#${FRAG}`;
            // A shell with the erase half (med-r1j2.7/.8); the nested
            // describe below takes it away again.
            let parentOps;
            beforeAll(() => { parentOps = bootShellOps; bootShellOps = [...bootShellOps, 'local.erase']; });
            afterAll(() => { bootShellOps = parentOps; });
            const slotted = (slot) => bridge.mockImplementation(async (op) => {
                if (op === 'shell.ops') return bootShellOps;
                if (op === 'invite.pending') return slot;
                return op === 'setEgressHosts' ? { changed: false } : true;
            });
            const dialog = (document) => vi.waitFor(() => {
                const d = document.querySelector('mt-modal.mt-confirm-modal');
                if (!d) throw new Error('no dialog');
                return d;
            });
            const erased = () => bridge.mock.calls.some(([op]) => op === 'local.reset' || op === 'local.erase');
            async function withRecords(window) {
                await vi.waitFor(async () => expect(await window.apiCall('/api/bp?days=60')).toHaveLength(1));
                await window.apiCall('/api/weight', 'POST', { weight: 80 });
                cancelReminderRecompute({ accountId: 'local' });
                return window.CloudVault.userContentCount();
            }

            it('the dialog names the account and the record count; Cancel drops the code and keeps every record', async () => {
                const { window, document } = env;
                const n = await withRecords(window);
                expect(n).toBeGreaterThanOrEqual(2);
                slotted({ url: HANDOFF, receivedAt: Date.now() });
                await window.InviteSheet.boot();
                const d = await dialog(document);
                expect(d.textContent).toContain('Join abc.app.example.com and erase this iPhone?');
                expect(d.textContent).toContain(`Everything on this iPhone (${n} records) will be erased after this iPhone is added.`);
                expect(d.textContent).toContain('Nothing is erased if adding fails or you stop');
                expect(d.querySelector('.mt-confirm-modal__confirm').textContent).toBe('Join and erase');
                d.querySelector('.mt-confirm-modal__cancel').click();
                await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('invite.clear'));
                expect(leaveOps()).toEqual([]);
                expect(erased()).toBe(false);
                expect(await window.CloudVault.userContentCount()).toBe(n);
            });

            it('Join and erase → local.leave {claim url, erase: true}: no stash, nothing erased on this page', async () => {
                const { window, document } = env;
                const n = await withRecords(window);
                slotted({ url: HANDOFF, receivedAt: Date.now() });
                await window.InviteSheet.boot();
                (await dialog(document)).querySelector('.mt-confirm-modal__confirm').click();
                await vi.waitFor(() => expect(leaveOps()).toEqual([['local.leave', { url: JOIN, erase: true }]]));
                expect(bridge).not.toHaveBeenCalledWith('invite.clear');
                expect(erased()).toBe(false);
                expect(await window.CloudVault.userContentCount()).toBe(n);
            });

            it('an expired code (slot older than 10 minutes) is cleared with no dialog; records stay', async () => {
                const { window, document } = env;
                const n = await withRecords(window);
                slotted({ url: HANDOFF, receivedAt: Date.now() - 11 * 60 * 1000 });
                await window.InviteSheet.boot();
                expect(bridge).toHaveBeenCalledWith('invite.clear');
                await new Promise((r) => { setTimeout(r, 20); });
                expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull();
                expect(leaveOps()).toEqual([]);
                expect(await window.CloudVault.userContentCount()).toBe(n);
            });

            it('a pasted medtracker://d/ link in F1 reaches the same dialog', async () => {
                const { window, document } = env;
                await withRecords(window);
                openSheet(window, { clipboard: `medtracker://d/abc#${FRAG}` });
                act(document, 'paste').click();
                const d = await dialog(document);
                expect(sheet(document)).toBeNull();
                expect(d.textContent).toContain('Join abc.app.example.com and erase this iPhone?');
                d.querySelector('.mt-confirm-modal__confirm').click();
                await vi.waitFor(() => expect(leaveOps()).toEqual([['local.leave', { url: JOIN, erase: true }]]));
            });

            // Every shipped shell today: no local.erase → no erase promise.
            describe('a shell without local.erase', () => {
                let ops;
                beforeAll(() => { ops = bootShellOps; bootShellOps = bootShellOps.filter((op) => op !== 'local.erase'); });
                afterAll(() => { bootShellOps = ops; });

                it('"Join <host>?" says the records stay in local mode; Join → plain local.leave {url}', async () => {
                    const { window, document } = env;
                    const n = await withRecords(window);
                    slotted({ url: HANDOFF, receivedAt: Date.now() });
                    await window.InviteSheet.boot();
                    const d = await dialog(document);
                    expect(d.textContent).toContain('Join abc.app.example.com?');
                    expect(d.textContent).toContain(`The ${n} records on this iPhone stay in local mode. They are not copied to the account.`);
                    expect(d.textContent).not.toMatch(/erase/i);
                    expect(d.querySelector('.mt-confirm-modal__confirm').textContent).toBe('Join');
                    d.querySelector('.mt-confirm-modal__confirm').click();
                    await vi.waitFor(() => expect(leaveOps()).toEqual([['local.leave', { url: JOIN }]]));
                    expect(erased()).toBe(false);
                    expect(await window.CloudVault.userContentCount()).toBe(n);
                });
            });

            describe('with no records on this device', () => {
                beforeAll(() => { healthOn = false; });
                afterAll(() => { healthOn = true; });

                // The slot never opens by itself: any page can fire the scheme.
                it('the slot still asks once ("Join <host>?"); Cancel clears it, Join opens the claim', async () => {
                    const { window, document } = env;
                    slotted({ url: HANDOFF, receivedAt: Date.now() });
                    await window.InviteSheet.boot();
                    let d = await dialog(document);
                    expect(leaveOps()).toEqual([]);
                    expect(d.textContent).toContain('Join abc.app.example.com?');
                    expect(d.querySelector('.mt-confirm-modal__confirm').textContent).toBe('Join');
                    d.querySelector('.mt-confirm-modal__cancel').click();
                    await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('invite.clear'));
                    expect(leaveOps()).toEqual([]);
                    await vi.waitFor(() => expect(document.querySelector('mt-modal.mt-confirm-modal')).toBeNull());
                    window.InviteSheet.offer(JOIN);
                    await vi.waitFor(() => { d = document.querySelector('mt-modal.mt-confirm-modal'); expect(d).not.toBeNull(); });
                    d.querySelector('.mt-confirm-modal__confirm').click();
                    await vi.waitFor(() => expect(leaveOps()).toEqual([['local.leave', { url: JOIN }]]));
                    expect(erased()).toBe(false);
                });
            });
        });
    });

    it('boot in a pre-v3 shell (no invite.pending): no slot read, nothing shown', async () => {
        const { window, document } = env;
        await window.InviteSheet.boot();
        expect(bridge).not.toHaveBeenCalledWith('invite.pending');
        expect(document.getElementById('invite-sync-sheet')).toBeNull();
        expect(document.getElementById('invite-ready')).toBeNull();
    });

    it('F1 in a pre-v3 shell (no invite.pending): a valid paste never stashes or leaves', async () => {
        const { window, document } = env;
        window.Clipboard = { readText: async () => 'https://abc.app.example.com/#claim=0a1b2c' };
        document.dispatchEvent(new window.CustomEvent('wg:invite-open'));
        document.querySelector('#invite-sheet [data-invite-action="paste"]').click();
        await vi.waitFor(() => expect(document.querySelector('#invite-sheet .wg-error').textContent).toMatch(/Update Med Tracker/));
        expect(bridge.mock.calls.map(([op]) => op).filter((op) => op === 'move.stash' || op === 'local.leave')).toEqual([]);
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

    // bd med-nt9p.32.3: the Android shell answers the same bridge ops, so the
    // gates take 'android' next to 'ios' and the copy names its device; any
    // other platform (the web, an unknown one) is still refused.
    it('the Android shell gets the same egress, move and erase ops, with "phone" copy', async () => {
        const { window } = env;
        const local = window.LocalNotifications;
        local.__native.platform = 'android';
        local.copy = { os: 'Android', device: 'phone' };
        await window.apiCall('/api/weight', 'POST', { weight: 80 });
        cancelReminderRecompute({ accountId: 'local' });
        // The boot's registration (on 'ios') is the window trial.apply re-runs.
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('setEgressHosts', { hosts: [] }));
        bridge.mockClear();

        await window.CloudVault.trial.apply();
        expect(bridge).toHaveBeenCalledWith('setEgressHosts', { hosts: [] });
        await window.CloudVault.moveToCloud({ win: window });
        expect(bridge).toHaveBeenCalledWith('move.stash', expect.objectContaining({ vault: expect.any(String) }));
        expect(bridge).toHaveBeenCalledWith('local.leave');
        const replace = vi.fn();
        const win = () => ({
            localStorage: window.localStorage, sessionStorage: window.sessionStorage,
            LocalNotifications: local, location: { replace },
        });
        await window.CloudVault.eraseDevice({ win: win() });
        expect(bridge).toHaveBeenCalledWith('local.reset');
        expect(replace).toHaveBeenCalledWith('/');

        for (const platform of ['web', 'windows']) {
            local.__native.platform = platform;
            bridge.mockClear();
            await window.CloudVault.trial.apply();
            await expect(window.CloudVault.moveToCloud({ win: window })).rejects.toThrow('Open the app on your phone to use an invite.');
            await window.CloudVault.eraseDevice({ win: win() });
            expect(bridge).not.toHaveBeenCalled();
        }
        expect(offDevice()).toEqual([]);
    });

    // bd med-nt9p.32.9 (Android), med-o7zq.39 (iOS): Settings → App lock is
    // the phone shell's optional lock. The boot (on 'ios' here) asks
    // lock.status, but this bridge's `true` is no status, so no row; the row
    // mounts only when a phone shell answers { on, available }, its copy names
    // that platform's check, and a refused or rejected lock.set flips it back.
    it.each([
        ['android', 'fingerprint, face or screen lock'],
        ['ios', 'Face ID, Touch ID or passcode'],
    ])('Settings → App lock: %s shell, under the local-mode indicator, refused toggle flips back', async (platform, check) => {
        const { window, document } = env;
        const { mountLocalLockRow } = await import('../../../cloud/js/local-policy.js');
        expect(bridge.mock.calls.some(([op]) => op === 'lock.set')).toBe(false);
        expect(document.getElementById('settings-local-lock')).toBeNull();

        const local = window.LocalNotifications;
        local.__native.platform = platform;
        let status = { on: false, available: false };
        let allow = true;
        bridge.mockImplementation(async (op) => {
            if (op === 'lock.status') return status;
            if (op === 'lock.set') return allow;
            return null;
        });
        // No screen lock and the lock off: nothing to offer.
        expect(await mountLocalLockRow({ win: window })).toBeNull();

        status = { on: false, available: true };
        const group = await mountLocalLockRow({ win: window });
        expect(group).not.toBeNull();
        // Kit S6 slot ② (bd med-ckm5.6), right after the mode-card slot.
        expect(group.parentElement.dataset.settingsSlot).toBe('mode-actions');
        expect(group.parentElement.previousElementSibling.querySelector('#settings-sync-card')).not.toBeNull();
        expect(group.querySelector('.wg-setting__desc').textContent).toContain(`Asks for your ${check} each time`);
        const input = document.getElementById('settings-local-lock-toggle');
        expect(input.checked).toBe(false);
        expect(await mountLocalLockRow({ win: window })).toBeNull(); // once

        input.checked = true;
        input.dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => expect(input.disabled).toBe(false));
        expect(bridge).toHaveBeenCalledWith('lock.set', { on: true });
        expect(input.checked).toBe(true);

        allow = false;
        input.checked = false;
        input.dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => expect(bridge).toHaveBeenCalledWith('lock.set', { on: false }));
        await vi.waitFor(() => expect(input.checked).toBe(true));

        // Changed outside the page (iPhone Settings → Lock): the switch follows
        // when the page comes back.
        status = { on: false, available: true };
        document.dispatchEvent(new window.Event('visibilitychange'));
        await vi.waitFor(() => expect(input.checked).toBe(false));
        status = { on: true, available: true };
        document.dispatchEvent(new window.Event('visibilitychange'));
        await vi.waitFor(() => expect(input.checked).toBe(true));

        // A rejected lock.set ("locked") flips back too.
        bridge.mockImplementation(async (op) => {
            if (op === 'lock.set') throw new Error('locked');
            return null;
        });
        input.checked = false;
        input.dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => expect(input.disabled).toBe(false));
        expect(input.checked).toBe(true);

        group.remove();
        // An older iOS shell rejects lock.status: no row.
        local.__native.platform = 'ios';
        bridge.mockImplementation(async (op) => { throw new Error(`unsupported: ${op}`); });
        expect(await mountLocalLockRow({ win: window })).toBeNull();
        local.__native.platform = 'web';
        bridge.mockClear();
        expect(await mountLocalLockRow({ win: window })).toBeNull();
        expect(bridge).not.toHaveBeenCalled();
        expect(offDevice()).toEqual([]);
    });
});

// bd med-ta2n.24 §B1 — shellPost: the fetch-shaped adapter over the shell's
// base.post op. The W5 suite drives it end to end; this pins what that flow
// cannot reach (the attest headers and empty-body statuses #1261 relies on).
describe('shellPost over base.post', () => {
    it('sends the path, the body verbatim and only the X-Attest-* headers; answers a Response', async () => {
        const call = vi.fn(async () => ({ status: 401, headers: { 'X-Attest-Challenge': 'c2' }, body: '{"error":"install_unknown"}' }));
        const body = '{"b": "é\\n"}';
        const res = await shellPost({ call })('https://ignored.example/api/attest/feedback?x=1#y', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'X-Attest-Key-Id': 'k', 'X-Attest-Assertion': 'a', Cookie: 'no' },
            body,
        });
        expect(call).toHaveBeenCalledWith('base.post', {
            path: '/api/attest/feedback', body, headers: { 'X-Attest-Key-Id': 'k', 'X-Attest-Assertion': 'a' },
        });
        expect(res.status).toBe(401);
        expect(res.ok).toBe(false);
        expect(res.headers.get('X-Attest-Challenge')).toBe('c2');
        expect(await res.json()).toEqual({ error: 'install_unknown' });
    });
    it('204 has a null body; an op error rejects with a TypeError, as fetch does', async () => {
        const ok = await shellPost({ call: async () => ({ status: 204, headers: {}, body: '' }) })('/api/attest/feedback', { body: '{}' });
        expect(ok.status).toBe(204);
        expect(await ok.text()).toBe('');
        await expect(shellPost({ call: async () => { throw new Error('network'); } })('/api/invite-requests', { body: '{}' }))
            .rejects.toThrow(TypeError);
    });
    it('the page allowlist is the shells\' five paths', () => {
        // /api/attest/delete: the erase's install-record delete (bd med-egb3).
        expect(BASE_POST_PATHS).toEqual(['/api/attest/challenge', '/api/attest/delete', '/api/attest/enroll', '/api/attest/feedback', '/api/invite-requests']);
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
        await egressSettled(bridge);
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

    const trialState = (document) => document.querySelector('#integrations-trial-card [data-offer-card]')?.getAttribute('data-trial-state');

    it('the Settings trial card runs the local consent, adds the base domain, and Turn off removes it', async () => {
        const { window, document } = env;
        await window.SettingsIntegrations._renderTrialCard();
        const section = document.getElementById('integrations-trial');
        expect(section.classList.contains('hidden')).toBe(false);
        expect(trialState(document)).toBe('offer');
        expect(document.querySelector('#integrations-trial-card .wg-meta').textContent).toBe('Food AI · food database · voice');

        const turningOn = window.SettingsIntegrations._setLocalTrial(true);
        const modal = await vi.waitFor(() => {
            const el = document.querySelector('.wg-trial-consent-modal[data-trial-consent-scope="anon"]');
            expect(el).not.toBeNull();
            return el;
        });
        // Local copy: through our server, what it keeps, per iPhone, and a
        // reinstall continues the same allowance (bd med-o7zq.26).
        expect(modal.textContent).toMatch(/through our server/i);
        expect(modal.textContent).toMatch(/App Attest/);
        // med-ckm5.11: four facts, the iOS Device check among them; the rest under Full details.
        expect([...modal.querySelectorAll('.wg-facts > li b')].map((b) => b.textContent))
            .toEqual(['What’s sent', 'Where it goes', 'Device check', 'Rather use your own key?']);
        expect(modal.querySelector('.wg-facts').textContent).toMatch(/Apple App Attest confirms this is the real app/);
        expect(modal.querySelector('details.wg-disc').open).toBe(false);
        expect(modal.querySelector('.wg-disc__body').textContent).toMatch(/reinstalling the app continues the same allowance/i);
        expect(modal.textContent).toMatch(/free AI requests on this iPhone/i);
        expect(modal.textContent).toMatch(/reinstalling the app continues the same allowance/i);
        expect(modal.textContent).not.toMatch(/gives up the rest/i);
        // Voice (bd med-o7zq.23): what goes where, and the minutes.
        expect(modal.textContent).toMatch(/voice calls/i);
        expect(modal.textContent).toMatch(/ElevenLabs account/);
        // Shown before the grant, so no numbers: the limits are the server's
        // (bd med-o7zq.28), shown in Settings once granted.
        expect(modal.textContent).toMatch(/free minutes of voice calls on this iPhone, with a daily limit/);
        expect(modal.textContent).toMatch(/each call uses its full length limit when it starts/);
        expect(modal.textContent).not.toMatch(/\d+ (free )?minutes/);
        modal.querySelector('[data-trial-consent-choice="allow"]').click();
        await turningOn;

        expect((await window.apiCall('/api/settings/trial-consent')).anon).toBe(true);
        expect(bridge).toHaveBeenLastCalledWith('setEgressHosts', { hosts: [TRIAL_BASE, 'api.elevenlabs.io'] });
        expect(await window.CloudVault.trial.status()).toMatchObject({ on: true });
        expect(trialState(document)).toBe('on');

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
        await window.SettingsIntegrations._renderTrialCard();
        expect(document.getElementById('integrations-trial').classList.contains('hidden')).toBe(true);
    });

    // med-6xb9: Today's "Try AI for free" card asks trialOffer() and starts
    // the trial through this same switch.
    it('trialOffer is true while the switch is off, startTrial is the switch, and no offer once on or without App Attest', async () => {
        const { window, document } = env;
        expect(await window.SettingsIntegrations.trialOffer()).toBe(true);
        const starting = window.SettingsIntegrations.startTrial();
        const modal = await vi.waitFor(() => {
            const el = document.querySelector('.wg-trial-consent-modal[data-trial-consent-scope="anon"]');
            expect(el).not.toBeNull();
            return el;
        });
        modal.querySelector('[data-trial-consent-choice="allow"]').click();
        expect(await starting).toBe(true);
        expect(trialState(document)).toBe('on');
        expect(await window.SettingsIntegrations.trialOffer()).toBe(false);

        await window.SettingsIntegrations._setLocalTrial(false);
        window.Attest.status = vi.fn(async () => ({ supported: false, base: TRIAL_BASE, attested: false }));
        expect(await window.SettingsIntegrations.trialOffer()).toBe(false);
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
        await egressSettled(bridge);
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
    const OFF_COPY = 'No food database in device-only mode. Turn on the free trial in Settings → AI & integrations to use it.';

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

    // fetch serialises the URL (WHATWG): ' goes out as %27, which
    // encodeURIComponent leaves alone. The server hashes the RequestURI it
    // received, so the signed digest must be over the URL actually fetched.
    it.each([
        ["McDonald's", 'an apostrophe'],
        ['café crème', 'a non-ASCII term'],
    ])('on: a search for %s (%s) signs the URL actually fetched', async (term) => {
        const { createHash } = await import('node:crypto');
        const { window, document } = env;
        foodReply = () => new Response(JSON.stringify({ results: [{ name: 'Big meal', kcal100g: 250 }] }), { status: 200 });
        await trialOn();
        window.FoodLog.addSheet.open();
        await settle();
        await window.FoodLog.addSheet.runSearch(term, false);
        await vi.waitFor(() => expect(document.getElementById('food-add-results').textContent).toContain('Big meal'));
        expect(foodGets()).toHaveLength(1);
        const wire = new URL(foodGets()[0].url);
        const sent = wire.pathname + wire.search;
        expect(sent).not.toContain("'");
        const digest = createHash('sha256').update(`${sent}\n`).digest('base64');
        expect(window.Attest.assert).toHaveBeenCalledWith('c1', digest);
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

// bd med-o7zq.23 — trial voice calls ride the same switch: the call trigger
// shows only while it is on, one signed POST /api/attest/voice/start mints
// the call (signed URL + relay token), the device leg dials the base domain
// with the token, and the SDK gets both. The real elevenlabs-call.js runs in
// the page with a stubbed SDK; the relay leg's WebSocket is stubbed.
describe('local-only mode trial voice calls (med-o7zq.23)', () => {
    const TRIAL_BASE = 'trial-base.example.test';
    const START = '/api/attest/voice/start';
    const SIGNED = 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=sig-1';
    const ELEVENLABS_SRC = readFileSync(
        fileURLToPath(new URL('../features/elevenlabs-call.js', import.meta.url)),
        'utf8',
    ).replace('sdkPromise = import(SDK_URL).catch((err) => {', 'sdkPromise = Promise.resolve(window.__fakeSDK).catch((err) => {');
    // The trial-off hint's two rules (the trigger's gate is in localModeCss).
    function hintCss() {
        const start = STYLES_CSS.indexOf('.wg-callbar__trial-hint {');
        const last = STYLES_CSS.indexOf(':root.wg-local-trial-off .wg-callbar__trial-hint {');
        return STYLES_CSS.slice(start, STYLES_CSS.indexOf('}', last) + 1);
    }

    class FakeSocket {
        constructor(url) {
            this.url = url;
            this.readyState = FakeSocket.OPEN;
            FakeSocket.instances.push(this);
        }

        send() {}

        close() { this.readyState = 3; }

        recv(frame) { this.onmessage({ data: JSON.stringify(frame) }); }

        fireClose(code) { this.readyState = 3; this.onclose({ code }); }
    }
    FakeSocket.OPEN = 1;

    let env;
    let fetched;
    let bridge;
    let startReply;
    let conv;
    let startSession;

    beforeEach(async () => {
        await deleteDb();
        fetched = [];
        FakeSocket.instances = [];
        vi.stubGlobal('WebSocket', FakeSocket);
        startReply = () => new Response(JSON.stringify({
            signed_url: SIGNED, call: 'tok-1', granted_seconds: 300, remaining_seconds: 480, daily_remaining_seconds: 180,
            voice_lifetime_seconds: 1200, voice_daily_seconds: 600, voice_call_max_seconds: 300,
        }), { status: 200 });
        const recorder = vi.fn(async (url, init = {}) => {
            fetched.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
            const u = String(url);
            if (u === `https://${TRIAL_BASE}/api/attest/challenge`) {
                return new Response(JSON.stringify({ challenge: 'c1', expires_in: 300 }), { status: 200 });
            }
            if (u === `https://${TRIAL_BASE}${START}`) return startReply();
            return createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', recorder);
        env = loadFrontendEnv();
        env.window.fetch = recorder;
        bridge = vi.fn(async (op) => (op === 'setEgressHosts' ? { changed: false } : null));
        const notifications = { isSupported: () => false, __native: { platform: 'ios', call: bridge } };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        env.window.Attest = {
            isSupported: () => true,
            status: vi.fn(async () => ({ supported: true, base: TRIAL_BASE, attested: true })),
            enroll: vi.fn(),
            assert: vi.fn(async (challenge, digest) => ({ keyId: 'key-1', assertion: `sig:${challenge}:${digest}` })),
        };
        const style = env.document.createElement('style');
        style.textContent = localModeCss() + hintCss();
        env.document.head.appendChild(style);
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await egressSettled(bridge);
        conv = { endSession: vi.fn(async () => {}), setMicMuted: vi.fn() };
        startSession = vi.fn(async (opts) => { opts.onConnect(); return conv; });
        env.window.__fakeSDK = { Conversation: { startSession } };
        env.window.eval(ELEVENLABS_SRC);
    });

    afterEach(async () => {
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

    function mountBar() {
        const bar = env.document.createElement('div');
        bar.className = 'wg-callbar';
        env.document.body.appendChild(bar);
        env.window.WGCallAgent.mountCard(bar);
        return bar;
    }

    const shown = (el) => env.window.getComputedStyle(el).display !== 'none';
    const toOffDevice = () => fetched.filter(({ url }) => url.startsWith('/api/')
        || (/^https?:/.test(url) && [TRIAL_BASE, 'api.elevenlabs.io'].includes(new URL(url).hostname)));
    const starts = () => fetched.filter(({ url }) => url === `https://${TRIAL_BASE}${START}`);

    async function tapCallAndAttach(bar) {
        bar.querySelector('.wg-callbar__call').click();
        const sock = await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
            return FakeSocket.instances[0];
        });
        sock.recv({ type: 'hello', call: 'tok-1' });
        await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
        return sock;
    }

    it('off: no call trigger, the hint says how to turn it on, and neither host is admitted or called', async () => {
        const bar = mountBar();
        expect(env.document.documentElement.classList.contains('wg-local-trial')).toBe(false);
        expect(shown(bar.querySelector('.wg-callbar__call'))).toBe(false);
        const hint = bar.querySelector('.wg-callbar__trial-hint');
        expect(hint.textContent).toBe('Turn on the free trial in Settings → AI & integrations to call the agent.');
        expect(shown(hint)).toBe(true);
        for (const [op, args] of bridge.mock.calls) {
            if (op === 'setEgressHosts') {
                expect(args.hosts).not.toContain(TRIAL_BASE);
                expect(args.hosts).not.toContain('api.elevenlabs.io');
            }
        }
        expect(env.window.CloudVoiceLLM.localTrial).toBeUndefined();
        expect(toOffDevice()).toEqual([]);
        expect(FakeSocket.instances).toEqual([]);
    });

    it('on: one signed start, the device leg with its token, and the SDK gets the signed URL and the token', async () => {
        const { createHash } = await import('node:crypto');
        // Mounted before the trial responder lands (boot race): it repaints.
        const bar = mountBar();
        await vi.waitFor(() => expect(bar.querySelector('.wg-callbar__call').dataset.action).toBe('voice-setup'));
        await trialOn();
        expect(bridge).toHaveBeenLastCalledWith('setEgressHosts', { hosts: [TRIAL_BASE, 'api.elevenlabs.io'] });
        expect(shown(bar.querySelector('.wg-callbar__call'))).toBe(true);
        expect(shown(bar.querySelector('.wg-callbar__trial-hint'))).toBe(false);
        await vi.waitFor(() => expect(bar.querySelector('.wg-callbar__label').textContent).toBe('Call agent'));
        expect(bar.querySelector('.wg-callbar__call').dataset.action).toBe('call-agent');

        const sock = await tapCallAndAttach(bar);
        expect(starts()).toHaveLength(1);
        expect(starts()[0].method).toBe('POST');
        const digest = createHash('sha256').update(`${START}\n`).digest('base64');
        expect(env.window.Attest.assert).toHaveBeenCalledWith('c1', digest);
        expect(starts()[0].headers).toMatchObject({
            'X-Attest-Key-Id': 'key-1', 'X-Attest-Challenge': 'c1', 'X-Attest-Assertion': `sig:c1:${digest}`,
        });
        expect(sock.url).toBe(`wss://${TRIAL_BASE}/api/attest/voice/device?call=tok-1`);
        expect(startSession.mock.calls[0][0]).toMatchObject({ signedUrl: SIGNED, customLlmExtraBody: { call: 'tok-1' } });
        expect(bar.dataset.state).toBe('in_call');
        // No account route, no second mint.
        expect(fetched.filter(({ url }) => url.startsWith('/api/'))).toEqual([]);

        // The grant runs out (frame, then close 4429): the call ends with why.
        sock.recv({ type: 'budget_exhausted' });
        sock.fireClose(4429);
        await vi.waitFor(() => expect(conv.endSession).toHaveBeenCalled());
        await vi.waitFor(() => expect(bar.querySelector('.wg-callbar__error').textContent)
            .toBe('Call time is up — each free call lasts up to 5 minutes. Call again to keep talking.'));
        expect(FakeSocket.instances).toHaveLength(1); // no redial

        await env.window.SettingsIntegrations._renderTrialCard();
        expect(env.document.getElementById('integrations-trial-status').textContent)
            .toContain('Voice: 8 min left (up to 10 min a day; each call uses up to 5 min).');
    });

    it('on: a 4429 close on the last minutes ends the session with the minutes-used-up copy', async () => {
        startReply = () => new Response(JSON.stringify({
            signed_url: SIGNED, call: 'tok-1', granted_seconds: 60, remaining_seconds: 0, daily_remaining_seconds: 0,
        }), { status: 200 });
        await trialOn();
        const bar = mountBar();
        const sock = await tapCallAndAttach(bar);
        sock.fireClose(4429);
        await vi.waitFor(() => expect(conv.endSession).toHaveBeenCalled());
        await vi.waitFor(() => expect(bar.querySelector('.wg-callbar__error').textContent)
            .toBe('Free voice minutes used up — add your own keys in a cloud account to keep calling.'));
        await env.window.SettingsIntegrations._renderTrialCard();
        expect(env.document.getElementById('integrations-trial-status').textContent).toContain('Voice minutes used up.');
    });

    it.each([
        [429, { error: 'trial_budget_exhausted', scope: 'voice' }, 'Free voice minutes used up on this iPhone. Add your own keys in a cloud account to keep calling.'],
        [429, { error: 'trial_budget_exhausted', scope: 'voice-day', resets_at: '2026-10-19T00:00:00Z' }, 'Free voice calls paused until tomorrow.'],
        [429, { error: 'trial_budget_exhausted', scope: 'global', resets_at: '2026-10-19T00:00:00Z' }, 'The free voice line is busy today — try again tomorrow.'],
        [503, { error: 'voice_not_configured' }, 'Voice calls are not available on this server.'],
        [409, { error: 'call_in_progress' }, 'Your last call is still ending — try again in a minute.'],
    ])('on: a %i %j start shows its copy and opens no session', async (status, body, copy) => {
        startReply = () => new Response(JSON.stringify(body), { status });
        await trialOn();
        const bar = mountBar();
        bar.querySelector('.wg-callbar__call').click();
        await vi.waitFor(() => expect(bar.querySelector('.wg-callbar__error').textContent).toBe(copy));
        expect(bar.dataset.state).toBe('error');
        expect(starts()).toHaveLength(1);
        expect(FakeSocket.instances).toEqual([]);
        expect(startSession).not.toHaveBeenCalled();
    });
});

// bd med-o7zq.26 — the trial pass: a fresh grant's pass goes to the shell's
// Keychain (window.Attest.setPass), and after a reinstall the shell's enroll
// reply hands it back, so the enroll presents it and the server rejoins the
// same device bucket instead of answering trial_already_used.
describe('local-only mode trial pass across reinstalls (med-o7zq.26)', () => {
    const TRIAL_BASE = 'trial-base.example.test';
    const ENROLL = `https://${TRIAL_BASE}/api/attest/enroll`;
    let env;
    let enrolls;
    let enrollReply;

    beforeEach(async () => {
        await deleteDb();
        enrolls = [];
        enrollReply = () => new Response(JSON.stringify({ remaining: 200, daily: 50 }), { status: 200 });
        const recorder = vi.fn(async (url, init = {}) => {
            const u = String(url);
            if (u === `https://${TRIAL_BASE}/api/attest/challenge`) {
                return new Response(JSON.stringify({ challenge: 'c1', expires_in: 300 }), { status: 200 });
            }
            if (u === ENROLL) {
                const body = JSON.parse(init.body);
                enrolls.push(body);
                return enrollReply(body);
            }
            return createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', recorder);
        env = loadFrontendEnv();
        env.window.fetch = recorder;
        const bridge = vi.fn(async (op) => (op === 'setEgressHosts' ? { changed: false } : null));
        const notifications = { isSupported: () => false, __native: { platform: 'ios', call: bridge } };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        // A fresh install: no attested key yet, so turning the trial on enrolls.
        env.window.Attest = {
            isSupported: () => true,
            status: vi.fn(async () => ({ supported: true, base: TRIAL_BASE, attested: false })),
            enroll: vi.fn(async () => ({ keyId: 'key-1', attestation: 'QQ==', deviceToken: 'RA==' })),
            assert: vi.fn(),
            setPass: vi.fn(async () => null),
        };
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await egressSettled(bridge);
    });

    afterEach(async () => {
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
    }

    it('a first grant keeps the pass from the enroll response in the Keychain', async () => {
        enrollReply = () => new Response(JSON.stringify({ remaining: 200, daily: 50, pass: 'bucket.secret' }), { status: 200 });
        await trialOn();
        await vi.waitFor(() => expect(env.window.Attest.setPass).toHaveBeenCalledWith('bucket.secret'));
        expect(enrolls).toHaveLength(1);
        expect(enrolls[0]).not.toHaveProperty('pass');
    });

    it('after a reinstall the Keychain pass rides on the enroll, and the rejoin stores nothing new', async () => {
        env.window.Attest.enroll = vi.fn(async () => ({
            keyId: 'key-2', attestation: 'QQ==', deviceToken: 'RA==', pass: 'bucket.secret',
        }));
        enrollReply = () => new Response(JSON.stringify({ remaining: 120, daily: 50 }), { status: 200 });
        await trialOn();
        await vi.waitFor(() => expect(enrolls).toHaveLength(1));
        expect(enrolls[0]).toMatchObject({ key_id: 'key-2', pass: 'bucket.secret' });
        // The enroll finished (its body is in the Settings memo): no pass to keep.
        await vi.waitFor(() => expect(JSON.parse(env.window.localStorage.getItem('wg:local-trial'))).toMatchObject({ daily: 50 }));
        expect(env.window.Attest.setPass).not.toHaveBeenCalled();
    });

    it('a rejoin shows the voice minutes left in Settings before any call, from the server limits (med-o7zq.28)', async () => {
        env.window.Attest.enroll = vi.fn(async () => ({
            keyId: 'key-2', attestation: 'QQ==', deviceToken: 'RA==', pass: 'bucket.secret',
        }));
        enrollReply = () => new Response(JSON.stringify({
            remaining: 120, daily: 50, voice_remaining_seconds: 420, voice_daily_remaining_seconds: 300,
            voice_lifetime_seconds: 600, voice_daily_seconds: 300, voice_call_max_seconds: 300,
        }), { status: 200 });
        await trialOn();
        await vi.waitFor(() => expect(JSON.parse(env.window.localStorage.getItem('wg:local-trial')))
            .toMatchObject({ voiceRemaining: 420, voiceCallMax: 300 }));
        await env.window.SettingsIntegrations._renderTrialCard();
        expect(env.document.getElementById('integrations-trial-status').textContent)
            .toContain('Voice: 7 min left (up to 5 min a day; each call uses up to 5 min).');
        // Kit A1: the same limits as meters (used / total), so the end is visible coming.
        const card = env.document.querySelector('#integrations-trial-card [data-offer-card]');
        expect([...card.querySelectorAll('.wg-macros__label')].map((n) => n.textContent)).toEqual(['Voice', 'Today']);
        expect([...card.querySelectorAll('.wg-macros__val')].map((n) => n.textContent)).toEqual(['3 / 10 min', '0 / 5 min']);
        expect(card.querySelector('.wg-meter__fill').style.getPropertyValue('--p')).toBe('30%');
    });

    it('a server without anonymous voice adds no voice line on enroll', async () => {
        await trialOn();
        await vi.waitFor(() => expect(JSON.parse(env.window.localStorage.getItem('wg:local-trial'))).toMatchObject({ daily: 50 }));
        await env.window.SettingsIntegrations._renderTrialCard();
        expect(env.document.getElementById('integrations-trial-status').textContent).not.toMatch(/Voice/);
    });

    // bd med-o7zq.29 / med-ta2n.2 — first run's W2 "Try it free" is this
    // same switch: the anon consent, then the grant, then the next step.
    function mountFirstRun() {
        const dir = fileURLToPath(new URL('../features/firstrun/', import.meta.url));
        env.window.sessionStorage.setItem('wg-firstrun-step', 'trial');
        for (const f of ['state.js', 'screens/trial.js', 'index.js']) {
            env.window.eval(readFileSync(dir + f, 'utf8'));
        }
        env.window.WGFirstRun.mount({ needs_first_run: true });
    }

    async function tapTrialAndAllow() {
        const tryBtn = await vi.waitFor(() => {
            const el = env.document.querySelector('[data-firstrun-action="trial"]');
            expect(el).not.toBeNull();
            return el;
        });
        tryBtn.click();
        const modal = await vi.waitFor(() => {
            const el = env.document.querySelector('.wg-trial-consent-modal[data-trial-consent-scope="anon"]');
            expect(el).not.toBeNull();
            return el;
        });
        modal.querySelector('[data-trial-consent-choice="allow"]').click();
    }

    it('first run offers the trial first; its tap consents, enrolls once and moves on (med-o7zq.29)', async () => {
        mountFirstRun();
        await tapTrialAndAllow();
        // No done screen (bd med-ta2n.1): moving on completes the flow.
        await vi.waitFor(() => expect(env.window.WGFirstRun.isActive()).toBe(false));
        expect((await env.window.apiCall('/api/settings/trial-consent')).anon).toBe(true);
        expect(enrolls).toHaveLength(1);
        expect(await env.window.CloudVault.trial.status()).toMatchObject({ on: true, daily: 50 });
    });

    it('first run: a trial already used on this iPhone says so and leaves Not now (med-o7zq.29)', async () => {
        enrollReply = () => new Response(JSON.stringify({ error: 'trial_already_used' }), { status: 403 });
        mountFirstRun();
        await tapTrialAndAllow();
        await vi.waitFor(() => expect(env.document.querySelector('[data-firstrun-form-error="trial"]').textContent)
            .toMatch(/already used on this iPhone/));
        expect(env.window.WGFirstRun.state.getStep()).toBe('trial');
        env.document.querySelector('[data-firstrun-action="not-now"]').click();
        await vi.waitFor(() => expect(env.window.WGFirstRun.isActive()).toBe(false));
    });

    it('a pass the server refuses is dropped, and the enroll runs once more without it', async () => {
        env.window.Attest.enroll = vi.fn(async () => ({
            keyId: 'key-3', attestation: 'QQ==', deviceToken: 'RA==', pass: 'stale.secret',
        }));
        enrollReply = (body) => (body.pass
            ? new Response(JSON.stringify({ error: 'trial_pass_invalid' }), { status: 401 })
            : new Response(JSON.stringify({ remaining: 200, daily: 50, pass: 'fresh.secret' }), { status: 200 }));
        await trialOn();
        await vi.waitFor(() => expect(env.window.Attest.setPass).toHaveBeenCalledWith('fresh.secret'));
        expect(env.window.Attest.setPass.mock.calls).toEqual([[''], ['fresh.secret']]);
        expect(enrolls.map((b) => b.pass)).toEqual(['stale.secret', undefined]);
    });
});

// bd med-nt9p.32.8.4 — the Android shell's window.Attest (native/attest.js's
// android impl over android/.../Attest.kt): the same trial, enrolled with a
// Keystore key and a Play Integrity token. Only the enroll body and the
// consent's "what our server keeps" sentence differ; after enrollment it is
// the iOS path (challenge, signed requests, pass).
describe('local-only mode trial in the Android shell (med-nt9p.32.8.4)', () => {
    const TRIAL_BASE = 'trial-base.example.test';
    const ENROLL = `https://${TRIAL_BASE}/api/attest/enroll`;
    const TRANSIT = 'Android transit: an install id from a Keystore key, confirmed by Google Play Integrity.';
    const TRANSIT_2 = 'Android allowance: Google Play keeps a mark, so reinstalling does not reset it.';
    const DEVICE_CHECK = 'Android device check: Play Integrity confirms the real app.';
    const settle = async (n = 5) => {
        for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
    };
    let env;
    let fetched;
    let enrolls;
    let bridge;

    beforeEach(async () => {
        await deleteDb();
        fetched = [];
        enrolls = [];
        const recorder = vi.fn(async (url, init = {}) => {
            const u = String(url);
            fetched.push({ url: u, method: init.method || 'GET', headers: init.headers || {} });
            if (u === `https://${TRIAL_BASE}/api/attest/challenge`) {
                return new Response(JSON.stringify({ challenge: 'c1', expires_in: 300 }), { status: 200 });
            }
            if (u === ENROLL) {
                enrolls.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ remaining: 200, daily: 50, pass: 'bucket.secret' }), { status: 200 });
            }
            if (u.startsWith(`https://${TRIAL_BASE}/api/attest/food/`)) {
                return new Response(JSON.stringify({ results: [{ name: 'Rolled oats', kcal100g: 370 }] }), { status: 200 });
            }
            return createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', recorder);
        env = loadFrontendEnv();
        env.window.fetch = recorder;
        vi.stubGlobal('document', env.document);
        env.window.safeToast = vi.fn();
        bridge = vi.fn(async (op) => (op === 'setEgressHosts' ? { changed: false } : null));
        const notifications = { isSupported: () => false, __native: { platform: 'android', call: bridge } };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        // Attest.kt's reply shapes; no key handed out yet, so turning the trial on enrolls.
        env.window.Attest = {
            isSupported: () => true,
            status: vi.fn(async () => ({ supported: true, base: TRIAL_BASE, attested: false })),
            enroll: vi.fn(async () => ({ kind: 'android', keyId: 'akey-1', publicKey: 'UEs=', integrityToken: 'play.token' })),
            assert: vi.fn(async (challenge, digest) => ({ keyId: 'akey-1', assertion: `sig:${challenge}:${digest}` })),
            setPass: vi.fn(async () => null),
            copy: { trialTransit: [TRANSIT, TRANSIT_2], deviceCheck: DEVICE_CHECK },
        };
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await egressSettled(bridge);
    });

    afterEach(async () => {
        await env.window.apiCall('/api/settings/trial-consent', 'PATCH', { anon: false });
        await env.window.CloudVault.trial.apply();
        const { setTrialTransport } = await import('../../../cloud/js/aiclient.js');
        setTrialTransport(null);
        env.cleanup();
        vi.unstubAllGlobals();
    });

    const toBase = () => fetched.filter(({ url }) => /^https?:/.test(url) && new URL(url).hostname === TRIAL_BASE);

    it('consent names Play Integrity, one Android enroll body, signed lookups, and off removes the host', async () => {
        const { createHash } = await import('node:crypto');
        const { window, document } = env;
        expect(toBase()).toEqual([]);
        await window.SettingsIntegrations._renderTrialCard();
        expect(document.getElementById('integrations-trial').classList.contains('hidden')).toBe(false);

        const turningOn = window.SettingsIntegrations._setLocalTrial(true);
        const modal = await vi.waitFor(() => {
            const el = document.querySelector('.wg-trial-consent-modal[data-trial-consent-scope="anon"]');
            expect(el).not.toBeNull();
            return el;
        });
        expect(modal.textContent).toContain(TRANSIT);
        // The variants differ only in the Device check fact and the details text (med-ckm5.11).
        const details = [...modal.querySelectorAll('.wg-disc__body p')].map((p) => p.textContent);
        expect(details).toContain(TRANSIT);
        expect(details).toContain(TRANSIT_2);
        const facts = [...modal.querySelectorAll('.wg-facts > li')];
        expect(facts.map((li) => li.querySelector('b').textContent))
            .toEqual(['What’s sent', 'Where it goes', 'Device check', 'Rather use your own key?']);
        expect(facts[2].textContent).toContain(DEVICE_CHECK);
        expect(facts[2].querySelector('.wg-ico').getAttribute('data-icon')).toBe('device');
        expect(modal.textContent).toMatch(/through our server/i);
        expect(modal.textContent).not.toMatch(/iPhone|App Attest|DeviceCheck|keychain/i);
        modal.querySelector('[data-trial-consent-choice="allow"]').click();
        await turningOn;
        expect(bridge).toHaveBeenLastCalledWith('setEgressHosts', { hosts: [TRIAL_BASE, 'api.elevenlabs.io'] });

        // One enrollment, the Play Integrity body (no Apple fields), and the pass is kept.
        await vi.waitFor(() => expect(window.Attest.setPass).toHaveBeenCalledWith('bucket.secret'));
        expect(window.Attest.enroll).toHaveBeenCalledTimes(1);
        expect(enrolls).toEqual([{
            key_id: 'akey-1', challenge: 'c1', kind: 'android', public_key: 'UEs=', integrity_token: 'play.token',
        }]);
        await vi.waitFor(async () => expect(await window.CloudVault.trial.status()).toMatchObject({ on: true, daily: 50 }));

        // A food lookup is signed by the enrolled key, as on iOS.
        window.FoodLog.addSheet.open();
        await settle();
        await window.FoodLog.addSheet.runSearch('oats', false);
        await vi.waitFor(() => expect(document.getElementById('food-add-results').textContent).toContain('Rolled oats'));
        const path = '/api/attest/food/search?q=oats&limit=20';
        const gets = fetched.filter(({ url }) => url === `https://${TRIAL_BASE}${path}`);
        expect(gets).toHaveLength(1);
        const digest = createHash('sha256').update(`${path}\n`).digest('base64');
        expect(gets[0].headers).toMatchObject({ 'X-Attest-Key-Id': 'akey-1', 'X-Attest-Assertion': `sig:c1:${digest}` });
        expect(window.Attest.enroll).toHaveBeenCalledTimes(1);

        await window.SettingsIntegrations._setLocalTrial(false);
        expect(bridge).toHaveBeenLastCalledWith('setEgressHosts', { hosts: [] });
        expect(await window.CloudVault.trial.status()).toEqual({ on: false });
    });

    it('no Play services or no Play Integrity project (emulator, QA, forks): the row is hidden and nothing is asked', async () => {
        const { window, document } = env;
        window.Attest.status = vi.fn(async () => ({ supported: false, base: TRIAL_BASE, attested: false }));
        expect(await window.CloudVault.trial.status()).toBeNull();
        await window.SettingsIntegrations._renderTrialCard();
        expect(document.getElementById('integrations-trial').classList.contains('hidden')).toBe(true);
        expect(window.Attest.enroll).not.toHaveBeenCalled();
        expect(toBase()).toEqual([]);
    });
});

// bd med-o7zq.36.4: the account → local move, local side. The REAL
// local-boot.js picks up the shell's leave stash through the real settings.js
// nativeHas probe and the real importexport.js restoreVault into the real
// on-device store; only the bridge and the dialogs are stubbed.
describe('local-only mode leave stash pickup (med-o7zq.36.4)', () => {
    const VAULT = JSON.stringify(VAULT_FIXTURE);
    const FIXTURE_WEIGHTS = VAULT_FIXTURE.data.weight.logs.map((r) => r.weight).sort();
    const NOTICE = 'Your records from your account are on this iPhone.';
    const NOT_COPIED = 'Your account\'s records were not copied to this iPhone. Your account is unchanged: open it again and choose Use this iPhone without an account to retry, or restore a backup file.';
    let env;
    let log;

    beforeEach(async () => {
        allowConsoleNoise(); // location.reload is a jsdom "not implemented" error
        await deleteDb();
        vi.stubGlobal('fetch', vi.fn(async () => createMockResponse({ status: 503, json: {} })));
    });

    afterEach(() => {
        cancelReminderRecompute({ accountId: 'local' });
        env?.cleanup();
        env = null;
        vi.unstubAllGlobals();
    });

    // One app open over the same store. `ops` null = shell.ops rejects; `take`
    // is leave.take's answer, or a function that throws; `platform` null = the web.
    async function boot({
        platform = 'ios', ops = ['shell.ops', 'leave.take', 'leave.clear'], take = null,
        choice = 'replace', confirm = true, notice = false,
    } = {}) {
        env?.cleanup();
        env = loadFrontendEnv();
        const { window } = env;
        window.fetch = globalThis.fetch;
        // LOCAL_VAULT.importAll defaults its window to the global one.
        vi.stubGlobal('window', window);
        log = [];
        const call = vi.fn(async (op) => {
            log.push(op);
            if (op === 'shell.ops') { if (!ops) throw new Error('unsupported: shell.ops'); return ops; }
            if (op === 'leave.take') return typeof take === 'function' ? take() : take;
            if (op === 'setEgressHosts') return { changed: false };
            return true;
        });
        if (platform) window.LocalNotifications = { isSupported: () => false, __native: { platform, call } };
        window.safeChoose = vi.fn(async () => { log.push('choose'); return choice; });
        window.safeConfirm = vi.fn(async () => { log.push('confirm'); return confirm; });
        window.safeAlert = vi.fn(async () => { log.push('alert'); });
        window.safeToast = vi.fn();
        if (notice) window.sessionStorage.setItem('wg-leave-picked-up', '1');
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(window, (spec) => MODULES[spec]());
        await window.MedTrackerCloudReady;
        if (platform) await egressSettled(call);
        return { window, call };
    }
    const weights = async () => (await env.window.apiCall('/api/weight?days=0&limit=1000')).map((r) => r.weight).sort();
    const leaveOps = () => log.filter((op) => op.startsWith('leave.'));
    async function seedWeight() {
        await boot();
        await env.window.apiCall('/api/weight', 'POST', { weight: 80 });
        cancelReminderRecompute({ accountId: 'local' });
    }

    it('no shell (the web): no bridge call', async () => {
        const { call } = await boot({ platform: null, take: { vault: VAULT } });
        expect(call).not.toHaveBeenCalled();
        expect(await weights()).toEqual([]);
    });

    it('a shell without leave.take, or one that rejects shell.ops: never takes', async () => {
        for (const ops of [['shell.ops', 'account.leave'], null]) {
            await boot({ ops, take: { vault: VAULT } });
            expect(log).toContain('shell.ops');
            expect(leaveOps()).toEqual([]);
            expect(await weights()).toEqual([]);
        }
    });

    it('take rejects (locked) or finds no stash: nothing restored, nothing cleared', async () => {
        for (const take of [() => { throw new Error('locked'); }, null, { vault: 7 }]) {
            const { window } = await boot({ take });
            expect(leaveOps()).toEqual(['leave.take']);
            expect(window.safeAlert).not.toHaveBeenCalled();
            expect(await weights()).toEqual([]);
        }
    });

    it('stash + empty store: restores without a dialog, clears, reloads, and the next open toasts once', async () => {
        const { window } = await boot({ take: { vault: VAULT } });
        expect(window.safeChoose).not.toHaveBeenCalled();
        expect(window.safeConfirm).not.toHaveBeenCalled();
        expect(leaveOps()).toEqual(['leave.take', 'leave.clear']);
        expect(await weights()).toEqual(FIXTURE_WEIGHTS);
        // beforeReload ran (restoreVault reloads right after it): the notice
        // for the reloaded page is set, not shown yet.
        expect(window.sessionStorage.getItem('wg-leave-picked-up')).toBe('1');
        expect(window.safeToast).not.toHaveBeenCalledWith(NOTICE, 'success');

        const next = await boot({ notice: true });
        expect(next.window.safeToast.mock.calls.filter(([m]) => m === NOTICE)).toEqual([[NOTICE, 'success']]);
        expect(next.window.sessionStorage.getItem('wg-leave-picked-up')).toBeNull();
        expect(leaveOps()).toEqual(['leave.clear']);
        expect(await weights()).toEqual(FIXTURE_WEIGHTS);
    });

    // iOS flow QA (bd med-w6gx.23.8): the pickup's leave.clear lost to the 5 s
    // box on a slow bridge, so the reloaded page still found the stash and
    // asked Merge / Replace over the records it had just imported.
    it('the reload right after a pickup clears a stash still there instead of taking it again', async () => {
        await boot({ take: { vault: VAULT } });
        expect(await weights()).toEqual(FIXTURE_WEIGHTS);
        const next = await boot({ notice: true, take: { vault: VAULT } });
        expect(next.window.safeChoose).not.toHaveBeenCalled();
        expect(leaveOps()).toEqual(['leave.clear']);
        expect(await weights()).toEqual(FIXTURE_WEIGHTS);
    });

    // A first run on this iPhone writes only settings and onboarding records
    // (bd med-o7zq.37): nothing of the user's is at stake, so no confirm.
    it('stash + a store with only first-run settings: restores without a dialog', async () => {
        await boot();
        await env.window.apiCall('/api/settings/features/weight', 'POST', { enabled: false });
        await env.window.apiCall('/api/settings/integrations', 'PATCH', {});
        await env.window.apiCall('/api/firstrun/complete', 'POST', {});
        expect((await env.window.apiCall('/api/settings/features')).weight).toBe(false);
        cancelReminderRecompute({ accountId: 'local' });
        const { window } = await boot({ take: { vault: VAULT } });
        expect(window.safeConfirm).not.toHaveBeenCalled();
        expect(leaveOps()).toEqual(['leave.take', 'leave.clear']);
        expect(await weights()).toEqual(FIXTURE_WEIGHTS);
    });

    // bd med-o7zq.38: records here → Merge / Replace / Cancel.
    it('stash + records here: the choice; Replace, confirmed with typed REPLACE, replaces them', async () => {
        await seedWeight();
        const { window } = await boot({ take: { vault: VAULT } });
        expect(window.safeChoose).toHaveBeenCalledTimes(1);
        // The leave copy (bd med-o7zq.37/.38, D1 med-ckm5.5), not the backup-file one.
        expect(window.safeChoose.mock.calls[0][0]).toBe('This iPhone already has records from using it without an account. Your account is not changed either way.');
        expect(window.safeChoose.mock.calls[0][2]).toMatchObject({ title: 'Records already on this iPhone', confirmLabel: 'Continue', selected: 'merge' });
        expect(window.safeConfirm).toHaveBeenCalledTimes(1);
        expect(window.safeConfirm.mock.calls[0][2]).toMatchObject({
            title: 'Replace the records on this iPhone?', destructive: true, confirmLabel: 'Replace', typedConfirm: 'REPLACE',
        });
        expect(window.safeConfirm.mock.calls[0][2].facts[0]).toEqual({ text: 'The records on this iPhone now', gone: true });
        expect(leaveOps()).toEqual(['leave.take', 'leave.clear']);
        expect(await weights()).toEqual(FIXTURE_WEIGHTS);
    });

    it('stash + records here: Merge keeps them and adds the account\'s', async () => {
        await seedWeight();
        const { window } = await boot({ take: { vault: VAULT }, choice: 'merge' });
        expect(window.safeConfirm).not.toHaveBeenCalled();
        expect(leaveOps()).toEqual(['leave.take', 'leave.clear']);
        expect(await weights()).toEqual([...FIXTURE_WEIGHTS, 80].sort());
    });

    it.each([
        ['choice cancelled', { choice: null }],
        ['Replace declined', { confirm: false }],
    ])('stash + records here, %s: no dialog after it, records intact, back to the account (med-o7zq.42)', async (_, opts) => {
        await seedWeight();
        const { window, call } = await boot({ take: { vault: VAULT }, ...opts });
        expect(leaveOps()).toEqual(['leave.take', 'leave.clear']);
        expect(call).toHaveBeenCalledWith('leave.clear', { back: true });
        expect(await weights()).toEqual([80]);
        expect(window.safeAlert).not.toHaveBeenCalled();
        expect(window.sessionStorage.getItem('wg-leave-picked-up')).toBeNull();
    });

    it('a vault this bundle cannot read (version 2): records intact, stash cleared, alert', async () => {
        await seedWeight();
        const { window } = await boot({ take: { vault: JSON.stringify({ ...VAULT_FIXTURE, version: 2 }) } });
        expect(leaveOps()).toEqual(['leave.take', 'leave.clear']);
        expect(await weights()).toEqual([80]);
        expect(window.safeAlert.mock.calls.map(([m]) => m)).toContain(NOT_COPIED);
    });
});

// bd med-ta2n.15 — the Emergency Kit nudge, an account's Today card. The
// cloud router (no `protection` port) over the real store, the clock faked:
// GET /api/protection/kit-nudge is what the card reads.
describe('Kit nudge status (cloud router, real store, fake clock)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const T0 = Date.parse('2026-10-01T09:00:00Z');
    let router;
    const status = () => router('/api/protection/kit-nudge', 'GET');
    const close = (action) => router('/api/protection/kit-nudge', 'POST', { action });
    const at = (ms) => vi.setSystemTime(ms);
    let seq = 0;
    let listed = [];
    const addRecords = async (n) => {
        for (let i = 0; i < n; i += 1) {
            seq += 1;
            await localRecordsPort().put('weight', { recordId: `kit-${seq}`, clientTs: Date.now(), deleted: false, weight: 80 });
        }
    };
    // The real port, with the types each request read: the count must be lazy.
    const freshRouter = () => {
        const port = localRecordsPort();
        return createApiRouter(null, { records: { ...port, list: (t) => { listed.push(t); return port.list(t); } }, timeZone: 'UTC' });
    };

    beforeEach(async () => {
        await deleteDb();
        seq = 0;
        listed = [];
        vi.useFakeTimers({ toFake: ['Date'], now: T0 });
        router = freshRouter();
        // Sign-in without the kit offer files how 'none' (signup.js): sync is on.
        await router('/api/settings/emergency-kit', 'PUT', { savedAt: T0, how: 'none' });
    });
    afterEach(() => { vi.useRealTimers(); });

    it('first show: 2 days after sync is on AND 10 records, not before; no count before day 2', async () => {
        await addRecords(9);
        listed = [];
        expect(await status()).toMatchObject({ records: null, nudge: false });
        expect(listed).not.toContain('weight');
        at(T0 + 5 * DAY);
        expect(await status()).toMatchObject({ records: null, kitSaved: false, nudge: false });
        expect(listed).toContain('weight');
        await addRecords(1);
        at(T0 + 2 * DAY - 1);
        expect((await status()).nudge).toBe(false);
        at(T0 + 2 * DAY);
        expect(await status()).toMatchObject({ records: 10, nudge: true, lastShownAt: null, optedOut: false });
    });

    it('× snoozes; it returns once the count doubles, or after 30 days', async () => {
        await addRecords(12);
        at(T0 + 3 * DAY);
        expect((await status()).nudge).toBe(true);
        const shown = Date.now();
        expect(await close('later')).toEqual({ success: true });
        expect(await status()).toMatchObject({ nudge: false, lastShownAt: shown, lastShownRecordCount: 12 });
        await addRecords(11);
        expect((await status()).nudge).toBe(false);
        await addRecords(1); // 24 = 2 × 12
        expect((await status()).nudge).toBe(true);

        await close('later');
        const second = Date.now();
        at(second + 30 * DAY - 1);
        expect((await status()).nudge).toBe(false);
        at(second + 30 * DAY);
        expect((await status()).nudge).toBe(true);
    });

    it("Don't remind me again is permanent, whatever the growth, and reads no user type", async () => {
        await addRecords(10);
        at(T0 + 2 * DAY);
        listed = [];
        await close('never');
        expect(listed).not.toContain('weight');
        await addRecords(100);
        at(T0 + 400 * DAY);
        listed = [];
        expect(await status()).toMatchObject({ optedOut: true, nudge: false, records: null });
        expect(listed).not.toContain('weight');
        // A kit-only protection record stays out of the backup file.
        const vault = recordsToVault(await localRecordsPort().list('protection'), { now: Date.now() });
        expect(vault.data.protection).toBeUndefined();
    });

    it('kitNudge and the W4 fields survive each other\'s writes', async () => {
        const B = T0 - 3 * DAY;
        await localRecordsPort().put('protection', {
            recordId: 'protection', clientTs: T0, deleted: false, lastBackupAt: B, nudgeDismissedAt: [T0 - DAY],
        });
        await addRecords(10);
        at(T0 + 2 * DAY);
        await close('later');
        const rec = () => localRecordsPort().list('protection').then((l) => l[0]);
        expect(await rec()).toMatchObject({
            lastBackupAt: B, nudgeDismissedAt: [T0 - DAY], kitNudge: { lastShownAt: T0 + 2 * DAY, lastShownRecordCount: 10, optedOut: false },
        });
        // The W4 writers keep kitNudge.
        await router.domains.settings.dismissNudge();
        await router.domains.settings.markBackup();
        expect(await rec()).toMatchObject({
            lastBackupAt: T0 + 2 * DAY, nudgeDismissedAt: [T0 - DAY, T0 + 2 * DAY], kitNudge: { lastShownAt: T0 + 2 * DAY, lastShownRecordCount: 10 },
        });
        await close('never');
        expect(await rec()).toMatchObject({ lastBackupAt: T0 + 2 * DAY, nudgeDismissedAt: [T0 - DAY, T0 + 2 * DAY], kitNudge: { optedOut: true } });
    });

    it('never once the kit is saved, opted out or not; a saved kit reads no user type', async () => {
        await addRecords(10);
        at(T0 + 2 * DAY);
        expect((await status()).nudge).toBe(true);
        await router('/api/settings/emergency-kit', 'PUT', { savedAt: Date.now(), how: 'download' });
        listed = [];
        expect(await status()).toMatchObject({ kitSaved: true, nudge: false, records: null });
        expect(listed).not.toContain('weight');
        at(T0 + 400 * DAY);
        await addRecords(100);
        expect((await status()).nudge).toBe(false);
    });

    describe('no kit record (an account older than it): the firstrun baseline', () => {
        beforeEach(async () => {
            await deleteDb();
            router = freshRouter();
            await addRecords(10);
        });

        it('counts from the firstrun record\'s clientTs', async () => {
            await localRecordsPort().put('firstrun', { recordId: 'firstrun', clientTs: T0, deleted: false, first_run_complete: true });
            at(T0 + 2 * DAY - 1);
            expect((await status()).nudge).toBe(false);
            at(T0 + 2 * DAY);
            expect(await status()).toMatchObject({ records: 10, kitSaved: false, nudge: true });
        });

        it('clientTs 0 (a restored vault\'s floor) is no baseline: never shows', async () => {
            await localRecordsPort().putIfAbsent('firstrun', { recordId: 'firstrun', clientTs: 0, deleted: false, first_run_complete: true });
            expect((await localRecordsPort().list('firstrun'))[0].clientTs).toBe(0);
            at(T0 + 400 * DAY);
            expect(await status()).toMatchObject({ nudge: false, records: null });
        });

        it('no firstrun record either: never shows', async () => {
            at(T0 + 400 * DAY);
            expect((await status()).nudge).toBe(false);
        });
    });

    it('an unknown action is refused and writes nothing', async () => {
        await expect(close('snooze')).rejects.toThrow(/Unknown kit nudge action/);
        expect(await localRecordsPort().list('protection')).toEqual([]);
    });
});

// bd med-ta2n.20 — feedback in local mode: the cloud's launcher and outbox,
// sealed to the recipient from the attest challenge JSON and drained to the
// attested POST /api/attest/feedback (server: med-ta2n.19), every request sent
// by the shell (bridge op base.post, med-ta2n.24 §A/§B3) — never a page fetch.
// Only a Send asks our server anything; the key it enrolls is feedback-only
// (trial: false, med-ta2n.25).
describe('local-only mode feedback (med-ta2n.20)', () => {
    const TRIAL_BASE = 'trial-base.example.test';
    const AGE_VENDOR = fileURLToPath(new URL('../../vendor/age.min.js', import.meta.url));
    const FORWARDED = ['X-Attest-Challenge', 'X-Trial-Remaining', 'Retry-After'];
    let typage;
    let identity;
    let recipientKey;
    let env;
    let fetched; // what reached our base, through the shell
    let pageFetched; // window.fetch: must never see our base
    let bridge;
    let reply;

    beforeAll(async () => {
        const { pathToFileURL } = await import('node:url');
        const { setLoader } = await import('../../../cloud/js/feedback-submit.js');
        setLoader(() => import(pathToFileURL(AGE_VENDOR).href));
        typage = await import(pathToFileURL(AGE_VENDOR).href);
        identity = await typage.generateIdentity();
        recipientKey = await typage.identityToRecipient(identity);
    });

    // base.post → { status, headers, body }: the shell's reply shape (§A5).
    async function shellReply(res) {
        const headers = {};
        for (const name of FORWARDED) {
            const v = res.headers.get(name);
            if (v !== null) headers[name] = v;
        }
        return { status: res.status, headers, body: await res.text() };
    }

    async function boot(attest, { ops = ['base.post'] } = {}) {
        await deleteDb();
        fetched = [];
        pageFetched = [];
        reply = {
            challenge: () => new Response(JSON.stringify({ challenge: 'c1', expires_in: 300, feedback_recipient: recipientKey }), { status: 200 }),
            enroll: () => new Response(JSON.stringify({ remaining: 0, daily: 50, granted: false }), { status: 200, headers: { 'X-Attest-Challenge': 'c2' } }),
            feedback: () => new Response(null, { status: 204, headers: { 'X-Attest-Challenge': 'c3' } }),
        };
        const recorder = vi.fn(async (url, init = {}) => {
            pageFetched.push(String(url));
            return createMockResponse({ status: 503, json: {} });
        });
        vi.stubGlobal('fetch', recorder);
        env = loadFrontendEnv();
        env.window.fetch = recorder;
        // feedback-ui.js reads the page through the globals, as in the app.
        vi.stubGlobal('document', env.document);
        vi.stubGlobal('window', env.window);
        bridge = vi.fn(async (op, args) => {
            if (op === 'setEgressHosts') return { changed: false };
            if (op !== 'base.post') return null;
            fetched.push({ url: `https://${TRIAL_BASE}${args.path}`, headers: args.headers, body: args.body });
            // reply.erase unset = a shell from before /api/attest/delete (bd med-egb3): `invalid path`.
            const answer = { '/api/attest/challenge': reply.challenge, '/api/attest/enroll': reply.enroll, '/api/attest/feedback': reply.feedback, '/api/attest/delete': reply.erase }[args.path];
            if (!answer) throw new Error('invalid path');
            return shellReply(await answer()); // an answer that throws is the op's error string
        });
        const notifications = {
            isSupported: () => false,
            __native: { platform: 'ios', call: bridge, has: vi.fn(async (op) => ops.includes(op)) },
        };
        env.window.LocalNotifications = notifications;
        vi.stubGlobal('LocalNotifications', notifications);
        if (attest) env.window.Attest = attest;
        const run = new Function('window', '__imp', LOCAL_BOOT_SRC); // eslint-disable-line no-new-func
        run(env.window, (spec) => MODULES[spec]());
        await env.window.MedTrackerCloudReady;
        await egressSettled(bridge);
        toasts = [];
        if (!env.window.SyncManager) env.window.SyncManager = {};
        env.window.SyncManager.showToast = (message) => { toasts.push(message); };
    }
    let toasts;
    const SENT_TOAST = 'Thanks — feedback sent';
    const QUEUED_TOAST = 'Feedback saved on this phone. It will be sent when our server can be reached.';
    const outbox = async () => (await import('../../../cloud/js/feedback-submit.js')).getAllFeedbackItems();

    const freshInstall = () => ({
        isSupported: () => true,
        status: vi.fn(async () => ({ supported: true, base: TRIAL_BASE, attested: false })),
        enroll: vi.fn(async () => ({ keyId: 'key-1', attestation: 'QQ==', deviceToken: 'RA==' })),
        assert: vi.fn(async (challenge, digest) => ({ keyId: 'key-1', assertion: `sig:${challenge}:${digest}` })),
        setPass: vi.fn(async () => null),
    });

    afterEach(async () => {
        const { __resetDrainForTest } = await import('../../../cloud/js/feedback-submit.js');
        __resetDrainForTest();
        env.cleanup();
        vi.unstubAllGlobals();
    });

    const toBase = () => fetched;
    const paths = () => fetched.map(({ url }) => new URL(url).pathname);
    const pageHitBase = () => pageFetched.some((u) => /^https?:/.test(u) && new URL(u).hostname === TRIAL_BASE);

    async function compose(text) {
        const row = await vi.waitFor(() => {
            const el = env.document.getElementById('feedback-launcher');
            expect(el).not.toBeNull();
            return el;
        });
        expect(row.closest('[data-settings-slot="feedback"]')).not.toBeNull();
        row.click();
        const modal = env.document.getElementById('feedback-modal');
        const textarea = modal.querySelector('textarea');
        textarea.value = text;
        textarea.dispatchEvent(new env.window.Event('input'));
        return modal;
    }
    const send = (modal) => modal.querySelector('[data-feedback-choice="send"]').click();

    it('mounts the row with no request; Send enrolls feedback-only, seals to the challenge recipient and the shell POSTs it signed', async () => {
        const { createHash } = await import('node:crypto');
        await boot(freshInstall());
        await vi.waitFor(() => expect(env.document.getElementById('feedback-launcher')).not.toBeNull());
        expect(toBase()).toEqual([]);

        const modal = await compose('the scale page froze');
        expect(modal.querySelector('.wg-local-only').textContent).toBe('Sent encrypted to the developer through our server; the server can\'t read it. Your log stays on this phone.');
        expect(toBase()).toEqual([]);
        send(modal);

        const post = await vi.waitFor(() => {
            const p = fetched.find(({ url }) => url === `https://${TRIAL_BASE}/api/attest/feedback`);
            expect(p).toBeTruthy();
            return p;
        });
        // "sent" only once the server took it.
        await vi.waitFor(() => expect(env.document.getElementById('feedback-modal')).toBeNull());
        expect(toasts).toContain(SENT_TOAST);
        expect(paths()).toEqual(['/api/attest/challenge', '/api/attest/enroll', '/api/attest/feedback']);
        expect(env.window.Attest.enroll).toHaveBeenCalledTimes(1);
        // The enroll asks for no trial grant (it never spends the trial).
        const enroll = JSON.parse(fetched[1].body);
        expect(enroll).toMatchObject({ key_id: 'key-1', trial: false });
        // Signed over the exact body, with the challenge the enroll handed on;
        // the shell gets the three X-Attest-* headers and nothing else.
        const digest = createHash('sha256').update(`/api/attest/feedback\n${post.body}`).digest('base64');
        expect(post.headers).toEqual({
            'X-Attest-Key-Id': 'key-1', 'X-Attest-Challenge': 'c2', 'X-Attest-Assertion': `sig:c2:${digest}`,
        });
        const body = JSON.parse(post.body);
        expect(Object.keys(body).sort()).toEqual(['app_version', 'ciphertext', 'client_id', 'kind']);
        const d = new typage.Decrypter();
        d.addIdentity(identity);
        const plain = JSON.parse(new TextDecoder().decode(await d.decrypt(fromB64(body.ciphertext))));
        expect(plain).toMatchObject({ v: 1, text: 'the scale page froze', attachments: [] });
        // Never the cloud route, never a page fetch to our base; the outbox drains empty.
        expect(pageFetched.some((u) => u.endsWith('/api/feedback'))).toBe(false);
        expect(pageHitBase()).toBe(false);
        await vi.waitFor(async () => expect(await outbox()).toEqual([]));
        // The memo keeps the reply's granted: a feedback-only key.
        expect(JSON.parse(env.window.localStorage.getItem('wg:local-feedback'))).toMatchObject({ keyed: true, granted: false });
    });

    it('a 401 install_unknown on the POST re-enrolls once and re-signs', async () => {
        await boot(freshInstall());
        let first = true;
        reply.feedback = () => {
            if (first) {
                first = false;
                return new Response(JSON.stringify({ error: 'install_unknown' }), { status: 401 });
            }
            return new Response(null, { status: 204 });
        };
        send(await compose('again'));
        await vi.waitFor(() => expect(toasts).toContain(SENT_TOAST));
        expect(paths()).toEqual([
            '/api/attest/challenge', '/api/attest/enroll', '/api/attest/feedback',
            '/api/attest/challenge', '/api/attest/enroll', '/api/attest/feedback',
        ]);
        expect(JSON.parse(fetched[4].body)).toMatchObject({ trial: false });
    });

    // iOS (Attest.swift): an attested key can't be re-attested, so turning the
    // trial on after a feedback-only enroll mints a NEW key. Refused
    // trial_already_used, it has already replaced the feedback key: the next
    // Send meets install_unknown and must re-enroll feedback-only.
    it('iOS: trial on after feedback mints a new key; refused, the next Send re-enrolls {trial:false}', async () => {
        let n = 0;
        let current = '';
        const known = new Set();
        const attest = {
            ...freshInstall(),
            enroll: vi.fn(async () => { current = `key-${++n}`; return { keyId: current, attestation: 'QQ==', deviceToken: 'RA==' }; }),
            assert: vi.fn(async (challenge) => ({ keyId: current, assertion: `sig:${challenge}` })),
        };
        await boot(attest);
        reply.enroll = () => {
            const trialOff = JSON.parse(fetched.at(-1).body).trial === false;
            if (!trialOff) return new Response(JSON.stringify({ error: 'trial_already_used' }), { status: 403 });
            known.add(JSON.parse(fetched.at(-1).body).key_id);
            return new Response(JSON.stringify({ remaining: 0, daily: 50, granted: false }), { status: 200, headers: { 'X-Attest-Challenge': 'c2' } });
        };
        reply.feedback = () => (known.has(fetched.at(-1).headers['X-Attest-Key-Id'])
            ? new Response(null, { status: 204, headers: { 'X-Attest-Challenge': 'c3' } })
            : new Response(JSON.stringify({ error: 'install_unknown' }), { status: 401 }));
        const enrollBodies = () => fetched.filter(({ url }) => url.endsWith('/api/attest/enroll')).map(({ body }) => JSON.parse(body));

        send(await compose('one'));
        await vi.waitFor(() => expect(toasts).toContain(SENT_TOAST));
        expect(enrollBodies()).toEqual([expect.objectContaining({ key_id: 'key-1', trial: false })]);

        await env.window.apiCall('/api/settings/trial-consent', 'PATCH', { anon: true });
        await env.window.CloudVault.trial.apply();
        try {
            // The trial enroll: a new key, no trial:false, refused.
            await vi.waitFor(() => expect(enrollBodies()).toHaveLength(2));
            expect(enrollBodies()[1].key_id).toBe('key-2');
            expect(enrollBodies()[1]).not.toHaveProperty('trial');

            toasts = [];
            send(await compose('two'));
            await vi.waitFor(() => expect(toasts).toContain(SENT_TOAST));
            expect(enrollBodies()).toHaveLength(3);
            expect(enrollBodies()[2]).toMatchObject({ key_id: 'key-3', trial: false });
            const posts = fetched.filter(({ url }) => url.endsWith('/api/attest/feedback'));
            expect(posts.map(({ headers }) => headers['X-Attest-Key-Id'])).toEqual(['key-1', 'key-2', 'key-3']);
        } finally {
            await env.window.apiCall('/api/settings/trial-consent', 'PATCH', { anon: false });
            await env.window.CloudVault.trial.apply();
        }
    });

    it('an enroll the server refuses keeps the sheet and the text; nothing is queued or sent', async () => {
        await boot(freshInstall());
        reply.enroll = () => new Response(JSON.stringify({ error: 'trial_unavailable' }), { status: 503 });
        const modal = await compose('hello');
        send(modal);
        await vi.waitFor(() => expect(modal.querySelector('[data-feedback-error]').textContent)
            .toBe('Feedback is not available from device-only mode right now. Your message was not sent.'));
        expect(env.document.getElementById('feedback-modal')).toBe(modal);
        expect(modal.querySelector('textarea').value).toBe('hello');
        expect(modal.querySelector('[data-feedback-choice="send"]').disabled).toBe(false);
        expect(paths()).not.toContain('/api/attest/feedback');
        expect(await outbox()).toEqual([]);
    });

    it('a server with feedback off says so and enrolls nothing', async () => {
        await boot(freshInstall());
        reply.challenge = () => new Response(JSON.stringify({ challenge: 'c1', expires_in: 300, feedback_recipient: '' }), { status: 200 });
        const modal = await compose('hello');
        send(modal);
        await vi.waitFor(() => expect(modal.querySelector('[data-feedback-error]').textContent)
            .toBe('Feedback is not available from device-only mode right now. Your message was not sent.'));
        expect(env.window.Attest.enroll).not.toHaveBeenCalled();
        expect(paths()).toEqual(['/api/attest/challenge']);
    });

    for (const [what, answer] of [
        ['a 503', () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })],
        ['the op\'s "network" error', () => { throw new Error('network'); }],
    ]) {
        it(`${what} on the POST: the sheet closes saying "saved", never "sent"; the item stays queued`, async () => {
            await boot(freshInstall());
            reply.feedback = answer;
            const modal = await compose('later please');
            send(modal);
            await vi.waitFor(() => expect(env.document.getElementById('feedback-modal')).toBeNull());
            expect(toasts).toContain(QUEUED_TOAST);
            expect(toasts).not.toContain(SENT_TOAST);
            expect((await outbox()).length).toBe(1);
        });
    }

    for (const [what, answer] of [
        ['the server refuses for good', () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })],
        ['the shell refuses as too large', () => { throw new Error('body too large'); }],
    ]) it(`a POST ${what} keeps the sheet and the text and says it was not sent`, async () => {
        await boot(freshInstall());
        reply.feedback = answer;
        const modal = await compose('hello');
        send(modal);
        await vi.waitFor(() => expect(modal.querySelector('[data-feedback-error]').textContent)
            .toBe('Our server did not accept this feedback. Your message was not sent.'));
        expect(env.document.getElementById('feedback-modal')).toBe(modal);
        expect(modal.querySelector('textarea').value).toBe('hello');
        expect(toasts).not.toContain(SENT_TOAST);
        expect(toasts).not.toContain(QUEUED_TOAST);
        expect(await outbox()).toEqual([]);
    });

    it('a Close while the challenge is pending cancels the Send: nothing is sealed, queued or posted', async () => {
        await boot(freshInstall());
        let answer;
        reply.challenge = () => new Promise((resolve) => {
            answer = () => resolve(new Response(JSON.stringify({ challenge: 'c1', expires_in: 300, feedback_recipient: recipientKey }), { status: 200 }));
        });
        const modal = await compose('never mind');
        send(modal);
        await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
        modal.querySelector('[data-feedback-choice="cancel"]').click();
        expect(env.document.getElementById('feedback-modal')).toBeNull();
        answer();
        await vi.waitFor(() => expect(paths()).toContain('/api/attest/enroll'));
        await new Promise((r) => setTimeout(r, 50));
        expect(paths()).not.toContain('/api/attest/feedback');
        expect(await outbox()).toEqual([]);
        expect(toasts).not.toContain(SENT_TOAST);
        expect(toasts).not.toContain(QUEUED_TOAST);
    });

    it('a queued item refused later is told once, on the next sheet', async () => {
        await boot(freshInstall());
        reply.feedback = () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
        send(await compose('first'));
        await vi.waitFor(() => expect(toasts).toContain(QUEUED_TOAST));
        // The server refuses it for good now: the drain drops the item.
        reply.feedback = () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
        const { drainFeedbackOutbox } = await import('../../../cloud/js/feedback-submit.js');
        await drainFeedbackOutbox();
        expect(await outbox()).toEqual([]);
        const again = await compose('second');
        expect(again.querySelector('[data-feedback-error]').textContent)
            .toBe('Earlier feedback from this iPhone could not be delivered: our server did not accept it. Please send it again.');
        again.querySelector('[data-feedback-choice="cancel"]').click();
        expect((await compose('third')).querySelector('[data-feedback-error]').textContent).toBe('');
    });

    for (const [where, attest, ops] of [
        ['no window.Attest (the web, an old shell)', () => null, ['base.post']],
        ['App Attest unsupported (the Simulator)', () => ({ ...freshInstall(), status: vi.fn(async () => ({ supported: false, base: TRIAL_BASE, attested: false })) }), ['base.post']],
        ['a shell without base.post', freshInstall, []],
    ]) {
        it(`${where}: nothing mounts and nothing is asked`, async () => {
            await boot(attest(), { ops });
            await new Promise((r) => setTimeout(r, 20));
            expect(env.document.getElementById('feedback-launcher')).toBeNull();
            expect(toBase()).toEqual([]);
            expect(pageHitBase()).toBe(false);
        });
    }

    // bd med-egb3: Erase data on this device first asks our server, through
    // the shell, to delete this device's install record, signed by its key;
    // only a confirmed deletion lets the shell drop the key and pass.
    describe('erase deletes the install record', () => {
        const attestedInstall = () => ({ ...freshInstall(), status: vi.fn(async () => ({ supported: true, base: TRIAL_BASE, attested: true })) });
        let replace;
        const eraseWin = (confirm) => {
            replace = vi.fn();
            return {
                localStorage: env.window.localStorage,
                sessionStorage: env.window.sessionStorage,
                LocalNotifications: env.window.LocalNotifications,
                Attest: env.window.Attest,
                fetch: env.window.fetch,
                safeConfirm: vi.fn(async () => confirm),
                location: { replace },
            };
        };
        const resets = () => bridge.mock.calls.filter(([op]) => op === 'local.reset');
        // The boot's egress registration finishes before the test ends: it
        // reads window.document, which afterEach unstubs.
        async function bootSettled(attest) {
            await boot(attest);
        }

        it('204: signed over the empty body, then the erase and local.reset {dropAttest: true}', async () => {
            const { createHash } = await import('node:crypto');
            await bootSettled(attestedInstall());
            reply.erase = () => new Response(null, { status: 204, headers: { 'X-Attest-Challenge': 'c9' } });
            env.window.localStorage.setItem('wg.marker', '1');
            const win = eraseWin(true);
            expect(await env.window.CloudVault.eraseDevice({ win })).toEqual({ erased: true, installRecord: 'deleted' });
            expect(paths()).toEqual(['/api/attest/challenge', '/api/attest/delete']);
            const digest = createHash('sha256').update('/api/attest/delete\n').digest('base64');
            expect(fetched[1]).toMatchObject({ body: '', headers: { 'X-Attest-Key-Id': 'key-1', 'X-Attest-Challenge': 'c1', 'X-Attest-Assertion': `sig:c1:${digest}` } });
            expect(env.window.Attest.enroll).not.toHaveBeenCalled();
            expect(win.safeConfirm).not.toHaveBeenCalled();
            expect(env.window.localStorage.getItem('wg.marker')).toBeNull();
            expect(resets()).toEqual([['local.reset', { dropAttest: true }]]);
            expect(replace).toHaveBeenCalledWith('/');
            expect(pageHitBase()).toBe(false);
        });

        it('install_unknown erases silently but keeps the key and pass (local.reset without dropAttest); a stale challenge is re-signed once; never an enroll', async () => {
            await bootSettled(attestedInstall());
            const answers = [
                new Response(JSON.stringify({ error: 'challenge_invalid' }), { status: 400, headers: { 'X-Attest-Challenge': 'c5' } }),
                new Response(JSON.stringify({ error: 'install_unknown' }), { status: 401 }),
            ];
            reply.erase = () => answers.shift();
            // The pass may still name a live bucket (an iOS reinstall whose enroll failed): kept.
            const win = eraseWin(true);
            expect(await env.window.CloudVault.eraseDevice({ win })).toEqual({ erased: true, installRecord: 'unknown' });
            expect(paths()).toEqual(['/api/attest/challenge', '/api/attest/delete', '/api/attest/delete']);
            expect(fetched[2].headers['X-Attest-Challenge']).toBe('c5');
            expect(env.window.Attest.enroll).not.toHaveBeenCalled();
            expect(win.safeConfirm).not.toHaveBeenCalled();
            expect(resets()).toEqual([['local.reset']]);
            expect(replace).toHaveBeenCalledWith('/');
        });

        it('a failure (an old shell\'s invalid path) asks first: Cancel keeps everything, nothing retried', async () => {
            await bootSettled(attestedInstall()); // reply.erase unset: invalid path
            env.window.localStorage.setItem('wg.marker', '1');
            const win = eraseWin(false);
            expect(await env.window.CloudVault.eraseDevice({ win })).toEqual({ erased: false, installRecord: 'failed' });
            expect(win.safeConfirm).toHaveBeenCalledTimes(1);
            expect(win.safeConfirm.mock.calls[0][0]).toBe('The anonymous install record on the server could not be deleted (offline, or the app needs an update). Erase this device anyway?');
            expect(paths().filter((p) => p === '/api/attest/delete')).toHaveLength(1);
            expect(env.window.localStorage.getItem('wg.marker')).toBe('1');
            expect(resets()).toEqual([]);
            expect(replace).not.toHaveBeenCalled();
        });

        it('a failure (a server without the route) confirmed with Erase anyway erases, but keeps the shell\'s key and pass', async () => {
            await bootSettled(attestedInstall());
            // An older server's mux: a plain 404 proves nothing was deleted.
            reply.erase = () => new Response('404 page not found\n', { status: 404 });
            env.window.localStorage.setItem('wg.marker', '1');
            expect(await env.window.CloudVault.eraseDevice({ win: eraseWin(true) })).toEqual({ erased: true, installRecord: 'failed' });
            expect(env.window.localStorage.getItem('wg.marker')).toBeNull();
            expect(resets()).toEqual([['local.reset']]);
            expect(replace).toHaveBeenCalledWith('/');
        });

        it('no key in the shell: nothing to delete, no question, no enroll', async () => {
            const attest = attestedInstall();
            attest.assert = vi.fn(async () => { throw new Error('no_key'); });
            await bootSettled(attest);
            reply.erase = () => new Response(null, { status: 204 });
            const win = eraseWin(true);
            expect(await env.window.CloudVault.eraseDevice({ win })).toEqual({ erased: true, installRecord: 'none' });
            expect(paths()).not.toContain('/api/attest/delete');
            expect(attest.enroll).not.toHaveBeenCalled();
            expect(win.safeConfirm).not.toHaveBeenCalled();
            expect(resets()).toEqual([['local.reset']]);
        });

        it('a never-enrolled install (attested false) asks our server nothing', async () => {
            await bootSettled(freshInstall());
            reply.erase = () => new Response(null, { status: 204 });
            const win = eraseWin(true);
            expect(await env.window.CloudVault.eraseDevice({ win })).toEqual({ erased: true, installRecord: 'none' });
            expect(toBase()).toEqual([]);
            expect(win.safeConfirm).not.toHaveBeenCalled();
            expect(resets()).toEqual([['local.reset']]);
        });
    });
});

function fromB64(s) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
