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

    it('exercises/history returns completed logs for one exercise with per-set arrays + session dates, newest-first', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'Bench' });

        // Two completed ad-hoc sessions of the same exercise, each carrying a
        // per-set array (incl. a warm-up the read passes through untouched).
        for (const setsArg of [
            [{ weight_kg: 40, reps: 10, set_type: 'warmup' }, { weight_kg: 80, reps: 5 }],
            [{ weight_kg: 85, reps: 5 }, { weight_kg: 85, reps: 4 }],
        ]) {
            const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                session_id: session.id, exercise_id: item.id, exercise_name: item.name,
                source: 'library', status: 'completed', sets: setsArg,
            });
            await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });
        }

        const history = await window.apiCallDirect('/api/workout/exercises/history?name=Bench');
        expect(history).toHaveLength(2);
        for (const entry of history) {
            expect(entry.date).toBeTruthy();
            expect(Array.isArray(entry.sets)).toBe(true);
            expect(entry.session_id).toBeGreaterThan(0);
        }
        // Per-set arrays ride through verbatim (warm-up preserved for the reader).
        const allSets = history.flatMap((e) => e.sets);
        expect(allSets.some((s) => s.set_type === 'warmup' && s.weight_kg === 40)).toBe(true);
        expect(allSets.some((s) => s.weight_kg === 85 && s.reps === 5)).toBe(true);

        // Library-only history has no workout_exercises row to inherit a goal
        // from, so training_goal stays null and the UI falls back to the default.
        expect(history.every((e) => e.training_goal === null)).toBe(true);

        // A different exercise name returns nothing.
        const none = await window.apiCallDirect('/api/workout/exercises/history?name=Deadlift');
        expect(none).toEqual([]);
    });

    // med-qj4.6.4/.5: the detail view's headline emphasis + near-failure advisory
    // are goal-driven, and the exercise NAME is the only handle the client has —
    // so the effective goal rides on the history response.
    it('exercises/history carries the exercise\'s effective training goal', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        const group = await window.apiCall('/api/workout/groups/create', 'POST', {
            name: 'Strength Block', training_goal: 'strength',
        });
        const variant = await window.apiCall('/api/workout/variants/create', 'POST', {
            group_id: group.id, name: 'A',
        });
        const exercise = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variant.id, exercise_name: 'Squat', target_sets: 3, target_reps_min: 5,
        });

        const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: session.id, exercise_id: exercise.id, exercise_name: 'Squat',
            source: 'schedule', status: 'completed', sets: [{ weight_kg: 100, reps: 5, rpe: 8 }],
        });
        await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

        // Inherited from the routine (no per-exercise override).
        let history = await window.apiCallDirect('/api/workout/exercises/history?name=Squat');
        expect(history).toHaveLength(1);
        expect(history[0].training_goal).toBe('strength');

        // An explicit per-exercise override wins over the routine's goal.
        await window.apiCall(`/api/workout/exercises/update?id=${exercise.id}`, 'PUT', {
            variant_id: variant.id, exercise_name: 'Squat',
            target_sets: 3, target_reps_min: 5, training_goal: 'endurance',
        });
        history = await window.apiCallDirect('/api/workout/exercises/history?name=Squat');
        expect(history[0].training_goal).toBe('endurance');

        // A second routine logs the same exercise name later. The goal must come
        // from the NEWEST scheduled log, not from whichever record the store
        // returns first — otherwise a retired routine's emphasis sticks.
        const group2 = await window.apiCall('/api/workout/groups/create', 'POST', {
            name: 'Hypertrophy Block', training_goal: 'hypertrophy',
        });
        const variant2 = await window.apiCall('/api/workout/variants/create', 'POST', {
            group_id: group2.id, name: 'A',
        });
        const exercise2 = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variant2.id, exercise_name: 'Squat', target_sets: 3, target_reps_min: 10,
        });
        const later = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall(`/api/workout/sessions/status?id=${later.id}`, 'PUT', { status: 'in_progress' });
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: later.id, exercise_id: exercise2.id, exercise_name: 'Squat',
            source: 'schedule', status: 'completed', sets: [{ weight_kg: 60, reps: 10 }],
        });
        await window.apiCall(`/api/workout/sessions/status?id=${later.id}`, 'PUT', { status: 'completed' });

        history = await window.apiCallDirect('/api/workout/exercises/history?name=Squat');
        expect(history).toHaveLength(2);
        expect(history[0].training_goal).toBe('hypertrophy');
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
