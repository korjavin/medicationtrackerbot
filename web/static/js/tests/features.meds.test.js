// Plan 2026-05-17 Task 6 — Optimistic write conversion for medication intake +
// CRUD handlers in app.js + features/meds.js. Confirm/skip/edit/log-past and
// add/edit/archive/delete must update the relevant cached payloads BEFORE the
// network round-trip resolves, then roll back on failure.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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
        MedicationStore: {
            getAll: async () => [],
            saveCache: async () => undefined
        },
        IntakeHistoryStore: {
            saveCache: async () => undefined
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

describe('features/meds.js + app.js — optimistic write conversion', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('confirmSelectedMedications flips the matched intake_log to TAKEN in cached history before the POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 101, medication_id: 1, status: 'PENDING', scheduled_at: '2026-05-17T08:00:00.000Z' },
                { id: 102, medication_id: 2, status: 'PENDING', scheduled_at: '2026-05-17T08:00:00.000Z' }
            ],
            next_intake: { scheduled_at: '2026-05-17T08:00:00.000Z', medication_names: ['Aspirin'] }
        });

        window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Vitamin D'], '2026-05-17T08:00:00.000Z', 'confirm', [101, 102]);
        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/medications/confirm-schedule') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.confirmSelectedMedications();
        await postCalled;

        const history = cache.get('history_3_0');
        expect(history).toBeTruthy();
        expect(history.length).toBe(2);
        expect(history[0].status).toBe('TAKEN');
        expect(history[0]._optimistic).toBe(true);
        expect(history[1].status).toBe('TAKEN');
        // next_intake cleared because scheduled_at matches the confirm
        const next = cache.get('next_intake');
        expect(next.scheduled_at).toBe(null);

        pending.resolve({ status: 'ok' });
        await handlerDone;
    });

    it('confirmSelectedMedications removes only the confirmed medication from next_intake when two meds share a name', async () => {
        // Regression: the next_intake mutator must filter by medication_id, not
        // name. Same-name + different-dosage meds (e.g. "Aspirin 100mg" and
        // "Aspirin 500mg") both appear as "Aspirin" in medication_names.
        // Filtering by name would over-evict both even when only one is confirmed.
        const { window, document } = env;
        const cache = installApiCache(window, {
            next_intake: {
                scheduled_at: '2026-05-17T08:00:00.000Z',
                medication_ids: [1, 2],
                medication_names: ['Aspirin', 'Aspirin']
            }
        });

        window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Aspirin'], '2026-05-17T08:00:00.000Z', 'confirm', [101, 102]);
        const checks = document.querySelectorAll('.med-confirm-check');
        checks[0].checked = true;   // confirm id=1 only
        checks[1].checked = false;

        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/medications/confirm-schedule') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.confirmSelectedMedications();
        await postCalled;

        const next = cache.get('next_intake');
        expect(next.scheduled_at).toBe('2026-05-17T08:00:00.000Z');
        expect(next.medication_ids).toEqual([2]);
        expect(next.medication_names).toEqual(['Aspirin']);

        pending.resolve({ status: 'ok' });
        await handlerDone;
    });

    it('confirmSelectedMedications rolls back the optimistic flip when the POST returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 101, medication_id: 1, status: 'PENDING', scheduled_at: '2026-05-17T08:00:00.000Z' }
            ]
        });

        window.showMedicationConfirmModal([1], ['Aspirin'], '2026-05-17T08:00:00.000Z', 'confirm', [101]);
        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.confirmSelectedMedications();

        const history = cache.get('history_3_0');
        if (history) {
            expect(history.length).toBe(1);
            expect(history[0].status).toBe('PENDING');
        }
    });

    it('skipSelectedMedications flips matched intake_log entries to SKIPPED before the POST resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 201, medication_id: 5, status: 'PENDING', scheduled_at: '2026-05-17T09:00:00.000Z' }
            ]
        });

        window.showMedicationConfirmModal([5], ['Med E'], '2026-05-17T09:00:00.000Z', 'confirm', [201]);
        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/medications/skip') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.skipSelectedMedications();
        await postCalled;

        const history = cache.get('history_3_0');
        expect(history[0].status).toBe('SKIPPED');
        expect(history[0]._optimistic).toBe(true);

        pending.resolve({ status: 'ok' });
        await handlerDone;
    });

    it('skipSelectedMedications rolls back when the POST returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 201, medication_id: 5, status: 'PENDING', scheduled_at: '2026-05-17T09:00:00.000Z' }
            ]
        });

        window.showMedicationConfirmModal([5], ['Med E'], '2026-05-17T09:00:00.000Z', 'confirm', [201]);
        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.skipSelectedMedications();

        const history = cache.get('history_3_0');
        if (history) {
            expect(history[0].status).toBe('PENDING');
        }
    });

    it('updateIntakeHistory flips matched logs to TAKEN/PENDING in cached history before POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 301, medication_id: 7, status: 'PENDING', scheduled_at: '2026-05-17T10:00:00.000Z' },
                { id: 302, medication_id: 8, status: 'TAKEN', scheduled_at: '2026-05-17T10:00:00.000Z', taken_at: '2026-05-17T10:05:00.000Z' }
            ]
        });

        window.showMedicationConfirmModal([7, 8], ['Med G', 'Med H'], '2026-05-17T10:00:00.000Z', 'edit', [301, 302]);
        document.getElementById('med-confirm-datetime').value = '2026-05-17T10:30';
        const checks = document.querySelectorAll('.med-confirm-check');
        checks[0].checked = true;   // 301 → TAKEN
        checks[1].checked = false;  // 302 → PENDING (revert)

        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/intakes/update') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.updateIntakeHistory();
        await postCalled;

        const history = cache.get('history_3_0');
        const row301 = history.find((l) => l.id === 301);
        const row302 = history.find((l) => l.id === 302);
        expect(row301.status).toBe('TAKEN');
        expect(row302.status).toBe('PENDING');
        expect(row302.taken_at).toBe(null);

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('confirmLogPast prepends a TAKEN log into matching cached history payloads before POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 901, medication_id: 99, status: 'TAKEN', scheduled_at: '2026-05-10T08:00:00.000Z' }
            ],
            'history_3_77': [],
            'history_3_42': []
        });

        window.showMedicationConfirmModal([77], ['Med X'], '2026-05-17T11:00:00.000Z', 'log_past', []);
        document.getElementById('med-confirm-datetime').value = '2026-05-17T11:00';

        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn(async () => ({ fresh: [] }));
        window.safeAlert = vi.fn();
        window.renderInventory = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/medications/log-past') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.confirmLogPast();
        await postCalled;

        // history_3_0 is "all meds" — should include the optimistic log.
        const all = cache.get('history_3_0');
        expect(all.length).toBe(2);
        expect(all[0].status).toBe('TAKEN');
        expect(all[0].medication_id).toBe(77);
        expect(all[0]._optimistic).toBe(true);

        // history_3_77 is for med 77 — should include the optimistic log.
        const own = cache.get('history_3_77');
        expect(own.length).toBe(1);
        expect(own[0].medication_id).toBe(77);

        // history_3_42 is for med 42 — should NOT include the optimistic log.
        const other = cache.get('history_3_42');
        expect(other.length).toBe(0);

        pending.resolve({ id: 12345 });
        await handlerDone;
    });

    it('confirmLogPast rolls back the optimistic insert when the POST returns null', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 901, medication_id: 99, status: 'TAKEN', scheduled_at: '2026-05-10T08:00:00.000Z' }
            ]
        });

        window.showMedicationConfirmModal([77], ['Med X'], '2026-05-17T11:00:00.000Z', 'log_past', []);
        document.getElementById('med-confirm-datetime').value = '2026-05-17T11:00';
        window.loadMeds = vi.fn();
        window.loadHistory = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.confirmLogPast();

        const all = cache.get('history_3_0');
        if (all) {
            expect(all.length).toBe(1);
            expect(all[0].id).toBe(901);
        }
    });

    it('deleteFutureIntakes drops the target rows from cached history before the POST resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 11, medication_id: 1, status: 'PENDING', scheduled_at: '2026-05-18T08:00:00.000Z' },
                { id: 12, medication_id: 1, status: 'PENDING', scheduled_at: '2026-05-19T08:00:00.000Z' },
                { id: 13, medication_id: 1, status: 'TAKEN', scheduled_at: '2026-05-17T08:00:00.000Z' }
            ]
        });

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.refreshMedsAfterMutation = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/medications/delete-intake') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.deleteFutureIntakes([11, 12]);
        await postCalled;

        const history = cache.get('history_3_0');
        expect(history.length).toBe(1);
        expect(history[0].id).toBe(13);

        pending.resolve({ deleted_count: 2 });
        await handlerDone;
    });

    it('deleteFutureIntakes rolls back when the POST returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            'history_3_0': [
                { id: 11, medication_id: 1, status: 'PENDING', scheduled_at: '2026-05-18T08:00:00.000Z' },
                { id: 12, medication_id: 1, status: 'PENDING', scheduled_at: '2026-05-19T08:00:00.000Z' }
            ]
        });

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.refreshMedsAfterMutation = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.deleteFutureIntakes([11]);

        const history = cache.get('history_3_0');
        if (history) {
            expect(history.length).toBe(2);
            expect(history.map((l) => l.id).sort()).toEqual([11, 12]);
        }
    });

    it('saveMedication (create) appends an optimistic row into cached medications before POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            medications: [
                { id: 1, name: 'Aspirin', dosage: '100mg', schedule: '{"type":"daily","times":["08:00"]}' }
            ]
        });
        window.medications = [...cache.get('medications')];
        window.editingMedId = null;

        window.ModalManager.med.open();
        document.getElementById('med-name').value = 'Vitamin D';
        document.getElementById('med-dosage').value = '1000IU';
        document.getElementById('schedule-type').value = 'as_needed';
        document.getElementById('med-archived').checked = false;
        document.getElementById('med-supplement').checked = true;

        window.loadMeds = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCallDirect = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/medications') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.saveMedication();
        await postCalled;

        const meds = cache.get('medications');
        expect(meds.length).toBe(2);
        const created = meds[meds.length - 1];
        expect(created.name).toBe('Vitamin D');
        expect(created.dosage).toBe('1000IU');
        expect(created._optimistic).toBe(true);

        pending.resolve({ id: 999 });
        await handlerDone;
    });

    it('saveMedication (edit) updates the matching row in cached medications before POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            medications: [
                { id: 7, name: 'Aspirin', dosage: '100mg', schedule: '{"type":"daily","times":["08:00"]}', archived: false, supplement: false }
            ]
        });
        window.medications = [...cache.get('medications')];
        window.editingMedId = 7;

        window.ModalManager.med.open();
        document.getElementById('med-name').value = 'Aspirin';
        document.getElementById('med-dosage').value = '200mg';
        document.getElementById('schedule-type').value = 'as_needed';
        document.getElementById('med-archived').checked = false;
        document.getElementById('med-supplement').checked = false;

        window.loadMeds = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCallDirect = vi.fn(async (url, method) => {
            if (method === 'POST' && url.startsWith('/api/medications/')) {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.saveMedication();
        await postCalled;

        const meds = cache.get('medications');
        expect(meds.length).toBe(1);
        expect(meds[0].id).toBe(7);
        expect(meds[0].dosage).toBe('200mg');
        expect(meds[0]._optimistic).toBe(true);

        pending.resolve({ id: 7 });
        await handlerDone;
    });

    it('saveMedication rolls back when POST returns null', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            medications: [
                { id: 1, name: 'Aspirin', dosage: '100mg', schedule: '{"type":"daily","times":["08:00"]}' }
            ]
        });
        window.medications = [...cache.get('medications')];
        window.editingMedId = null;

        window.ModalManager.med.open();
        document.getElementById('med-name').value = 'Vitamin D';
        document.getElementById('med-dosage').value = '1000IU';
        document.getElementById('schedule-type').value = 'as_needed';
        document.getElementById('med-archived').checked = false;
        document.getElementById('med-supplement').checked = false;

        window.loadMeds = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCallDirect = vi.fn(async () => null);

        await window.saveMedication();

        const meds = cache.get('medications');
        if (meds) {
            expect(meds.length).toBe(1);
            expect(meds[0].name).toBe('Aspirin');
        }
    });

    it('deleteMed (archive) flips archived=true in cached medications before POST resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            medications: [
                { id: 5, name: 'Med', dosage: '5mg', schedule: '{"type":"as_needed"}', archived: false, supplement: false }
            ]
        });
        window.medications = [...cache.get('medications')];

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.loadMeds = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/medications/5') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.deleteMed(5);
        await postCalled;

        const meds = cache.get('medications');
        expect(meds[0].archived).toBe(true);
        expect(meds[0]._optimistic).toBe(true);

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('deleteMed (archived → delete permanently) removes the row from cached medications before DELETE resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            medications: [
                { id: 5, name: 'Med', dosage: '5mg', schedule: '{"type":"as_needed"}', archived: true, supplement: false },
                { id: 6, name: 'Other', dosage: '6mg', schedule: '{"type":"as_needed"}', archived: false, supplement: false }
            ]
        });
        window.medications = [...cache.get('medications')];

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.loadMeds = vi.fn();
        window.safeAlert = vi.fn();

        let deleteCalledSignal;
        const deleteCalled = new Promise((r) => { deleteCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'DELETE' && url === '/api/medications/5') {
                deleteCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.deleteMed(5);
        await deleteCalled;

        const meds = cache.get('medications');
        expect(meds.length).toBe(1);
        expect(meds[0].id).toBe(6);

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('deleteMed (archive) rolls back when POST returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            medications: [
                { id: 5, name: 'Med', dosage: '5mg', schedule: '{"type":"as_needed"}', archived: false, supplement: false }
            ]
        });
        window.medications = [...cache.get('medications')];

        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        window.loadMeds = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.deleteMed(5);

        const meds = cache.get('medications');
        if (meds) {
            expect(meds[0].archived).toBe(false);
        }
    });
});
