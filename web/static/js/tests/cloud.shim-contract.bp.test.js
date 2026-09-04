// Plan 2026-07-05 cloud-c1, Task 7 — shim-mode contract run of the BP
// feature flows against web/domain/bp.js. Drives the real feature code
// (handleBPSubmit / loadBPReadings / _deleteBPApi) through the real
// window.apiCall (core/api.js), which delegates to the cloud shim
// (web/cloud/js/apishim.js) instead of the network. Divergences here are
// contract bugs in the JS domain layer, not test bugs — this suite is
// additive; the original (network-mocked) features.bp.test.js keeps running
// unshimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateBPCategory } from '../../../domain/bp.js';
import { computeReminderHorizon } from '../../../domain/reminders.js';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

// Same ApiCache/BPStore stand-in the network-mocked BP suite uses, so
// DataStore.loadSWR / applyOptimistic have somewhere to read/write.
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
        BPStore: {
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

async function submitBPReading(window, document, { daysAgo, systolic, diastolic, pulse = '70', notes = '' }) {
    window.showBPRecordModal();
    document.getElementById('bp-datetime').value = daysAgoLocalInput(daysAgo);
    document.getElementById('bp-systolic').value = String(systolic);
    document.getElementById('bp-diastolic').value = String(diastolic);
    document.getElementById('bp-pulse').value = pulse;
    document.getElementById('bp-notes').value = notes;
    await window.handleBPSubmit({ preventDefault() {} });
}

describe('cloud shim contract — BP flows (features/bp.js over web/domain/bp.js)', () => {
    let env;
    let cache;

    function setupEnv(seedRecords, clock) {
        if (env) env.cleanup();
        env = loadCloudShimFrontendEnv({ seedRecords, ...clock });
        cache = installApiCache(env.window);
        env.window.loadToday = vi.fn();
        env.window.SyncManager = { updateStatus: () => {} };
    }

    beforeEach(() => {
        setupEnv();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('save then list round-trips through the shim with a server-matching category', async () => {
        const { window, document } = env;
        await submitBPReading(window, document, { daysAgo: 1, systolic: 118, diastolic: 76 });

        const bp = cache.get('bp');
        expect(bp).toBeTruthy();
        expect(bp.readingsRes).toHaveLength(1);
        const reading = bp.readingsRes[0];
        expect(reading.systolic).toBe(118);
        expect(reading.diastolic).toBe(76);
        expect(reading.category).toBe(calculateBPCategory(118, 76));
        expect(reading.category).toBe('Normal');
    });

    it('a hypertensive reading gets the server-matching category', async () => {
        const { window, document } = env;
        await submitBPReading(window, document, { daysAgo: 1, systolic: 145, diastolic: 95 });

        const bp = cache.get('bp');
        expect(bp.readingsRes[0].category).toBe(calculateBPCategory(145, 95));
        expect(bp.readingsRes[0].category).toBe('High BP Stage 2');
    });

    it('getGoal reflects a goal record already synced from another device', async () => {
        // Goal-setting is not part of the ported HTTP surface (server only
        // exposes GET /api/bp/goal — see internal/server/server.go:825), so
        // the goal record arrives via sync (recordsPort), not a POST call.
        setupEnv({ bpgoal: [{ recordId: 'bpgoal', clientTs: Date.now(), deleted: false, target_systolic: 120, target_diastolic: 80 }] });
        const { window } = env;

        const getRes = await window.apiCall('/api/bp/goal');
        expect(getRes).toEqual({ target_systolic: 120, target_diastolic: 80 });
    });

    it('stats_14 reflects the daily-weighted average of readings within the window', async () => {
        const { window, document } = env;
        await submitBPReading(window, document, { daysAgo: 2, systolic: 120, diastolic: 80 });
        await submitBPReading(window, document, { daysAgo: 1, systolic: 130, diastolic: 90 });

        const statsRes = await window.apiCall('/api/bp/stats');
        expect(statsRes.stats_14).toBeTruthy();
        expect(statsRes.stats_14.systolic).toBe(Math.round((120 + 130) / 2));
        expect(statsRes.stats_14.diastolic).toBe(Math.round((80 + 90) / 2));
        expect(statsRes.stats_14.readings).toBe(2);
    });

    // med-9bmb: a reading logged IN THE APP satisfies today's measure reminder,
    // so the Telegram chain the relay already sent has to end — otherwise the
    // message keeps sitting in the chat with its Snooze/Skip buttons and a
    // re-fire armed by a tap still fires. Same mechanism as the in-app dose
    // confirm and the workout transitions (med-r3dm).
    describe('logging a reading cancels the Telegram measure chain', () => {
        // Pinned clock: 18:30 UTC in UTC, so a 09:00 slot is already past (the
        // relay has sent it, chain live) and a 20:00 slot is still ahead.
        const NOW = Date.parse('2026-09-05T18:30:00Z');
        const PAST_HOUR = 9;
        const PAST_SLOT_UNIX = Date.parse('2026-09-05T09:00:00Z') / 1000;
        const FUTURE_HOUR = 20;

        let fetchMock;

        function withBPPref(pref) {
            setupEnv(
                pref ? { bpreminderpref: [{ recordId: 'bpreminderpref', clientTs: 1, deleted: false, ...pref }] } : undefined,
                { now: () => NOW, timeZone: 'UTC' }
            );
            fetchMock = vi.fn().mockResolvedValue({ ok: true });
            globalThis.fetch = fetchMock;
        }

        function cancelCallbacks() {
            return fetchMock.mock.calls
                .filter(([url]) => url === '/api/telegram/cancel-refire')
                .map(([, init]) => JSON.parse(init.body).callback);
        }

        afterEach(() => {
            delete globalThis.fetch;
        });

        it('posts exactly one cancel-refire for the stem the horizon would have pushed', async () => {
            withBPPref({ enabled: true, preferred_reminder_hour: PAST_HOUR });
            const { window } = env;

            await window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76, pulse: 70 });

            expect(cancelCallbacks()).toEqual([`bp:${PAST_SLOT_UNIX}`]);
            // The stem must be the one computeReminderHorizon emits for that
            // slot, or the server cancels nothing.
            const horizon = computeReminderHorizon({
                medications: [], intakes: [], bps: [], weights: [], timeZone: 'UTC',
                now: NOW - 24 * 60 * 60 * 1000,
                bpStatus: { enabled: true, preferred_reminder_hour: PAST_HOUR },
                weightStatus: { enabled: false },
                workoutStatus: { enabled: false }
            });
            expect(horizon.some((e) => e.callback === `bp:${PAST_SLOT_UNIX}`)).toBe(true);
        });

        it('does not cancel when today\'s slot has not fired yet', async () => {
            withBPPref({ enabled: true, preferred_reminder_hour: FUTURE_HOUR });
            const { window } = env;

            await window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76 });

            expect(cancelCallbacks()).toEqual([]);
        });

        it('does not cancel when BP reminders are disabled or unconfigured', async () => {
            withBPPref({ enabled: false, preferred_reminder_hour: PAST_HOUR });
            await env.window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76 });
            expect(cancelCallbacks()).toEqual([]);

            withBPPref(null);
            await env.window.apiCall('/api/bp', 'POST', { systolic: 118, diastolic: 76 });
            expect(cancelCallbacks()).toEqual([]);
        });
    });

    it('_deleteBPApi removes the reading from the shim-backed store', async () => {
        const { window, document } = env;
        await submitBPReading(window, document, { daysAgo: 1, systolic: 118, diastolic: 76 });
        const id = cache.get('bp').readingsRes[0].id;

        await window._deleteBPApi(id);

        expect(cache.get('bp').readingsRes).toHaveLength(0);
        const listRes = await window.apiCall('/api/bp?days=60');
        expect(listRes).toHaveLength(0);
    });
});
