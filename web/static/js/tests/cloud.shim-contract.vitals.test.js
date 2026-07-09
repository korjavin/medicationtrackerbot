// Plan 2026-07-05 cloud-c2a, Task 5 — shim-mode contract run of the Vitals
// read side against web/domain/vitals.js. Drives the real feature code
// (loadHealthOverview in features/health.js) through the real window.apiCall
// (core/api.js), which delegates to the cloud shim (web/cloud/js/apishim.js)
// instead of the network — plus a seeded-fixture check that the aggregation
// matches internal/server/health_handlers.go semantics for a small week of
// sleep + day-batched samples (no cloud ingestion path yet, so this is the
// only way to exercise the aggregation logic here).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiCache, loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — vitals overview (features/health.js over web/domain/vitals.js)', () => {
    let env;

    afterEach(() => {
        if (env) env.cleanup();
        env = null;
    });

    it('loadHealthOverview renders the empty state cleanly with no records seeded (no thrown errors)', async () => {
        env = loadCloudShimFrontendEnv();
        installApiCache(env.window);
        const { window, document } = env;
        const consoleError = vi.spyOn(console, 'error');

        await expect(window.loadHealthOverview()).resolves.not.toThrow();

        expect(document.getElementById('health-overview-loading').style.display).toBe('none');
        expect(document.getElementById('health-overview-content').classList.contains('hidden')).toBe(false);
        expect(consoleError).not.toHaveBeenCalled();
    });

    it('GET /api/health/overview aggregates a seeded week of sleep + day-batched HR samples', async () => {
        const day = (n) => {
            const d = new Date();
            d.setUTCDate(d.getUTCDate() - n);
            return d.toISOString().slice(0, 10);
        };
        const daySleep = (n, totalMinutes, hr) => ({
            recordId: `sleep_${day(n)}`,
            clientTs: Date.now(),
            deleted: false,
            start_time: `${day(n)}T22:00:00Z`,
            end_time: `${day(n)}T${String(6).padStart(2, '0')}:00:00Z`,
            timezone_offset: 0,
            day: day(n),
            total_minutes: totalMinutes,
            deep_minutes: Math.round(totalMinutes * 0.2),
            heart_rate_avg: hr,
            user_modified: false,
        });
        // HR samples are filtered by absolute instant (ms <= now), so anchor
        // them to fixed offsets before `now` — not to a today-UTC hour, which
        // would land in the future when CI runs early in the day and be
        // dropped (flaky). All offsets stay well inside the 7d window.
        //
        // Batch them exactly as vault.js packSamples does — one record per UTC
        // calendar day, recordId `hrsample-<UTC day>`. That id convention is
        // load-bearing: readSamples reads the window with a primary-key range
        // over it (med-9z3.3), so a fixture with arbitrary ids would exercise a
        // record shape production never stores.
        const HOUR = 60 * 60 * 1000;
        const hrSamples = [[1, 60], [2, 62], [3, 64], [25, 58], [26, 60]];
        const byUtcDay = new Map();
        for (const [offsetHours, value] of hrSamples) {
            const at = new Date(Date.now() - offsetHours * HOUR);
            const utcDay = at.toISOString().slice(0, 10);
            if (!byUtcDay.has(utcDay)) byUtcDay.set(utcDay, []);
            byUtcDay.get(utcDay).push({ date_time: at.toISOString(), value });
        }
        const hrRecords = [...byUtcDay].map(([utcDay, samples]) => ({
            recordId: `hrsample-${utcDay}`,
            clientTs: Date.now(),
            deleted: false,
            samples,
        }));

        env = loadCloudShimFrontendEnv({
            seedRecords: {
                sleep: [daySleep(0, 420, 60), daySleep(1, 400, 62), daySleep(2, 450, 58)],
                hrsample: hrRecords,
            },
        });
        installApiCache(env.window);

        const overview = await env.window.apiCall('/api/health/overview', 'GET');

        expect(overview.average_heart_rate_7d).toBe(Math.trunc((60 + 62 + 64 + 58 + 60) / 5));
        expect(overview.sleep_stats_7d).toHaveLength(3);
        // average_sleep_hours_7d = trunc(avg minutes) / 60 (server truncates the
        // minutes average before converting to hours — mirrors calcAvg).
        expect(overview.average_sleep_hours_7d).toBeCloseTo(Math.trunc((420 + 400 + 450) / 3) / 60, 5);
        const today = overview.sleep_stats_7d.find((s) => s.date === day(0));
        expect(today.total_mins).toBe(420);
        expect(today.heart_rate_avg).toBe(60);
    });

    // med-9z3.9 — handleListSleepLogs guards `days` with `err == nil && d > 0`
    // (health_handlers.go), so a non-positive value keeps the 90d default. The
    // shim's intParam let 0/-5 through into `now - days*DAY`, producing an empty
    // (days=0) or future (days<0) window: no rows where bot mode returns 90 days.
    describe('non-positive `days` on /api/health/sleep falls back to the default 90d', () => {
        const sleepRecord = (daysAgo) => {
            const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
            const day = at.toISOString().slice(0, 10);
            return {
                recordId: `sleep_${day}`,
                clientTs: Date.now(),
                deleted: false,
                start_time: at.toISOString(),
                end_time: at.toISOString(),
                timezone_offset: 0,
                day,
                total_minutes: 420,
                user_modified: false,
            };
        };

        for (const days of ['0', '-5']) {
            it(`days=${days} returns the same rows as the default window`, async () => {
                env = loadCloudShimFrontendEnv({ seedRecords: { sleep: [sleepRecord(1)] } });
                installApiCache(env.window);

                const withDays = await env.window.apiCall(`/api/health/sleep?days=${days}`, 'GET');
                const withDefault = await env.window.apiCall('/api/health/sleep', 'GET');

                expect(withDays).toHaveLength(1);
                expect(withDays).toEqual(withDefault);
            });
        }
    });

    // med-9z3.3 — overview() used to flatten EVERY stored sample day for three
    // streams and then throw all but the 30d window away. A multi-year account
    // re-expanded years of batches on every load.
    describe('reads the 30d window with a bounded primary-key range', () => {
        const HOUR = 60 * 60 * 1000;
        const DAY = 24 * HOUR;
        const batch = (type, ms, value) => {
            const at = new Date(ms);
            return {
                recordId: `${type}-${at.toISOString().slice(0, 10)}`,
                clientTs: Date.now(),
                deleted: false,
                samples: [{ date_time: at.toISOString(), value }],
            };
        };

        it('never lists a vitals stream unbounded, and bounds it to the window', async () => {
            const now = Date.now();
            env = loadCloudShimFrontendEnv({
                seedRecords: { hrsample: [batch('hrsample', now - 2 * HOUR, 60)] },
            });
            installApiCache(env.window);
            const listRange = vi.spyOn(env.records, 'listRange');
            const list = vi.spyOn(env.records, 'list');

            await env.window.apiCall('/api/health/overview', 'GET');

            for (const type of ['hrsample', 'spo2sample', 'stresssample']) {
                expect(list).not.toHaveBeenCalledWith(type);
                const call = listRange.mock.calls.find((c) => c[0] === type);
                expect(call, `${type} must be read via listRange`).toBeTruthy();
                const [, fromId, toId] = call;
                // ~30d window, padded one UTC day each side (the batch key is the
                // sample's UTC day, which at a +14/-12 offset differs from the
                // local day the window is computed in).
                expect(fromId.startsWith(`${type}-`)).toBe(true);
                expect(toId.startsWith(`${type}-`)).toBe(true);
                const spanDays = (Date.parse(toId.slice(type.length + 1)) - Date.parse(fromId.slice(type.length + 1))) / DAY;
                expect(spanDays).toBeGreaterThanOrEqual(30);
                expect(spanDays).toBeLessThanOrEqual(32);
            }
        });

        it('excludes batches older than the 30d window while keeping in-window ones', async () => {
            const now = Date.now();
            env = loadCloudShimFrontendEnv({
                seedRecords: {
                    hrsample: [
                        batch('hrsample', now - 2 * HOUR, 60),   // in window
                        batch('hrsample', now - 400 * DAY, 200), // ancient: must not be read at all
                    ],
                },
            });
            installApiCache(env.window);

            const overview = await env.window.apiCall('/api/health/overview', 'GET');

            // A 200 bpm sample from >1y ago would wreck the average if it leaked in.
            expect(overview.average_heart_rate_7d).toBe(60);
            expect(overview.heart_rate_history_30d.every((b) => b.max === 60)).toBe(true);
        });

        it('keeps a sample whose UTC day sits one day off the local window edge', async () => {
            // The padding exists for exactly this: the batch key is a UTC day, the
            // window boundary is a local day. An unpadded bound drops the edge batch.
            const now = Date.now();
            const nearEdge = now - 29 * DAY + 2 * HOUR;
            env = loadCloudShimFrontendEnv({
                seedRecords: {
                    hrsample: [batch('hrsample', now - HOUR, 60), batch('hrsample', nearEdge, 70)],
                },
            });
            installApiCache(env.window);

            const overview = await env.window.apiCall('/api/health/overview', 'GET');
            expect(overview.average_heart_rate_30d).toBe(Math.trunc((60 + 70) / 2));
        });
    });
});
