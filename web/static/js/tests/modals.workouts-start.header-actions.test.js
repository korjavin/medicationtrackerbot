// Header-actions refactor: Workout Start (push-notification) modal (Task 11).
//
// Promotes the legacy `.actions` block onto the wg-modal shell and asserts
// the primary Cancel + Start pair lives inside
// `.wg-workouts-start-modal__header-actions` so it stays visible above a
// focused mobile keyboard. Secondary actions (snooze/skip) remain in the
// body — only the Cancel/Start primaries belong in the header.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('WorkoutStartModal header-actions', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('Cancel and Start live inside .wg-workouts-start-modal__header-actions', () => {
        const { document } = env;
        const headerActions = document.querySelector('#workout-start-modal .wg-workouts-start-modal__header-actions');
        expect(headerActions).not.toBeNull();

        const cancelBtn = document.getElementById('workout-start-dismiss-btn');
        const startBtn = document.getElementById('workout-start-now-btn');
        expect(cancelBtn).not.toBeNull();
        expect(startBtn).not.toBeNull();
        expect(cancelBtn.parentElement).toBe(headerActions);
        expect(startBtn.parentElement).toBe(headerActions);
    });

    it('legacy .actions body row no longer exists on the start modal', () => {
        const { document } = env;
        expect(document.querySelector('#workout-start-modal .actions')).toBeNull();
    });

    it('button IDs still resolve so existing handlers keep binding', () => {
        const { document } = env;
        expect(document.getElementById('workout-start-dismiss-btn')).not.toBeNull();
        expect(document.getElementById('workout-start-now-btn')).not.toBeNull();
        expect(document.getElementById('workout-start-snooze-60-btn')).not.toBeNull();
        expect(document.getElementById('workout-start-snooze-120-btn')).not.toBeNull();
        expect(document.getElementById('workout-start-skip-btn')).not.toBeNull();
    });

    it('Cancel sits left of Start inside the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#workout-start-modal .wg-workouts-start-modal__header-actions');
        const cancelBtn = document.getElementById('workout-start-dismiss-btn');
        const startBtn = document.getElementById('workout-start-now-btn');
        const children = Array.from(headerActions.children);
        const cancelIdx = children.indexOf(cancelBtn);
        const startIdx = children.indexOf(startBtn);
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(startIdx).toBeGreaterThan(cancelIdx);
    });

    it('snooze and skip buttons stay in the body, not the header row', () => {
        const { document } = env;
        const headerActions = document.querySelector('#workout-start-modal .wg-workouts-start-modal__header-actions');
        const body = document.querySelector('#workout-start-modal .wg-workouts-start-modal__body');
        expect(body).not.toBeNull();

        for (const id of ['workout-start-snooze-60-btn', 'workout-start-snooze-120-btn', 'workout-start-skip-btn']) {
            const btn = document.getElementById(id);
            expect(headerActions.contains(btn)).toBe(false);
            expect(body.contains(btn)).toBe(true);
        }
    });

    it('start modal carries the wg-modal shell classes', () => {
        const { document } = env;
        const modal = document.getElementById('workout-start-modal');
        expect(modal.classList.contains('wg-modal')).toBe(true);
        expect(modal.classList.contains('wg-workouts-start-modal')).toBe(true);
    });
});
