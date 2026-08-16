// Plan 2026-07-05 cloud-c2b, Task 8 — shim-mode contract run of the meds CRUD
// flows against web/domain/medications.js. Drives the real feature code
// (saveMedication / deleteMed) through window.offlineAwareApiCall / apiCall,
// which route to the cloud shim (web/cloud/js/apishim.js) instead of the
// network — same pattern as cloud.shim-contract.bp.test.js. Divergences here
// are contract bugs in the JS domain layer, not test bugs; the original
// (network-mocked) features.meds.test.js keeps running unshimmed.
import {
    afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
import { loadCloudShimFrontendEnv, createInMemoryRecordsPort } from './helpers/cloud-shim-harness.js';
import { createApiRouter } from '../../../cloud/js/apishim.js';

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

    it('deleteMed archives a medication, then permanently deletes it once archived', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'Ibuprofen', dosage: '200mg' });
        await window.saveMedication();
        const [created] = await window.apiCall('/api/medications');

        window.medications = [created];
        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });

        await window.deleteMed(created.id);
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
                recordId: 'intake-1-x',
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
