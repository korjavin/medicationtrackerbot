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

// One occurrence-projection row as the timeline caches it (doses_timeline).
function occ(occId, medId, state, plannedAt, extra = {}) {
    return { occId, medId: String(medId), state, plannedAt, tz: 'UTC', localDate: plannedAt.slice(0, 10), localTime: plannedAt.slice(11, 16), source: 'schedule', ...extra };
}
const byOcc = (rows, id) => rows.find((r) => r.occId === id);

describe('features/meds.js + app.js — optimistic write conversion', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('confirmSelectedMedications flips the matched timeline rows to taken before the POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            doses_timeline: [
                occ(101, 1, 'due', '2026-05-17T08:00:00.000Z'),
                occ(102, 2, 'due', '2026-05-17T08:00:00.000Z'),
                occ(103, 3, 'due', '2026-05-17T08:00:00.000Z')
            ],
            next_intake: { scheduled_at: '2026-05-17T08:00:00.000Z', medication_names: ['Aspirin'] }
        });

        window.showMedicationConfirmModal([1, 2], ['Aspirin', 'Vitamin D'], '2026-05-17T08:00:00.000Z', 'confirm', [101, 102]);
        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/doses/act') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.confirmSelectedMedications();
        await postCalled;

        const rows = cache.get('doses_timeline');
        expect(rows).toHaveLength(3);
        expect(byOcc(rows, 101).state).toBe('taken');
        expect(byOcc(rows, 101).takenAt).toBeTruthy();
        expect(byOcc(rows, 102).state).toBe('taken');
        // Not on the sheet → untouched.
        expect(byOcc(rows, 103).state).toBe('due');
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
        checks[0].setAttribute('aria-pressed', 'true');   // confirm id=1 only
        checks[1].setAttribute('aria-pressed', 'false');

        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/doses/act') {
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
            doses_timeline: [occ(101, 1, 'due', '2026-05-17T08:00:00.000Z')]
        });

        window.showMedicationConfirmModal([1], ['Aspirin'], '2026-05-17T08:00:00.000Z', 'confirm', [101]);
        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.confirmSelectedMedications();

        const rows = cache.get('doses_timeline');
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe('due');
    });

    it('skipSelectedMedications flips the matched timeline rows to skipped before the POST resolves', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            doses_timeline: [occ(201, 5, 'due', '2026-05-17T09:00:00.000Z')]
        });

        window.showMedicationConfirmModal([5], ['Med E'], '2026-05-17T09:00:00.000Z', 'confirm', [201]);
        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/doses/act') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.skipSelectedMedications();
        await postCalled;

        expect(cache.get('doses_timeline')[0].state).toBe('skipped');

        pending.resolve({ status: 'ok' });
        await handlerDone;
    });

    it('skipSelectedMedications rolls back when the POST returns null', async () => {
        const { window } = env;
        const cache = installApiCache(window, {
            doses_timeline: [occ(201, 5, 'due', '2026-05-17T09:00:00.000Z')]
        });

        window.showMedicationConfirmModal([5], ['Med E'], '2026-05-17T09:00:00.000Z', 'confirm', [201]);
        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.skipSelectedMedications();

        expect(cache.get('doses_timeline')[0].state).toBe('due');
    });

    it('updateIntakeHistory flips the checked timeline rows to the picked state before the POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            doses_timeline: [
                occ(301, 7, 'taken', '2026-05-17T10:00:00.000Z', { takenAt: '2026-05-17T10:05:00.000Z' }),
                occ(302, 8, 'taken', '2026-05-17T10:00:00.000Z', { takenAt: '2026-05-17T10:05:00.000Z' })
            ]
        });

        window.showMedicationConfirmModal([7, 8], ['Med G', 'Med H'], '2026-05-17T10:05:00.000Z', 'edit', [301, 302], ['taken', 'taken']);
        const checks = document.querySelectorAll('.med-confirm-check');
        checks[0].setAttribute('aria-pressed', 'false');  // 301 left as it was
        document.querySelector('#med-confirm-state [data-dose-state="pending"]').click(); // 302 → Not taken

        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn();
        window.safeAlert = vi.fn();

        let postCalledSignal;
        const postCalled = new Promise((r) => { postCalledSignal = r; });
        const pending = deferred();
        window.apiCall = vi.fn(async (url, method) => {
            if (method === 'POST' && url === '/api/doses/act') {
                postCalledSignal();
                return pending.promise;
            }
            return null;
        });

        const handlerDone = window.updateIntakeHistory();
        await postCalled;

        const rows = cache.get('doses_timeline');
        expect(byOcc(rows, 301).state).toBe('taken');
        expect(byOcc(rows, 302).state).toBe('due');
        expect(byOcc(rows, 302).takenAt).toBe(null);
        expect(window.apiCall).toHaveBeenCalledWith('/api/doses/act', 'POST', { action: 'undo', occ_ids: [302] });

        pending.resolve({ ok: true });
        await handlerDone;
    });

    it('confirmLogPast adds a taken manual row to the cached timeline before POST resolves', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            doses_timeline: [occ(901, 99, 'taken', '2026-05-10T08:00:00.000Z', { takenAt: '2026-05-10T08:00:00.000Z' })]
        });

        window.showMedicationConfirmModal([77], ['Med X'], '2026-05-17T11:00:00.000Z', 'log_past', []);
        document.getElementById('med-confirm-datetime').value = '2026-05-17T11:00';

        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn(async () => ({ fresh: [] }));
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

        const rows = cache.get('doses_timeline');
        expect(rows).toHaveLength(2);
        const added = rows[1];
        expect(added).toMatchObject({ medId: '77', state: 'taken', source: 'manual' });
        expect(added.takenAt).toBe(new Date('2026-05-17T11:00').toISOString());
        expect(added.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(added.localTime).toMatch(/^\d{2}:\d{2}$/);

        pending.resolve({ id: 12345 });
        await handlerDone;
    });

    it('confirmLogPast rolls back the optimistic insert when the POST returns null', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            doses_timeline: [occ(901, 99, 'taken', '2026-05-10T08:00:00.000Z', { takenAt: '2026-05-10T08:00:00.000Z' })]
        });

        window.showMedicationConfirmModal([77], ['Med X'], '2026-05-17T11:00:00.000Z', 'log_past', []);
        document.getElementById('med-confirm-datetime').value = '2026-05-17T11:00';
        window.loadMeds = vi.fn();
        window.loadTimeline = vi.fn();
        window.safeAlert = vi.fn();
        window.apiCall = vi.fn(async () => null);

        await window.confirmLogPast();

        const rows = cache.get('doses_timeline');
        expect(rows).toHaveLength(1);
        expect(rows[0].occId).toBe(901);
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

        // Archive is undoable (med-xso6.5): flush() closes the Undo window now.
        const handlerDone = window.deleteMed(5).then((ctl) => ctl.flush());
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

        await window.deleteMed(5).then((ctl) => ctl.flush());

        const meds = cache.get('medications');
        if (meds) {
            expect(meds[0].archived).toBe(false);
        }
    });
});

describe('features/meds.js — row delete undoes from the toast (med-xso6.5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withSync: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('deleteMed (archive) moves the med at once; Undo restores it and sends no POST', async () => {
        const { window, document } = env;
        const cache = installApiCache(window, {
            medications: [
                { id: 5, name: 'Med', dosage: '5mg', schedule: '{"type":"as_needed"}', archived: false, supplement: false }
            ]
        });
        window.medications = [...cache.get('medications')];
        window.safeConfirm = vi.fn();
        window.loadMeds = vi.fn();
        window.apiCall = vi.fn(async (_url, method) => (method === 'POST' ? { ok: true } : null));

        const ctl = await window.deleteMed(5);
        await vi.waitFor(() => expect(cache.get('medications')[0].archived).toBe(true));
        expect(document.querySelector('.wg-toasts .wg-toast__text').textContent).toBe('Med archived');
        document.querySelector('.wg-toasts .wg-toast__undo').click();

        expect(await ctl.done).toBe('undone');
        expect(cache.get('medications')[0].archived).toBe(false);
        expect(window.apiCall.mock.calls.filter(([, m]) => m === 'POST')).toHaveLength(0);
        expect(window.safeConfirm).not.toHaveBeenCalled();
    });
});
