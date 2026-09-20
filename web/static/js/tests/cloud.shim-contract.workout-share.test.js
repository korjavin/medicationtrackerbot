// bd med-uo64.1 — shim-mode contract for portable workout plan export/import
// (web/domain/workout-share.js via web/cloud/js/apishim.js). Same fixture
// style as cloud.shim-contract.workout-crud.test.js: a router over an
// in-memory records port, driven through window.apiCall / apiCallDirect.
// Error-path assertions use window.offlineAwareApiCall so the raw domain
// error (carrying .status) is observed instead of apiCall's null/alert path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

const stripGroup = (g) => {
    const { id, created_at, updated_at, ...rest } = g;
    return rest;
};

const stripVariant = (v) => {
    const { id, group_id, created_at, ...rest } = v;
    return rest;
};

const stripExercise = (e) => {
    const { id, variant_id, exercise_library_id, ...rest } = e;
    return rest;
};

const stripLibrary = (item) => {
    const { id, user_id, created_at, updated_at, ...rest } = item;
    return rest;
};

async function buildSourcePlan(window) {
    const group = await window.apiCall('/api/workout/groups/create', 'POST', {
        name: 'Share Me', description: 'sender plan', is_rotating: true,
        days_of_week: '[1,3]', scheduled_time: '18:00', training_goal: 'strength',
    });
    const dayA = await window.apiCall('/api/workout/variants/create', 'POST', {
        group_id: group.id, name: 'Day A', description: 'push focus', rotation_order: 0,
    });
    const dayB = await window.apiCall('/api/workout/variants/create', 'POST', {
        group_id: group.id, name: 'Day B', rotation_order: 1,
    });
    await window.apiCall('/api/workout/exercises/create', 'POST', {
        variant_id: dayA.id, exercise_name: 'Bench Press', target_sets: 4,
        target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60, order_index: 0,
        progression_rule: { type: 'double', increment_kg: 2.5 }, training_goal: 'strength',
    });
    await window.apiCall('/api/workout/exercises/create', 'POST', {
        variant_id: dayA.id, exercise_name: 'Overhead Press', target_sets: 3,
        target_reps_min: 8, order_index: 1,
    });
    await window.apiCall('/api/workout/exercises/create', 'POST', {
        variant_id: dayB.id, exercise_name: 'Squat', target_sets: 5,
        target_reps_min: 5, target_weight_kg: 100, order_index: 0,
    });
    // Tag one library row so the export has a body_part to carry.
    const lib = await window.apiCall('/api/workout/exercise-library');
    const bench = lib.find((i) => i.name === 'Bench Press');
    await window.apiCall(`/api/workout/exercise-library/update?id=${bench.id}`, 'PUT', {
        name: 'Bench Press', default_sets: 4, default_reps_min: 8,
        default_reps_max: 10, default_weight_kg: 60, body_part: 'chest',
    });
    return group;
}

async function snapshotPlan(window, groupId) {
    const variants = await window.apiCall(`/api/workout/variants?group_id=${groupId}`);
    const days = [];
    for (const v of variants) {
        days.push({
            variant: stripVariant(v),
            exercises: (await window.apiCall(`/api/workout/exercises?variant_id=${v.id}`)).map(stripExercise),
        });
    }
    return days;
}

describe('cloud shim contract — workout plan export/import (share)', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('export → import into a fresh store round-trips losslessly modulo ids/timestamps', async () => {
        const { window } = env;
        const group = await buildSourcePlan(window);
        const token = await window.apiCall(`/api/workout/plans/export?id=${group.id}`);
        expect(token.v).toBe(1);
        expect(token.plan.name).toBe('Share Me');
        expect(token.plan.days).toHaveLength(2);
        // Absent optionals stay omitted so the token stays small …
        const dayA = token.plan.days.find((d) => d.name === 'Day A');
        const ohp = dayA.exercises.find((e) => e.name === 'Overhead Press');
        expect('reps_max' in ohp).toBe(false);
        expect('weight_kg' in ohp).toBe(false);
        // … while set optionals ride along.
        const bench = dayA.exercises.find((e) => e.name === 'Bench Press');
        expect(bench.progression_rule.type).toBe('double');
        expect(bench.training_goal).toBe('strength');
        expect(token.plan.library.find((e) => e.name === 'Bench Press').body_part).toBe('chest');

        // Fresh router over an empty store — the cross-instance case.
        const env2 = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        try {
            const res = await env2.window.apiCall(
                '/api/workout/plans/import', 'POST', JSON.parse(JSON.stringify(token)),
            );
            expect(res.days).toBe(2);
            expect(res.exercises).toBe(3);
            expect(res.exercises_created).toBe(3);
            expect(res.exercises_matched).toBe(0);

            expect(
                (await env2.window.apiCallDirect('/api/workout/groups')).map(stripGroup),
            ).toEqual((await window.apiCallDirect('/api/workout/groups')).map(stripGroup));
            expect(await snapshotPlan(env2.window, res.id))
                .toEqual(await snapshotPlan(window, group.id));
            expect(
                (await env2.window.apiCall('/api/workout/exercise-library')).map(stripLibrary),
            ).toEqual((await window.apiCall('/api/workout/exercise-library')).map(stripLibrary));

            // Every imported exercise links back to the recipient library …
            for (const v of await env2.window.apiCall(`/api/workout/variants?group_id=${res.id}`)) {
                const exs = await env2.window.apiCall(`/api/workout/exercises?variant_id=${v.id}`);
                for (const e of exs) expect(e.exercise_library_id).toBeGreaterThan(0);
            }
            // … and the body_part tag survived the trip.
            const dstLib = await env2.window.apiCall('/api/workout/exercise-library');
            expect(dstLib.find((i) => i.name === 'Bench Press').body_part).toBe('chest');
        } finally {
            env2.cleanup();
        }
    });

    it('importing twice creates "X" and "X (2)" with no library duplicates', async () => {
        const { window } = env;
        const group = await buildSourcePlan(window);
        const token = await window.apiCall(`/api/workout/plans/export?id=${group.id}`);

        // Same store for both imports — a fresh one, so the names land on
        // exactly "Share Me" and "Share Me (2)".
        const env2 = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        try {
            const first = await env2.window.apiCall(
                '/api/workout/plans/import', 'POST', JSON.parse(JSON.stringify(token)),
            );
            expect(first.name).toBe('Share Me');
            const libAfterFirst = await env2.window.apiCall('/api/workout/exercise-library');

            const second = await env2.window.apiCall(
                '/api/workout/plans/import', 'POST', JSON.parse(JSON.stringify(token)),
            );
            expect(second.name).toBe('Share Me (2)');
            expect(second.id).not.toBe(first.id);
            expect(second.exercises_matched).toBe(second.exercises);
            expect(second.exercises_created).toBe(0);

            expect(await env2.window.apiCallDirect('/api/workout/groups')).toHaveLength(2);
            const libAfterSecond = await env2.window.apiCall('/api/workout/exercise-library');
            expect(libAfterSecond.map((i) => i.name).sort())
                .toEqual(libAfterFirst.map((i) => i.name).sort());
        } finally {
            env2.cleanup();
        }
    });

    it('matches the recipient library case-insensitively and keeps their casing', async () => {
        const { window } = env;
        await window.apiCall('/api/workout/exercise-library/create', 'POST', {
            name: 'bench press', default_sets: 3, default_reps_min: 8,
        });
        const payload = {
            v: 1,
            plan: {
                name: 'Case Plan',
                days: [{
                    name: 'Day', exercises: [
                        { name: 'Bench Press', sets: 3, reps_min: 8, order_index: 0 },
                    ],
                }],
                library: [],
            },
        };
        const res = await window.apiCall('/api/workout/plans/import', 'POST', payload);
        expect(res.exercises_matched).toBe(1);
        expect(res.exercises_created).toBe(0);

        const lib = await window.apiCall('/api/workout/exercise-library');
        expect(lib.filter((i) => i.name.toLowerCase() === 'bench press')).toHaveLength(1);
        const variants = await window.apiCall(`/api/workout/variants?group_id=${res.id}`);
        const exs = await window.apiCall(`/api/workout/exercises?variant_id=${variants[0].id}`);
        expect(exs).toHaveLength(1);
        expect(exs[0].exercise_name).toBe('bench press');
    });

    it('import never touches an existing group', async () => {
        const { window } = env;
        const existing = await window.apiCall('/api/workout/groups/create', 'POST', { name: 'Keep Me' });
        const existingVariant = await window.apiCall('/api/workout/variants/create', 'POST', {
            group_id: existing.id, name: 'Solo',
        });
        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: existingVariant.id, exercise_name: 'Curl', target_sets: 3, target_reps_min: 10,
        });
        const groupsBefore = await window.apiCallDirect('/api/workout/groups');
        const variantsBefore = await window.apiCall(`/api/workout/variants?group_id=${existing.id}`);

        const res = await window.apiCall('/api/workout/plans/import', 'POST', {
            v: 1,
            plan: {
                name: 'New Plan',
                days: [{
                    name: 'Day', exercises: [
                        { name: 'Dip', sets: 3, reps_min: 10, order_index: 0 },
                    ],
                }],
                library: [],
            },
        });

        const groupsAfter = await window.apiCallDirect('/api/workout/groups');
        expect(groupsAfter.filter((g) => g.id !== res.id)).toEqual(groupsBefore);
        expect(await window.apiCall(`/api/workout/variants?group_id=${existing.id}`))
            .toEqual(variantsBefore);
    });

    it('rejects bad payloads with status 400', async () => {
        const { window } = env;
        const goodDay = (exercises) => ({ name: 'Day', exercises });
        const goodEx = (overrides = {}) => ({
            name: 'Bench', sets: 3, reps_min: 8, order_index: 0, ...overrides,
        });
        const cases = [
            ['v !== 1', { v: 2, plan: { name: 'X', days: [], library: [] } }],
            ['missing plan.name', { v: 1, plan: { days: [], library: [] } }],
            ['blank plan.name', { v: 1, plan: { name: '  ', days: [], library: [] } }],
            ['>20 days', {
                v: 1,
                plan: {
                    name: 'X', library: [],
                    days: Array.from({ length: 21 }, (_, i) => goodDay([goodEx({ name: `E${i}` })])),
                },
            }],
            ['>50 exercises in a day', {
                v: 1,
                plan: {
                    name: 'X', library: [],
                    days: [goodDay(Array.from({ length: 51 }, (_, i) => goodEx({ name: `E${i}` })))],
                },
            }],
            ['non-finite sets', {
                v: 1, plan: { name: 'X', library: [], days: [goodDay([goodEx({ sets: Infinity })])] },
            }],
            ['NaN weight', {
                v: 1,
                plan: { name: 'X', library: [], days: [goodDay([goodEx({ weight_kg: NaN })])] },
            }],
            ['negative progression increment', {
                v: 1,
                plan: {
                    name: 'X', library: [],
                    days: [goodDay([
                        goodEx(),
                        goodEx({ name: 'Squat', progression_rule: { type: 'linear', increment_kg: -1 } }),
                    ])],
                },
            }],
            ['inverted double-progression window', {
                v: 1,
                plan: {
                    name: 'X', library: [],
                    days: [goodDay([
                        goodEx({ progression_rule: { type: 'double', min_reps: 12, max_reps: 8 } }),
                    ])],
                },
            }],
            ['fractional targets collapsing after truncation', {
                v: 1,
                plan: {
                    name: 'X', library: [],
                    days: [goodDay([
                        goodEx({
                            reps_min: 8.5, reps_max: 8.5,
                            progression_rule: { type: 'double', increment_kg: 2.5 },
                        }),
                    ])],
                },
            }],
        ];
        for (const [label, payload] of cases) {
            await expect(
                window.offlineAwareApiCall('/api/workout/plans/import', 'POST', payload),
                label,
            ).rejects.toMatchObject({ status: 400 });
        }
        // A rejected import persists nothing — no partial group is left behind
        // for a retry to suffix-copy (codex review round 1).
        expect(await window.apiCallDirect('/api/workout/groups')).toHaveLength(0);
        expect(await window.apiCall('/api/workout/exercise-library')).toHaveLength(0);
    });

    it('a linear rule whose window sits outside the rep targets still round-trips', async () => {
        // anchorDoubleWindow only constrains double rules — a linear rule with
        // an explicit min above the target max is storable, so it must import
        // (codex review round 2).
        const { window } = env;
        const payload = {
            v: 1,
            plan: {
                name: 'Linear Plan',
                days: [{
                    name: 'Day', exercises: [{
                        name: 'Press', sets: 3, reps_min: 8, reps_max: 12, order_index: 0,
                        progression_rule: { type: 'linear', increment_kg: 2.5, min_reps: 15 },
                    }],
                }],
                library: [],
            },
        };
        const res = await window.apiCall('/api/workout/plans/import', 'POST', payload);
        expect(res.exercises).toBe(1);
        const token = await window.apiCall(`/api/workout/plans/export?id=${res.id}`);
        expect(token.plan.days[0].exercises[0].progression_rule).toEqual(
            { type: 'linear', increment_kg: 2.5, min_reps: 15 },
        );
        const retry = await window.apiCall(
            '/api/workout/plans/import', 'POST', JSON.parse(JSON.stringify(token)),
        );
        expect(retry.name).toBe('Linear Plan (2)');
    });

    it('export of an unknown id rejects with status 404', async () => {
        const { window } = env;
        await expect(window.offlineAwareApiCall('/api/workout/plans/export?id=999999'))
            .rejects.toMatchObject({ status: 404 });
        await expect(window.offlineAwareApiCall('/api/workout/plans/export?id=0'))
            .rejects.toMatchObject({ status: 404 });
    });
});
