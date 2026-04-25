// Wandergeek Workouts log-set + edit-exercise modals (Phase 7, Task 8).
//
// Exercises the rewritten log-set modal (#workout-add-exercise-to-session-modal)
// and per-variant edit-exercise modal (#workout-exercise-modal). Both share the
// generic `.wg-modal` shell; both use mono eyebrow + title headers,
// `.wg-gloss--inset` input wraps, and a Cancel/Save action bar (Save as
// sun-glossed 2x flex per modal-button-order convention).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('Log-set modal shell (Phase 7, Task 8)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('uses the .wg-modal + .wg-workouts-log-set-modal classes', () => {
        const { document } = env;
        const modal = document.getElementById('workout-add-exercise-to-session-modal');
        expect(modal).not.toBeNull();
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-workouts-log-set-modal')).toBe(true);
    });

    it('renders a mono eyebrow + title heading', () => {
        const { document } = env;
        const modal = document.getElementById('workout-add-exercise-to-session-modal');
        const eyebrow = modal.querySelector('.wg-workouts-log-set-modal__eyebrow');
        const title = modal.querySelector('.wg-workouts-log-set-modal__title');
        expect(eyebrow).not.toBeNull();
        expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
        expect(eyebrow.textContent).toBe('Log set');
        expect(title).not.toBeNull();
        expect(title.classList.contains('wg-mono-display')).toBe(true);
        expect(title.id).toBe('workout-add-exercise-to-session-title');
    });

    it('wraps every input field in .wg-gloss--inset', () => {
        const { document } = env;
        const modal = document.getElementById('workout-add-exercise-to-session-modal');
        const wraps = modal.querySelectorAll('.wg-workouts-log-set-modal__input-wrap');
        expect(wraps.length).toBeGreaterThanOrEqual(5);
        wraps.forEach((wrap) => {
            expect(wrap.classList.contains('wg-gloss--inset')).toBe(true);
        });
    });

    it('has Cancel + Save header-action buttons with Save as sun-glossed', () => {
        const { document } = env;
        const actions = document.querySelector('#workout-add-exercise-to-session-modal .wg-workouts-log-set-modal__header-actions');
        expect(actions).not.toBeNull();

        const cancel = actions.querySelector('#session-add-exercise-cancel-btn');
        const save = actions.querySelector('#session-add-exercise-save-btn');
        expect(cancel).not.toBeNull();
        expect(save).not.toBeNull();

        expect(cancel.classList.contains('wg-gloss')).toBe(true);
        expect(cancel.classList.contains('wg-workouts-log-set-modal__header-btn')).toBe(true);
        expect(save.classList.contains('wg-gloss')).toBe(true);
        expect(save.classList.contains('wg-gloss--sun')).toBe(true);
        expect(save.classList.contains('wg-workouts-log-set-modal__header-btn--save')).toBe(true);
    });

    it('preserves the preexisting ID hooks used by saveNewSessionExercise + onSessionExerciseSelect', () => {
        const { document } = env;
        ['session-add-exercise-name', 'session-add-exercise-id',
         'session-add-exercise-sets', 'session-add-exercise-reps',
         'session-add-exercise-weight', 'session-add-exercise-notes',
         'session-add-exercise-cancel-btn', 'session-add-exercise-save-btn',
         'session-add-exercise-close-btn', 'workout-add-exercise-to-session-title',
         'unique-exercises-list']
            .forEach((id) => {
                expect(document.getElementById(id), `expected #${id} to exist`).not.toBeNull();
            });
    });

    it('onSessionExerciseSelect updates the mono title to "Log set \u00b7 <name>"', () => {
        const { window, document } = env;
        const input = document.getElementById('session-add-exercise-name');
        const title = document.getElementById('workout-add-exercise-to-session-title');

        input.value = 'Bench';
        window.onSessionExerciseSelect();
        expect(title.textContent).toBe('Log set \u00b7 Bench');

        input.value = '';
        window.onSessionExerciseSelect();
        expect(title.textContent).toBe('Add exercise');
    });

    it('showAddExerciseToSessionModal opens the modal and seeds a default title', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint.startsWith('/api/workout/sessions/details')) {
                return {
                    session: { id: 42, variant_id: 1, status: 'in_progress' },
                    logs: []
                };
            }
            if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return [];
            if (endpoint === '/api/workout/exercise-library') return [];
            return null;
        });

        await window.showWorkoutSessionModal(42);
        await window.showAddExerciseToSessionModal();

        expect(document.getElementById('workout-add-exercise-to-session-modal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('workout-add-exercise-to-session-title').textContent).toBe('Add exercise');
    });

    it('closeAddExerciseToSessionModal calls the shared ModalManager close', () => {
        const { window } = env;
        const closeSpy = vi.fn();
        window.ModalManager.workoutAddExerciseToSession = {
            open: vi.fn(),
            close: closeSpy
        };

        window.closeAddExerciseToSessionModal();
        expect(closeSpy).toHaveBeenCalled();
    });

    it('saveNewSessionExercise posts session_id + sets + reps to /logs/create and closes on success', async () => {
        const { window, document } = env;
        const apiSpy = vi.fn(async (endpoint, method, payload) => {
            if (endpoint.startsWith('/api/workout/sessions/details')) {
                return {
                    session: { id: 42, variant_id: 1, status: 'in_progress' },
                    logs: []
                };
            }
            if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return [];
            if (endpoint === '/api/workout/exercise-library') {
                return [{ id: 7, name: 'Bench', default_sets: 3, default_reps_min: 10, default_weight_kg: 80 }];
            }
            if (endpoint === '/api/workout/sessions/logs/create') {
                return { id: 999, ...payload };
            }
            return { ok: true };
        });
        window.apiCall = apiSpy;

        await window.showWorkoutSessionModal(42);
        // Replace post-save refresh hook with a spy to avoid navigating away.
        window.showWorkoutSessionModal = vi.fn();

        await window.showAddExerciseToSessionModal();

        document.getElementById('session-add-exercise-name').value = 'Bench';
        document.getElementById('session-add-exercise-id').value = '7';
        document.getElementById('session-add-exercise-sets').value = '3';
        document.getElementById('session-add-exercise-reps').value = '10';
        document.getElementById('session-add-exercise-weight').value = '80';
        document.getElementById('session-add-exercise-notes').value = 'Pause reps';

        await window.saveNewSessionExercise();

        expect(apiSpy).toHaveBeenCalledWith(
            '/api/workout/sessions/logs/create',
            'POST',
            expect.objectContaining({
                session_id: 42,
                exercise_id: 7,
                exercise_name: 'Bench',
                target_sets: 3,
                target_reps_min: 10,
                target_weight_kg: 80,
                notes: 'Pause reps'
            })
        );
        expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(42);
    });
});

describe('Edit-exercise modal shell (Phase 7, Task 8)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('uses the .wg-modal + .wg-workouts-exercise-modal classes', () => {
        const { document } = env;
        const modal = document.getElementById('workout-exercise-modal');
        expect(modal).not.toBeNull();
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-workouts-exercise-modal')).toBe(true);
    });

    it('renders a mono eyebrow + title heading', () => {
        const { document } = env;
        const modal = document.getElementById('workout-exercise-modal');
        const eyebrow = modal.querySelector('.wg-workouts-exercise-modal__eyebrow');
        const title = modal.querySelector('.wg-workouts-exercise-modal__title');
        expect(eyebrow).not.toBeNull();
        expect(eyebrow.classList.contains('wg-section-label')).toBe(true);
        expect(eyebrow.textContent).toBe('Workout exercise');
        expect(title).not.toBeNull();
        expect(title.classList.contains('wg-mono-display')).toBe(true);
        expect(title.id).toBe('workout-exercise-modal-title');
    });

    it('wraps every input field in .wg-gloss--inset', () => {
        const { document } = env;
        const modal = document.getElementById('workout-exercise-modal');
        const wraps = modal.querySelectorAll('.wg-workouts-exercise-modal__input-wrap');
        expect(wraps.length).toBeGreaterThanOrEqual(5);
        wraps.forEach((wrap) => {
            expect(wrap.classList.contains('wg-gloss--inset')).toBe(true);
        });
    });

    it('has Cancel + Save header-action buttons with Save as sun-glossed', () => {
        const { document } = env;
        const actions = document.querySelector('#workout-exercise-modal .wg-workouts-exercise-modal__header-actions');
        expect(actions).not.toBeNull();

        const cancel = actions.querySelector('#exercise-cancel-btn');
        const save = actions.querySelector('#exercise-save-btn');
        expect(cancel).not.toBeNull();
        expect(save).not.toBeNull();

        expect(cancel.classList.contains('wg-gloss')).toBe(true);
        expect(cancel.classList.contains('wg-workouts-exercise-modal__header-btn')).toBe(true);
        expect(save.classList.contains('wg-gloss')).toBe(true);
        expect(save.classList.contains('wg-gloss--sun')).toBe(true);
        expect(save.classList.contains('wg-workouts-exercise-modal__header-btn--save')).toBe(true);
    });

    it('preserves the preexisting ID hooks used by saveExercise / showEditExerciseModal', () => {
        const { document } = env;
        ['workout-exercise-name', 'workout-exercise-sets',
         'workout-exercise-reps-min', 'workout-exercise-reps-max',
         'workout-exercise-weight', 'workout-exercise-order',
         'workout-exercise-modal-title', 'exercise-cancel-btn',
         'exercise-save-btn', 'exercise-close-btn']
            .forEach((id) => {
                expect(document.getElementById(id), `expected #${id} to exist`).not.toBeNull();
            });
    });

    it('showEditExerciseModal populates the inputs from the apiCall fetch', async () => {
        const { window, document } = env;
        const exercises = [{
            id: 2,
            exercise_name: 'Overhead Press',
            target_sets: 4,
            target_reps_min: 6,
            target_reps_max: 10,
            target_weight_kg: 45,
            order_index: 2
        }];
        window.apiCall = vi.fn(async () => exercises);

        await window.loadExercisesForVariant(55);
        await window.showEditExerciseModal(2);

        expect(document.getElementById('workout-exercise-modal-title').textContent).toBe('Edit Exercise');
        expect(document.getElementById('workout-exercise-name').value).toBe('Overhead Press');
        expect(document.getElementById('workout-exercise-sets').value).toBe('4');
        expect(document.getElementById('workout-exercise-reps-min').value).toBe('6');
        expect(document.getElementById('workout-exercise-reps-max').value).toBe('10');
        expect(document.getElementById('workout-exercise-weight').value).toBe('45');
        expect(document.getElementById('workout-exercise-order').value).toBe('2');
    });

    it('saveExercise POSTs a new exercise and closes the modal', async () => {
        const { window, document } = env;
        const apiSpy = vi.fn(async (endpoint) => {
            if (endpoint === '/api/workout/exercise-library') return [];
            if (endpoint.startsWith('/api/workout/exercises?variant_id=')) return [];
            if (endpoint === '/api/workout/exercises/create') return { id: 500 };
            return { ok: true };
        });
        window.apiCall = apiSpy;

        await window.loadExercisesForVariant(55);
        await window.showAddExerciseModal();

        document.getElementById('workout-exercise-name').value = 'Squat';
        document.getElementById('workout-exercise-sets').value = '5';
        document.getElementById('workout-exercise-reps-min').value = '5';
        document.getElementById('workout-exercise-reps-max').value = '';
        document.getElementById('workout-exercise-weight').value = '100';
        document.getElementById('workout-exercise-order').value = '0';

        const closeSpy = vi.fn();
        window.closeExerciseModal = closeSpy;
        window.loadExercisesForVariant = vi.fn();

        await window.saveExercise();

        expect(apiSpy).toHaveBeenCalledWith(
            '/api/workout/exercises/create',
            'POST',
            expect.objectContaining({
                variant_id: 55,
                exercise_name: 'Squat',
                target_sets: 5,
                target_reps_min: 5,
                target_reps_max: null,
                target_weight_kg: 100,
                order_index: 0
            })
        );
        expect(closeSpy).toHaveBeenCalled();
    });

    it('closeExerciseModal calls the shared ModalManager close', () => {
        const { window } = env;
        const closeSpy = vi.fn();
        window.ModalManager.workoutExercise = {
            open: vi.fn(),
            close: closeSpy
        };

        window.closeExerciseModal();
        expect(closeSpy).toHaveBeenCalled();
    });
});

describe('modal-controller history integration (Phase 7, Task 8)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('log-set modal is registered as a sub-modal in ModalManager.getSubModalDefs', () => {
        const { window } = env;
        const defs = window.ModalManager.getSubModalDefs();
        const logSetDef = defs.find((d) => d.id === 'workout-add-exercise-to-session-modal');
        expect(logSetDef).toBeDefined();
        expect(typeof logSetDef.fn).toBe('function');
    });

    it('edit-exercise modal is registered as a top-level modal in ModalManager.getTopModalDefs', () => {
        const { window } = env;
        const defs = window.ModalManager.getTopModalDefs();
        const editExDef = defs.find((d) => d.id === 'workout-exercise-modal');
        expect(editExDef).toBeDefined();
        expect(typeof editExDef.fn).toBe('function');
    });

    it('the log-set modal sub-modal def calls closeAddExerciseToSessionModal when present', () => {
        const { window } = env;
        const closeSpy = vi.fn();
        window.closeAddExerciseToSessionModal = closeSpy;
        const defs = window.ModalManager.getSubModalDefs();
        const logSetDef = defs.find((d) => d.id === 'workout-add-exercise-to-session-modal');
        logSetDef.fn();
        expect(closeSpy).toHaveBeenCalled();
    });

    it('the edit-exercise modal top-modal def calls closeExerciseModal when present', () => {
        const { window } = env;
        const closeSpy = vi.fn();
        window.closeExerciseModal = closeSpy;
        const defs = window.ModalManager.getTopModalDefs();
        const editExDef = defs.find((d) => d.id === 'workout-exercise-modal');
        editExDef.fn();
        expect(closeSpy).toHaveBeenCalled();
    });
});
