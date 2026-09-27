// med-niix.1 — shim-mode contract for the equipment inventory routes against
// web/domain/equipment.js. Drives window.apiCall / window.apiCallDirect
// (core/api.js), which delegate to the cloud shim (web/cloud/js/apishim.js)
// instead of the network — same pattern as
// cloud.shim-contract.workout-crud.test.js.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — workout equipment CRUD', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('fixed create/list/get/update/delete round-trips through the shim', async () => {
        const { window } = env;
        const created = await window.apiCall('/api/workout/equipment', 'POST', {
            kind: 'fixed', name: 'Hex DBs', loads_kg: [10, 12, 14, 16],
        });
        expect(created.id).toBeGreaterThan(0);
        expect(created.loads_kg).toEqual([10, 12, 14, 16]);
        expect(created.min_step_kg).toBe(2);
        expect(created.max_kg).toBe(16);

        let list = await window.apiCallDirect('/api/workout/equipment');
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('Hex DBs');

        const got = await window.apiCallDirect(`/api/workout/equipment/${created.id}`);
        expect(got.loads_kg).toEqual([10, 12, 14, 16]);

        await window.apiCall(`/api/workout/equipment/${created.id}`, 'PUT', {
            kind: 'fixed', name: 'Hex DBs v2', loads_kg: [10, 12],
        });
        list = await window.apiCallDirect('/api/workout/equipment');
        expect(list[0].name).toBe('Hex DBs v2');
        expect(list[0].max_kg).toBe(12);

        await window.apiCall(`/api/workout/equipment/${created.id}`, 'DELETE');
        expect(await window.apiCallDirect('/api/workout/equipment')).toHaveLength(0);
    });

    it('plated create returns computed loads with min_step 2.5', async () => {
        const { window } = env;
        const created = await window.apiCall('/api/workout/equipment', 'POST', {
            kind: 'plated', name: 'Ohio bar', bar_kg: 20, sides: 2,
            plates: [1.25, 2.5, 5, 10, 20].map((kg) => ({ kg, count: 2 })),
        });
        expect(created.loads_kg).toContain(22.5);
        expect(created.loads_kg).toContain(25);
        expect(created.min_step_kg).toBe(2.5);
    });

    it('implement round-trips on fixed writes and defaults on plated writes', async () => {
        const { window } = env;
        const fixed = await window.apiCall('/api/workout/equipment', 'POST', {
            kind: 'fixed', name: 'KB', loads_kg: [8], implement: 'kettlebell',
        });
        expect(fixed.implement).toBe('kettlebell');
        const list = await window.apiCallDirect('/api/workout/equipment');
        expect(list[0].implement).toBe('kettlebell');

        const plated = await window.apiCall('/api/workout/equipment', 'POST', {
            kind: 'plated', name: 'Bell', bar_kg: 8, sides: 1, plates: [],
        });
        expect(plated.implement).toBe('kettlebell');
    });

    it('unknown numeric ids read as 404', async () => {
        const { window } = env;
        await expect(window.offlineAwareApiCall('/api/workout/equipment/999999'))
            .rejects.toThrow();
    });

    it('validation failures reject: missing name, bad kind, bad implement', async () => {
        const { window } = env;
        await expect(window.offlineAwareApiCall('/api/workout/equipment', 'POST', {
            kind: 'fixed', loads_kg: [10],
        })).rejects.toThrow(/Name is required/);
        await expect(window.offlineAwareApiCall('/api/workout/equipment', 'POST', {
            kind: 'bands', name: 'x',
        })).rejects.toThrow(/kind must be/);
        await expect(window.offlineAwareApiCall('/api/workout/equipment', 'POST', {
            kind: 'fixed', name: 'x', loads_kg: [10], implement: 'rack',
        })).rejects.toThrow(/implement must be/);
    });
});
