// Wandergeek Workouts log-set modal (Phase 7, Task 8).
//
// Exercises the add-exercise sheet (#workout-add-exercise-to-session-modal):
// the generic `.wg-modal` shell and, since med-okwf.3 (kit WA3), a search
// field over a row list with no Save. The plan editor's Exercise page
// (med-xso6.22) is covered in features.workout-exercises.test.js.

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

    // Kit WA3 (med-okwf.3): title "Add exercise", the close X only (no Save \u2014
    // a row tap adds), and a search affix instead of sets/reps/weight/notes.
    it('is the kit add sheet: close X only, a search field, no quick-add fields', () => {
        const { document } = env;
        const modal = document.getElementById('workout-add-exercise-to-session-modal');
        expect(modal.querySelector('.wg-sheethead__title').textContent).toBe('Add exercise');
        const actions = modal.querySelector('.wg-sheethead__acts');
        expect(Array.from(actions.children).map((b) => b.id)).toEqual(['session-add-exercise-cancel-btn']);
        const cancel = document.getElementById('session-add-exercise-cancel-btn');
        expect(cancel.className).toBe('wg-btn wg-btn--ghost wg-btn--icon');
        expect(cancel.getAttribute('aria-label')).toBe('Close');

        const input = modal.querySelector('.wg-affix > #session-add-exercise-name');
        expect(input).not.toBeNull();
        expect(input.getAttribute('placeholder')).toBe('Search your exercises and the library');
        ['session-add-exercise-save-btn', 'session-add-exercise-id', 'session-add-exercise-sets',
         'session-add-exercise-reps', 'session-add-exercise-weight', 'session-add-exercise-notes']
            .forEach((id) => expect(document.getElementById(id), `#${id} is gone`).toBeNull());
    });

    it('showAddExerciseToSessionModal opens with the plan name as eyebrow and no list', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint.startsWith('/api/workout/sessions/details')) {
                return {
                    // Production shape: the plan names ride on the envelope.
                    session: { id: 42, variant_id: 1, status: 'in_progress' },
                    group_name: 'Plan 3',
                    variant_name: 'Day A',
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
        expect(document.getElementById('workout-add-exercise-to-session-eyebrow').textContent).toBe('Plan 3 \u00b7 Day A');
        expect(document.getElementById('session-add-exercise-suggest').hidden).toBe(true);
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

    it('tapping a library row posts a placeholder log with the library default and closes', async () => {
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

        const input = document.getElementById('session-add-exercise-name');
        input.value = 'Ben';
        await input.oninput();
        document.querySelector('#session-add-exercise-suggest .wg-row').click();

        await vi.waitFor(() => expect(window.showWorkoutSessionModal).toHaveBeenCalledWith(42));
        expect(apiSpy).toHaveBeenCalledWith(
            '/api/workout/sessions/logs/create',
            'POST',
            expect.objectContaining({
                session_id: 42,
                exercise_id: 7,
                exercise_name: 'Bench',
                // Added as a placeholder, not done (med-okwf.1); the library
                // default pre-fills the one pending set (med-okwf.3).
                target_sets: 0,
                target_reps_min: 10,
                target_weight_kg: 80,
                status: '',
                source: 'library'
            })
        );
        expect(document.getElementById('workout-add-exercise-to-session-modal').classList.contains('hidden')).toBe(true);
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
