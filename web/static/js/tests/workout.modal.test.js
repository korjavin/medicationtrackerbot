// Wandergeek Workouts log-set modal (Phase 7, Task 8).
//
// Exercises the rewritten log-set modal (#workout-add-exercise-to-session-modal):
// the generic `.wg-modal` shell, mono eyebrow + title header,
// `.wg-gloss--inset` input wraps, and a Cancel/Save action bar (Save as
// sun-glossed 2x flex per modal-button-order convention). The plan editor's
// Exercise page (med-xso6.22) is covered in features.workout-exercises.test.js.

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

    it('renders the kit sheet header: eyebrow + title', () => {
        const { document } = env;
        const modal = document.getElementById('workout-add-exercise-to-session-modal');
        const eyebrow = modal.querySelector('.wg-sheethead .wg-eyebrow');
        const title = modal.querySelector('.wg-sheethead .wg-sheethead__title');
        expect(eyebrow).not.toBeNull();
        expect(eyebrow.textContent).toBe('Log set');
        expect(title).not.toBeNull();
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

    it('has Save (primary) + the close X kit buttons in the sheet header', () => {
        const { document } = env;
        const actions = document.querySelector('#workout-add-exercise-to-session-modal .wg-sheethead__acts');
        expect(actions).not.toBeNull();

        const cancel = actions.querySelector('#session-add-exercise-cancel-btn');
        const save = actions.querySelector('#session-add-exercise-save-btn');
        expect(cancel).not.toBeNull();
        expect(save).not.toBeNull();

        expect(cancel.className).toBe('wg-btn wg-btn--ghost wg-btn--icon');
        expect(cancel.getAttribute('aria-label')).toBe('Close');
        expect(save.className).toBe('wg-btn wg-btn--primary wg-btn--sm');
    });

    it('preserves the preexisting ID hooks used by saveNewSessionExercise + onSessionExerciseSelect', () => {
        const { document } = env;
        ['session-add-exercise-name', 'session-add-exercise-id',
         'session-add-exercise-sets', 'session-add-exercise-reps',
         'session-add-exercise-weight', 'session-add-exercise-notes',
         'session-add-exercise-cancel-btn', 'session-add-exercise-save-btn',
         'workout-add-exercise-to-session-title',
         'session-add-exercise-suggest']
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

    it('the log-set modal sub-modal def calls closeAddExerciseToSessionModal when present', () => {
        const { window } = env;
        const closeSpy = vi.fn();
        window.closeAddExerciseToSessionModal = closeSpy;
        const defs = window.ModalManager.getSubModalDefs();
        const logSetDef = defs.find((d) => d.id === 'workout-add-exercise-to-session-modal');
        logSetDef.fn();
        expect(closeSpy).toHaveBeenCalled();
    });
});
