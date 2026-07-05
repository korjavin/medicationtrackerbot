// Plan 2026-07-05 cloud-c1, Task 7 — shim-mode contract run of the weight
// feature flows against web/domain/weight.js. Drives the real feature code
// (handleWeightSubmit / editWeightLog / _deleteWeightApi) through the real
// window.apiCall (core/api.js), which delegates to the cloud shim
// (web/cloud/js/apishim.js) instead of the network, including the
// `?replaces=` edit path. Additive suite — the original (network-mocked)
// features.weight.test.js keeps running unshimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateWeightTrend } from '../../../domain/weight.js';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

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
        WeightStore: {
            getPending: async () => [],
            getRejected: async () => [],
            getAll: async () => [],
            confirmDelete: async () => undefined
        }
    };
    return map;
}

function daysAgoLocalInput(days, hour = 8) {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

describe('cloud shim contract — weight flows (features/weight.js over web/domain/weight.js)', () => {
    let env;
    let cache;
    // handleWeightSubmit/_deleteWeightApi fire-and-forget their trailing
    // loadWeightLogs() refresh (not awaited — unlike bp.js's handleBPSubmit).
    // Mock the global so that stray call is a no-op, and drive the real
    // implementation explicitly via this saved reference so cache reads
    // right after a submit/delete are deterministic.
    let realLoadWeightLogs;

    function setupEnv(seedRecords) {
        if (env) env.cleanup();
        env = loadCloudShimFrontendEnv({ seedRecords });
        cache = installApiCache(env.window);
        env.window.loadToday = vi.fn();
        env.window.setWeightUnitPreference = vi.fn();
        env.window.SyncManager = { isOnline: true, updateStatus: () => {} };
        realLoadWeightLogs = env.window.loadWeightLogs;
        env.window.loadWeightLogs = vi.fn();
    }

    async function submitWeightLog(window, document, { daysAgo, weight, notes = '' }) {
        window.showWeightModal();
        document.getElementById('weight-datetime').value = daysAgoLocalInput(daysAgo);
        document.getElementById('weight-value').value = String(weight);
        document.getElementById('weight-notes').value = notes;
        await window.handleWeightSubmit({ preventDefault() {} });
        await realLoadWeightLogs();
    }

    beforeEach(() => {
        setupEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('save then list round-trips through the shim, trend seeded to the first weight', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 2, weight: 80.0 });

        const w = cache.get('weight');
        expect(w).toBeTruthy();
        expect(w.logsRes).toHaveLength(1);
        expect(w.logsRes[0].weight).toBe(80.0);
        expect(w.logsRes[0].weight_trend).toBe(calculateWeightTrend(80.0, null));
        expect(w.logsRes[0].weight_trend).toBe(80.0);
    });

    it('a second log computes the EMA trend against the first', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 2, weight: 80.0 });
        await submitWeightLog(window, document, { daysAgo: 1, weight: 79.0 });

        const w = cache.get('weight');
        const newest = w.logsRes.find((l) => l.weight === 79.0);
        expect(newest.weight_trend).toBeCloseTo(calculateWeightTrend(79.0, 80.0), 10);
    });

    it('getGoal merges a synced goal record with the highest-ever weight', async () => {
        // Goal-setting is not part of the ported HTTP surface (server only
        // exposes GET /api/weight/goal — internal/server/server.go:840), so
        // the goal record arrives via sync (recordsPort), not a POST call.
        const now = Date.now();
        const daysAgoIso = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
        setupEnv({
            weight: [
                { recordId: 'w1', clientTs: now - 2, deleted: false, measured_at: daysAgoIso(2), weight: 82.0, weight_trend: 82.0, body_fat: null, muscle_mass: null, notes: '' },
                { recordId: 'w2', clientTs: now - 1, deleted: false, measured_at: daysAgoIso(1), weight: 79.0, weight_trend: 78.7, body_fat: null, muscle_mass: null, notes: '' }
            ],
            weightgoal: [{ recordId: 'g1', clientTs: now, deleted: false, set_at: new Date(now).toISOString(), target_weight: 75.0, target_date: null, start_weight: 82.0 }]
        });

        const getRes = await env.window.apiCall('/api/weight/goal');
        expect(getRes.goal).toBe(75.0);
        expect(getRes.highest_weight).toBe(82.0);
    });

    it('editing the latest log via ?replaces= excludes the replaced row from the trend calc', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 2, weight: 80.0 });
        const original = cache.get('weight').logsRes[0];

        window.editWeightLog(original);
        document.getElementById('weight-value').value = '81.0';
        document.getElementById('weight-datetime').value = daysAgoLocalInput(1);
        await window.handleWeightSubmit({ preventDefault() {} });
        await realLoadWeightLogs();

        const w = cache.get('weight');
        // The replaced row is gone — only the edited entry remains.
        expect(w.logsRes).toHaveLength(1);
        expect(w.logsRes[0].weight).toBe(81.0);
        // No prior trend survives the replace (the only earlier log was the
        // one just replaced), so the new entry seeds to its own weight —
        // exactly the weight_handlers.go:39-45 ?replaces= semantics.
        expect(w.logsRes[0].weight_trend).toBe(calculateWeightTrend(81.0, null));

        const listRes = await window.apiCall('/api/weight?days=0&limit=1000');
        expect(listRes).toHaveLength(1);
        expect(listRes[0].id).not.toBe(original.id);
    });

    it('PATCH /api/settings/weight-unit persists and is echoed by bootstrap (no 404 alert)', async () => {
        const { window } = env;
        // The Settings kg/lb toggle is always present in cloud mode; before the
        // shim mapped this route it fell through to the 404 path, which api.js
        // turns into a user-facing alert + reverted preference.
        const res = await window.apiCall('/api/settings/weight-unit', 'PATCH', { unit: 'lb' });
        expect(res).toEqual({ unit: 'lb' });

        const boot = await window.apiCall('/api/bootstrap');
        expect(boot.settings.weight_unit_preference).toBe('lb');
    });

    it('_deleteWeightApi removes the log from the shim-backed store', async () => {
        const { window, document } = env;
        await submitWeightLog(window, document, { daysAgo: 1, weight: 80.0 });
        const id = cache.get('weight').logsRes[0].id;

        await window._deleteWeightApi(id);
        await realLoadWeightLogs();

        expect(cache.get('weight').logsRes).toHaveLength(0);
        const listRes = await window.apiCall('/api/weight?days=0&limit=1000');
        expect(listRes).toHaveLength(0);
    });
});
