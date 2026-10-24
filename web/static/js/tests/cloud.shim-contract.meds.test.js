// Plan 2026-07-05 cloud-c2b, Task 8 — shim-mode contract run of the meds CRUD
// flows against web/domain/medications.js. Drives the real feature code
// (saveMedication / deleteMed) through window.offlineAwareApiCall / apiCall,
// which route to the cloud shim (web/cloud/js/apishim.js) instead of the
// network — same pattern as cloud.shim-contract.bp.test.js. Divergences here
// are contract bugs in the JS domain layer, not test bugs; the original
// (network-mocked) features.meds.test.js keeps running unshimmed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
import { loadCloudShimFrontendEnv, createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';
import { createApiRouter, materializationSettled } from '../../../cloud/js/apishim.js';
import { createIntakeDomain } from '../../../domain/medintake.js';
import { createMedicationsDomain } from '../../../domain/medications.js';
import { sortByEffective } from '../../../domain/medschedule.js';
import { computeReminderHorizon } from '../../../domain/reminders.js';

// Fake rxnorm port (Task 8: "warning alert (fake rxnorm port)") — the real
// browser impl does live RxNav fetches (Task 6); tests substitute a
// deterministic port instead of hitting the network.
vi.mock('../../../cloud/js/rxnorm.js', () => ({
    createRxnormPort: () => ({
        async searchRxNorm(name) {
            return name === 'WarnDrug'
                ? { rxcui: 'rx-warn', normalizedName: name }
                : { rxcui: '', normalizedName: '' };
        },
        async checkInteractions(rxcuis) {
            return rxcuis.length > 1 ? ['Interaction between A and B: severe'] : [];
        }
    })
}));

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
            getCache: async () => null,
            saveCache: async () => undefined
        },
        IntakeHistoryStore: {
            saveCache: async () => undefined
        }
    };
    return map;
}

function fillMedForm(window, document, {
    name, dosage, type = 'as_needed', archived = false, supplement = false,
    times = [], trackInventory = false, inventoryCount = ''
}) {
    window.ModalManager.med.open();
    document.getElementById('med-name').value = name;
    document.getElementById('med-dosage').value = dosage;
    document.getElementById('schedule-type').value = type;
    document.getElementById('med-archived').checked = archived;
    document.getElementById('med-supplement').checked = supplement;
    if (type !== 'as_needed') {
        const inputs = document.querySelectorAll('.med-time-input');
        times.forEach((t, i) => { if (inputs[i]) inputs[i].value = t; });
    }
    document.getElementById('med-track-inventory').checked = trackInventory;
    document.getElementById('med-inventory-count').value = trackInventory ? String(inventoryCount) : '';
}

describe('cloud shim contract — meds CRUD flows (features/meds.js over web/domain/medications.js)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.loadMeds = vi.fn();
        env.window.safeAlert = vi.fn();
        env.window.editingMedId = null;
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('saveMedication (create) round-trips through the shim into the medications list', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Aspirin', dosage: '100mg' });

        await window.saveMedication();

        const list = await window.apiCall('/api/medications');
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            name: 'Aspirin', dosage: '100mg', archived: false, supplement: false
        });
    });

    it('saveMedication (create) with track-inventory persists the initial stock (med-eas.13)', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Aspirin', dosage: '100mg', trackInventory: true, inventoryCount: 42 });

        await window.saveMedication();

        const list = await window.apiCall('/api/medications');
        expect(list).toHaveLength(1);
        expect(list[0].inventory_count).toBe(42);
    });

    it('saveMedication (edit) updates the matching record', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Aspirin', dosage: '100mg' });
        await window.saveMedication();
        const [created] = await window.apiCall('/api/medications');

        window.editingMedId = created.id;
        fillMedForm(window, document, { name: 'Aspirin', dosage: '200mg' });
        await window.saveMedication();

        const list = await window.apiCall('/api/medications');
        expect(list).toHaveLength(1);
        expect(list[0].dosage).toBe('200mg');
    });

    it('saveMedication (create) rejects a name+dosage duplicate with a 409 and shows the friendly alert', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Aspirin', dosage: '100mg' });
        await window.saveMedication();

        fillMedForm(window, document, { name: 'Aspirin', dosage: '100mg' });
        await window.saveMedication();

        expect(window.safeAlert).toHaveBeenCalledWith(
            expect.stringContaining('already exists')
        );
        const list = await window.apiCall('/api/medications');
        expect(list).toHaveLength(1);
    });

    it('surfaces an interaction warning from the injected rxnorm port on the second interacting medication', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'WarnDrug', dosage: '1mg' });
        await window.saveMedication();
        window.safeAlert.mockClear();

        fillMedForm(window, document, { name: 'WarnDrug', dosage: '2mg' });
        await window.saveMedication();

        expect(window.safeAlert).toHaveBeenCalledWith(
            expect.stringContaining('Interaction between A and B')
        );
    });

    it('editor shows the interaction inline once the Rx match resolves (GET /api/medications/rx-check), and Save does not alert it again', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'WarnDrug', dosage: '1mg' });
        await window.saveMedication();
        window.safeAlert.mockClear();

        window.showAddModal();
        const name = document.getElementById('med-name');
        name.value = 'WarnDrug';
        name.dispatchEvent(new window.Event('change'));
        await vi.waitFor(() => {
            expect(document.getElementById('med-rx-warning').classList.contains('hidden')).toBe(false);
        });
        expect(document.getElementById('med-rx-warning-text').textContent).toContain('Interaction between A and B');
        expect(document.getElementById('med-rx-name').textContent).toBe('Rx · WarnDrug');

        document.getElementById('med-dosage').value = '2mg';
        document.getElementById('schedule-type').value = 'as_needed';
        await window.saveMedication();
        expect(window.safeAlert).not.toHaveBeenCalled();
        expect(await window.apiCall('/api/medications')).toHaveLength(2);
    });

    it('rx-check answers no match (and no warning) for an unknown drug', async () => {
        const { window } = env;
        const res = await window.offlineAwareApiCall('/api/medications/rx-check?name=Plain', 'GET');
        expect(res).toEqual({ rxcui: '', normalized_name: '', warning: '' });
    });

    it('deleteMed archives a medication, then permanently deletes it once archived', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Ibuprofen', dosage: '200mg' });
        await window.saveMedication();
        const [created] = await window.apiCall('/api/medications');

        window.medications = [created];
        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });

        // Archive is the undoable row action: flush() closes the Undo window.
        await (await window.deleteMed(created.id)).flush();
        let list = await window.apiCall('/api/medications?archived=true');
        expect(list).toHaveLength(1);
        expect(list[0].archived).toBe(true);

        window.medications = list;
        await window.deleteMed(created.id);
        list = await window.apiCall('/api/medications?archived=true');
        expect(list).toHaveLength(0);
    });

    it('restock starts tracking inventory (COALESCE-to-0) and is reflected in listRestocks + the medications list', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Metformin', dosage: '500mg' });
        await window.saveMedication();
        const [created] = await window.apiCall('/api/medications');
        expect(created.inventory_count).toBeUndefined();

        const res = await window.apiCall(`/api/medications/${created.id}/restock`, 'POST', { quantity: 20, note: 'refill' });
        expect(res).toEqual({ status: 'restocked', quantity_added: 20, inventory_count: 20 });

        const res2 = await window.apiCall(`/api/medications/${created.id}/restock`, 'POST', { quantity: 10 });
        expect(res2).toEqual({ status: 'restocked', quantity_added: 10, inventory_count: 30 });

        const restocks = await window.apiCall(`/api/medications/${created.id}/restocks`);
        expect(restocks).toHaveLength(2);
        expect(restocks.map((r) => r.quantity).sort()).toEqual([10, 20]);
        expect(restocks[0].medication_id).toBe(created.id);

        const list = await window.apiCall('/api/medications');
        expect(list[0].inventory_count).toBe(30);
    });

    it('low-stock list flags a medication whose days-of-stock falls under the default threshold', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Warfarin', dosage: '5mg', type: 'daily', times: ['08:00'] });
        await window.saveMedication();
        const [created] = await window.apiCall('/api/medications');
        await window.apiCall(`/api/medications/${created.id}/restock`, 'POST', { quantity: 1 });

        const low = await window.apiCall('/api/inventory/low');
        expect(low).toHaveLength(1);
        expect(low[0].name).toBe('Warfarin');
        expect(low[0].days_remaining).toBeDefined();
        expect(low[0].days_remaining).toBeLessThan(7);
    });
});

// bd med-gut.1 / med-gut.2 — GET /api/medications/upcoming. Drives the REAL
// router (the single entry point the cloud UI and mcp-responder share) with an
// explicit `timeZone` that is NOT the device zone, which is the whole point:
// the Schedule tab used to bucket doses in the browser's own timezone and so
// disagreed with Home's next-intake card. `now` is pinned so the assertions
// are wall-clock independent.
describe('cloud shim contract — plan-aware upcoming doses (web/domain/medintake.js upcomingDoses)', () => {
    const TZ = 'Asia/Tokyo'; // UTC+9, no DST
    // 2026-08-16T00:00Z === 09:00 on 2026-08-16 in Tokyo.
    const NOW = Date.UTC(2026, 7, 16, 0, 0);
    const HOUR = 3600_000;

    function seedMed(overrides = {}) {
        return {
            recordId: 1,
            clientTs: NOW,
            deleted: false,
            name: 'Metformin',
            dosage: '500mg',
            schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }),
            archived: false,
            start_date: null,
            end_date: null,
            inventory_count: null,
            tz_shift_policy: 'strict',
            created_at: '2026-01-01T00:00:00.000Z',
            ...overrides
        };
    }

    function routerWith(seedRecords) {
        const records = createInMemoryRecordsPort(seedRecords);
        return createApiRouter({}, {
            records, win: {}, now: () => NOW, timeZone: TZ
        });
    }

    it('forecasts a full week in the tracked timezone, not the device one', async () => {
        const call = routerWith({ medication: [seedMed()] });

        const doses = await call('/api/medications/upcoming?days=7', 'GET');

        // 08:00 Tokyo has already passed today (it is 09:00 there), so the
        // week runs Aug 17..Aug 23 — seven doses, one per day.
        expect(doses.map((d) => d.local_date)).toEqual([
            '2026-08-17', '2026-08-18', '2026-08-19',
            '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'
        ]);
        expect(doses.every((d) => d.local_time === '08:00')).toBe(true);
        expect(doses.map((d) => d.day_offset)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        // 08:00 Tokyo on Aug 17 is 23:00Z on Aug 16 — proof the instant was
        // computed in Tokyo rather than in whatever zone the runner is in.
        expect(doses[0].scheduled_at).toBe('2026-08-16T23:00:00.000Z');
        expect(doses[0]).toMatchObject({
            medication_id: 1, med_name: 'Metformin', dosage: '500mg', source: 'schedule'
        });
        expect(doses[0].step_number).toBeUndefined();
    });

    it('reads a legacy "HH:MM" schedule string as a daily one-dose schedule', async () => {
        const call = routerWith({ medication: [seedMed({ schedule: '20:00' })] });

        const doses = await call('/api/medications/upcoming?days=2', 'GET');

        expect(doses).toHaveLength(2);
        expect(doses[0].local_date).toBe('2026-08-16');
        expect(doses[0].local_time).toBe('20:00');
    });

    it('surfaces an approved plan\'s steps with their number and note, then resumes the normal schedule', async () => {
        const steps = [
            {
                medicationId: 1,
                medName: 'Metformin',
                stepNumber: 1,
                totalSteps: 2,
                scheduledAtMs: NOW + 3 * HOUR,
                note: 'Metformin (strict — gradual shift): step 1/2 — 14:00 JST old / 12:00 GMT new'
            },
            {
                medicationId: 1,
                medName: 'Metformin',
                stepNumber: 2,
                totalSteps: 2,
                // 12:00 Tokyo on Aug 17 — after that day's normal 08:00 slot,
                // so the transition is still running when it would land.
                scheduledAtMs: NOW + 27 * HOUR,
                note: 'Metformin (strict — gradual shift): step 2/2 — 14:00 JST old / 12:00 GMT new'
            }
        ];
        const call = routerWith({
            medication: [seedMed()],
            tzplan: [{
                recordId: 'tzplan-current',
                clientTs: NOW,
                deleted: false,
                old_tz: 'Asia/Tokyo',
                new_tz: 'Europe/London',
                status: 'APPROVED',
                created_at: '2026-08-15T00:00:00.000Z',
                steps
            }]
        });

        const doses = await call('/api/medications/upcoming?days=7', 'GET');

        const stepRows = doses.filter((d) => d.source === 'tz_step');
        expect(stepRows).toHaveLength(2);
        expect(stepRows[0]).toMatchObject({
            step_number: 1, total_steps: 2, note: steps[0].note, local_time: '12:00'
        });
        expect(stepRows[1]).toMatchObject({
            step_number: 2, total_steps: 2, note: steps[1].note, local_date: '2026-08-17'
        });

        // The Aug-17 08:00 dose lands mid-transition (the last step is at
        // 12:00 that day), so the steps replace it...
        const dates = doses.filter((d) => d.source === 'schedule').map((d) => d.local_date);
        expect(dates).not.toContain('2026-08-17');
        // ...and the normal schedule resumes on its own from the day after the
        // last step, instead of staying suppressed for the whole horizon.
        expect(dates).toEqual([
            '2026-08-18', '2026-08-19', '2026-08-20',
            '2026-08-21', '2026-08-22', '2026-08-23'
        ]);
    });

    it('drops a slot that has already been taken or skipped', async () => {
        const call = routerWith({
            medication: [seedMed()],
            intake: [{
                // The real deterministic slot id: the projection matches a
                // stored row to its forecast slot by exact id (bd med-wi09.1).
                recordId: `intake-1-${Date.UTC(2026, 7, 16, 23, 0) / 1000}`,
                clientTs: NOW,
                deleted: false,
                medication_id: 1,
                // 08:00 Tokyo on Aug 17.
                scheduled_at: '2026-08-16T23:00:00.000Z',
                taken_at: '2026-08-16T23:05:00.000Z',
                status: 'TAKEN',
                snoozed_until: null,
                source: 'schedule'
            }]
        });

        const doses = await call('/api/medications/upcoming?days=3', 'GET');

        expect(doses.map((d) => d.local_date)).toEqual(['2026-08-18', '2026-08-19']);
    });

    // planDoses' medication-level start gate used to be `start_date > now`,
    // which in a day-by-day forecast walk skipped the med for exactly the
    // window containing its first dose — the next window then began after that
    // dose, so a course starting tomorrow silently lost its first day.
    it('includes a course that starts inside the forecast window, from its start onward', async () => {
        const call = routerWith({
            medication: [seedMed({
                name: 'NewCourse',
                // Midnight Tokyo on Aug 17 — after `now` (09:00 Tokyo, Aug 16).
                start_date: '2026-08-16T15:00:00.000Z'
            })]
        });

        const doses = await call('/api/medications/upcoming?days=3', 'GET');

        expect(doses.map((d) => d.local_date)).toEqual([
            '2026-08-17', '2026-08-18', '2026-08-19'
        ]);
    });

    it('still excludes doses before the course starts and courses starting past the horizon', async () => {
        // Course opens 15:00 Tokyo on Aug 17, so that day's 08:00 dose is not
        // part of it.
        const midCourse = routerWith({
            medication: [seedMed({ start_date: '2026-08-17T06:00:00.000Z' })]
        });
        expect((await midCourse('/api/medications/upcoming?days=3', 'GET')).map((d) => d.local_date))
            .toEqual(['2026-08-18', '2026-08-19']);

        const later = routerWith({
            medication: [seedMed({ start_date: '2026-09-01T00:00:00.000Z' })]
        });
        expect(await later('/api/medications/upcoming?days=3', 'GET')).toEqual([]);
    });

    it('clamps the requested window', async () => {
        const call = routerWith({ medication: [seedMed()] });

        // days=0 / garbage falls back to the 7-day default rather than
        // "everything"; an oversized ask is clamped, not honoured.
        expect(await call('/api/medications/upcoming?days=0', 'GET')).toHaveLength(7);
        expect(await call('/api/medications/upcoming?days=abc', 'GET')).toHaveLength(7);
        expect(await call('/api/medications/upcoming?days=999', 'GET')).toHaveLength(30);
    });
});

// bd med-wi09.12 — ledger v2 activation. Nothing stores a PENDING prediction:
// before the ledger cut the stored rows are the truth, from the cut on the
// projection regenerates doses from history (medsched / tztransition) + lineage
// and unions the stored evidence, deduped by id. Driven through the shim
// (installApiShim writes the ledgercut row) and the /api routes the screens use.
describe('ledger v2 — doses regenerated from the cut (bd med-wi09.12)', () => {
    const TZ = 'UTC';
    const HOUR = 3600_000;
    const iso = (ms) => new Date(ms).toISOString();
    const DAILY = (t) => JSON.stringify({ type: 'daily', times: [t] });
    const slot = (ms) => `intake-7-${ms / 1000}`;
    // Sun 2026-10-18 … Thu 2026-10-22, all UTC.
    const day = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m);
    const med = (created = '2026-10-18T06:00:00.000Z') => ({
        recordId: 7,
        clientTs: 1,
        deleted: false,
        name: 'Metformin',
        dosage: '500mg',
        schedule: DAILY('08:00'),
        archived: false,
        start_date: null,
        end_date: null,
        inventory_count: 30,
        tz_shift_policy: 'flexible',
        created_at: created
    });
    const pending = (recordId, ms, extra = {}) => ({
        recordId,
        clientTs: 0,
        deleted: false,
        medication_id: 7,
        scheduled_at: iso(ms),
        taken_at: null,
        status: 'PENDING',
        snoozed_until: null,
        source: 'schedule',
        ...extra
    });
    const cutRow = (ms) => ({ recordId: 'ledgercut', clientTs: 0, deleted: false, at: iso(ms) });

    let env = null;
    let nowMs = 0;
    const realFetch = globalThis.fetch;
    const open = (seedRecords, at) => {
        nowMs = at;
        env = loadCloudShimFrontendEnv({ seedRecords, now: () => nowMs, timeZone: TZ });
        // A take best-effort POSTs /api/telegram/cancel-refire (med-r3dm).
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        return env;
    };
    const doses = (fromMs, toMs) => env.window.apiCall(`/api/doses?from=${iso(fromMs)}&to=${iso(toMs)}`);
    const shape = (rows) => rows.map((r) => [r.plannedAt, r.state]);

    afterEach(async () => {
        await materializationSettled();
        if (env) env.cleanup();
        env = null;
        globalThis.fetch = realFetch;
    });

    // Socrates' case: the schedule moves 08:00 → 20:00 on Tuesday while this
    // device is closed (no sweep ever ran on it). Wednesday's open regenerates
    // Monday and Tuesday from history, Tuesday on both generations.
    it('Mon/Tue/Wed: a schedule edit made Tuesday while closed regenerates Tuesday from history', async () => {
        open({ medication: [med()], ledgercut: [cutRow(day(18, 7))] }, day(20, 12));
        await env.window.apiCall('/api/medications/7', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: DAILY('20:00'), tz_shift_policy: 'flexible', inventory_count: 30
        });

        nowMs = day(21, 10);
        expect(shape(await doses(day(18, 0), day(22, 10)))).toEqual([
            [iso(day(18, 8)), 'due'],
            [iso(day(19, 8)), 'due'],
            [iso(day(20, 8)), 'due'], // old generation, before the edit
            [iso(day(20, 20)), 'due'], // new generation, after it
            // Wednesday 08:00 was cancelled by the edit's lineage (→ 20:00).
            [iso(day(21, 20)), 'upcoming']
        ]);

        // A regenerated dose is actionable at its exact id: the take writes
        // the evidence there, nothing else.
        const res = await env.window.apiCall('/api/doses/act', 'POST', { occ_ids: [slot(day(20, 8))], action: 'take' });
        expect(res).toMatchObject({ updated: 1, failed: 0 });
        expect((await env.records.list('intake')).map((i) => [i.recordId, i.status, i.rev]))
            .toEqual([[slot(day(20, 8)), 'TAKEN', 1]]);
        expect((await doses(day(20, 0), day(20, 23))).map((r) => r.state)).toEqual(['taken', 'due']);
    });

    it('pre-cut rows are untouched; a post-cut PENDING row from an old client reads as no evidence', async () => {
        open({
            medication: [med('2026-10-01T00:00:00.000Z')],
            ledgercut: [cutRow(day(19, 12))],
            intake: [
                // Before the cut: as stored, orphaned instant and all.
                pending('intake-7-legacy-a', day(18, 9)),
                { ...pending(slot(day(18, 8)), day(18, 8)), status: 'TAKEN', taken_at: iso(day(18, 8)) },
                // After the cut, written by an old client that still predicted.
                pending(slot(day(20, 9)), day(20, 9)), // instant no history yields
                pending(slot(day(20, 8)), day(20, 8), { snoozed_until: iso(day(20, 13)) }) // a real slot
            ]
        }, day(20, 12));

        // 17 Oct 08:00: before the cut day with nothing stored — absent.
        // 20 Oct 09:00: the old client's prediction — hidden.
        expect(shape(await doses(day(17, 0), day(20, 12)))).toEqual([
            [iso(day(18, 8)), 'taken'],
            [iso(day(18, 9)), 'due'],
            [iso(day(19, 8)), 'due'], // cut day: regenerated from its midnight
            [iso(day(20, 8)), 'snoozed'] // its stored snooze rides on the real slot
        ]);
        const history = await env.window.apiCall('/api/history?days=7');
        expect(history.map((h) => h.scheduled_at)).toEqual([
            iso(day(20, 8)), iso(day(19, 8)), iso(day(18, 9)), iso(day(18, 8))
        ]);
    });

    it('day one: stuck pendings show as due with their dates, and nothing writes PENDING', async () => {
        open({
            medication: [med('2026-10-01T00:00:00.000Z')],
            intake: [pending(slot(day(16, 8)), day(16, 8)), pending(slot(day(17, 8)), day(17, 8))]
        }, day(18, 12));
        await materializationSettled();
        // First boot of this client wrote the cut: floored, put-if-absent.
        expect(await env.records.list('ledgercut')).toEqual([
            expect.objectContaining({ recordId: 'ledgercut', clientTs: 0, at: iso(day(18, 12)) })
        ]);

        const rows = await doses(day(15, 0), day(18, 12));
        expect(rows.map((r) => [r.localDate, r.localTime, r.state])).toEqual([
            ['2026-10-16', '08:00', 'due'],
            ['2026-10-17', '08:00', 'due'],
            // Today's 08:00 was never materialized by the old client: the
            // cut day regenerates from local midnight.
            ['2026-10-18', '08:00', 'due']
        ]);
        await env.window.apiCall('/api/history?days=7');
        await env.window.apiCall('/api/medications/next-intake');
        nowMs = day(19, 12);
        await doses(day(15, 0), day(19, 12));
        expect((await env.records.list('intake')).map((i) => i.recordId))
            .toEqual([slot(day(16, 8)), slot(day(17, 8))]);
    });

    // bd med-wi09.16 — a string med recordId against numeric intake ids (imported
    // vault) must still match: no duplicate slot, no missing name.
    it('string med recordId vs numeric intake medication_id: no duplicate, name resolved', async () => {
        const SLOT_MS = day(18, 8);
        const records = createInMemoryRecordsPort({
            medication: [{ ...med(), recordId: '7' }],
            intake: [pending(slot(SLOT_MS), SLOT_MS)]
        });
        const domain = createIntakeDomain({ records, now: () => day(18, 9), timeZone: TZ });
        await createIntakeDomain({ records, now: () => SLOT_MS - HOUR, timeZone: TZ }).triggerNextIntake();
        const rows = await records.list('intake');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('TAKEN');
        expect((await domain.listWindow())[0].medication_name).toBe('Metformin');

        // logPast finds the med by String id.
        await expect(domain.logPast(7, SLOT_MS - 86400_000)).resolves.toBeDefined();

        // Reminder horizon: the slot is a medication entry (med found by String
        // id); the TAKEN slot just logged is not nagged again.
        const horizon = (intakes) => computeReminderHorizon({
            medications: [{ ...med(), recordId: '7' }],
            intakes,
            timeZone: TZ,
            now: SLOT_MS - HOUR
        }).filter((e) => e.kind === 'medication' && e.fireAtUnix === SLOT_MS / 1000);
        expect(horizon([])).toHaveLength(1);
        expect(horizon(await records.listRaw('intake'))).toHaveLength(0);
    });

    it('a deleted dose stays deleted once it comes due: the tombstone hides the regenerated slot', async () => {
        const SLOT_MS = day(18, 8);
        const records = createInMemoryRecordsPort({ medication: [med()], ledgercut: [cutRow(day(18, 0))] });
        let at = day(18, 7); // an hour before the slot
        const domain = createIntakeDomain({ records, now: () => at, timeZone: TZ });
        // A forecast dose with no row: delete writes the tombstone at its id.
        expect((await domain.deleteFutureIntakes([slot(SLOT_MS)])).deleted_count).toBe(1);

        at = day(18, 9);
        expect(await domain.occurrences({ fromMs: day(18, 0), toMs: at })).toEqual([]);
        expect((await domain.act({ occIds: [slot(SLOT_MS)], action: 'take' })).failures)
            .toEqual([{ id: slot(SLOT_MS), reason: 'not_found' }]);
        expect(await records.list('intake')).toEqual([]);
    });

    it('a Telegram confirm and an in-app take of the same regenerated dose land on one id', async () => {
        const SLOT_MS = day(18, 8);
        const seed = () => ({ medication: [med()], ledgercut: [cutRow(day(18, 0))] });
        const a = createInMemoryRecordsPort(seed());
        const b = createInMemoryRecordsPort(seed());
        await createIntakeDomain({ records: a, now: () => day(18, 9), timeZone: TZ }).act({ occIds: [slot(SLOT_MS)], action: 'take' });
        await createIntakeDomain({ records: b, now: () => day(18, 10), timeZone: TZ, via: 'telegram' }).confirm(slot(SLOT_MS), day(18, 8, 5));
        const [rowA] = await a.list('intake');
        const [rowB] = await b.list('intake');
        expect([rowA.recordId, rowB.recordId]).toEqual([slot(SLOT_MS), slot(SLOT_MS)]);
        expect([rowA.status, rowB.status, rowA.rev, rowB.rev]).toEqual(['TAKEN', 'TAKEN', 1, 1]);
    });
});

// bd med-wi09.1 — one occurrence projection. Every reader of "which doses
// exist and what state are they in" reads GET /api/doses' projection, so on one
// vault state they cannot disagree. The fixture carries every case the old
// readers split on: a stuck past PENDING, a snoozed row, a tombstone, a tz_step
// and a manual log.
describe('one occurrence projection — every reader agrees (bd med-wi09.1)', () => {
    const TZ = 'UTC';
    const NOW = Date.UTC(2026, 7, 16, 12, 0); // 12:00 UTC, Aug 16
    const HOUR = 3600_000;
    const at = (h, day = 16) => Date.UTC(2026, 7, day, h, 0);
    const iso = (ms) => new Date(ms).toISOString();
    const slotId = (medId, ms) => `intake-${medId}-${ms / 1000}`;
    const med = (recordId, name, schedule) => ({
        recordId,
        clientTs: 1,
        deleted: false,
        name,
        dosage: '10mg',
        schedule: JSON.stringify(schedule),
        archived: false,
        start_date: null,
        end_date: null,
        inventory_count: null,
        tz_shift_policy: 'strict',
        created_at: '2026-01-01T00:00:00.000Z'
    });
    const intake = (recordId, medId, ms, extra = {}) => ({
        recordId,
        clientTs: 1,
        deleted: false,
        medication_id: medId,
        scheduled_at: iso(ms),
        taken_at: null,
        status: 'PENDING',
        snoozed_until: null,
        source: 'schedule',
        ...extra
    });
    const STEP_NOTE = 'Losartan: step 1/1 — 09:00 old / 14:00 new';
    const seedRecords = () => ({
        medication: [
            med(1, 'Metformin', { type: 'daily', times: ['08:00', '20:00'] }),
            med(2, 'Losartan', { type: 'daily', times: ['09:00'] }),
            med(3, 'Ibuprofen', { type: 'as_needed' })
        ],
        intake: [
            // Stuck past PENDING: the 08:00 dose nobody acted on.
            intake(slotId(1, at(8)), 1, at(8)),
            // Snoozed past its slot, snooze still running.
            intake(slotId(2, at(9)), 2, at(9), { snoozed_until: iso(NOW + 5 * 60_000) }),
            // Tombstone: tonight's Metformin was deleted on purpose.
            intake(slotId(1, at(20)), 1, at(20), { deleted: true }),
            // Manual log of an as-needed med.
            intake(`intake-manual-${at(10)}-1`, 3, at(10), { status: 'TAKEN', taken_at: iso(at(10)) })
        ],
        // tz_step: an approved plan moves today's Losartan to 14:00.
        tzplan: [{
            recordId: 'tzplan-current',
            clientTs: 1,
            deleted: false,
            old_tz: 'UTC',
            new_tz: 'Asia/Dubai',
            status: 'APPROVED',
            created_at: '2026-08-15T00:00:00.000Z',
            steps: [{
                medicationId: 2, medName: 'Losartan', stepNumber: 1, totalSteps: 1, scheduledAtMs: at(14), note: STEP_NOTE
            }]
        }]
    });

    let env;
    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ seedRecords: seedRecords(), now: () => NOW, timeZone: TZ });
    });
    afterEach(() => {
        env.cleanup();
        env = null;
    });
    const call = (path) => env.window.apiCall(path);
    const range = (fromMs, toMs) => `/api/doses?from=${iso(fromMs)}&to=${iso(toMs)}`;

    it('GET /api/doses: stored rows as-is ∪ future forecast, tombstone hidden, no missed state', async () => {
        const doses = await call(range(NOW - 24 * HOUR, NOW + 24 * HOUR));

        expect(doses.map((d) => [d.occId, d.medId, d.plannedAt, d.source, d.state])).toEqual([
            [slotId(1, at(8)), 1, iso(at(8)), 'schedule', 'due'],
            [slotId(2, at(9)), 2, iso(at(9)), 'schedule', 'snoozed'],
            [`intake-manual-${at(10)}-1`, 3, iso(at(10)), 'manual', 'taken'],
            [slotId(2, at(14)), 2, iso(at(14)), 'tz_step', 'upcoming'],
            // 20:00 Metformin is tombstoned → absent.
            [slotId(1, at(8, 17)), 1, iso(at(8, 17)), 'schedule', 'upcoming'],
            [slotId(2, at(9, 17)), 2, iso(at(9, 17)), 'schedule', 'upcoming']
        ]);
        expect(doses[0]).toMatchObject({
            name: 'Metformin', dosage: '10mg', tz: 'UTC', localDate: '2026-08-16', localTime: '08:00'
        });
        // Evidence channel (bd med-wi09.11): a rev-less stored row is legacy; a
        // forecast row has no evidence at all.
        expect(doses[0].via).toBe('legacy');
        expect(doses[3].via).toBeUndefined();
        expect(doses[1].snoozedUntil).toBe(iso(NOW + 5 * 60_000));
        expect(doses[2].takenAt).toBe(iso(at(10)));
        expect(doses[3].stepNote).toBe(STEP_NOTE);
    });

    it('next-intake, upcoming, the badge, history and the reminder horizon read the same rows', async () => {
        const week = await call(range(NOW - 24 * HOUR, NOW + 7 * 24 * HOUR));
        const upcomingRows = week.filter((d) => d.state === 'upcoming');

        // Home next-intake: the earliest upcoming cluster — the tz_step, since
        // the tombstoned 20:00 is not offered.
        const next = await call('/api/medications/next-intake');
        expect(next).toEqual({
            scheduled_at: upcomingRows[0].plannedAt, medication_ids: [2], medication_names: ['Losartan']
        });

        // Schedule tab upcoming: exactly the projection's upcoming rows.
        const upcoming = await call('/api/medications/upcoming?days=7');
        expect(upcoming.map((u) => [u.medication_id, u.scheduled_at]))
            .toEqual(upcomingRows.map((d) => [d.medId, d.plannedAt]));
        expect(upcoming[0]).toMatchObject({ source: 'tz_step', step_number: 1, total_steps: 1, note: STEP_NOTE });

        // Meds badge: its own request, its own counter — the stuck PENDING only
        // (snoozed is not due; the manual log is taken).
        const badgeRows = await call(env.window.AppNav.dueDosesPath(NOW));
        expect(env.window.AppNav.countDueDoses(badgeRows)).toBe(1);
        expect(badgeRows.filter((d) => d.state === 'due').map((d) => d.occId))
            .toEqual(week.filter((d) => d.state === 'due').map((d) => d.occId));

        // History: the projection's stored half, legacy wire shape, newest first.
        const history = await call('/api/history?days=1');
        expect(history.map((h) => [h.id, h.status, h.source])).toEqual([
            [`intake-manual-${at(10)}-1`, 'TAKEN', 'schedule'],
            [slotId(2, at(9)), 'PENDING', 'schedule'],
            [slotId(1, at(8)), 'PENDING', 'schedule']
        ]);
        expect(history[1].snoozed_until).toBe(iso(NOW + 5 * 60_000));

        // Reminder horizon: one push per upcoming instant, same instants.
        const records = env.records;
        const entries = computeReminderHorizon({
            medications: await records.list('medication'),
            intakes: await records.listRaw('intake'),
            tzPlan: (await records.list('tzplan'))[0],
            timeZone: TZ,
            now: NOW
        }).filter((e) => e.kind === 'medication');
        const upcomingSlots = [...new Set(upcomingRows.map((d) => Date.parse(d.plannedAt) / 1000))];
        expect(entries.map((e) => e.fireAtUnix)).toEqual(upcomingSlots);
        expect(entries[0].medicationIds).toEqual([2]);
        expect(entries.map((e) => e.fireAtUnix)).not.toContain(at(20) / 1000);
    });

    // bd med-wi09.15 — Today's Next up and its take sheet named every missed
    // dose "Medication": the projection's name lookup was strict while the
    // sheet/Schedule match ids as strings. An imported vault can hold a med's
    // recordId as a string while its intakes carry a number (inbox-apply.js).
    it('missed doses carry real medicine names on Today, whatever the id type', async () => {
        env.cleanup();
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [
                    med('7', 'Atorvastatin', { type: 'daily', times: ['08:00'] }),
                    med(8, 'Metformin', { type: 'daily', times: ['08:00'] })
                ],
                intake: [intake(slotId(7, at(8)), 7, at(8)), intake(slotId(8, at(8)), 8, at(8))]
            },
            now: () => NOW,
            timeZone: TZ
        });
        const due = (await call(range(NOW - 24 * HOUR, NOW))).filter((d) => d.state === 'due');
        expect(due.map((d) => [d.name, d.dosage])).toEqual([['Atorvastatin', '10mg'], ['Metformin', '10mg']]);

        const todayJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../features/today.js');
        env.window.eval(fs.readFileSync(todayJs, 'utf8'));
        const features = { medication: true, bp: false, weight: false, food: false, workout: false, health: false, gamification: false };
        const medications = await call('/api/medications');
        const missed = (rows) => env.window.TodayDashboard
            .aggregateToday({ features, medications, intake_history: rows }, {}, NOW).missedDoses.value;
        expect(missed(due)).toEqual([{
            scheduledAt: iso(at(8)), names: ['Atorvastatin', 'Metformin'], ids: [7, 8], intakeIds: [slotId(7, at(8)), slotId(8, at(8))]
        }]);
        // Rows cached by the buggy build (name '') still resolve from the
        // cached medications list — the offline doses_due_24h path.
        expect(missed(due.map((d) => ({ ...d, name: '' })))[0].names).toEqual(['Atorvastatin', 'Metformin']);
    });
});

// bd med-wi09.9 — schedule history: one immutable medsched-* row per change,
// so the planner can regenerate the past. Nothing reads it yet.
describe('schedule history — medsched-* on every schedule/policy edit (bd med-wi09.9)', () => {
    const DAILY = (t) => JSON.stringify({ type: 'daily', times: [t] });
    const legacyMed = () => ({
        recordId: 7,
        clientTs: 1,
        deleted: false,
        name: 'Metformin',
        dosage: '500mg',
        schedule: DAILY('08:00'),
        archived: false,
        tz_shift_policy: 'flexible',
        created_at: '2026-01-01T00:00:00.000Z'
    });
    const edit = (schedule, policy = 'flexible') => ({
        name: 'Metformin', dosage: '500mg', schedule, tz_shift_policy: policy
    });
    let env = null;

    afterEach(() => {
        if (env) env.cleanup();
        env = null;
    });

    it('create writes the base generation; schedule and policy edits each add one; other edits add none', async () => {
        // Each write a minute apart, so the effective order is the edit order.
        let t = Date.parse('2026-07-01T09:00:00Z');
        env = loadCloudShimFrontendEnv({ now: () => (t += 60_000) });
        const { id } = await env.window.apiCall('/api/medications', 'POST', edit(DAILY('08:00')));
        let hist = await env.records.list('medsched');
        expect(hist).toHaveLength(1);
        expect(hist[0].recordId).toMatch(new RegExp(`^medsched-${id}-\\d+-base$`));
        expect(hist[0]).toMatchObject({ medication_id: id, schedule: DAILY('08:00'), tz_shift_policy: 'flexible' });

        await env.window.apiCall(`/api/medications/${id}`, 'POST', { ...edit(DAILY('08:00')), dosage: '850mg' });
        expect(await env.records.list('medsched')).toHaveLength(1);

        await env.window.apiCall(`/api/medications/${id}`, 'POST', { ...edit(DAILY('09:00')), dosage: '850mg' });
        await env.window.apiCall(`/api/medications/${id}`, 'POST', { ...edit(DAILY('09:00'), 'strict'), dosage: '850mg' });
        hist = sortByEffective(await env.records.list('medsched'), 'from');
        expect(hist.map((h) => [h.schedule, h.tz_shift_policy])).toEqual([
            [DAILY('08:00'), 'flexible'], [DAILY('09:00'), 'flexible'], [DAILY('09:00'), 'strict']
        ]);
        expect(hist.every((h) => String(h.medication_id) === String(id))).toBe(true);
    });

    it('the first edit of a med that predates history backfills its old generation at the clientTs floor', async () => {
        env = loadCloudShimFrontendEnv({ seedRecords: { medication: [legacyMed()] } });
        await env.window.apiCall('/api/medications/7', 'POST', edit(DAILY('10:00')));
        const [base, change] = sortByEffective(await env.records.list('medsched'), 'from');
        expect(base).toMatchObject({
            recordId: `medsched-7-${Date.parse('2026-01-01T00:00:00Z') / 1000}-base`,
            clientTs: 0,
            schedule: DAILY('08:00'),
            from: '2026-01-01T00:00:00.000Z'
        });
        expect(change.schedule).toBe(DAILY('10:00'));
        expect(change.clientTs).toBeGreaterThan(0);
    });

    it('two devices editing in the same second both persist and order the same everywhere', async () => {
        const NOW = Date.parse('2026-07-01T09:00:00.000Z');
        const device = () => {
            const records = createInMemoryRecordsPort({ medication: [legacyMed()] });
            return { records, meds: createMedicationsDomain({ records, now: () => NOW, timeZone: 'UTC' }) };
        };
        const a = device();
        const b = device();
        await a.meds.update(7, edit(DAILY('10:00')));
        await b.meds.update(7, edit(DAILY('11:00')));
        const rowsA = await a.records.list('medsched');
        const rowsB = await b.records.list('medsched');
        // Union by recordId, the way sync merges them: the shared base row
        // collapses, both edits survive under their own ids.
        const union = (x, y) => [...new Map([...x, ...y].map((r) => [r.recordId, r])).values()];
        const ab = sortByEffective(union(rowsA, rowsB), 'from');
        const ba = sortByEffective(union(rowsB, rowsA), 'from');
        expect(ab).toHaveLength(3);
        expect(ab.map((r) => r.recordId)).toEqual(ba.map((r) => r.recordId));
        expect(ab.slice(1).map((r) => r.schedule).sort()).toEqual([DAILY('10:00'), DAILY('11:00')]);
    });

    it('deleting an archived med drops its history', async () => {
        env = loadCloudShimFrontendEnv({ seedRecords: { medication: [{ ...legacyMed(), archived: true }] } });
        await env.window.apiCall('/api/medications/7', 'POST', { ...edit(DAILY('10:00')), archived: true });
        expect(await env.records.list('medsched')).toHaveLength(2);
        await env.window.apiCall('/api/medications/7', 'DELETE');
        expect(await env.records.list('medsched')).toHaveLength(0);
    });
});
