// Wandergeek Workouts session-detail view (Phase 7, Task 4).
//
// Covers the rebuilt session-detail pieces: the mono header + slot tag
// rendered by `renderWorkoutSessionInfo`, the per-exercise card list
// rendered by `renderWorkoutSessionLogs` with set-by-set mono rows, and
// the Log set / Finish / Delete action cluster rendered by
// `renderSessionDetailActions`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function sessionFixture(overrides) {
    return {
        id: 77,
        variant_id: 0,
        variant_name: 'Push Day',
        group_name: 'PPL',
        status: 'in_progress',
        scheduled_date: '2026-04-22',
        scheduled_time: '09:00',
        started_at: '2026-04-22T09:05:00Z',
        completed_at: null,
        duration_minutes: 42,
        ...(overrides || {})
    };
}

function logFixture(overrides) {
    return {
        id: 1,
        exercise_id: 10,
        exercise_name: 'Bench',
        sets_completed: 3,
        reps_completed: 8,
        weight_kg: 60,
        notes: '',
        status: 'completed',
        ...(overrides || {})
    };
}

describe('Workouts session detail (Phase 7, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the mono header with slot tag and a formatted date/weekday', () => {
        const { window, document } = env;
        const infoContainer = document.getElementById('workout-session-info');
        window.renderWorkoutSessionInfo(infoContainer, sessionFixture());

        const slotTag = infoContainer.querySelector('.wg-workouts-slot-tag');
        expect(slotTag).not.toBeNull();
        expect(slotTag.textContent).toBe('PUSH');
        expect(slotTag.classList.contains('wg-workouts-slot-tag--push')).toBe(true);

        const title = infoContainer.querySelector('.wg-workouts-session-info__title');
        expect(title).not.toBeNull();
        expect(title.classList.contains('wg-mono-display')).toBe(true);
        // "22.04.2026 · Wed" (Europe-style) — assert the mono date + separator
        // pattern without coupling to weekday locale differences across
        // environments. Year must be present.
        expect(title.textContent).toMatch(/\d{2}[./]\d{2}[./]\d{4}\s*·\s*\S+/);
        expect(title.textContent).toContain('2026');
    });

    it('surfaces the session status select inside a wg-gloss--inset wrapper', () => {
        const { window, document } = env;
        const infoContainer = document.getElementById('workout-session-info');
        window.renderWorkoutSessionInfo(infoContainer, sessionFixture({ status: 'completed' }));

        const statusRow = infoContainer.querySelector('.wg-workouts-session-info__status');
        expect(statusRow).not.toBeNull();
        expect(statusRow.classList.contains('wg-gloss--inset')).toBe(true);

        const select = statusRow.querySelector('#session-status-select');
        expect(select).not.toBeNull();
        expect(select.value).toBe('completed');
        const values = Array.from(select.options).map((o) => o.value);
        expect(values).toEqual(['in_progress', 'completed', 'skipped']);
    });

    // The production code keeps the currently-open session's logs in a
    // module-scoped `let currentSessionLogs` binding that isn't reachable
    // from the harness window. These tests go through the public
    // `showWorkoutSessionModal(sessionId)` entry point with a mocked
    // apiCall so the real code path populates that binding for us.
    async function openSession(window, logs, sessionOverrides) {
        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint.startsWith('/api/workout/sessions/details')) {
                return { session: sessionFixture(sessionOverrides), logs };
            }
            return [];
        });
        await window.showWorkoutSessionModal(77);
    }

    it('renders an empty state when no exercise logs are present', async () => {
        const { window, document } = env;
        await openSession(window, []);

        const logsContainer = document.getElementById('workout-session-logs');
        const empty = logsContainer.querySelector('.wg-workouts-session-logs__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toBe('No exercises logged');
    });

    it('renders a .wg-card per exercise with the mono set-by-set row', async () => {
        const { window, document } = env;
        await openSession(window, [
            logFixture({ exercise_name: 'Bench', sets_completed: 4, reps_completed: 8, weight_kg: 70 }),
            logFixture({ id: 2, exercise_name: 'Overhead', sets_completed: 3, reps_completed: 10, weight_kg: 40 })
        ]);

        const logsContainer = document.getElementById('workout-session-logs');
        const cards = logsContainer.querySelectorAll('.wg-workouts-session-exercise');
        expect(cards.length).toBe(2);
        cards.forEach((card) => {
            expect(card.classList.contains('wg-card')).toBe(true);
        });

        const monoRows = logsContainer.querySelectorAll('.wg-workouts-session-exercise__mono');
        expect(monoRows.length).toBe(2);
        expect(monoRows[0].textContent).toBe('4 × 8 · 70 kg');
        expect(monoRows[1].textContent).toBe('3 × 10 · 40 kg');
    });

    it('labels bodyweight sets (weight_kg = 0) as "bodyweight" in the mono row', async () => {
        const { window, document } = env;
        await openSession(window, [
            logFixture({ exercise_name: 'Pull-ups', sets_completed: 3, reps_completed: 8, weight_kg: 0 })
        ]);

        const logsContainer = document.getElementById('workout-session-logs');
        const monoRow = logsContainer.querySelector('.wg-workouts-session-exercise__mono');
        expect(monoRow.textContent).toBe('3 × 8 · bodyweight');
    });

    it('marks unsaved planned rows and removes the dim state when an input is edited', async () => {
        const { window, document } = env;
        await openSession(window, [
            logFixture({ id: 0, _dirty: false, exercise_name: 'Fly' })
        ]);

        const logsContainer = document.getElementById('workout-session-logs');
        const entry = logsContainer.querySelector('.wg-workouts-session-exercise');
        expect(entry.classList.contains('unsaved')).toBe(true);
        const hint = entry.querySelector('.wg-workouts-session-exercise__hint');
        expect(hint).not.toBeNull();
        expect(hint.textContent).toBe('Not yet logged — edit to include');

        window.updateLocalLog(0, 'weight_kg', '15');
        expect(entry.classList.contains('unsaved')).toBe(false);
        expect(entry.querySelector('.wg-workouts-session-exercise__hint')).toBeNull();
    });

    it('renders Log set + Finish workout buttons in the action cluster', () => {
        const { window, document } = env;
        const actionsContainer = document.getElementById('workout-session-actions');
        const onLogSet = vi.fn();
        const onFinish = vi.fn();

        window.renderSessionDetailActions(actionsContainer, { onLogSet, onFinish });

        expect(actionsContainer.classList.contains('wg-workouts-session-actions')).toBe(true);

        const logSetBtn = actionsContainer.querySelector('.wg-workouts-session-actions__log-set');
        const finishBtn = actionsContainer.querySelector('.wg-workouts-session-actions__finish');
        const deleteBtn = actionsContainer.querySelector('.wg-workouts-session-actions__delete');
        expect(logSetBtn).not.toBeNull();
        expect(finishBtn).not.toBeNull();
        expect(deleteBtn).toBeNull();

        // Log set is the sun pill; Finish is a neutral gloss button.
        expect(logSetBtn.classList.contains('wg-gloss--sun')).toBe(true);
        expect(finishBtn.classList.contains('wg-gloss')).toBe(true);
        expect(finishBtn.classList.contains('wg-gloss--sun')).toBe(false);

        expect(logSetBtn.textContent).toBe('Log set');
        expect(finishBtn.textContent).toBe('Finish workout');
    });

    it('dispatches Log set and Finish callbacks independently', () => {
        const { window, document } = env;
        const actionsContainer = document.getElementById('workout-session-actions');
        const onLogSet = vi.fn();
        const onFinish = vi.fn();
        window.renderSessionDetailActions(actionsContainer, { onLogSet, onFinish });

        actionsContainer.querySelector('.wg-workouts-session-actions__log-set').click();
        actionsContainer.querySelector('.wg-workouts-session-actions__finish').click();

        expect(onLogSet).toHaveBeenCalledTimes(1);
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('tolerates omitted handlers without throwing on click', () => {
        const { window, document } = env;
        const actionsContainer = document.getElementById('workout-session-actions');
        window.renderSessionDetailActions(actionsContainer, {});

        expect(() => {
            actionsContainer.querySelector('.wg-workouts-session-actions__log-set').click();
            actionsContainer.querySelector('.wg-workouts-session-actions__finish').click();
        }).not.toThrow();
    });

    it('per-exercise cards carry a trailing icon-btn delete control', async () => {
        const { window, document } = env;
        env.window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint.startsWith('/api/workout/sessions/details')) {
                return { session: sessionFixture(), logs: [logFixture()] };
            }
            return [];
        });
        await env.window.showWorkoutSessionModal(77);

        const logsContainer = document.getElementById('workout-session-logs');
        const card = logsContainer.querySelector('.wg-workouts-session-exercise');
        const deleteBtn = card.querySelector('.wg-workouts-session-exercise__delete');
        expect(deleteBtn).not.toBeNull();
        expect(deleteBtn.classList.contains('wg-icon-btn')).toBe(true);
        expect(deleteBtn.querySelector('.wg-gloss')).not.toBeNull();
        expect(deleteBtn.getAttribute('aria-label')).toBe('Remove exercise');
    });
});
