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

    it('stats reports weekly_activity: null, daily_activity: null and top_exercises: null when nothing has happened yet', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const stats = await env.window.apiCallDirect('/api/workout/stats');
        expect(stats.total_sessions).toBe(0);
        expect(stats.weekly_activity).toBeNull();
        // `null`, never `[]` — the Consistency calendar reads it with
        // Array.isArray-style truthiness, same contract as weekly_activity.
        expect('daily_activity' in stats).toBe(true);
        expect(stats.daily_activity).toBeNull();
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
        // A session logged today is inside every window, and one trained week
        // is a one-week streak.
        expect(stats.range).toBe('30d');
        expect(stats.current_streak_weeks).toBe(1);
        const sevenDay = await window.apiCallDirect('/api/workout/stats?range=7d');
        expect(sevenDay.range).toBe('7d');
        expect(sevenDay.total_sessions).toBe(1);
        expect(sevenDay.top_exercises).toHaveLength(1);
    });

    it('range scopes both the counts and top_exercises off the session date', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'Deadlift' });
        const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: session.id, exercise_id: item.id, exercise_name: item.name, source: 'library',
            target_sets: 3, target_reps_min: 5, target_weight_kg: 100, status: 'completed'
        });
        await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

        // Backdate the session 60 days: inside 90d/all, outside 7d/30d. The
        // log rides along because top_exercises is scoped by its session date.
        const backdated = new Date(Date.now() - 60 * 86400000).toISOString();
        for (const rec of await env.records.list('workoutsession')) {
            await env.records.put('workoutsession', { ...rec, scheduled_date: backdated });
        }

        const near = await window.apiCallDirect('/api/workout/stats?range=30d');
        expect(near.total_sessions).toBe(0);
        expect(near.top_exercises).toBeNull();
        // daily_activity is scoped to the ACTIVE range (unlike the 12-week
        // heatmap span weekly_activity keeps), so the calendar grid covers
        // exactly the window the range pills claim.
        expect(near.daily_activity).toBeNull();

        const far = await window.apiCallDirect('/api/workout/stats?range=90d');
        expect(far.total_sessions).toBe(1);
        expect(far.top_exercises).toHaveLength(1);
        expect(far.daily_activity).toEqual([
            { date: backdated.slice(0, 10), completed: 1, skipped: 0 },
        ]);

        const all = await window.apiCallDirect('/api/workout/stats?range=all');
        expect(all.total_sessions).toBe(1);
    });

    // med-zte — one entry per LOCAL calendar day that saw a completed or
    // skipped session, ascending, rest days simply absent.
    it('daily_activity buckets completed and skipped sessions per local day, ascending', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        // Two sessions today (one completed, one skipped) plus one completed
        // three days ago — enough to prove per-day buckets and the sort.
        const first = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall(`/api/workout/sessions/status?id=${first.id}`, 'PUT', { status: 'completed' });
        const second = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall(`/api/workout/sessions/status?id=${second.id}`, 'PUT', { status: 'skipped' });

        const older = new Date(Date.now() - 3 * 86400000).toISOString();
        const third = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall(`/api/workout/sessions/status?id=${third.id}`, 'PUT', { status: 'completed' });
        for (const rec of await env.records.list('workoutsession')) {
            if (rec.id === third.id) await env.records.put('workoutsession', { ...rec, scheduled_date: older });
        }

        const stats = await window.apiCallDirect('/api/workout/stats?range=30d');
        const today = first.scheduled_date.slice(0, 10);
        expect(stats.daily_activity).toEqual([
            { date: older.slice(0, 10), completed: 1, skipped: 0 },
            { date: today, completed: 1, skipped: 1 },
        ]);
        // The per-day buckets add up to the range's own counts.
        const sum = (k) => stats.daily_activity.reduce((n, d) => n + d[k], 0);
        expect(sum('completed')).toBe(stats.completed_sessions);
        expect(sum('skipped')).toBe(stats.skipped_sessions);
    });

    // med-904.1 — the Load/Balance views read `totals`, `weekly_volume` and
    // `exercise_totals` off the SAME payload the Consistency view already used,
    // so switching views never refetches.
    it('totals exclude warm-up sets from volume, hard sets and reps', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'Squat' });
        const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: session.id, exercise_id: item.id, exercise_name: item.name, source: 'library',
            status: 'completed',
            sets: [
                { weight_kg: 40, reps: 10, set_type: 'warmup' },
                { weight_kg: 100, reps: 5 },
                { weight_kg: 100, reps: 5 },
            ],
        });
        await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

        const stats = await window.apiCallDirect('/api/workout/stats');
        // The 40 kg × 10 warm-up contributes nothing: 2 hard sets, 10 reps, 1000 kg.
        expect(stats.totals).toEqual({ volume_kg: 1000, hard_sets: 2, easy_sets: 0, reps: 10, pr_count: 1 });
        expect(stats.exercise_totals).toEqual([
            { exercise_name: 'Squat', session_count: 1, sets: 2, hard_sets: 2, reps: 10, total_volume_kg: 1000, max_weight_kg: 100 },
        ]);
        // weekly_volume shares weekly_activity's ISO-Monday buckets exactly.
        expect(stats.weekly_volume).toHaveLength(stats.weekly_activity.length);
        expect(stats.weekly_volume.reduce((sum, w) => sum + w.volume_kg, 0)).toBe(1000);
        expect(stats.weekly_volume.reduce((sum, w) => sum + w.hard_sets, 0)).toBe(2);
        // med-7pq — top_exercises used to report the derived-scalar product
        // (3 stored sets × max 10 reps × max 100 kg = 3000 kg, warm-up included).
        // It is now the top-8 slice of exercise_totals, so both views agree.
        expect(stats.top_exercises).toEqual([
            { exercise_name: 'Squat', session_count: 1, total_volume_kg: 1000, max_weight_kg: 100 },
        ]);
    });

    // med-vov — `hard_sets` counts effort, not sets: a working set only lands in
    // it when it was taken near failure (RIR <= 4, i.e. rpe >= 6).
    describe('hard sets are effort-gated (med-vov)', () => {
        async function logSets(window, name, sets) {
            const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name });
            const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                session_id: session.id, exercise_id: item.id, exercise_name: item.name,
                source: 'library', status: 'completed', sets,
            });
            await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });
            return window.apiCallDirect('/api/workout/stats');
        }

        // THE regression that matters: rpe is optional, and rating only the top
        // set is normal practice. A vault carrying no effort anywhere has to
        // produce exactly the numbers it produced before med-vov, or the tile
        // silently zeroes for most users.
        it('counts every unrated work set as hard, unchanged', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const stats = await logSets(env.window, 'Squat', [
                { weight_kg: 40, reps: 10, set_type: 'warmup' },
                { weight_kg: 100, reps: 5 },
                { weight_kg: 100, reps: 5 },
                { weight_kg: 100, reps: 5 },
            ]);
            expect(stats.totals.hard_sets).toBe(3);
            expect(stats.totals.easy_sets).toBe(0);
            expect(stats.exercise_totals[0]).toMatchObject({ sets: 3, hard_sets: 3 });
            expect(stats.weekly_volume.reduce((sum, w) => sum + w.hard_sets, 0)).toBe(3);
        });

        it('drops rated-easy sets (rpe < 6) from hard_sets and reports them as easy_sets', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const stats = await logSets(env.window, 'Bench Press', [
                { weight_kg: 40, reps: 10, set_type: 'warmup', rpe: 3 },
                { weight_kg: 60, reps: 5, rpe: 5 },   // RIR 5 — five in reserve, not hard
                { weight_kg: 80, reps: 5, rpe: 6 },   // RIR 4 — the boundary, hard
                { weight_kg: 90, reps: 5, rpe: 9 },   // RIR 1 — hard
                { weight_kg: 90, reps: 5 },           // unrated — no opinion, hard
            ]);
            expect(stats.totals.hard_sets).toBe(3);
            expect(stats.totals.easy_sets).toBe(1);
            // The rated-easy set is still work: volume and reps keep all four
            // working sets (60×5 + 80×5 + 90×5 + 90×5), only the hard count drops.
            expect(stats.totals.volume_kg).toBe(1600);
            expect(stats.totals.reps).toBe(20);
            // Every EFFORT surface agrees — range tile, weekly bucket, per-exercise
            // hard_sets — while per-exercise `sets` keeps counting COVERAGE: all
            // four working sets, ungated. Two questions, two fields.
            expect(stats.exercise_totals[0]).toMatchObject({ sets: 4, hard_sets: 3 });
            expect(stats.weekly_volume.reduce((sum, w) => sum + w.hard_sets, 0)).toBe(3);
        });

        // The incentive-inverting bug: `exercise_totals[].sets` feeds the Balance
        // view's body-part split, and any body part folding to zero sets is
        // printed under "Not Trained". Gating that field on effort would tell a
        // user who squatted three honest RPE-5 sets that they never trained legs
        // — while a user who logs no RPE at all keeps getting the truth.
        it('keeps the full working-set count on exercise_totals when every set was rated easy', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const stats = await logSets(env.window, 'Squat', [
                { weight_kg: 100, reps: 5, rpe: 5 },
                { weight_kg: 100, reps: 5, rpe: 4 },
                { weight_kg: 100, reps: 5, rpe: 3 },
            ]);
            expect(stats.exercise_totals[0]).toMatchObject({ exercise_name: 'Squat', sets: 3, hard_sets: 0 });
            expect(stats.totals).toMatchObject({ hard_sets: 0, easy_sets: 3 });
        });

        it('counts every set of a flat-scalar log, which carries no effort at all', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'Row' });
            const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                session_id: session.id, exercise_id: item.id, exercise_name: item.name, source: 'library',
                target_sets: 4, target_reps_min: 8, target_weight_kg: 50, status: 'completed',
            });
            await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

            const stats = await window.apiCallDirect('/api/workout/stats');
            expect(stats.totals.hard_sets).toBe(4);
            expect(stats.totals.easy_sets).toBe(0);
        });

        // bd med-45u. Both halves in one vault, because the fix only holds if
        // the filter is WORKING SETS and never volume: a warm-up-only log is
        // nobody's training and must not print a "0 kg" row in Top Exercises,
        // while a bodyweight push-up has real working sets at 0 kg and must
        // keep its row — dropping it would move a body part the user actually
        // trained into the Balance view's "Not Trained" chips.
        it('drops a warm-up-only exercise but keeps a zero-volume bodyweight one', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            await logSets(env.window, 'Leg Press', [
                { weight_kg: 40, reps: 10, set_type: 'warmup' },
                { weight_kg: 60, reps: 10, set_type: 'warmup' },
            ]);
            await logSets(env.window, 'Push-up', [
                { reps: 20 },
                { reps: 15 },
            ]);

            // A second Push-up session that never got past the ramp: it must not
            // add a session to the row it already has. Logged against the same
            // library item — the library rejects a duplicate name.
            const { window } = env;
            const pushup = (await window.apiCall('/api/workout/exercise-library'))
                .find((e) => e.name === 'Push-up');
            const second = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                session_id: second.id, exercise_id: pushup.id, exercise_name: 'Push-up',
                source: 'library', status: 'completed', sets: [{ reps: 5, set_type: 'warmup' }],
            });
            await window.apiCall(`/api/workout/sessions/status?id=${second.id}`, 'PUT', { status: 'completed' });
            const stats = await window.apiCallDirect('/api/workout/stats');

            expect(stats.exercise_totals).toEqual([
                expect.objectContaining({
                    exercise_name: 'Push-up', session_count: 1, sets: 2, hard_sets: 2, reps: 35, total_volume_kg: 0,
                }),
            ]);
            expect(stats.top_exercises).toEqual([
                { exercise_name: 'Push-up', session_count: 1, total_volume_kg: 0, max_weight_kg: 0 },
            ]);
        });
    });

    it('range scopes the load aggregates, while weekly_volume keeps the wider heatmap span', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'Deadlift' });
        const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: session.id, exercise_id: item.id, exercise_name: item.name, source: 'library',
            status: 'completed',
            sets: [{ weight_kg: 120, reps: 3 }, { weight_kg: 120, reps: 3 }],
        });
        await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

        // Same 60-day backdate as the counts test above: inside 90d/all, outside 7d/30d.
        const backdated = new Date(Date.now() - 60 * 86400000).toISOString();
        for (const rec of await env.records.list('workoutsession')) {
            await env.records.put('workoutsession', { ...rec, scheduled_date: backdated });
        }

        const near = await window.apiCallDirect('/api/workout/stats?range=30d');
        expect(near.totals).toEqual({ volume_kg: 0, hard_sets: 0, easy_sets: 0, reps: 0, pr_count: 0 });
        expect(near.exercise_totals).toBeNull();
        // ...but the 12-week heatmap still covers a 60-day-old week, so its
        // tonnage bucket is present even when the range excludes it from totals.
        expect(near.weekly_volume.reduce((sum, w) => sum + w.volume_kg, 0)).toBe(720);

        const far = await window.apiCallDirect('/api/workout/stats?range=90d');
        expect(far.totals).toEqual({ volume_kg: 720, hard_sets: 2, easy_sets: 0, reps: 6, pr_count: 1 });
        expect(far.exercise_totals).toHaveLength(1);
        expect(far.exercise_totals[0]).toMatchObject({ exercise_name: 'Deadlift', sets: 2, max_weight_kg: 120 });
    });

    it('exercise_totals covers every exercise trained, not just the top-8 slice', async () => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        const { window } = env;
        const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        // Nine exercises with strictly descending volume — the ninth cannot make
        // the top-8 cut, which is exactly what the Balance view needs to see.
        for (let i = 0; i < 9; i++) {
            const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: `Move ${i}` });
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                session_id: session.id, exercise_id: item.id, exercise_name: item.name, source: 'library',
                status: 'completed', sets: [{ weight_kg: 100 - i, reps: 5 }],
            });
        }
        await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

        const stats = await window.apiCallDirect('/api/workout/stats');
        expect(stats.top_exercises).toHaveLength(8);
        expect(stats.exercise_totals).toHaveLength(9);
        const topNames = stats.top_exercises.map((e) => e.exercise_name);
        expect(topNames).not.toContain('Move 8');
        expect(stats.exercise_totals.map((e) => e.exercise_name)).toContain('Move 8');
        // Every exercise is a first-ever lift, so every one of them is a PR.
        expect(stats.totals.pr_count).toBe(9);
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
            // The session's within-day key — scheduled_date is day-granular, so
            // the graph series orders same-day sessions on this (med-qj4.7).
            expect(entry.scheduled_time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
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

    // med-73o: the exercise editor's weight suggestion. The contract that
    // matters is not the number in isolation — it is that the number comes from
    // the SAME progression engine that advances a plan after a session, so the
    // editor can never prescribe a weight the automatic progression disagrees
    // with. Every case below drives it through the real shim router.
    describe('exercises/suggest-target (med-73o)', () => {
        // One completed library session of `name` with the given per-set array.
        async function logSession(window, name, sets) {
            const items = await window.apiCall('/api/workout/exercise-library');
            const item = (items || []).find((i) => i.name === name)
                || await window.apiCall('/api/workout/exercise-library/create', 'POST', { name });
            const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                session_id: session.id, exercise_id: item.id, exercise_name: name,
                source: 'library', status: 'completed', sets,
            });
            await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });
            return item;
        }

        it('returns null for a name with no history at all, so the editor field stays blank', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const suggestion = await env.window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Deadlift&goal=strength');
            expect(suggestion).toBeNull();
        });

        it('returns null for an empty name (the Add modal opens before anything is typed)', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            expect(await env.window.apiCallDirect('/api/workout/exercises/suggest-target?name=')).toBeNull();
        });

        it('bumps the load when the rep target was hit near failure, and carries the RPE evidence', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            // Strength: band 3-6 reps, target_rir 2, linear preset. Two work
            // sets at the band's ceiling, rated RPE 8 (2 RIR) → gate open.
            await logSession(window, 'Squat', [
                { weight_kg: 60, reps: 8, set_type: 'warmup' },
                { weight_kg: 100, reps: 6, rpe: 8 },
                { weight_kg: 100, reps: 6, rpe: 8 },
            ]);

            const s = await window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Squat&goal=strength');
            // Linear preset, default 2.5 kg step, anchored to the LOGGED weight.
            expect(s.target_weight_kg).toBe(102.5);
            expect(s.training_goal).toBe('strength');
            // Evidence: the max working load and the MINIMUM reps across the
            // work sets — the numbers the engine actually judged, warm-up excluded.
            expect(s.last.weight_kg).toBe(100);
            expect(s.last.reps).toBe(6);
            expect(s.last.effort).toBe('RPE 8 · 2 RIR');
            expect(s.last.logged_at).toBeTruthy();
        });

        it('holds the load when the reps were hit with too much left in reserve (RIR gate)', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            // RPE 6 = 4 RIR, well outside strength's target_rir of 2.
            await logSession(window, 'Squat', [{ weight_kg: 100, reps: 6, rpe: 6 }]);

            const s = await window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Squat&goal=strength');
            expect(s.target_weight_kg).toBe(100);
            expect(s.last.effort).toBe('RPE 6 · 4 RIR');
        });

        it('still suggests with ZERO effort logged anywhere, and omits the effort entirely', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            // No `rpe` on any set — the common case. The RIR gate has no
            // opinion, so the progression rule alone decides, which still beats
            // a blank field. `effort` must be null, never '' or 'RPE null'.
            await logSession(window, 'Squat', [
                { weight_kg: 100, reps: 6 },
                { weight_kg: 100, reps: 6 },
            ]);

            const s = await window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Squat&goal=strength');
            expect(s.target_weight_kg).toBe(102.5);
            expect(s.last.effort).toBeNull();
        });

        it('reads the NEWEST completed log, not the first one stored', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            await logSession(window, 'Squat', [{ weight_kg: 90, reps: 6, rpe: 9 }]);
            await logSession(window, 'Squat', [{ weight_kg: 110, reps: 6, rpe: 9 }]);

            const s = await window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Squat&goal=strength');
            expect(s.last.weight_kg).toBe(110);
            expect(s.target_weight_kg).toBe(112.5);
        });

        it('a goal with no progression (general) mirrors the last weight rather than inventing a bump', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            await logSession(window, 'Squat', [{ weight_kg: 100, reps: 12, rpe: 9 }]);

            const s = await window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Squat&goal=general');
            expect(s.target_weight_kg).toBe(100);
        });

        it('a bodyweight-only history suggests nothing — there is no load to prescribe', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            await logSession(window, 'Pull-up', [{ weight_kg: 0, reps: 10, rpe: 9 }]);

            expect(await window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Pull-up&goal=hypertrophy')).toBeNull();
        });

        // THE pin: the suggestion must equal what the progression engine would
        // prescribe for the same log under the same goal. A second weight model
        // that drifted from progression_preview would be worse than no
        // suggestion at all, and only an end-to-end comparison catches that.
        it('agrees, to the kilo, with what progression-preview proposes for the same log + goal', async () => {
            env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
            const { window } = env;
            // A real plan whose exercise carries exactly what the editor's goal
            // cascade seeds for hypertrophy: 8-12 reps, `double`, default step.
            const group = await window.apiCall('/api/workout/groups/create', 'POST', {
                name: 'Push', training_goal: 'hypertrophy',
            });
            const variant = await window.apiCall('/api/workout/variants/create', 'POST', {
                group_id: group.id, name: 'A',
            });
            const exercise = await window.apiCall('/api/workout/exercises/create', 'POST', {
                variant_id: variant.id, exercise_name: 'Bench', target_sets: 3,
                target_reps_min: 8, target_reps_max: 12,
                progression_rule: { type: 'double' },
            });

            const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
            const sets = [
                { weight_kg: 70, reps: 12, rpe: 9 },
                { weight_kg: 70, reps: 12, rpe: 9 },
                { weight_kg: 70, reps: 12, rpe: 9 },
            ];
            await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                session_id: session.id, exercise_id: exercise.id, exercise_name: 'Bench',
                source: 'schedule', status: 'completed', sets,
            });
            await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });

            const preview = await window.apiCallDirect('/api/workout/progression-preview');
            const row = preview.exercises.find((e) => e.exercise_name === 'Bench');
            const s = await window.apiCallDirect(
                '/api/workout/exercises/suggest-target?name=Bench&goal=hypertrophy');

            expect(row.proposed.target_weight_kg).toBe(72.5);
            expect(s.target_weight_kg).toBe(row.proposed.target_weight_kg);
            // …and they explain themselves with the same effort string.
            expect(s.last.effort).toBe(row.effort);
        });
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
