// Plan 2026-07-06 cloud-c2d, Task 7 — shim-mode contract run of the workout
// next-workout engine, rotation, session lifecycle, and session-detail save
// flows against web/domain/workout.js. Drives window.apiCall /
// window.apiCallDirect (core/api.js), which delegate to the cloud shim
// (web/cloud/js/apishim.js) instead of the network. Divergences here are
// contract bugs in the JS domain layer, not test bugs; the original
// (network-mocked) workout.*.test.js files keep running unshimmed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

// Every day matches, so "today" always resolves in the P2 scan regardless of
// which weekday the suite happens to run on.
const EVERY_DAY = '[0,1,2,3,4,5,6]';

describe('cloud shim contract — workout next-workout, rotation, session lifecycle', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    async function makeRotatingGroup(window, variantNames, scheduledTime = '23:59') {
        const group = await window.apiCall('/api/workout/groups/create', 'POST', {
            name: 'Push/Pull/Legs', is_rotating: true, days_of_week: EVERY_DAY, scheduled_time: scheduledTime
        });
        const variants = [];
        for (let i = 0; i < variantNames.length; i++) {
            variants.push(await window.apiCall('/api/workout/variants/create', 'POST', {
                group_id: group.id, name: variantNames[i], rotation_order: i
            }));
        }
        return { group, variants };
    }

    it('P2 scan resolves the earliest upcoming occurrence and lazily materializes the pending session', async () => {
        const { window } = env;
        const { group, variants } = await makeRotatingGroup(window, ['Push', 'Pull']);

        const next = await window.apiCallDirect('/api/workout/sessions/next');
        expect(next.group_id).toBe(group.id);
        expect(next.variant_id).toBe(variants[0].id);
        expect(next.session.status).toBe('pending');
        expect(next.session.is_today).toBe(true);

        const sessions = await window.apiCall('/api/workout/sessions?limit=10');
        expect(sessions).toHaveLength(1);
        expect(sessions[0].session.id).toBe(next.session.id);
    });

    it('P0 prioritizes an active-today session over a P2 candidate', async () => {
        const { window } = env;
        // Group A (23:59): materialize today's occurrence and start it, so it is
        // an active-today session.
        await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        await window.apiCall(`/api/workout/sessions/${first.session.id}/start`, 'POST');

        // Decoy group B scheduled one minute earlier today: its pending
        // occurrence is the earliest P2 candidate, so without the P0 branch
        // getNext would return B's fresh pending session instead. P0 must keep
        // the active session in front.
        await makeRotatingGroup(window, ['Legs'], '23:58');

        const next = await window.apiCallDirect('/api/workout/sessions/next');
        expect(next.session.id).toBe(first.session.id);
        expect(next.session.status).toBe('in_progress');
    });

    it('P1 resolves the earliest expired-snooze session ahead of a fresh P2 scan', async () => {
        const { window } = env;
        const { group } = await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        await window.apiCall(`/api/workout/sessions/${first.session.id}/snooze`, 'POST', { minutes: -1 });

        const next = await window.apiCallDirect('/api/workout/sessions/next');
        expect(next.session.id).toBe(first.session.id);
        expect(next.session.is_snoozed).toBe(true);
        expect(next.group_id).toBe(group.id);
    });

    it('completing a session advances the rotation cursor to the next variant', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push', 'Pull']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        expect(first.variant_id).toBe(variants[0].id);

        await window.apiCall(`/api/workout/sessions/status?id=${first.session.id}`, 'PUT', { status: 'completed' });

        // Today's occurrence is now completed, so the P2 scan skips it and
        // resolves tomorrow's — same rotating group, cursor now on variant 2.
        const next = await window.apiCallDirect('/api/workout/sessions/next');
        expect(next.session.id).not.toBe(first.session.id);
        expect(next.variant_id).toBe(variants[1].id);
        expect(next.session.is_today).toBe(false);
    });

    it('skipping a session advances the rotation cursor to the next variant', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push', 'Pull']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');

        await window.apiCall(`/api/workout/sessions/${first.session.id}/skip`, 'POST');

        const next = await window.apiCallDirect('/api/workout/sessions/next');
        expect(next.variant_id).toBe(variants[1].id);
    });

    it('next-variant advances the cursor and deletes the current pending session so it re-materializes fresh', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push', 'Pull']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        expect(first.variant_id).toBe(variants[0].id);

        await window.apiCall(`/api/workout/sessions/${first.session.id}/next-variant`, 'POST');

        const next = await window.apiCallDirect('/api/workout/sessions/next');
        expect(next.variant_id).toBe(variants[1].id);
        expect(next.session.is_today).toBe(true);
        // Self-heal: a brand new numeric id at the same deterministic slot,
        // not a dangling reference to the deleted session.
        expect(next.session.id).not.toBe(first.session.id);

        await expect(window.apiCall(`/api/workout/sessions/details?id=${first.session.id}`, 'GET')).resolves.toBeNull();
    });

    it('preskip/cancel-preskip round-trip the session status without touching rotation', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push', 'Pull']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');

        await window.apiCall(`/api/workout/sessions/${first.session.id}/preskip`, 'POST');
        let details = await window.apiCall(`/api/workout/sessions/details?id=${first.session.id}`);
        expect(details.session.status).toBe('pre_skipped');

        await window.apiCall(`/api/workout/sessions/${first.session.id}/cancel-preskip`, 'POST');
        details = await window.apiCall(`/api/workout/sessions/details?id=${first.session.id}`);
        expect(details.session.status).toBe('pending');

        // Rotation never advanced — still resolves the first variant.
        const next = await window.apiCallDirect('/api/workout/sessions/next');
        expect(next.variant_id).toBe(variants[0].id);
    });

    it('setSessionStatus rejects an invalid status', async () => {
        const { window } = env;
        await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        await expect(window.offlineAwareApiCall(`/api/workout/sessions/status?id=${first.session.id}`, 'PUT', { status: 'bogus' }))
            .rejects.toThrow();
    });

    it('session-detail multi-call save gates update-vs-create on log.id > 0, same as sessions.js', async () => {
        const { window } = env;
        await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessionId = first.session.id;
        const existingLog = await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: 1, exercise_name: 'Bench', source: 'schedule',
            target_sets: 3, target_reps_min: 8
        });

        // Simulate sessions.js's save sequence: an entry with id>0 updates,
        // an entry with no id creates.
        const dirtyLogs = [
            { id: existingLog.id, sets_completed: 3, reps_completed: 8, weight_kg: 60 },
            { id: undefined, exercise_id: 2, exercise_name: 'Row', source: 'schedule', target_sets: 3, target_reps_min: 10, target_weight_kg: 40 }
        ];
        for (const log of dirtyLogs) {
            if (log.id > 0) {
                await window.apiCall('/api/workout/sessions/logs/update', 'POST', { ...log });
            } else {
                await window.apiCall('/api/workout/sessions/logs/create', 'POST', { session_id: sessionId, status: 'completed', ...log });
            }
        }

        const details = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(details.logs).toHaveLength(2);
        // Both auto-promote to completed: the update path via sets_completed>=1
        // on a placeholder, the create path via the explicit status above.
        expect(details.logs.every((l) => l.status === 'completed')).toBe(true);
    });

    it('updating a completed log without a status keeps it completed (no reset to placeholder)', async () => {
        const { window } = env;
        await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessionId = first.session.id;
        const log = await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: 1, exercise_name: 'Bench', source: 'schedule',
            target_sets: 3, target_reps_min: 8, status: 'completed'
        });

        // Edit weight only, no status field — same shape sessions.js sends.
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id, sets_completed: 3, reps_completed: 8, weight_kg: 65
        });

        const details = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(details.logs[0].status).toBe('completed');
        expect(details.logs[0].weight_kg).toBe(65);
    });

    it('ad-hoc flow: create-adhoc + log a library exercise, listSessions names it by biggest volume', async () => {
        const { window } = env;
        const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', { name: 'Deadlift' });
        const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        expect(session.group_id).toBe(-1);
        expect(session.variant_id).toBe(-1);
        expect(session.status).toBe('in_progress');

        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: session.id, exercise_id: item.id, exercise_name: item.name, source: 'library',
            target_sets: 3, target_reps_min: 5, target_weight_kg: 100, status: 'completed'
        });

        const sessions = await window.apiCall('/api/workout/sessions?limit=10');
        const view = sessions.find((s) => s.session.id === session.id);
        expect(view.group_name).toBe('Ad-hoc');
        expect(view.variant_name).toBe('Deadlift');
        expect(view.exercises_count).toBe(1);
        expect(view.total_volume).toBe(3 * 5 * 100);
    });

    // Phase 1 (epic med-qj4): per-set logging. A `sets` array nests inside the
    // exerciselog record and round-trips through save → session-details; the
    // flat scalars (sets_completed/reps_completed/weight_kg) are derived from
    // it (len / max reps / max weight), so bot-compat consumers keep working.
    it('per-set: create + update round-trip the sets array and derive the flat scalars', async () => {
        const { window } = env;
        await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessionId = first.session.id;

        // Create a placeholder-style log, then update it with three sets
        // (one warm-up, an RPE on the top set) — the shape sessions.js sends.
        const log = await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: 1, exercise_name: 'Bench', source: 'schedule',
            target_sets: 3, target_reps_min: 8
        });

        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: [
                { set_index: 0, weight_kg: 20, reps: 10, set_type: 'warmup' },
                { set_index: 1, weight_kg: 60, reps: 8, set_type: 'normal' },
                { set_index: 2, weight_kg: 65, reps: 6, rpe: 9, set_type: 'normal' },
            ],
            // sessions.js keeps the derived flat fields alongside sets; the
            // domain recomputes them, so the values here are irrelevant.
            sets_completed: 3, reps_completed: 8, weight_kg: 65,
        });

        let details = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(details.logs[0].sets).toHaveLength(3);
        expect(details.logs[0].sets[0].set_type).toBe('warmup');
        expect(details.logs[0].sets[2].rpe).toBe(9);
        // Derived scalars: len=3, max reps=10, max weight=65 — auto-promoted.
        expect(details.logs[0].sets_completed).toBe(3);
        expect(details.logs[0].reps_completed).toBe(10);
        expect(details.logs[0].weight_kg).toBe(65);
        expect(details.logs[0].status).toBe('completed');

        // A second update replaces the whole array.
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: [{ set_index: 0, weight_kg: 70, reps: 5, set_type: 'normal' }],
        });
        details = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(details.logs[0].sets).toHaveLength(1);
        expect(details.logs[0].sets_completed).toBe(1);
        expect(details.logs[0].weight_kg).toBe(70);
        expect(details.logs[0].reps_completed).toBe(5);

        // An empty sets:[] from an external caller means "no per-set data",
        // NOT "zero everything" — it must fall back to the flat scalars and
        // never wipe the stored breakdown to zeros.
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id, sets: [], sets_completed: 4, reps_completed: 12, weight_kg: 80,
        });
        details = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(details.logs[0].sets_completed).toBe(4);
        expect(details.logs[0].reps_completed).toBe(12);
        expect(details.logs[0].weight_kg).toBe(80);
        // The stale per-set array (which derived 1×5×70) must be dropped so it
        // can't contradict the new flat scalars — reads fall back to the flat
        // aggregate. Pins the updateLog reconciliation branch.
        expect(details.logs[0].sets ?? []).toHaveLength(0);
    });

    it('per-set: rejects an oversized sets array at the domain trust boundary', async () => {
        const { window } = env;
        await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessionId = first.session.id;

        const bigSets = Array.from({ length: 21 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 8 }));
        await expect(window.offlineAwareApiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: 1, exercise_name: 'Bench', source: 'schedule', sets: bigSets,
        })).rejects.toThrow();
    });

    it('per-set: create with an empty sets:[] falls back to target_* scalars, not zeros', async () => {
        const { window } = env;
        await makeRotatingGroup(window, ['Push']);
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessionId = first.session.id;

        const log = await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: 1, exercise_name: 'Bench', source: 'schedule',
            target_sets: 3, target_reps_min: 8, target_weight_kg: 50, sets: [],
        });
        const details = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(details.logs[0].sets_completed).toBe(3);
        expect(details.logs[0].reps_completed).toBe(8);
        expect(details.logs[0].weight_kg).toBe(50);
    });

    // Phase 4 (epic med-qj4.4.1): opt-in per-exercise progression rule. The
    // rule nests on the workoutexercise record (additive vault field, no
    // migration) and round-trips through create/update → GET; none/absent omits
    // it entirely.
    it('progression rule: create/update round-trips it through GET; none/absent omits it', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);

        // Create with a linear rule.
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        expect(ex.progression_rule).toEqual({ type: 'linear', increment_kg: 2.5 });

        let list = await window.apiCall(`/api/workout/exercises?variant_id=${variants[0].id}`);
        expect(list[0].progression_rule).toEqual({ type: 'linear', increment_kg: 2.5 });

        // Update to double-progression with a rep window.
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_reps_max: 10,
            target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 },
        });
        list = await window.apiCall(`/api/workout/exercises?variant_id=${variants[0].id}`);
        expect(list[0].progression_rule).toEqual({ type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 });

        // Update to type:'none' clears the stored rule; the response omits it.
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_reps_max: 10,
            target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'none' },
        });
        list = await window.apiCall(`/api/workout/exercises?variant_id=${variants[0].id}`);
        expect(list[0].progression_rule).toBeUndefined();

        // Absent rule on create also omits it (default mirror behavior).
        const ex2 = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Row', target_sets: 3,
            target_reps_min: 8, order_index: 1,
        });
        expect(ex2.progression_rule).toBeUndefined();
    });

    it('progression rule: an update that OMITS progression_rule (e.g. the MCP update op) preserves the stored rule', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);

        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });

        // The MCP workouts.exercises.update body schema has no progression_rule
        // field, so a rename/weight edit through it omits the key entirely. It
        // must NOT wipe the user's opt-in rule.
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            exercise_name: 'Bench Press', target_sets: 3, target_reps_min: 8,
            target_reps_max: 10, target_weight_kg: 62.5, order_index: 0,
        });
        const list = await window.apiCall(`/api/workout/exercises?variant_id=${variants[0].id}`);
        expect(list[0].exercise_name).toBe('Bench Press');
        expect(list[0].progression_rule).toEqual({ type: 'linear', increment_kg: 2.5 });
    });

    // Phase 4 (epic med-qj4.4.1): the rule is *applied* on a completed log via
    // propagateExerciseToSchedule — the write-back seam. Helper: a completed log
    // whose N work sets each hit `reps` at `weight`, threaded through the domain
    // exactly like sessions.js sends it.
    async function logAllSets(window, sessionId, exId, name, reps, weight, count) {
        const sets = Array.from({ length: count }, (_, i) => ({ set_index: i, weight_kg: weight, reps, set_type: 'normal' }));
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: exId, exercise_name: name, source: 'schedule',
            status: 'completed', sets,
        });
    }

    async function exerciseTargets(window, variantId, exId) {
        const list = await window.apiCall(`/api/workout/exercises?variant_id=${variantId}`);
        return list.find((e) => e.id === exId);
    }

    it('progression linear: +increment when the rep target is met on all work sets, unchanged when not', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // All three work sets hit the top of the range (10) → weight bumps +2.5,
        // the rep range stays put (no mirror widening).
        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        let target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(62.5);
        expect(target.target_reps_min).toBe(8);
        expect(target.target_reps_max).toBe(10);
    });

    it('progression linear: re-saving the same qualifying log is idempotent (does not compound the increment)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // First save bumps 60 → 62.5.
        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);

        // The UI re-sends every existing log on each Save (sessions.js) while the
        // session is still in progress. Re-updating the SAME log with identical
        // sets must NOT add the increment again — the bump anchors to the logged
        // weight, not the (already-bumped) plan target.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        const sets = Array.from({ length: 3 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 10, set_type: 'normal' }));
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', { id: log.id, sets });
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', { id: log.id, sets, notes: 'edited' });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);
    });

    it('progression linear: editing a qualifying log DOWN within the same session releases the un-earned bump', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Qualifying save bumps 60 → 62.5.
        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);

        // The user corrects the same log DOWN (last set was really 9 reps). The
        // goal is no longer met, so the un-earned bump must be released back to
        // the logged weight (60) — not left stuck at 62.5 with no recovery path.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id, sets: [
                { set_index: 0, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 1, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 2, weight_kg: 60, reps: 9, set_type: 'normal' },
            ],
        });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(60);
    });

    it('progression linear: a flat re-save that omits weight_kg does not compound (anchors to the logged weight)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);

        // A flat MCP/API re-save that still meets the rep gate but omits weight_kg
        // (no `sets` array) must anchor the bump to the stored logged weight (60),
        // not the already-bumped plan target — else each save compounds 62.5→65→…
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', { id: log.id, sets_completed: 3, reps_completed: 10, notes: 'a' });
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', { id: log.id, sets_completed: 3, reps_completed: 10, notes: 'b' });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);
    });

    it('progression linear: holds the target steady when the rep target is missed on a set', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // One set short of the top (9 < 10) → no bump, plan unchanged (not mirrored).
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: ex.id, exercise_name: 'Bench', source: 'schedule', status: 'completed',
            sets: [
                { set_index: 0, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 1, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 2, weight_kg: 60, reps: 9, set_type: 'normal' },
            ],
        });
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(60);
        expect(target.target_reps_min).toBe(8);
    });

    it('progression linear: a reduced-load drop set does not suppress a qualifying progression', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Three work sets hit the top of the range (10) at 60kg, then a drop set
        // at reduced load (40kg × 6). The drop set's lower reps must NOT drag the
        // rep-target gate below the goal — the bump still fires.
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: ex.id, exercise_name: 'Bench', source: 'schedule', status: 'completed',
            sets: [
                { set_index: 0, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 1, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 2, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 3, weight_kg: 40, reps: 6, set_type: 'drop' },
            ],
        });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);
    });

    it('progression: a bodyweight log (weight_kg=0) is treated as no anchor — no phantom weight bump', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        // Bodyweight movement: no plan weight, opted into double progression.
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Pull-up', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 2.5, min_reps: 8, max_reps: 12 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Top the range (12) on all bodyweight sets. A weighted exercise would
        // get weight += 2.5; a bodyweight log (weight_kg=0) has no stable anchor,
        // so weight stays absent (no phantom 2.5) and reps still reset to min.
        await logAllSets(window, sessionId, ex.id, 'Pull-up', 12, 0, 3);
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg == null || target.target_weight_kg === 0).toBe(true);
        expect(target.target_reps_min).toBe(8);
        expect(target.target_reps_max).toBe(12);

        // Linear on bodyweight likewise holds steady (returns {} → plan unchanged).
        const ex2 = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Dip', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, order_index: 1,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        await logAllSets(window, sessionId, ex2.id, 'Dip', 10, 0, 3);
        const t2 = await exerciseTargets(window, variants[0].id, ex2.id);
        expect(t2.target_weight_kg == null || t2.target_weight_kg === 0).toBe(true);
    });

    it('progression double: reps climb toward max, then weight bumps and reps reset to min', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // 10 reps on all sets (mid-range) → prescribed reps climb one toward max.
        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        let target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_reps_min).toBe(11);
        expect(target.target_reps_max).toBe(12);
        expect(target.target_weight_kg).toBe(60);

        // Now top the range (12) on all sets → weight +5, reps reset to min.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: Array.from({ length: 3 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 12, set_type: 'normal' })),
        });
        target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(65);
        expect(target.target_reps_min).toBe(8);
        expect(target.target_reps_max).toBe(12);
    });

    it('progression double: rule without an explicit rep window resets to the exercise\'s original floor (no drift)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        // The editor never sends min_reps/max_reps — the window must anchor to
        // the exercise's targets at create time so the climbed target_reps_min
        // doesn't become the reset floor.
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Climb once (10 reps → prescribed reps advance, mutating target_reps_min).
        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        let target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_reps_min).toBe(11);

        // Top the range → reset must return to the ORIGINAL floor (8), not 11.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: Array.from({ length: 3 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 12, set_type: 'normal' })),
        });
        target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(65);
        expect(target.target_reps_min).toBe(8);
        expect(target.target_reps_max).toBe(12);
    });

    it('progression double: a manual exercise edit (payload omits the window) preserves the anchored floor', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Climb once → target_reps_min mutates to 11 (stored rule window stays 8..12).
        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_reps_min).toBe(11);

        // User edits the exercise (e.g. changes nothing but the name). The editor
        // sends only {type, increment_kg} — no min/max. This must NOT re-anchor the
        // window to the climbed target_reps_min (11); the stored floor (8) is kept.
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            variant_id: variants[0].id, exercise_name: 'Bench Press',
            target_sets: 3, target_reps_min: 11, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        });

        // Top the range → reset must return to the ORIGINAL floor (8), not 11.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: Array.from({ length: 3 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 12, set_type: 'normal' })),
        });
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_reps_min).toBe(8);
        expect(target.target_reps_max).toBe(12);
        expect(target.target_weight_kg).toBe(65);
    });

    it('progression double: a manual edit that changes the visible rep ceiling re-anchors the hidden window', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // User deliberately narrows the range 8-12 → 6-10 in the editor. The
        // editor only sends {type, increment_kg}, but the changed ceiling (12→10)
        // must re-anchor the hidden window rather than keep the stale 8..12.
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            variant_id: variants[0].id, exercise_name: 'Bench',
            target_sets: 3, target_reps_min: 6, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        });

        // Top the NEW range (10) on all sets → weight +5, reps reset to the new
        // floor (6), and the ceiling holds at the new max (10).
        await logAllSets(window, sessionId, ex.id, 'Bench', 10, 60, 3);
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(65);
        expect(target.target_reps_min).toBe(6);
        expect(target.target_reps_max).toBe(10);
    });

    it('progression double: a manual edit that lowers only the visible floor re-anchors the hidden window', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // User widens the range 8-12 → 6-12 in the editor: only the floor moves,
        // the ceiling is untouched. The editor still sends {type, increment_kg},
        // so a ceiling-only check would wrongly preserve the stale 8..12 window
        // and reset to 8. The changed floor must re-anchor to the new 6.
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            variant_id: variants[0].id, exercise_name: 'Bench',
            target_sets: 3, target_reps_min: 6, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        });

        // Top the range (12) on all sets → weight +5, reps reset to the new
        // floor (6), not the stale 8.
        await logAllSets(window, sessionId, ex.id, 'Bench', 12, 60, 3);
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(65);
        expect(target.target_reps_min).toBe(6);
        expect(target.target_reps_max).toBe(12);
    });

    it('progression double: inverted rep targets (max < min) with an implicit window are rejected', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        // The editor omits min_reps/max_reps, so the window is synthesized from
        // the exercise targets. Inverted targets would otherwise persist an
        // invalid (min > max) window and progress on the lower max.
        await expect(window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Squat', target_sets: 3,
            target_reps_min: 12, target_reps_max: 10, target_weight_kg: 80, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        })).rejects.toThrow(/min_reps must not exceed max_reps/);
    });

    it('progression: rejects an out-of-range increment_kg that would overflow the plan weight', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        // A large finite increment passes finiteness but would sum to Infinity at
        // apply time (JSON.stringify(Infinity) === "null"), corrupting the plan.
        await expect(window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Squat', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 80, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 1e308 },
        })).rejects.toThrow(/increment_kg must be between 0 and 1000/);
    });

    it('progression none: still mirrors last performance onto the plan', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // No rule → mirror: the plan absorbs the logged weight (65) and reps.
        await logAllSets(window, sessionId, ex.id, 'Bench', 9, 65, 3);
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(65);
        expect(target.target_reps_min).toBe(9);
    });

    // Code-review regression: progression must judge the per-set MINIMUM reps, not
    // the reps_completed scalar (which deriveSetScalars stores as the MAX). A flat
    // update that omits `sets` (e.g. a notes-only re-save) previously fell back to
    // that max, so a heterogeneous log like [12,8] falsely read "all sets hit 12"
    // and advanced the plan on a benign edit.
    it('progression double: a notes-only flat re-save does not false-progress on a heterogeneous log', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 2,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Sets [12, 8] → true min is 8 → a climb (reps 9), NOT a top-of-range reset.
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: ex.id, exercise_name: 'Bench', source: 'schedule',
            sets: [
                { set_index: 0, weight_kg: 60, reps: 12, set_type: 'normal' },
                { set_index: 1, weight_kg: 60, reps: 8, set_type: 'normal' },
            ],
        });
        let target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_reps_min).toBe(9);
        expect(target.target_weight_kg).toBe(60);

        // A notes-only flat re-save (omits `sets`; stored reps_completed=12 is the
        // MAX) must keep judging the stored per-set min (8) — no weight bump/reset.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', { id: log.id, sets_completed: 2, reps_completed: 12, notes: 'felt good' });
        target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(60);
        expect(target.target_reps_min).toBe(9);
    });

    // Code-review regression: propagate merges partial patches over the live plan,
    // so an earlier same-session save that hit max (reset → weight += increment)
    // must not leave the bump stuck when a later edit only qualifies as a climb.
    it('progression double: editing a set down after a reset un-sticks the weight bump', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // All sets at max (12) → reset: weight +5, reps back to min.
        await logAllSets(window, sessionId, ex.id, 'Bench', 12, 60, 3);
        let target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(65);
        expect(target.target_reps_min).toBe(8);

        // Correct one set down to 10 → now a climb at the logged weight, not a
        // reset: the un-earned +5 must fall back to the logged 60.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: [
                { set_index: 0, weight_kg: 60, reps: 12, set_type: 'normal' },
                { set_index: 1, weight_kg: 60, reps: 12, set_type: 'normal' },
                { set_index: 2, weight_kg: 60, reps: 10, set_type: 'normal' },
            ],
        });
        target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(60);
        expect(target.target_reps_min).toBe(11);
    });

    // Code-review regression: a non-finite increment (1e999 parses to Infinity)
    // must be rejected at the boundary — else weightBase + Infinity poisons
    // target_weight_kg, which JSON.stringifies to null and corrupts the plan.
    it('progression: a non-finite increment_kg is rejected and defaults to 2.5', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 1e999 },
        });
        expect(ex.progression_rule.increment_kg).toBe(2.5);
        expect(Number.isFinite(ex.progression_rule.increment_kg)).toBe(true);
    });

    // med-qj4.6.3: the presets are goal-differentiated and RIR-gated. Effort is
    // stored as per-set `rpe` (med-qj4.6.2); RIR = 10 - RPE. A load bump needs
    // the rep target AND RIR <= the goal's target_rir. Helper: the same
    // all-work-sets log as logAllSets, with an RPE on every set.
    async function logAllSetsAtRpe(window, sessionId, exId, name, reps, weight, count, rpe) {
        const sets = Array.from({ length: count }, (_, i) => ({ set_index: i, weight_kg: weight, reps, rpe, set_type: 'normal' }));
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: exId, exercise_name: name, source: 'schedule',
            status: 'completed', sets,
        });
    }

    it('progression linear: RIR gate holds the load when the reps are hit far from failure', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Rep target met, but RPE 7 = 3 reps in reserve — the routine's default
        // hypertrophy goal wants RIR <= 1, so the plan holds at the logged weight.
        await logAllSetsAtRpe(window, sessionId, ex.id, 'Bench', 10, 60, 3, 7);
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(60);

        // Same reps taken to RPE 9 (RIR 1) → the bump fires.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: Array.from({ length: 3 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 10, rpe: 9, set_type: 'normal' })),
        });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);
    });

    it('progression linear: one easy work set suppresses the bump (worst set decides, like reps)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: ex.id, exercise_name: 'Bench', source: 'schedule', status: 'completed',
            sets: [
                { set_index: 0, weight_kg: 60, reps: 10, rpe: 9, set_type: 'normal' },
                { set_index: 1, weight_kg: 60, reps: 10, rpe: 9, set_type: 'normal' },
                // Warm-up RPE is ignored (not a work set) — the easy THIRD set isn't.
                { set_index: 2, weight_kg: 30, reps: 10, rpe: 5, set_type: 'warmup' },
                { set_index: 3, weight_kg: 60, reps: 10, rpe: 6.5, set_type: 'normal' },
            ],
        });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(60);
    });

    it('progression: rating only the top set still progresses (unrated ≠ failed the gate)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // RPE is optional per set and rating just the top set is normal practice
        // ("RIR 0-2 on the top set"). The gate judges the sets the user rated —
        // an unrated set is no opinion, not a veto — so this bumps.
        await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
            session_id: sessionId, exercise_id: ex.id, exercise_name: 'Bench', source: 'schedule', status: 'completed',
            sets: [
                { set_index: 0, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 1, weight_kg: 60, reps: 10, set_type: 'normal' },
                { set_index: 2, weight_kg: 60, reps: 10, rpe: 9, set_type: 'normal' },
            ],
        });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);
    });

    it('progression: the goal override sets the RIR threshold (strength tolerates RIR 2)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const strength = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Squat', target_sets: 3,
            target_reps_min: 5, target_reps_max: 5, target_weight_kg: 100, order_index: 0,
            training_goal: 'strength',
            progression_rule: { type: 'linear', increment_kg: 5 },
        });
        // Same log, same rule — only the goal differs (this one inherits the
        // routine's hypertrophy, which wants RIR <= 1).
        const hyper = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Row', target_sets: 3,
            target_reps_min: 5, target_reps_max: 5, target_weight_kg: 100, order_index: 1,
            progression_rule: { type: 'linear', increment_kg: 5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        await logAllSetsAtRpe(window, sessionId, strength.id, 'Squat', 5, 100, 3, 8);
        await logAllSetsAtRpe(window, sessionId, hyper.id, 'Row', 5, 100, 3, 8);
        expect((await exerciseTargets(window, variants[0].id, strength.id)).target_weight_kg).toBe(105);
        expect((await exerciseTargets(window, variants[0].id, hyper.id)).target_weight_kg).toBe(100);
    });

    it('progression double: reps at the window top but far from failure hold the plan (no reset, no bump)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // Top of the window at RPE 7 (RIR 3): no weight bump AND no reset down
        // to the floor — the prescription stands, the user gets the effort nudge.
        await logAllSetsAtRpe(window, sessionId, ex.id, 'Bench', 12, 60, 3, 7);
        let target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(60);
        expect(target.target_reps_min).toBe(8);
        expect(target.target_reps_max).toBe(12);

        // Same reps at RPE 10 (RIR 0) → weight bumps, reps reset to the floor.
        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: Array.from({ length: 3 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 12, rpe: 10, set_type: 'normal' })),
        });
        target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_weight_kg).toBe(65);
        expect(target.target_reps_min).toBe(8);
    });

    it('progression double: the rep climb is not effort-gated (reps in reserve = prescribe more reps)', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5, min_reps: 8, max_reps: 12 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        await logAllSetsAtRpe(window, sessionId, ex.id, 'Bench', 9, 60, 3, 6);
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_reps_min).toBe(10);
        expect(target.target_weight_kg).toBe(60);
    });

    it('progression double: the goal band never raises an explicit rep ceiling', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        // Ceiling set (6), floor left unset — hypertrophy's band floor is 8, so a
        // naive fill would push the window to 8 and strand the user's own target.
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 0, target_reps_max: 6, target_weight_kg: 60, order_index: 0,
            progression_rule: { type: 'double', increment_kg: 5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        await logAllSetsAtRpe(window, sessionId, ex.id, 'Bench', 6, 60, 3, 10);
        const target = await exerciseTargets(window, variants[0].id, ex.id);
        expect(target.target_reps_max).toBe(6);
        expect(target.target_weight_kg).toBe(65);
    });

    it('progression: an exercise with no rep target falls back to the goal band, never "reps >= 0"', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3,
            target_reps_min: 0, target_weight_kg: 60, order_index: 0,
            training_goal: 'endurance',
            progression_rule: { type: 'linear', increment_kg: 2.5 },
        });
        const sessionId = (await window.apiCallDirect('/api/workout/sessions/next')).session.id;

        // 12 reps would clear a 0 target, but the endurance band tops out at 25.
        await logAllSets(window, sessionId, ex.id, 'Bench', 12, 60, 3);
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(60);

        const log = (await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`)).logs[0];
        await window.apiCall('/api/workout/sessions/logs/update', 'POST', {
            id: log.id,
            sets: Array.from({ length: 3 }, (_, i) => ({ set_index: i, weight_kg: 60, reps: 25, set_type: 'normal' })),
        });
        expect((await exerciseTargets(window, variants[0].id, ex.id)).target_weight_kg).toBe(62.5);
    });

    // med-qj4.2.1: a completed session snapshots its planned exercises + targets
    // so later edits to the variant / library / targets do NOT retroactively
    // rewrite what that past session shows.
    it('completing a session snapshots the plan; later plan edits do not rewrite the past session', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0
        });

        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessionId = first.session.id;
        await window.apiCall(`/api/workout/sessions/status?id=${sessionId}`, 'PUT', { status: 'completed' });

        const before = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(before.session.exercise_snapshot).toEqual([
            { exercise_id: ex.id, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0 }
        ]);

        // Mutate the plan three ways: change the exercise's targets, rename the
        // library item it links to, and add a second exercise to the variant.
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            exercise_name: 'Incline Bench', target_sets: 5, target_reps_min: 3, target_reps_max: 5, target_weight_kg: 80, order_index: 0
        });
        const lib = (await window.apiCall('/api/workout/exercise-library')).find((l) => l.name === 'Bench' || l.name === 'Incline Bench');
        if (lib) await window.apiCall(`/api/workout/exercise-library/update?id=${lib.id}`, 'PUT', { name: 'Renamed', default_sets: 1, default_reps_min: 1 });
        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Fly', target_sets: 3, target_reps_min: 12, order_index: 1
        });

        // Past session's detail snapshot is untouched by all three edits.
        const after = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(after.session.exercise_snapshot).toEqual(before.session.exercise_snapshot);

        // exercises_count is stable at 1 even though the variant now has 2.
        const sessions = await window.apiCall('/api/workout/sessions?limit=10');
        expect(sessions.find((s) => s.session.id === sessionId).exercises_count).toBe(1);
    });

    // The snapshot is immutable: a repeat/retry completed-status call after the
    // variant changed must NOT rebuild it against the now-changed plan.
    it('re-completing a session does not rewrite its existing snapshot', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        const ex = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_weight_kg: 60, order_index: 0
        });

        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessionId = first.session.id;
        await window.apiCall(`/api/workout/sessions/status?id=${sessionId}`, 'PUT', { status: 'completed' });
        const before = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);

        // Change the plan, then flip the completed status again (a retry).
        await window.apiCall(`/api/workout/exercises/update?id=${ex.id}`, 'PUT', {
            exercise_name: 'Bench', target_sets: 9, target_reps_min: 1, target_weight_kg: 200, order_index: 0
        });
        await window.apiCall(`/api/workout/sessions/status?id=${sessionId}`, 'PUT', { status: 'completed' });

        const after = await window.apiCall(`/api/workout/sessions/details?id=${sessionId}`);
        expect(after.session.exercise_snapshot).toEqual(before.session.exercise_snapshot);
    });

    it('a snapshot-less (legacy) session falls back to the live variant for exercises_count', async () => {
        const { window } = env;
        const { variants } = await makeRotatingGroup(window, ['Push']);
        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variants[0].id, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, order_index: 0
        });
        // Materialize but leave the session pending (no completion → no snapshot).
        const first = await window.apiCallDirect('/api/workout/sessions/next');
        const sessions = await window.apiCall('/api/workout/sessions?limit=10');
        const view = sessions.find((s) => s.session.id === first.session.id);
        expect(view.session.exercise_snapshot).toBeUndefined();
        expect(view.exercises_count).toBe(1);
    });

    // bd med-9tx: at most one active session at a time. A second ad-hoc Start
    // while one is already active must resume the existing session, not mint a
    // duplicate — matching service.go's CreateAdHocSession guard.
    it('ad-hoc Start resumes the existing active session instead of creating a duplicate', async () => {
        const { window } = env;
        const first = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        expect(first.status).toBe('in_progress');

        const second = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
        expect(second.id).toBe(first.id);

        const sessions = await window.apiCall('/api/workout/sessions?limit=10');
        const adHoc = sessions.filter((s) => s.session.group_id === -1);
        expect(adHoc).toHaveLength(1);
    });
});
