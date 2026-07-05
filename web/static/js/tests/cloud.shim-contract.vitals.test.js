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
        const HOUR = 60 * 60 * 1000;
        const hrRecord = (id, offsetHours, values) => ({
            recordId: id,
            clientTs: Date.now(),
            deleted: false,
            samples: values.map((v, i) => ({ date_time: new Date(Date.now() - (offsetHours + i) * HOUR).toISOString(), value: v })),
        });

        env = loadCloudShimFrontendEnv({
            seedRecords: {
                sleep: [daySleep(0, 420, 60), daySleep(1, 400, 62), daySleep(2, 450, 58)],
                hrsample: [hrRecord('hr_a', 1, [60, 62, 64]), hrRecord('hr_b', 25, [58, 60])],
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
});
