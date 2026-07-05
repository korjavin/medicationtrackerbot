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
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

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
