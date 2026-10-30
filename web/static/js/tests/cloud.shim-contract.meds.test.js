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
import { loadCloudShimFrontendEnv, createInMemoryRecordsPort, applyIncomingReplica } from './helpers/cloud-shim-harness.js';
import { mergeTzFloor } from '../../../domain/settings.js';
import { createApiRouter, materializationSettled } from '../../../cloud/js/apishim.js';
import { createIntakeDomain, foldAdherence } from '../../../domain/medintake.js';
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

describe('cloud medication identity through the real RxNorm port', () => {
    let env;
    let replyForName;
    let fetchRxnav;

    beforeEach(async () => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        env.window.loadMeds = vi.fn();
        env.window.safeAlert = vi.fn();
        // Captured 2026-10-30 from NLM /REST/rxcui.json?name=<name>&search=0:
        // Candecor, Candecor comp, Smecta and Lipitorr -> { idGroup: {} };
        // Lipitor/lipitor -> { idGroup: { rxnormId: ['153165'] } }.
        // Contract: exact is case-insensitive; JSON IDs are strings, and an
        // exact lookup may return multiple concepts (which must abstain).
        // https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.findRxcuiByString.html
        // Properties/approximate response shapes:
        // https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getRxConceptProperties.html
        // https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getApproximateMatch.html
        replyForName = (name) => name.toLowerCase() === 'lipitor'
            ? { idGroup: { rxnormId: ['153165'] } } : { idGroup: {} };
        fetchRxnav = vi.fn(async (url) => {
            const request = new URL(url, 'https://example.test');
            let data;
            if (request.pathname === '/api/rxnav/rxcui') data = replyForName(request.searchParams.get('name'));
            else if (request.pathname === '/api/rxnav/properties') data = { properties: { name: 'Lipitor' } };
            // A tempting approximate candidate must never be consulted, even
            // if it reports rank=1 or a large score (scores are query-relative).
            else if (request.pathname === '/api/rxnav/approximate') {
                data = { approximateGroup: { candidate: [{ rxcui: '999', name: 'Caldecort / Umecta', score: '1000', rank: '1' }] } };
            } else data = { fullInteractionTypeGroup: [] };
            return { ok: true, json: async () => data };
        });
        vi.stubGlobal('fetch', fetchRxnav);
        const { createRxnormPort } = await vi.importActual('../../../cloud/js/rxnorm.js');
        env.window.offlineAwareApiCall = createApiRouter({}, {
            records: env.records, win: env.window, rxnorm: createRxnormPort(),
            now: () => Date.parse('2026-10-30T12:00:00Z'), timeZone: () => 'UTC',
            effects: { scheduleReminderRecompute: vi.fn() },
        });
    });

    afterEach(() => {
        env.cleanup();
        vi.unstubAllGlobals();
    });

    it.each(['Candecor', 'Candecor comp', 'Smecta', 'Lipitorr'])(
        'keeps %s unverified across editor checking and Save without asking for a spelling guess', async (name) => {
            const { window, document } = env;
            fillMedForm(window, document, { name, dosage: 'user-entered dose' });
            await window.checkMedRx();
            expect(document.getElementById('med-rx-display').classList.contains('hidden')).toBe(true);
            expect(await window.apiCall(`/api/medications/rx-check?name=${encodeURIComponent(name)}`)).toEqual({
                rxcui: '', normalized_name: '', warning: '',
            });
            await window.saveMedication();
            const [stored] = await env.records.list('medication');
            expect(stored).toMatchObject({ name, dosage: 'user-entered dose', rxcui: '', normalized_name: '' });
            expect(fetchRxnav.mock.calls.every(([url]) => new URL(url, 'https://example.test').pathname === '/api/rxnav/rxcui')).toBe(true);
        },
    );

    it('accepts one exact US identity, including case variants, without replacing the typed name', async () => {
        const { window, document } = env;
        fillMedForm(window, document, { name: 'lipitor', dosage: '10mg' });
        await window.checkMedRx();
        expect(document.getElementById('med-name').value).toBe('lipitor');
        expect(document.getElementById('med-rx-name').textContent).toBe('Rx · Lipitor');
        await window.saveMedication();
        expect((await env.records.list('medication'))[0]).toMatchObject({
            name: 'lipitor', rxcui: '153165', normalized_name: 'Lipitor',
        });
        expect(fetchRxnav.mock.calls.some(([url]) => url.includes('/approximate'))).toBe(false);
    });

    it.each([
        { idGroup: { rxnormId: [] } },
        { idGroup: { rxnormId: '153165' } },
        { idGroup: { rxnormId: [153165] } },
        { idGroup: { rxnormId: [''] } },
        { idGroup: { rxnormId: ['not-an-id'] } },
        { idGroup: { rxnormId: ['153165', '1191'] } },
    ])('abstains on a malformed or ambiguous exact reply: %j', async (reply) => {
        replyForName = () => reply;
        expect(await env.window.apiCall('/api/medications/rx-check?name=Lipitor')).toEqual({
            rxcui: '', normalized_name: '', warning: '',
        });
        expect(fetchRxnav).toHaveBeenCalledTimes(1);
    });

    it('accepts duplicate copies of the same exact ID as one identity', async () => {
        replyForName = () => ({ idGroup: { rxnormId: ['153165', '153165'] } });
        expect(await env.window.apiCall('/api/medications/rx-check?name=Lipitor')).toEqual({
            rxcui: '153165', normalized_name: 'Lipitor', warning: '',
        });
    });

    it('rechecks a legacy wrong identity without writing on open; ordinary Save clears only its derived match', async () => {
        const { window, document } = env;
        const legacy = {
            recordId: 1, clientTs: 1, name: 'Candecor', dosage: '8mg', schedule: '{"type":"as_needed"}',
            rxcui: '999', normalized_name: 'Caldecort', archived: false, supplement: true,
            inventory_count: null, tz_shift_policy: 'strict', pack_size: null,
            start_date: null, end_date: null, created_at: '2026-10-01T12:00:00Z',
        };
        await env.records.put('medication', legacy);
        window.medications = await window.apiCall('/api/medications');
        const write = vi.spyOn(env.records, 'put');
        window.showEditModal(1);
        await vi.waitFor(() => expect(fetchRxnav).toHaveBeenCalled());
        expect(document.getElementById('med-rx-name').textContent).toBe('');
        expect(document.getElementById('med-rx-warning').classList.contains('hidden')).toBe(true);
        expect(await window.apiCall('/api/medications/rx-check?name=Candecor&rxcui=999&exclude_id=1')).toEqual({
            rxcui: '', normalized_name: '', warning: '',
        });
        expect(await window.apiCall('/api/medications/rx-check?rxcui=999')).toEqual({
            rxcui: '', normalized_name: '', warning: '',
        });
        expect(write).not.toHaveBeenCalled();
        expect((await env.records.list('medication'))[0]).toMatchObject(legacy);
        await window.saveMedication();
        expect((await env.records.list('medication'))[0]).toMatchObject({
            name: 'Candecor', dosage: '8mg', schedule: '{"type":"as_needed"}', supplement: true,
            tz_shift_policy: 'strict', pack_size: null, rxcui: '', normalized_name: '',
        });
    });

    it('does not revive a saved chip or block Save when RxNav is unavailable', async () => {
        const { window, document } = env;
        fetchRxnav.mockRejectedValue(new Error('offline'));
        fillMedForm(window, document, { name: 'Candecor', dosage: '8mg' });
        window.setMedRxMatch('Caldecort', 'legacy warning');
        await window.checkMedRx('999', 'Caldecort'); // old callers are not proof
        expect(document.getElementById('med-rx-name').textContent).toBe('');
        expect(document.getElementById('med-rx-warning').classList.contains('hidden')).toBe(true);
        await window.saveMedication();
        expect((await env.records.list('medication'))[0]).toMatchObject({ name: 'Candecor', rxcui: '', normalized_name: '' });
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
    // Monday and Tuesday from history. Tuesday's untaken 08:00 gives way to
    // Tuesday's 20:00 (one dose per slot per day — Archie's F3 ruling).
    it('Mon/Tue/Wed: a schedule edit made Tuesday while closed regenerates Tuesday from history', async () => {
        open({ medication: [med()], ledgercut: [cutRow(day(18, 7))] }, day(20, 12));
        await env.window.apiCall('/api/medications/7', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: DAILY('20:00'), tz_shift_policy: 'flexible', inventory_count: 30
        });

        nowMs = day(21, 10);
        expect(shape(await doses(day(18, 0), day(22, 10)))).toEqual([
            [iso(day(18, 8)), 'due'],
            [iso(day(19, 8)), 'due'],
            // Tuesday 08:00 (untaken at the edit) was replaced by Tuesday 20:00,
            // Wednesday 08:00 by Wednesday 20:00 — the edit's lineage.
            [iso(day(20, 20)), 'due'],
            [iso(day(21, 20)), 'upcoming']
        ]);

        // A regenerated dose is actionable at its exact id: the take writes
        // the evidence there, nothing else.
        const res = await env.window.apiCall('/api/doses/act', 'POST', { occ_ids: [slot(day(19, 8))], action: 'take' });
        expect(res).toMatchObject({ updated: 1, failed: 0 });
        expect((await env.records.list('intake')).map((i) => [i.recordId, i.status, i.rev]))
            .toEqual([[slot(day(19, 8)), 'TAKEN', 1]]);
        expect((await doses(day(19, 0), day(20, 23))).map((r) => r.state)).toEqual(['taken', 'due']);
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

        // 17 Oct: before the cut day, nothing stored — absent. 19 Oct 08:00:
        // the cut day regenerates from its midnight (N2), and no stored row
        // holds that instant — due. 20 Oct 09:00: the old client's
        // prediction — hidden.
        expect(shape(await doses(day(17, 0), day(20, 12)))).toEqual([
            [iso(day(18, 8)), 'taken'],
            [iso(day(18, 9)), 'due'],
            [iso(day(19, 8)), 'due'],
            [iso(day(20, 8)), 'snoozed'] // its stored snooze rides on the real slot
        ]);
        const history = await env.window.apiCall('/api/history?days=7');
        expect(history.map((h) => h.scheduled_at)).toEqual([
            iso(day(20, 8)), iso(day(19, 8)), iso(day(18, 9)), iso(day(18, 8))
        ]);
    });

    // bd med-ry7b.3 merge gate (Archie 4709): the pending-only read has no age
    // cap. A stored PENDING row from long before the cut still reaches the
    // timeline's focus card count, next to the doses regenerated after the cut.
    it('a stored PENDING row 120 days before the cut reaches the pending read, the focus card and +N', async () => {
        const ancient = day(18, 9) - 120 * 24 * HOUR;
        open({
            medication: [med('2026-06-01T00:00:00.000Z')],
            ledgercut: [cutRow(day(18, 7))],
            intake: [pending('intake-7-legacy-old', ancient)]
        }, day(20, 12));

        const read = await env.window.apiCall(`/api/doses?status=due,snoozed&to=${iso(nowMs)}`);
        expect(shape(read)).toEqual([
            [iso(ancient), 'due'],
            [iso(day(18, 8)), 'due'],
            [iso(day(19, 8)), 'due'],
            [iso(day(20, 8)), 'due']
        ]);

        const { document } = env;
        env.window.Date.now = () => nowMs;
        env.window.loadMeds = async () => {};
        env.window.medications = [{ id: 7, name: 'Metformin', dosage: '500mg' }];
        await env.window.loadTimeline({ anchor: true });
        const focus = document.querySelector('#med-timeline-list .wg-tl-focus');
        expect(focus.querySelector('.wg-timeline__row').dataset.occIds).toBe(slot(day(20, 8)));
        expect(focus.querySelector('.wg-tl-focus__label .wg-meta').textContent.trim()).toBe('+3 more pending');
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
            // Today's 08:00 is before the cut (12:00, this boot) with no row:
            // the cut day regenerates from its midnight (N2) — due.
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

    // codex review: with no PENDING rows to tombstone, the archive flip itself
    // (a medsched row) must cancel the open doses and keep archived days empty.
    it('archiving cancels the open derived doses and un-archiving brings none of them back', async () => {
        open({ medication: [med()], ledgercut: [cutRow(day(18, 0))] }, day(19, 12));
        const body = (archived) => ({
            name: 'Metformin', dosage: '500mg', schedule: DAILY('08:00'), tz_shift_policy: 'flexible', inventory_count: 30, archived
        });
        await env.window.apiCall('/api/medications/7', 'POST', body(true));
        nowMs = day(21, 12);
        await env.window.apiCall('/api/medications/7', 'POST', body(false));

        nowMs = day(21, 13);
        expect(shape(await doses(day(18, 0), day(22, 10)))).toEqual([[iso(day(22, 8)), 'upcoming']]);
        expect(await env.records.list('intake')).toEqual([]);
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

    // Archie 4934 point 3: nothing writes when a dose comes due, so the shim's
    // dose clock invalidates the intake caches at the projection's next
    // boundary and every mounted surface (Today, Meds) re-reads.
    it('a dose turns due on the clock alone: the next boundary invalidates the dose caches', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            open({ medication: [med()], ledgercut: [cutRow(day(18, 0))] }, day(18, 7, 59));
            const invalidate = vi.spyOn(env.window.DataStore, 'invalidateTags');
            expect(shape(await doses(day(18, 7), day(18, 9)))).toEqual([[iso(day(18, 8)), 'upcoming']]);
            expect(invalidate).not.toHaveBeenCalled();
            nowMs = day(18, 8, 1);
            await vi.advanceTimersByTimeAsync(2 * 60_000);
            expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining(['medications', 'history']));
            expect(shape(await doses(day(18, 7), day(18, 9)))).toEqual([[iso(day(18, 8)), 'due']]);
        } finally {
            vi.useRealTimers();
        }
    });

    // Archie 4934 point 1: a batch resolves one snapshot, so a repeated id
    // must act once — one decrement on confirm, one increment on cancel.
    it('a repeated id in a batch confirm or cancel moves stock once', async () => {
        const records = createInMemoryRecordsPort({ medication: [med()], ledgercut: [cutRow(day(18, 0))] });
        const domain = createIntakeDomain({ records, now: () => day(18, 9), timeZone: TZ });
        const stock = async () => (await records.list('medication'))[0].inventory_count;
        await domain.confirmSchedule({ intakeIds: [slot(day(18, 8)), slot(day(18, 8))] });
        expect(await stock()).toBe(29);
        expect(await domain.cancelIntakes([slot(day(18, 8)), slot(day(18, 8))])).toMatchObject({ cancelled_count: 1 });
        expect(await stock()).toBe(30);
    });

    // F2 (Archie): a past day's zone comes from its evidence, never the device
    // clock. 08:00 taken in Berlin, 20:00 forgotten; the device is now in New
    // York with no tztransition recorded (an unpinned account).
    it('a past day regenerates in the zone its evidence was logged in, not the device zone', async () => {
        const TWICE = JSON.stringify({ type: 'daily', times: ['08:00', '20:00'] });
        const records = createInMemoryRecordsPort({
            medication: [{ ...med(), schedule: TWICE }],
            ledgercut: [cutRow(day(19, 23))] // 20 Oct 01:00 Berlin
        });
        const berlin = createIntakeDomain({ records, now: () => day(20, 7), timeZone: 'Europe/Berlin' });
        expect((await berlin.act({ occIds: [slot(day(20, 6))], action: 'take' })).updated).toBe(1);
        expect((await records.list('intake'))[0].tz).toBe('Europe/Berlin');

        const at = day(21, 2); // 20 Oct 22:00 in New York
        const ny = createIntakeDomain({ records, now: () => at, timeZone: 'America/New_York' });
        // Exactly one due — 20:00 Berlin (18:00Z). No 08:00/20:00 New York
        // phantom (12:00Z, and 00:00Z on the 21st, already past).
        expect(shape(await ny.occurrences({ fromMs: day(19, 22), toMs: at }))).toEqual([
            [iso(day(20, 6)), 'taken'],
            [iso(day(20, 18)), 'due']
        ]);
        // The brief's adherence fold over that day: 1 of 2.
        const log = await ny.listWindow({ fromMs: day(19, 22), toMs: at });
        expect(foldAdherence({ log, meds: await records.list('medication'), nowMs: at }).overall)
            .toEqual({ total: 2, taken: 1 });
        // "Took my meds" acts on exactly that dose (14:00 today in New York),
        // never a phantom.
        expect((await ny.dueToday(at)).map((i) => i.recordId)).toEqual([slot(day(20, 18))]);
    });

    // F3 (Archie): a time edit 08:00 → 20:00 made at 10:00 — one dose today
    // either way, and the reminder horizon reads the same projection (no band).
    it.each([
        ['untaken', false, [[iso(day(20, 20)), 'upcoming']], true],
        ['taken', true, [[iso(day(20, 8)), 'taken']], false]
    ])('a same-day time edit with 08:00 %s: one dose today, and the push agrees', async (_label, taken, today, pushesTonight) => {
        open({ medication: [med()], ledgercut: [cutRow(day(18, 7))] }, day(20, 8, 5));
        if (taken) await env.window.apiCall('/api/doses/act', 'POST', { occ_ids: [slot(day(20, 8))], action: 'take' });
        nowMs = day(20, 10);
        await env.window.apiCall('/api/medications/7', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: DAILY('20:00'), tz_shift_policy: 'flexible', inventory_count: 30
        });
        nowMs = day(20, 11);
        expect(shape(await doses(day(20, 0), day(20, 23, 59)))).toEqual(today);
        const horizon = computeReminderHorizon({
            medications: await env.records.list('medication'),
            intakes: await env.records.listRaw('intake'),
            scheds: await env.records.list('medsched'),
            timeZone: TZ,
            now: nowMs,
            cutMs: day(18, 7)
        }).filter((e) => e.kind === 'medication').map((e) => e.fireAtUnix * 1000);
        expect(horizon.includes(day(20, 20))).toBe(pushesTonight);
        expect(horizon).toContain(day(21, 20));
    });

    // N1 (Archie): the edit day pairs slots by order — k-th old with k-th new.
    it.each([
        ['08:00 taken, 20:00 untaken → 09:00/21:00', ['08:00', '20:00'], ['09:00', '21:00'],
            [[iso(day(20, 8)), 'taken'], [iso(day(20, 21)), 'upcoming']]],
        ['08:00 taken → 08:00/14:00/20:00', ['08:00', '20:00'], ['08:00', '14:00', '20:00'],
            [[iso(day(20, 8)), 'taken'], [iso(day(20, 14)), 'upcoming'], [iso(day(20, 20)), 'upcoming']]]
    ])('a same-day edit of a twice-daily med (%s at 10:00): no dose lost, none doubled', async (_label, from, to, today) => {
        const times = (list) => JSON.stringify({ type: 'daily', times: list });
        open({ medication: [{ ...med(), schedule: times(from) }], ledgercut: [cutRow(day(18, 7))] }, day(20, 8, 5));
        await env.window.apiCall('/api/doses/act', 'POST', { occ_ids: [slot(day(20, 8))], action: 'take' });
        nowMs = day(20, 10);
        await env.window.apiCall('/api/medications/7', 'POST', {
            name: 'Metformin', dosage: '500mg', schedule: times(to), tz_shift_policy: 'flexible', inventory_count: 29
        });
        nowMs = day(20, 11);
        expect(shape(await doses(day(20, 0), day(20, 23, 59)))).toEqual(today);
    });

    // N2 (Archie): the cut day regenerates from its local midnight; a stored
    // row at the same medication and instant wins.
    it.each([
        ['no stored row: 08:00 is due', [], [[iso(day(20, 8)), 'due', slot(day(20, 8))]]],
        ['a stored PENDING 08:00: one row, the stored one', [pending('intake-7-old-client', day(20, 8))],
            [[iso(day(20, 8)), 'due', 'intake-7-old-client']]]
    ])('first v2 boot at 11:00 — %s', async (_label, intake, want) => {
        open({ medication: [med('2026-10-01T00:00:00.000Z')], intake }, day(20, 11));
        await materializationSettled();
        expect((await env.records.list('ledgercut'))[0].at).toBe(iso(day(20, 11)));
        expect((await doses(day(20, 0), day(20, 11))).map((r) => [r.plannedAt, r.state, r.occId])).toEqual(want);
    });

    // HIGH-1: an old bundle (intake no longer gated) still writes PENDING
    // placeholders after the cut. At a regenerated slot's id it is one row with
    // that dose; at an instant history does not yield it is nothing; its own
    // TAKEN is the dose. A day only the old bundle logged (no tz on any of its
    // evidence) is still regenerated after the cut (NEW-2): its forgotten
    // evening dose is due, and a confirm lands on it.
    it('an old bundle\'s placeholders after the cut: one row per slot, nothing promoted, its TAKEN wins', async () => {
        const v2Take = (ms) => ({ ...pending(slot(ms), ms), status: 'TAKEN', taken_at: iso(ms), rev: 1, via: 'app', tz: TZ, acted_at: iso(ms) });
        const records = createInMemoryRecordsPort({
            medication: [{ ...med(), schedule: JSON.stringify({ type: 'daily', times: ['08:00', '20:00'] }) }],
            ledgercut: [cutRow(day(18, 0))],
            intake: [
                pending(slot(day(18, 8)), day(18, 8)), // on a regenerated slot
                pending(slot(day(18, 9)), day(18, 9)), // an instant no history yields
                v2Take(day(18, 20)),
                { ...pending(slot(day(19, 8)), day(19, 8)), status: 'TAKEN', taken_at: iso(day(19, 8, 10)) } // legacy TAKEN
            ]
        });
        const domain = createIntakeDomain({ records, now: () => day(19, 21), timeZone: TZ });
        expect(shape(await domain.occurrences({ fromMs: day(18, 0), toMs: day(19, 21) }))).toEqual([
            [iso(day(18, 8)), 'due'],
            [iso(day(18, 20)), 'taken'],
            [iso(day(19, 8)), 'taken'],
            [iso(day(19, 20)), 'due']
        ]);
        expect((await domain.withDueRows({ fromMs: day(19, 19), toMs: day(19, 21) })).map((i) => i.recordId))
            .toEqual([slot(day(19, 20))]);
        expect((await domain.confirm(slot(day(19, 20)), day(19, 20, 30))).status).toBe('TAKEN');
        // A v2 take of the placeholder's dose lands on the same id (rev 1).
        expect((await domain.act({ occIds: [slot(day(18, 8))], action: 'take' })).updated).toBe(1);
        expect((await records.list('intake')).find((i) => i.recordId === slot(day(18, 8))))
            .toMatchObject({ status: 'TAKEN', rev: 1 });
    });

    // Round 4 (bd med-wi09.12): not every writer reaches this tab's journal —
    // an old bundle's tab left open after the deploy, a cross-tab message lost
    // to a frozen page, Safari without BroadcastChannel. Such a take, on a day
    // the projection already cached, shows on the next read (the index is
    // fingerprinted against the list), so a second Take here is a no-op
    // instead of a second stock decrement.
    it('a take written past the journal (an old tab) shows on the next read; Take here does not decrement again', async () => {
        const store = new Map();
        const journal = [];
        const put = (type, r) => { store.set(`${type}|${r.recordId}`, { ...r, recordType: type }); journal.push({ type, id: String(r.recordId) }); return r; };
        const rows = (type) => [...store.values()].filter((r) => r.recordType === type);
        const records = {
            list: async (type) => rows(type).filter((r) => !r.deleted),
            listRaw: async (type) => rows(type),
            put: async (type, r) => put(type, r),
            putIfAbsent: async (type, r) => store.get(`${type}|${r.recordId}`) || put(type, r),
            del: async (type, id) => put(type, { recordId: id, clientTs: Date.now(), deleted: true }),
            changesSince: (type, token) => (typeof token !== 'string'
                ? { token: String(journal.length), ids: null }
                : { token: String(journal.length), ids: journal.slice(Number(token)).filter((j) => j.type === type).map((j) => j.id) }),
        };
        put('medication', med());
        put('ledgercut', cutRow(day(18, 0)));
        const domain = createIntakeDomain({ records, now: () => day(20, 12), timeZone: TZ });
        const span = { fromMs: day(18, 0), toMs: day(20, 12) };
        expect(shape(await domain.occurrences(span))).toEqual([
            [iso(day(18, 8)), 'due'], [iso(day(19, 8)), 'due'], [iso(day(20, 8)), 'due']
        ]);

        // The old tab's TAKEN on Monday (a settled, cached day), straight into
        // the store: no journal entry, no announcement.
        store.set(`intake|${slot(day(19, 8))}`, {
            ...pending(slot(day(19, 8)), day(19, 8)), recordType: 'intake', status: 'TAKEN', taken_at: iso(day(19, 8, 5)), clientTs: day(19, 8, 5)
        });
        expect(shape(await domain.occurrences(span))).toEqual([
            [iso(day(18, 8)), 'due'], [iso(day(19, 8)), 'taken'], [iso(day(20, 8)), 'due']
        ]);
        // Take on the same dose here: already taken, nothing written, stock kept.
        expect(await domain.act({ occIds: [slot(day(19, 8))], action: 'take' })).toMatchObject({ updated: 0, unchanged: 1 });
        expect(rows('medication')[0].inventory_count).toBe(30);

        // Round 5: a same-count edit below the newest stamp. Sunday's PENDING
        // row exists (journaled); a future-skewed row pins the newest clientTs.
        // The old tab then confirms Sunday straight into the store: same row
        // count, same max — only the clientTs sum moves.
        put('intake', { ...pending(slot(day(18, 8)), day(18, 8)), clientTs: 5 });
        put('intake', { ...pending('intake-7-skewed', day(18, 9)), status: 'SKIPPED', clientTs: day(30, 0) });
        expect(shape(await domain.occurrences(span))[0]).toEqual([iso(day(18, 8)), 'due']);
        store.set(`intake|${slot(day(18, 8))}`, {
            ...pending(slot(day(18, 8)), day(18, 8)), recordType: 'intake', status: 'TAKEN', taken_at: iso(day(18, 8, 5)), clientTs: 6
        });
        expect(shape(await domain.occurrences(span))[0]).toEqual([iso(day(18, 8)), 'taken']);
        expect(await domain.act({ occIds: [slot(day(18, 8))], action: 'take' })).toMatchObject({ updated: 0, unchanged: 1 });
        expect(rows('medication')[0].inventory_count).toBe(30);
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

    // bd med-ry7b.3 — the timeline's focus card reads every pending dose, not
    // just its shown days: status keeps only those states, and pending never
    // expires, so from defaults to the start of the ledger.
    it('GET /api/doses?status=due,snoozed: only pending rows, of any age by default', async () => {
        const old = Date.UTC(2026, 6, 17, 8, 0); // 30 days back
        const veryOld = Date.UTC(2026, 3, 18, 8, 0); // 120 days back
        env.cleanup();
        const seed = seedRecords();
        seed.intake.push(intake(slotId(2, old), 2, old), intake(slotId(2, veryOld), 2, veryOld));
        env = loadCloudShimFrontendEnv({ seedRecords: seed, now: () => NOW, timeZone: TZ });

        const pending = await call(`/api/doses?status=due,snoozed&to=${iso(NOW)}`);
        expect(pending.map((d) => [d.occId, d.state])).toEqual([
            [slotId(2, veryOld), 'due'],
            [slotId(2, old), 'due'],
            [slotId(1, at(8)), 'due'],
            [slotId(2, at(9)), 'snoozed']
        ]);
        expect((await call(`/api/doses?status=due&to=${iso(NOW)}`)).map((d) => d.state)).toEqual(['due', 'due', 'due']);
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

        // Meds badge (bd med-ry7b.4): the timeline's pending read, counted —
        // the stuck PENDING and the snoozed dose (the manual log is taken).
        const badgeRows = await env.window.readPendingDoses(NOW);
        expect(env.window.AppNav.countPendingDoses(badgeRows)).toBe(2);
        expect(badgeRows.map((d) => d.occId))
            .toEqual(week.filter((d) => d.state === 'due' || d.state === 'snoozed').map((d) => d.occId));

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
        // The running snooze fires first, at its end, on its own 09:00 slot's
        // callback (bd med-4j49).
        const upcomingSlots = [...new Set(upcomingRows.map((d) => Date.parse(d.plannedAt) / 1000))];
        expect(entries.map((e) => e.fireAtUnix)).toEqual([(NOW + 5 * 60_000) / 1000, ...upcomingSlots]);
        expect(entries[0]).toMatchObject({ callback: `s:${at(9) / 1000}`, medicationIds: [2] });
        expect(entries[1].medicationIds).toEqual([2]);
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
        // cached medications list — the offline doses_pending path.
        expect(missed(due.map((d) => ({ ...d, name: '' })))[0].names).toEqual(['Atorvastatin', 'Metformin']);
    });

    // bd med-ry7b.7 — Today's Next up read its own 24h window: a dose pending
    // for 30h was on the badge and not on Today, a snoozed one the other way
    // round. Next up now paints the badge's pending set from its cache, and a
    // take through Next up flips that one cache, so both repaint without a
    // refetch.
    it('Next up lists the pending set the badge counts; a take from Next up flips it with no refetch', async () => {
        env.cleanup();
        const OLD = at(6, 15); // 30h before NOW
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [
                    med(1, 'Metformin', { type: 'daily', times: ['06:00'] }),
                    med(2, 'Losartan', { type: 'daily', times: ['09:00'] })
                ],
                intake: [
                    intake(slotId(1, OLD), 1, OLD),
                    intake(slotId(1, at(6)), 1, at(6), { status: 'TAKEN', taken_at: iso(at(6)) }),
                    intake(slotId(2, at(9, 15)), 2, at(9, 15), { status: 'TAKEN', taken_at: iso(at(9, 15)) }),
                    intake(slotId(2, at(9)), 2, at(9), { snoozed_until: iso(NOW + 30 * 60_000) })
                ]
            },
            now: () => NOW,
            timeZone: TZ
        });
        const { window, document } = env;
        installApiCache(window);
        window.eval(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../features/today.js'), 'utf8'));
        const features = { medication: true, bp: false, weight: false, food: false, workout: false, health: false, gamification: false };
        const medications = await call('/api/medications');

        const badgeRows = await window.readPendingDoses(NOW);
        const badge = window.AppNav.countPendingDoses(badgeRows);
        expect(badgeRows.map((d) => d.occId)).toEqual(expect.arrayContaining([slotId(1, OLD), slotId(2, at(9))]));

        const root = document.createElement('div');
        document.body.appendChild(root);
        const paint = async () => {
            const state = window.TodayDashboard.aggregateToday(
                { features, medications, intake_history: await window.readCachedPendingDoses() }, {}, NOW);
            window.TodayDashboard.renderToday(state, root, { now: NOW });
            return state.missedDoses.value;
        };
        const groups = await paint();
        expect(groups.flatMap((g) => g.intakeIds).length).toBe(badge);
        expect(groups.flatMap((g) => g.intakeIds)).toEqual(expect.arrayContaining([slotId(1, OLD), slotId(2, at(9))]));
        const oldRow = [...root.querySelectorAll('[data-section="next-up"] [data-next="med-missed"]')]
            .find((r) => r.querySelector('.wg-row__title').textContent === 'Metformin');
        // Older than today: the Schedule tab's wording (pendingSlotLabel).
        const chipText = oldRow.querySelector('.wg-chip--danger').textContent;
        expect(chipText).toBe(`Missed ${window.pendingSlotLabel(new Date(OLD), new Date(NOW))}`);
        expect(chipText).toMatch(/ · (yesterday|\d+ days ago)$/);
        // The snoozed dose is listed as snoozed — the timeline's chip — not Missed.
        const snoozedRow = root.querySelector('[data-section="next-up"] [data-next="med-snoozed"]');
        expect(snoozedRow.querySelector('.wg-row__title').textContent).toBe('Losartan');
        expect(snoozedRow.querySelector('.wg-chip').textContent).toMatch(/^Snoozed until \d\d:\d\d$/);
        expect(snoozedRow.querySelector('.wg-chip--danger')).toBeNull();

        // The Meds tab badge, mounted: app-nav repaints it on the flip's
        // datastore:changed event from the same pending cache.
        const tabbar = document.createElement('nav');
        tabbar.className = 'wg-tabbar';
        const medsTab = document.createElement('a');
        medsTab.setAttribute('data-nav-id', 'meds');
        tabbar.appendChild(medsTab);
        document.body.appendChild(tabbar);
        window.featureSettings = { ...(window.featureSettings || {}), medication: true };
        const setBadge = vi.spyOn(window.WGBottomNav, 'setBadge').mockImplementation(() => {});

        // Take the 30h-old dose from Next up: before the POST goes out, the
        // sheet's optimistic flip is already in the one pending cache Today
        // and the badge read, the badge says badge − 1 — and nothing re-read
        // the pending set for it.
        const realApiCall = window.apiCall;
        const pendingReads = [];
        let atAct = null;
        window.apiCall = async (p, ...rest) => {
            if (String(p).startsWith('/api/doses?status=')) pendingReads.push(p);
            if (p === '/api/doses/act' && !atAct) {
                let badgeAtAct = null;
                await vi.waitFor(() => {
                    badgeAtAct = setBadge.mock.calls.length ? setBadge.mock.calls[setBadge.mock.calls.length - 1] : null;
                    expect(badgeAtAct).toEqual(['meds', badge - 1]);
                }).catch(() => {});
                atAct = { reads: pendingReads.length, groups: await paint(), badge: badgeAtAct };
            }
            return realApiCall(p, ...rest);
        };
        const refresh = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});
        oldRow.querySelector('[data-action="log-missed"]').click();
        const list = document.getElementById('med-confirm-list');
        await vi.waitFor(() => expect(list.querySelectorAll('.med-confirm-check').length).toBeGreaterThan(0));
        // The take's relay cancel-refire POST (cloud reminders) needs a fetch.
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        try {
            document.getElementById('med-confirm-action-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
            await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
        } finally {
            delete globalThis.fetch;
        }

        expect(atAct.badge).toEqual(['meds', badge - 1]);
        expect(atAct.reads).toBe(0);
        expect(atAct.groups.flatMap((g) => g.intakeIds)).not.toContain(slotId(1, OLD));
        expect(atAct.groups.flatMap((g) => g.intakeIds).length).toBe(badge - 1);
    });

    // bd med-wi09.18 — trigger-next-intake (MCP op, voice) writes the cluster
    // the Home card shows, read off the same projection rows; the raw planner
    // disagrees with them whenever a stored row keeps or cancels a dose.
    describe('trigger-next-intake confirms the cluster next-intake shows (bd med-wi09.18)', () => {
        const EARLY = at(6);
        const reload = (seed) => {
            env.cleanup();
            env = loadCloudShimFrontendEnv({ seedRecords: seed, now: () => EARLY, timeZone: TZ });
        };
        const trigger = () => env.window.apiCall('/api/medications/trigger-next-intake', 'POST', {});
        const intakeRows = async () => (await env.records.list('intake'))
            .map((i) => [i.recordId, i.medication_id, i.scheduled_at, i.status, i.source])
            .sort((a, b) => a[0].localeCompare(b[0]));

        it('a kept 08:00 is written, not the edited 09:00; cancelled and archived doses are not', async () => {
            reload({
                medication: [
                    // Edited 08:00 → 09:00 after today's 08:00 row was stored untaken.
                    med(1, 'Metformin', { type: 'daily', times: ['09:00'] }),
                    // 07:00 today was cancelled (tombstone); the planner still yields it.
                    med(2, 'Losartan', { type: 'daily', times: ['07:00'] }),
                    // Archived, with a stored PENDING row in the 08:00 cluster.
                    { ...med(3, 'Aspirin', { type: 'daily', times: ['08:00'] }), archived: true }
                ],
                intake: [
                    // Ledger v2 (bd med-wi09.12): a post-cut PENDING row is no
                    // evidence, so the untaken 08:00 is stored as UNTAKEN.
                    intake(slotId(1, at(8)), 1, at(8), { status: 'UNTAKEN' }),
                    intake(slotId(2, at(7)), 2, at(7), { deleted: true }),
                    intake(slotId(3, at(8)), 3, at(8))
                ]
            });

            const next = await call('/api/medications/next-intake');
            expect(next).toEqual({ scheduled_at: iso(at(8)), medication_ids: [1], medication_names: ['Metformin'] });

            const res = await trigger();
            expect(res).toMatchObject({
                status: 'confirmed', scheduled_at: next.scheduled_at, medication_count: 1, medication_names: ['Metformin']
            });
            expect(await intakeRows()).toEqual([
                [slotId(1, at(8)), 1, iso(at(8)), 'TAKEN', 'schedule'],
                [slotId(3, at(8)), 3, iso(at(8)), 'PENDING', 'schedule']
            ]);
        });

        it('a two-med cluster 5 min apart: each confirmed at its own instant, tz_step kept', async () => {
            const step = at(8) + 5 * 60_000;
            reload({
                medication: [
                    med(1, 'Metformin', { type: 'daily', times: ['08:00'] }),
                    med(2, 'Losartan', { type: 'daily', times: ['14:00'] })
                ],
                intake: [],
                tzplan: [{
                    ...seedRecords().tzplan[0],
                    steps: [{ medicationId: 2, medName: 'Losartan', stepNumber: 1, totalSteps: 1, scheduledAtMs: step, note: 'step' }]
                }]
            });

            const next = await call('/api/medications/next-intake');
            expect(next).toMatchObject({ scheduled_at: iso(at(8)), medication_ids: [1, 2] });

            const res = await trigger();
            expect(res).toMatchObject({ scheduled_at: iso(at(8)), medication_count: 2 });
            expect(await intakeRows()).toEqual([
                [slotId(1, at(8)), 1, iso(at(8)), 'TAKEN', 'schedule'],
                [slotId(2, step), 2, iso(step), 'TAKEN', 'tz_step']
            ]);
        });
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

// bd med-wi09.13: stock is a ledger — the last count + refills since − doses
// taken since — and medication.inventory_count is a write-only mirror of it.
describe('stock ledger (bd med-wi09.13)', () => {
    const T = (hh) => Date.UTC(2026, 9, 20, hh, 0, 0);
    const iso = (ms) => new Date(ms).toISOString();
    const AS_NEEDED = JSON.stringify({ type: 'as_needed' });
    const med = (over = {}) => ({
        recordId: 1, clientTs: 1, deleted: false, name: 'Metformin', dosage: '500mg', schedule: AS_NEEDED,
        archived: false, supplement: false, inventory_count: 10, tz_shift_policy: 'flexible', created_at: iso(T(0)), ...over,
    });
    const audit = (count, atMs, id = 'a1') => ({
        recordId: `stock-1-${atMs}-${id}`, clientTs: atMs, deleted: false, medication_id: 1, kind: 'audit', count, at: iso(atMs),
    });
    const takenRow = (atMs, id = `intake-manual-${atMs}-1`) => ({
        recordId: id, clientTs: atMs, deleted: false, medication_id: 1, scheduled_at: iso(atMs), taken_at: iso(atMs),
        status: 'TAKEN', snoozed_until: null, source: 'schedule', rev: 1, via: 'app', acted_at: iso(atMs),
    });
    let env;
    let clock;
    const open = (seedRecords) => {
        env = loadCloudShimFrontendEnv({ seedRecords, now: () => clock, timeZone: 'UTC' });
        return env;
    };
    const derived = async (e = env) => (await e.window.apiCall('/api/medications'))[0].inventory_count;
    const mirror = async (e = env) => (await e.records.list('medication'))[0].inventory_count;

    afterEach(() => {
        if (env) env.cleanup();
        env = null;
    });

    it('an offline dose at 11:00 and an online refill at 12:00 both land: 10 − 1 + 10 = 19', async () => {
        clock = T(12);
        open({ medication: [med()], stock: [audit(10, T(9))] });
        const res = await env.window.apiCall('/api/medications/1/restock', 'POST', { quantity: 10 });
        expect(res).toEqual({ status: 'restocked', quantity_added: 10, inventory_count: 20 });
        // The phone's dose syncs in after the refill.
        await env.records.put('intake', takenRow(T(11)));
        expect(await derived()).toBe(19);
        expect(await env.window.apiCall('/api/inventory/low', 'GET')).toEqual([]);
    });

    it('two concurrent refills from two devices both count', async () => {
        clock = T(12);
        const seed = () => ({ medication: [med()], stock: [audit(10, T(9))] });
        const a = loadCloudShimFrontendEnv({ seedRecords: seed(), now: () => clock, timeZone: 'UTC' });
        const b = loadCloudShimFrontendEnv({ seedRecords: seed(), now: () => clock, timeZone: 'UTC' });
        try {
            await a.window.apiCall('/api/medications/1/restock', 'POST', { quantity: 30 });
            await b.window.apiCall('/api/medications/1/restock', 'POST', { quantity: 30 });
            // Sync: each device receives the other's refill row (distinct ids).
            const rowsA = await a.records.list('stock');
            const rowsB = await b.records.list('stock');
            for (const r of rowsB) await a.records.put('stock', r);
            for (const r of rowsA) await b.records.put('stock', r);
            expect(await derived(a)).toBe(70);
            expect(await derived(b)).toBe(70);
        } finally {
            a.cleanup();
            b.cleanup();
        }
    });

    it('moving taken_at across a count changes the stock: a dose before the count is already in it', async () => {
        clock = T(12);
        open({ medication: [med()], stock: [audit(10, T(10))] });
        const dose = await env.window.apiCall('/api/medications/log-past', 'POST', { medication_id: 1, taken_at: iso(T(11)) });
        expect(await derived()).toBe(9);
        await env.window.apiCall('/api/doses/act', 'POST', { action: 'edit_time', occ_ids: [dose.id], taken_at: iso(T(9)) });
        expect(await derived()).toBe(10);
        // A time edit alone (TAKEN stays TAKEN) still refreshes the mirror.
        expect(await mirror()).toBe(10);
        await env.window.apiCall('/api/doses/act', 'POST', { action: 'edit_time', occ_ids: [dose.id], taken_at: iso(T(11) + 60000) });
        expect(await derived()).toBe(9);
        expect(await mirror()).toBe(9);
    });

    it('a count is the new starting point: later doses come off it, earlier ones are not rewritten', async () => {
        clock = T(12);
        open({ medication: [med()], stock: [audit(10, T(8))], intake: [takenRow(T(9))] });
        expect(await derived()).toBe(9);
        const res = await env.window.apiCall('/api/medications/1/stock-audit', 'POST', { count: 45 });
        expect(res).toEqual({ status: 'counted', inventory_count: 45 });
        clock = T(13);
        await env.window.apiCall('/api/medications/log-past', 'POST', { medication_id: 1, taken_at: iso(T(13)) });
        const [m] = await env.window.apiCall('/api/medications');
        expect(m.inventory_count).toBe(44);
        expect(m.stock).toMatchObject({ counted: 45, seed: false, refills: [], taken: 1 });
        expect(await mirror()).toBe(44);
        await expect(env.window.offlineAwareApiCall('/api/medications/1/stock-audit', 'POST', { count: -1 }))
            .rejects.toMatchObject({ status: 400 });
    });

    it('a med tracked before the ledger is seeded at its first move (floored, put-if-absent) and keeps its number', async () => {
        clock = T(12);
        // Old inventory 5, after a dose an old client already took off it.
        open({ medication: [med({ inventory_count: 5 })], intake: [takenRow(T(8))] });
        expect(await derived()).toBe(5);
        const dose = await env.window.apiCall('/api/medications/log-past', 'POST', { medication_id: 1, taken_at: iso(T(11)) });
        expect(await derived()).toBe(4);
        expect(await mirror()).toBe(4);
        const [seed] = await env.records.list('stock');
        // Back-projected over the evidence: 5 + the 1 dose already taken off it.
        expect(seed).toMatchObject({ recordId: `stock-1-${T(12)}-seed6`, clientTs: 0, kind: 'audit', count: 6, seed: true });
        // An undo of a dose from before the seed still gives it back.
        await env.window.apiCall('/api/doses/act', 'POST', { action: 'undo', occ_ids: [takenRow(T(8)).recordId] });
        await env.window.apiCall('/api/doses/act', 'POST', { action: 'undo', occ_ids: [dose.id] });
        expect(await derived()).toBe(6);
        expect(await mirror()).toBe(6);
        // An older client's write to the mirror is not read.
        await env.records.put('medication', { ...(await env.records.list('medication'))[0], inventory_count: 99 });
        expect(await derived()).toBe(6);
    });

    it('two devices seeding differently converge: the earliest seed wins, a real count beats any seed', async () => {
        clock = T(12);
        const seed = (atMs, count) => ({ ...audit(count, atMs, `seed${count}`), clientTs: 0, seed: true });
        open({ medication: [med()], stock: [seed(T(10), 12), seed(T(9), 11)], intake: [takenRow(T(8))] });
        // Seeds count every dose: 11 − 1.
        expect(await derived()).toBe(10);
        expect((await env.window.apiCall('/api/medications'))[0].stock).toMatchObject({ counted: 10, seed: true, taken: 0 });
        await env.records.put('stock', audit(30, T(7), 'real'));
        expect(await derived()).toBe(29);
    });

    it('a refill on a tracked med with no ledger yet seeds it first: derived and mirror = old + n', async () => {
        clock = T(12);
        // Old inventory 10, after a dose an old client already took off it.
        open({ medication: [med({ inventory_count: 10 })], intake: [takenRow(T(8))] });
        const res = await env.window.apiCall('/api/medications/1/restock', 'POST', { quantity: 5 });
        expect(res).toMatchObject({ status: 'restocked', inventory_count: 15 });
        const seed = (await env.records.list('stock')).find((r) => r.seed);
        expect(seed).toMatchObject({ kind: 'audit', count: 11, clientTs: 0 });
        expect(await derived()).toBe(15);
        expect(await mirror()).toBe(15);
    });

    it('an older client\'s restock row after the seed counts into derived stock and the next mirror', async () => {
        clock = T(12);
        const seed = { ...audit(10, T(9), 'seed10'), clientTs: 0, seed: true };
        open({ medication: [med({ inventory_count: 10 })], stock: [seed] });
        // An old bundle's POST /restock: a `restock` row (and its own mirror bump, ignored).
        await env.records.put('restock', {
            recordId: 'restock-old-1', clientTs: T(10), deleted: false, medication_id: 1, quantity: 5, restocked_at: iso(T(10)),
        });
        expect(await derived()).toBe(15);
        await env.window.apiCall('/api/medications/log-past', 'POST', { medication_id: 1, taken_at: iso(T(11)) });
        expect(await derived()).toBe(14);
        expect(await mirror()).toBe(14);
    });

    it('a batch of N dose writes reads the intake evidence a bounded number of times, not N (breakage F3)', async () => {
        clock = T(12);
        const rows = [7, 8, 9, 10, 11].map((h) => takenRow(T(h)));
        open({ medication: [med()], stock: [audit(10, T(6))], intake: rows });
        expect(await derived()).toBe(5);
        const list = vi.spyOn(env.records, 'list');
        const raw = env.records.listRaw ? vi.spyOn(env.records, 'listRaw') : null;
        const intakeReads = () => [...list.mock.calls, ...(raw ? raw.mock.calls : [])]
            .filter(([type]) => type === 'intake').length;
        const undo = async (ids) => {
            list.mockClear();
            if (raw) raw.mockClear();
            await env.window.apiCall('/api/doses/act', 'POST', { action: 'undo', occ_ids: ids });
            return intakeReads();
        };
        const one = await undo([rows[0].recordId]);
        const four = await undo(rows.slice(1).map((r) => r.recordId));
        expect(four).toBe(one);
        expect(await derived()).toBe(10);
        expect(await mirror()).toBe(10);
        // A write that moves no stock (a skip of a never-taken dose) reads no
        // evidence for the ledger at all.
        list.mockClear();
        await createIntakeDomain({ records: env.records, now: () => clock, timeZone: 'UTC' }).skip(rows[0].recordId);
        expect(list.mock.calls.filter(([type]) => type === 'stock')).toHaveLength(0);
    });

    it('pack_size is optional: kept when an update omits it, cleared by null', async () => {
        clock = T(12);
        open({ medication: [med()] });
        const base = { name: 'Metformin', dosage: '500mg', schedule: AS_NEEDED, inventory_count: 10 };
        await env.window.apiCall('/api/medications/1', 'POST', { ...base, pack_size: 28 });
        expect((await env.window.apiCall('/api/medications'))[0].pack_size).toBe(28);
        await env.window.apiCall('/api/medications/1', 'POST', base);
        expect((await env.window.apiCall('/api/medications'))[0].pack_size).toBe(28);
        // A tracked med's count is not set through the editor.
        await env.window.apiCall('/api/medications/1', 'POST', { ...base, inventory_count: 50, pack_size: null });
        const [m] = await env.window.apiCall('/api/medications');
        expect(m.pack_size).toBeUndefined();
        expect(m.inventory_count).toBe(10);
    });
});

// bd med-wi09.19 — an account with no pinned zone gets one: the first device
// to resolve it floors its own zone (tzfloor, clientTs 0, putIfAbsent), so a
// second device in another zone projects the same instants and occIds.
describe('account zone floor — one projection zone per account (bd med-wi09.19)', () => {
    const NOW = Date.UTC(2026, 2, 10, 5, 0); // 06:00 Berlin (CET), 01:00 New York (EDT)
    const iso = (ms) => new Date(ms).toISOString();
    const effects = { scheduleReminderRecompute() {}, cancelMedRefire() {}, rearmMedRefire() {} };
    const med = {
        recordId: 1, clientTs: 1, deleted: false, name: 'Metformin', dosage: '500mg',
        schedule: JSON.stringify({ type: 'daily', times: ['08:00'] }), archived: false,
        start_date: null, end_date: null, inventory_count: null, tz_shift_policy: 'flexible',
        created_at: '2026-01-01T00:00:00.000Z',
    };
    const device = (records, timeZone, now = NOW) => createApiRouter({}, {
        records, win: {}, effects, now: () => now, timeZone,
    });
    // One pull: sync.js applyIncoming for every type this suite writes —
    // tzfloor through its reducer, the rest strict-> LWW.
    const sync = async (from, to) => {
        for (const type of ['medication', 'settings', 'tzfloor', 'intake']) {
            for (const r of await from.listRaw(type)) {
                const cur = (await to.listRaw(type)).find((x) => x.recordId === r.recordId);
                const won = type === 'tzfloor' ? mergeTzFloor(cur, r) : applyIncomingReplica(cur, r);
                if (won !== cur) await to.put(type, won);
            }
        }
    };
    // The boot floors once it has pulled (cloud-boot.js → floorTimeZone), never
    // a request; each read here stands in for a device's first open.
    const doses = async (call) => {
        await call.floorTimeZone();
        return call(`/api/doses?from=${iso(NOW)}&to=${iso(NOW + 24 * 3600_000)}`);
    };
    const floorOf = async (records) => (await records.list('tzfloor'))[0];

    it('device A floors its zone at clientTs 0; device B then projects A\'s instants and resolves A\'s occIds', async () => {
        const a = createInMemoryRecordsPort({ medication: [med] });
        const onA = await doses(device(a, 'Europe/Berlin'));
        expect(await floorOf(a)).toMatchObject({ timezone: 'Europe/Berlin', clientTs: 0, at: NOW });
        expect(await a.list('settings')).toEqual([]); // the pin stays unset
        expect(onA.map((d) => d.plannedAt)).toEqual([iso(Date.UTC(2026, 2, 10, 7, 0))]); // 08:00 Berlin

        const b = createInMemoryRecordsPort();
        await sync(a, b);
        const callB = device(b, 'America/New_York');
        expect((await doses(callB)).map((d) => d.occId)).toEqual(onA.map((d) => d.occId));
        expect((await floorOf(b)).timezone).toBe('Europe/Berlin'); // B wrote no floor of its own
        expect((await callB('/api/doses/act', 'POST', { occ_ids: [onA[0].occId], action: 'take' })).updated).toBe(1);
        expect((await callB('/api/settings')).timezone_source).toBe('floor');
    });

    it('an explicit pick on B replaces the floor on A after sync', async () => {
        const a = createInMemoryRecordsPort({ medication: [med] });
        await doses(device(a, 'Europe/Berlin'));
        const b = createInMemoryRecordsPort();
        await sync(a, b);
        const callB = device(b, 'America/New_York', NOW + 60_000);
        expect(await callB('/api/settings', 'POST', { timezone: 'America/New_York' })).toEqual({ changed: true, planCreated: false });
        await sync(b, a);
        const callA = device(a, 'Europe/Berlin', NOW + 120_000);
        expect(await callA('/api/settings')).toMatchObject({ timezone: 'America/New_York', timezone_source: 'pinned' });
        expect((await doses(callA)).map((d) => d.plannedAt)).toEqual([iso(Date.UTC(2026, 2, 10, 12, 0))]); // 08:00 New York (EDT since Mar 8)
    });

    it('two devices that floor before seeing each other converge on the earlier floor', async () => {
        const a = createInMemoryRecordsPort({ medication: [med] });
        const b = createInMemoryRecordsPort({ medication: [med] });
        await doses(device(b, 'America/New_York', NOW + 5_000));
        await doses(device(a, 'Europe/Berlin', NOW));
        await sync(a, b);
        await sync(b, a);
        expect((await floorOf(a)).timezone).toBe('Europe/Berlin');
        expect((await floorOf(b)).timezone).toBe('Europe/Berlin');
        expect((await doses(device(b, 'America/New_York'))).map((d) => d.occId))
            .toEqual((await doses(device(a, 'Europe/Berlin'))).map((d) => d.occId));
    });

    it('never floors over a pinned zone, and local-only mode never floors', async () => {
        const pinned = createInMemoryRecordsPort({
            medication: [med], settings: [{ recordId: 'settings', clientTs: NOW, deleted: false, timezone: 'Asia/Tokyo' }],
        });
        const callPinned = device(pinned, 'Europe/Berlin');
        expect(await callPinned.floorTimeZone()).toBe(false);
        expect(await callPinned('/api/settings')).toMatchObject({ timezone: 'Asia/Tokyo', timezone_source: 'pinned' });
        expect(await pinned.list('tzfloor')).toEqual([]);

        const local = createInMemoryRecordsPort({ medication: [med] });
        const callLocal = createApiRouter({}, {
            recordsPort: () => local, win: {}, effects, now: () => NOW, timeZone: 'Europe/Berlin',
        });
        expect(await callLocal.floorTimeZone()).toBe(false);
        expect(await callLocal('/api/settings')).toMatchObject({ timezone: 'Europe/Berlin', timezone_source: 'device' });
        expect(await local.list('tzfloor')).toEqual([]);
    });

    // Breakage F1 (Archie 5889): the floor takes the zone the dose evidence is
    // in, so a device whose last logged dose is New York-stamped does not
    // switch today's slots to Berlin (a reminder at 02:00 NY that vanishes as
    // "out of date", and the 08:00 NY dose due with no reminder).
    it('floors the zone of the last logged dose, not the flooring device\'s own', async () => {
        const yesterdayNY = Date.UTC(2026, 2, 9, 12, 0); // 08:00 New York (EDT)
        const taken = {
            recordId: `intake-1-${yesterdayNY / 1000}`, clientTs: yesterdayNY, deleted: false, medication_id: 1,
            scheduled_at: iso(yesterdayNY), taken_at: iso(yesterdayNY), status: 'TAKEN', snoozed_until: null,
            source: 'schedule', tz: 'America/New_York', rev: 1,
        };
        const a = createInMemoryRecordsPort({ medication: [med], intake: [taken] });
        const onA = await doses(device(a, 'Europe/Berlin'));
        expect(await floorOf(a)).toMatchObject({ timezone: 'America/New_York', clientTs: 0 });
        expect(onA.map((d) => d.plannedAt)).toEqual([iso(Date.UTC(2026, 2, 10, 12, 0))]); // 08:00 NY, not 07:00Z

        const b = createInMemoryRecordsPort();
        await sync(a, b);
        const callB = device(b, 'America/New_York', NOW + 2 * 3600_000); // 07:00Z: past 08:00 Berlin
        expect((await doses(callB)).map((d) => [d.occId, d.state])).toEqual(onA.map((d) => [d.occId, 'upcoming']));
    });

    it('a zone this engine cannot read is skipped, keeps its source, and is never floored over', async () => {
        const pinned = createInMemoryRecordsPort({
            medication: [med], settings: [{ recordId: 'settings', clientTs: NOW, deleted: false, timezone: 'Mars/Olympus_Mons' }],
        });
        const callUnreadable = device(pinned, 'Europe/Berlin');
        expect(await callUnreadable.floorTimeZone()).toBe(false);
        expect(await callUnreadable('/api/settings')).toMatchObject({ timezone: 'Europe/Berlin', timezone_source: 'pinned' });
        expect(await pinned.list('tzfloor')).toEqual([]);

        const floored = createInMemoryRecordsPort({
            medication: [med], tzfloor: [{ recordId: 'tzfloor', clientTs: 0, deleted: false, timezone: 'Mars/Olympus_Mons', at: 1 }],
        });
        expect(await device(floored, 'Asia/Tokyo')('/api/settings')).toMatchObject({ timezone: 'Asia/Tokyo', timezone_source: 'floor' });
    });

    // Argus r1 (2), kept per Miles 5887: a device in another zone now gets the
    // launch travel prompt; a dismissal sticks for that detected zone.
    it('the launch prompt fires on a device off the floored zone, and a dismissal sticks', async () => {
        const a = createInMemoryRecordsPort({ medication: [med] });
        await doses(device(a, 'Europe/Berlin'));
        const b = createInMemoryRecordsPort();
        await sync(a, b);
        const callB = device(b, 'America/New_York');
        const ask = () => callB(`/api/tz-suggestion/should-prompt?detected_tz=${encodeURIComponent('America/New_York')}`);
        expect(await ask()).toMatchObject({ prompt: true, current_tz: 'Europe/Berlin' });
        await callB('/api/tz-suggestion/dismiss', 'POST', { detected_tz: 'America/New_York' });
        expect((await ask()).prompt).toBe(false);
        expect(await callB('/api/settings')).toMatchObject({ timezone: 'Europe/Berlin', timezone_source: 'floor' });
    });

    it('a router told not to floor (the inbox applier) never writes one', async () => {
        const records = createInMemoryRecordsPort({ medication: [med] });
        const call = createApiRouter({}, {
            records, win: {}, effects, now: () => NOW, timeZone: 'Europe/Berlin', canFloor: async () => false,
        });
        expect((await call('/api/settings')).timezone_source).toBe('device');
        await doses(call);
        expect(await records.list('tzfloor')).toEqual([]);
    });

    it('a request never floors: only the boot\'s floorTimeZone does (GET /api/brief reads its sections only)', async () => {
        const records = createInMemoryRecordsPort({ medication: [med] });
        const call = device(records, 'Europe/Berlin');
        await call(`/api/doses?from=${iso(NOW)}&to=${iso(NOW + 24 * 3600_000)}`);
        expect(await call('/api/settings')).toMatchObject({ timezone: 'Europe/Berlin', timezone_source: 'device' });
        expect(await records.list('tzfloor')).toEqual([]);
    });

    it('floorTimeZone waits for canFloor, then floors once', async () => {
        const records = createInMemoryRecordsPort({ medication: [med] });
        let up = false;
        const call = createApiRouter({}, {
            records, win: {}, effects, now: () => NOW, timeZone: 'Europe/Berlin', caughtUp: async () => up,
        });
        expect(await call.floorTimeZone()).toBe(false);
        expect((await call('/api/settings')).timezone_source).toBe('device');
        expect(await records.list('tzfloor')).toEqual([]);
        up = true;
        expect(await call.floorTimeZone()).toBe(true);
        expect((await call('/api/settings')).timezone_source).toBe('floor');
        expect(await call.floorTimeZone()).toBe(false); // once
    });
});

// bd med-2l38 — five doses of one 08:20 Tbilisi slot stored UNTAKEN rev 2 (taken
// and undone the night before, the raw rows of the report). Focus Take, then
// Today's take sheet for the rest: every write lands, and the Timeline and
// Today's pending set agree after each, with no reload.
describe('acting on undone doses from Focus and Today (bd med-2l38)', () => {
    const TZ = 'Asia/Tbilisi';
    const SLOT = 1792988400; // 2026-10-26 08:20 Tbilisi
    const NOW = Date.parse('2026-10-26T09:45:00.000Z');
    const MED_IDS = [2, 4, 7, 9, 16];
    const occ = (id) => `intake-${id}-${SLOT}`;
    const seed = () => ({
        medication: MED_IDS.map((id) => ({
            recordId: id, clientTs: 1, deleted: false, name: `Med ${id}`, dosage: '10mg',
            schedule: JSON.stringify({ type: 'daily', times: ['08:20'] }), archived: false,
            start_date: null, end_date: null, inventory_count: null, tz_shift_policy: 'flexible',
            created_at: '2026-09-01T00:00:00.000Z',
        })),
        ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: '2026-10-26T01:00:00.000Z' }],
        intake: MED_IDS.map((id) => ({
            recordId: occ(id), clientTs: 1792964412818, deleted: false, medication_id: id,
            scheduled_at: new Date(SLOT * 1000).toISOString(), taken_at: null, status: 'UNTAKEN',
            snoozed_until: null, source: 'schedule', rev: 2, acted_at: '2026-10-25T21:40:12.818Z',
            via: 'app', tz: TZ, note: 'Undone; was taken at 2026-10-25T21:40:00.802Z',
        })),
    });

    let env;
    afterEach(async () => {
        await materializationSettled();
        env.cleanup();
        env = null;
        delete globalThis.fetch;
    });

    it('Focus Take, then Today\'s sheet for the rest: every write lands, Timeline and Today agree after each, no reload', async () => {
        env = loadCloudShimFrontendEnv({ seedRecords: seed(), now: () => NOW, timeZone: TZ });
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }); // the take's relay cancel-refire
        const { window, document } = env;
        installApiCache(window);
        window.Date.now = () => NOW;
        window.loadMeds = async () => {};
        window.medications = MED_IDS.map((id) => ({ id, name: `Med ${id}`, dosage: '10mg' }));
        window.eval(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../features/today.js'), 'utf8'));
        const acts = [];
        const realApiCall = window.apiCall;
        window.apiCall = async (p, method, body) => {
            const res = await realApiCall(p, method, body);
            if (p === '/api/doses/act') acts.push(res);
            return res;
        };
        const features = { medication: true, bp: false, weight: false, food: false, workout: false, health: false, gamification: false };
        const medications = await realApiCall('/api/medications');
        const root = document.createElement('div');
        document.body.appendChild(root);
        // Today's Next up, painted from the pending cache it reads.
        const todayDue = async () => {
            const state = window.TodayDashboard.aggregateToday(
                { features, medications, intake_history: await window.readCachedPendingDoses() }, {}, NOW);
            window.TodayDashboard.renderToday(state, root, { now: NOW });
            return state.missedDoses.value.flatMap((g) => g.intakeIds).sort();
        };
        const focusRow = () => document.querySelector('#med-timeline-list .wg-tl-focus .wg-timeline__row');
        const timelineDue = () => Array.from(document.querySelectorAll('#med-timeline-list .wg-timeline__row[data-state="due"]'))
            .flatMap((r) => r.dataset.occIds.split(' ')).sort();
        const stored = async () => (await env.records.list('intake')).filter((i) => i.status === 'TAKEN').map((i) => i.recordId).sort();

        await window.loadTimeline();
        expect(timelineDue()).toEqual(MED_IDS.map(occ).sort());
        expect(await todayDue()).toEqual(MED_IDS.map(occ).sort());

        // Focus holds one dose: its Take writes that one (UNTAKEN acts like
        // PENDING — no refusal), and Today's Next up drops the same one.
        const first = focusRow().dataset.occIds;
        focusRow().querySelector('.wg-btn--primary').click();
        await vi.waitFor(() => expect(acts).toHaveLength(1));
        expect(acts[0]).toMatchObject({ updated: 1, failed: 0 });
        await vi.waitFor(async () => expect(await stored()).toEqual([first]));
        const rest = MED_IDS.map(occ).filter((id) => id !== first).sort();
        await vi.waitFor(() => expect(timelineDue()).toEqual(rest));
        expect(await todayDue()).toEqual(rest);

        // Today's sheet on the rest of the slot: all four land, both surfaces
        // empty, the Focus card is done.
        root.querySelector('[data-section="next-up"] [data-action="log-missed"]').click();
        await vi.waitFor(() => expect(document.querySelectorAll('#med-confirm-list .med-confirm-check')).toHaveLength(4));
        document.getElementById('med-confirm-action-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
        await vi.waitFor(() => expect(acts).toHaveLength(2));
        expect(acts[1]).toMatchObject({ updated: 4, failed: 0 });
        await vi.waitFor(async () => expect(await stored()).toEqual(MED_IDS.map(occ).sort()));
        await vi.waitFor(() => expect(timelineDue()).toEqual([]));
        expect(await todayDue()).toEqual([]);
        await materializationSettled();
        await window.loadTimeline();
        expect(timelineDue()).toEqual([]);
        expect(focusRow()).toBeNull();
    });
});
