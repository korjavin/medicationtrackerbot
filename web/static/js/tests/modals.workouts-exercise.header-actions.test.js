// Header-actions refactor: Workout Exercise modal (Task 8).
//
// Asserts Cancel + Save sit inside `.wg-workouts-exercise-modal__header-actions`
// so they remain visible above a focused mobile keyboard, and the legacy
// `.wg-workouts-exercise-modal__actions` body footer row is gone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('WorkoutExerciseModal header-actions', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('Cancel and Save live inside .wg-workouts-exercise-modal__header-actions', () => {
        const { document } = env;
        const headerActions = document.querySelector('#workout-exercise-modal .wg-workouts-exercise-modal__header-actions');
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById('exercise-cancel-btn');
        const saveBtn = document.getElementById('exercise-save-btn');
        expect(cancelBtn).not.toBeNull();
        expect(saveBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(saveBtn.parentElement).toBe(headerActions);
    });

    it('legacy .wg-workouts-exercise-modal__actions body row no longer exists', () => {
        const { document } = env;
        expect(document.querySelector('#workout-exercise-modal .wg-workouts-exercise-modal__actions')).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById('exercise-cancel-btn')).not.toBeNull();
        expect(document.getElementById('exercise-save-btn')).not.toBeNull();
    });

    it('Cancel sits left of Save inside the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#workout-exercise-modal .wg-workouts-exercise-modal__header-actions');
        const cancelBtn = document.getElementById('exercise-cancel-btn');
        const saveBtn = document.getElementById('exercise-save-btn');
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const saveIdx = children.indexOf(saveBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeGreaterThan(cancelIdx);
    });

    it('close-X button stays in the header next to Cancel/Save', () => {
        const { document } = env;
        const headerActions = document.querySelector('#workout-exercise-modal .wg-workouts-exercise-modal__header-actions');
        const closeBtn = document.getElementById('exercise-close-btn');
        expect(closeBtn).not.toBeNull();
        expect(closeBtn.parentElement).toBe(headerActions);
    });
});
