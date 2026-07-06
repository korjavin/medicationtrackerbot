// Plan 2026-07-06 cloud-c2d, Task 7 — shim-mode contract run of the workout
// stats + mi-band flows against web/domain/workout.js. Drives window.apiCall
// (core/api.js), which delegates to the cloud shim (web/cloud/js/apishim.js)
// instead of the network. Divergences here are contract bugs in the JS domain
// layer, not test bugs; the original workout.stats/miband test files keep
// running unshimmed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — workout stats + mi-band', () => {
    let env;

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('stats reports weekly_activity: null and top_exercises: null when nothing has happened yet', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const stats = await env.window.apiCallDirect('/api/workout/stats');
        expect(stats.total_sessions).toBe(0);
        expect(stats.weekly_activity).toBeNull();
        expect(stats.top_exercises).toBeNull();
    });

    it('stats aggregates a completed ad-hoc session into totals, heatmap, and top_exercises', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'Squat' });
        const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: session.id, exercise_id: item.id, exercise_name: item.name, source: 'library',
            target_sets: 5, target_reps_min: 5, target_weight_kg: 80, status: 'completed'
        });
        await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

        const stats = await window.apiCallDirect('/api/workout/stats');
        expect(stats.total_sessions).toBe(1);
        expect(stats.completed_sessions).toBe(1);
        expect(stats.completion_rate).toBe(100);
        expect(stats.weekly_activity).toBeInstanceOf(Array);
        expect(stats.weekly_activity.length).toBeGreaterThan(0);
        expect(stats.top_exercises).toEqual([
            { exercise_name: 'Squat', session_count: 1, total_volume_kg: 5 * 5 * 80, max_weight_kg: 80 }
        ]);
    });

    it('mi-band list respects limit, patch applies diff-semantics over six fields, delete tombstones', async () => {
        const now = Date.now();
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                miband: [
                    {
                        recordId: 'mb1', clientTs: now, deleted: false, id: 1, activity_type: 'run', activity_name: 'Morning Run',
                        source_start_ms: now - 3600_000, source_end_ms: now - 1800_000, duration_sec: 1800, distance_m: 5000,
                        steps: 6000, calories: 350, heart_rate_avg: 140, spo2_avg: 97, tz_offset: 0, source: 'miband'
                    },
                    {
                        recordId: 'mb2', clientTs: now, deleted: false, id: 2, activity_type: 'walk', activity_name: 'Evening Walk',
                        source_start_ms: now - 7200_000, source_end_ms: now - 5400_000, duration_sec: 1800, distance_m: 2000,
                        steps: 2500, calories: 120, heart_rate_avg: 100, spo2_avg: 98, tz_offset: 0, source: 'miband'
                    }
                ]
            }
        });
        const { window } = env;

        let list = await window.apiCall('/api/workout/miband?limit=1');
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe(1);

        list = await window.apiCall('/api/workout/miband');
        expect(list).toHaveLength(2);

        // Diff-semantics: only steps + calories are provided; every other
        // field (distance_m, duration_sec, heart_rate_avg, spo2_avg) survives.
        await window.apiCall('/api/workout/miband/1', 'PATCH', { steps: 6200, calories: 360 });
        list = await window.apiCall('/api/workout/miband');
        const patched = list.find((w) => w.id === 1);
        expect(patched.steps).toBe(6200);
        expect(patched.calories).toBe(360);
        expect(patched.distance_m).toBe(5000);
        expect(patched.heart_rate_avg).toBe(140);

        await window.apiCall('/api/workout/miband/2', 'DELETE');
        list = await window.apiCall('/api/workout/miband');
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe(1);
    });
});
