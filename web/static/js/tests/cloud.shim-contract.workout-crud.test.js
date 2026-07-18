// Plan 2026-07-06 cloud-c2d, Task 7 — shim-mode contract run of the workout
// groups/variants/exercises/library CRUD flows against web/domain/workout.js.
// Drives window.apiCall / window.apiCallDirect (core/api.js), which delegate
// to the cloud shim (web/cloud/js/apishim.js) instead of the network — same
// pattern as cloud.shim-contract.food-log.test.js. Divergences here are
// contract bugs in the JS domain layer, not test bugs; the original
// (network-mocked) workout.*.test.js / features.workout-*.test.js files keep
// running unshimmed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

describe('cloud shim contract — workout groups/variants/exercises/library CRUD', () => {
    let env;

    beforeEach(() => {
        env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('group create/list/update round-trips through the shim', async () => {
        const { window } = env;
        const created = await window.apiCall('/api/workout/groups/create', 'POST', {
            name: 'Push/Pull/Legs', is_rotating: true, days_of_week: '[1,3,5]', scheduled_time: '18:00'
        });
        expect(created.id).toBeGreaterThan(0);

        let list = await window.apiCallDirect('/api/workout/groups');
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('Push/Pull/Legs');

        await window.apiCall(`/api/workout/groups/update?id=${created.id}`, 'PUT', {
            name: 'PPL', is_rotating: true, days_of_week: '[1,3,5]', scheduled_time: '19:00', active: true
        });
        list = await window.apiCallDirect('/api/workout/groups');
        expect(list[0].name).toBe('PPL');
        expect(list[0].scheduled_time).toBe('19:00');
    });

    it('training_goal round-trips and defaults to hypertrophy', async () => {
        const { window } = env;
        // Explicit goal is stored + returned.
        const strong = await window.apiCall('/api/workout/groups/create', 'POST', {
            name: 'Strength Block', training_goal: 'strength'
        });
        let list = await window.apiCallDirect('/api/workout/groups');
        expect(list.find(g => g.id === strong.id).training_goal).toBe('strength');

        // Omitted goal defaults to hypertrophy.
        const dflt = await window.apiCall('/api/workout/groups/create', 'POST', { name: 'No Goal' });
        list = await window.apiCallDirect('/api/workout/groups');
        expect(list.find(g => g.id === dflt.id).training_goal).toBe('hypertrophy');

        // Update to a new goal round-trips; invalid falls back to hypertrophy.
        await window.apiCall(`/api/workout/groups/update?id=${strong.id}`, 'PUT', {
            name: 'Strength Block', training_goal: 'endurance'
        });
        await window.apiCall(`/api/workout/groups/update?id=${dflt.id}`, 'PUT', {
            name: 'No Goal', training_goal: 'bogus'
        });
        list = await window.apiCallDirect('/api/workout/groups');
        expect(list.find(g => g.id === strong.id).training_goal).toBe('endurance');
        expect(list.find(g => g.id === dflt.id).training_goal).toBe('hypertrophy');
    });

    it('deleting a group with variants still holding exercises is rejected', async () => {
        const { window } = env;
        const group = await window.apiCall('/api/workout/groups/create', 'POST', { name: 'Push' });
        const variant = await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'A' });
        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variant.id, exercise_name: 'Bench Press', target_sets: 3, target_reps_min: 8
        });

        await expect(window.offlineAwareApiCall(`/api/workout/groups/delete?id=${group.id}`, 'DELETE'))
            .rejects.toThrow(/remove all exercises/);

        await window.apiCall(`/api/workout/exercises/delete?id=${(await window.apiCall(`/api/workout/exercises?variant_id=${variant.id}`))[0].id}`, 'DELETE');
        await expect(window.apiCall(`/api/workout/groups/delete?id=${group.id}`, 'DELETE')).resolves.not.toThrow();

        const groups = await window.apiCallDirect('/api/workout/groups');
        expect(groups).toHaveLength(0);
        const variants = await window.apiCall(`/api/workout/variants?group_id=${group.id}`);
        expect(variants).toHaveLength(0);
    });

    it('variant create/list/update/delete round-trips, ordered by rotation_order then name', async () => {
        const { window } = env;
        const group = await window.apiCall('/api/workout/groups/create', 'POST', { name: 'Push' });
        const b = await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'B', rotation_order: 1 });
        await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'A', rotation_order: 0 });

        let variants = await window.apiCall(`/api/workout/variants?group_id=${group.id}`);
        expect(variants.map((v) => v.name)).toEqual(['A', 'B']);

        await window.apiCall(`/api/workout/variants/update?id=${b.id}`, 'PUT', { name: 'B2', rotation_order: 1 });
        variants = await window.apiCall(`/api/workout/variants?group_id=${group.id}`);
        expect(variants.find((v) => v.id === b.id).name).toBe('B2');

        await window.apiCall(`/api/workout/variants/delete?id=${b.id}`, 'DELETE');
        variants = await window.apiCall(`/api/workout/variants?group_id=${group.id}`);
        expect(variants).toHaveLength(1);
    });

    it('exercise create/list/update/delete round-trips, ordered by order_index', async () => {
        const { window } = env;
        const group = await window.apiCall('/api/workout/groups/create', 'POST', { name: 'Push' });
        const variant = await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'A' });
        const e2 = await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variant.id, exercise_name: 'Row', target_sets: 3, target_reps_min: 10, order_index: 1
        });
        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: variant.id, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, order_index: 0
        });

        let exercises = await window.apiCall(`/api/workout/exercises?variant_id=${variant.id}`);
        expect(exercises.map((e) => e.exercise_name)).toEqual(['Bench', 'Row']);

        await window.apiCall(`/api/workout/exercises/update?id=${e2.id}`, 'PUT', {
            exercise_name: 'Row2', target_sets: 4, target_reps_min: 10, order_index: 1
        });
        exercises = await window.apiCall(`/api/workout/exercises?variant_id=${variant.id}`);
        expect(exercises.find((e) => e.id === e2.id).exercise_name).toBe('Row2');

        await window.apiCall(`/api/workout/exercises/delete?id=${e2.id}`, 'DELETE');
        exercises = await window.apiCall(`/api/workout/exercises?variant_id=${variant.id}`);
        expect(exercises).toHaveLength(1);
    });

    it('creating a plan exercise promotes it into the exercise library (med-spp), deduped by name', async () => {
        const { window } = env;
        const group = await window.apiCall('/api/workout/groups/create', 'POST', { name: 'Push' });
        const varA = await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'A' });
        const varB = await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'B' });

        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: varA.id, exercise_name: 'Bench Press', target_sets: 4, target_reps_min: 8, target_reps_max: 10, target_weight_kg: 60
        });

        const lib = await window.apiCall('/api/workout/exercise-library');
        const entry = lib.find((i) => i.name === 'Bench Press');
        expect(entry).toBeTruthy();
        expect(entry.default_sets).toBe(4);
        expect(entry.default_reps_min).toBe(8);
        expect(entry.default_reps_max).toBe(10);
        expect(entry.default_weight_kg).toBe(60);

        // Same name in another variant must not create a second library entry.
        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: varB.id, exercise_name: 'Bench Press', target_sets: 5, target_reps_min: 3
        });
        const after = await window.apiCall('/api/workout/exercise-library');
        expect(after.filter((i) => i.name === 'Bench Press')).toHaveLength(1);
    });

    // med-prk.2 cross-mode contract-parity test (shim half; Go half is
    // TestExerciseLibraryReference_CreateDedupeRename). Create "Bench" twice
    // (dedupe to one library row), rename the library row, and assert the plan
    // reads follow the rename through exercise_library_id.
    it('renaming a library exercise renames it in plans (reference by id)', async () => {
        const { window } = env;
        const group = await window.apiCall('/api/workout/groups/create', 'POST', { name: 'Push' });
        const varA = await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'A' });
        const varB = await window.apiCall('/api/workout/variants/create', 'POST', { group_id: group.id, name: 'B' });

        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: varA.id, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8
        });
        await window.apiCall('/api/workout/exercises/create', 'POST', {
            variant_id: varB.id, exercise_name: 'Bench', target_sets: 5, target_reps_min: 3
        });

        // (a) exactly one library row for the duplicated name.
        const lib = await window.apiCall('/api/workout/exercise-library');
        const bench = lib.filter((i) => i.name === 'Bench');
        expect(bench).toHaveLength(1);

        // (b) rename it → both plans' reads follow through the FK.
        await window.apiCall(`/api/workout/exercise-library/update?id=${bench[0].id}`, 'PUT', {
            name: 'Bench Press', default_sets: 3, default_reps_min: 8
        });
        for (const v of [varA.id, varB.id]) {
            const exs = await window.apiCall(`/api/workout/exercises?variant_id=${v}`);
            expect(exs).toHaveLength(1);
            expect(exs[0].exercise_name).toBe('Bench Press');
        }
        const after = await window.apiCall('/api/workout/exercise-library');
        expect(after.filter((i) => i.name === 'Bench Press')).toHaveLength(1);

        // (c) deleting the referenced library row snapshots its current name into
        // the plans and drops the FK — no revert to the stale cached name (mirrors
        // Go's DeleteExerciseLibraryItem reconciliation).
        await window.apiCall(`/api/workout/exercise-library/delete?id=${after[0].id}`, 'DELETE');
        for (const v of [varA.id, varB.id]) {
            const exs = await window.apiCall(`/api/workout/exercises?variant_id=${v}`);
            expect(exs[0].exercise_name).toBe('Bench Press');
            expect(exs[0].exercise_library_id == null).toBe(true);
        }
    });

    it('exercise library create/list/update/delete round-trips with name-uniqueness enforced', async () => {
        const { window } = env;
        const item = await window.apiCall('/api/workout/exercise-library/create', 'POST', {
            name: 'Deadlift', default_sets: 3, default_reps_min: 5
        });
        await expect(window.offlineAwareApiCall('/api/workout/exercise-library/create', 'POST', { name: 'Deadlift' }))
            .rejects.toThrow();

        let list = await window.apiCall('/api/workout/exercise-library');
        expect(list).toHaveLength(1);

        await window.apiCall(`/api/workout/exercise-library/update?id=${item.id}`, 'PUT', {
            name: 'Deadlift', default_sets: 5, default_reps_min: 5
        });
        list = await window.apiCall('/api/workout/exercise-library');
        expect(list[0].default_sets).toBe(5);

        await window.apiCall(`/api/workout/exercise-library/delete?id=${item.id}`, 'DELETE');
        list = await window.apiCall('/api/workout/exercise-library');
        expect(list).toHaveLength(0);
    });
});
