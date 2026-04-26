// Header-actions refactor: Workout Library modal (Task 9).
//
// Asserts Cancel + Save sit inside `.wg-workouts-library-modal__header-actions`
// so they remain visible above a focused mobile keyboard, and the legacy
// `.wg-workouts-library-modal__actions` body footer row is gone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('WorkoutLibraryModal header-actions', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('Cancel and Save live inside .wg-workouts-library-modal__header-actions', () => {
        const { document } = env;
        const headerActions = document.querySelector('#exercise-library-modal .wg-workouts-library-modal__header-actions');
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById('exercise-library-cancel-btn');
        const saveBtn = document.getElementById('exercise-library-save-btn');
        expect(cancelBtn).not.toBeNull();
        expect(saveBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(saveBtn.parentElement).toBe(headerActions);
    });

    it('legacy .wg-workouts-library-modal__actions body row no longer exists', () => {
        const { document } = env;
        expect(document.querySelector('#exercise-library-modal .wg-workouts-library-modal__actions')).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById('exercise-library-cancel-btn')).not.toBeNull();
        expect(document.getElementById('exercise-library-save-btn')).not.toBeNull();
    });

    it('Cancel sits left of Save inside the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#exercise-library-modal .wg-workouts-library-modal__header-actions');
        const cancelBtn = document.getElementById('exercise-library-cancel-btn');
        const saveBtn = document.getElementById('exercise-library-save-btn');
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const saveIdx = children.indexOf(saveBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeGreaterThan(cancelIdx);
    });

    it('redundant close-X button is removed from the header', () => {
        const { document } = env;
        expect(document.getElementById('exercise-library-close-btn')).toBeNull();
    });
});
