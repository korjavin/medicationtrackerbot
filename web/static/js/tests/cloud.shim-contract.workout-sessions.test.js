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
