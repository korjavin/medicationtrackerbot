// Wandergeek Workouts history sub-tab (Phase 7, Task 4).
//
// Exercises the rewritten `_renderWorkoutHistory` path. Each row is a
// `.wg-card.wg-workouts-history-row` carrying a rotation-slot tag, mono
// duration, optional volume, and a trailing icon-button cluster
// (edit / delete). Day clusters use `.wg-section-label` for the
// "Today" / "Yesterday" / explicit-date header. Offline-pending and
// rejected badges surface as `.wg-tag--mono` variants.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickRowAction, loadFrontendEnv } from './helpers/frontend-harness.js';

function makeSession(overrides) {
    const { session: sessionOverrides, ...rest } = overrides || {};
    return {
        group_name: 'Upper/Lower',
        variant_name: 'Push Day',
        total_volume: 2400,
        exercises_completed: 4,
        exercises_count: 4,
        ...rest,
        session: {
            id: 101,
            status: 'completed',
            scheduled_date: new Date().toISOString().slice(0, 10),
            scheduled_time: '09:00',
            started_at: new Date().toISOString(),
            completed_at: new Date(Date.now() + 45 * 60000).toISOString(),
            duration_minutes: 45,
            ...(sessionOverrides || {})
        }
    };
}

describe('Workouts history (Phase 7, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the empty state when no sessions are present', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window._renderWorkoutHistory(container, [], [], '');

        const empty = container.querySelector('.wg-workouts-history__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toBe('No workout history yet');
    });

    it('groups sessions by day using .wg-section-label headers (Today / Yesterday / date)', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');

        const nowIso = new Date().toISOString();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const older = new Date();
        older.setDate(older.getDate() - 10);

        const sessions = [
            makeSession({ session: { id: 1, started_at: nowIso } }),
            makeSession({
                session: {
                    id: 2,
                    started_at: yesterday.toISOString()
                }
            }),
            makeSession({
                session: {
                    id: 3,
                    started_at: older.toISOString()
                }
            })
        ];

        window._renderWorkoutHistory(container, sessions, [], 'UTC');

        const labels = Array.from(container.querySelectorAll('.wg-section-label'));
        expect(labels.length).toBe(3);
        expect(labels[0].textContent).toBe('Today');
        expect(labels[1].textContent).toBe('Yesterday');
        // Third group has a locale-formatted date
        expect(labels[2].textContent).toMatch(/\d{2}[./]\d{2}[./]\d{4}/);
    });

    it('renders .wg-card history rows with slot tag, mono duration and volume', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window._renderWorkoutHistory(
            container,
            [makeSession({
                session: { id: 11, status: 'completed', duration_minutes: 62 },
                variant_name: 'Legs',
                group_name: 'PPL',
                total_volume: 4300
            })],
            [],
            'UTC'
        );

        const row = container.querySelector('.wg-workouts-history-row');
        expect(row).not.toBeNull();
        expect(row.classList.contains('wg-card')).toBe(true);

        const slotTag = row.querySelector('.wg-workouts-slot-tag');
        expect(slotTag).not.toBeNull();
        expect(slotTag.classList.contains('wg-workouts-slot-tag--plan')).toBe(true);
        expect(slotTag.textContent).toBe('PPL');

        const duration = row.querySelector('.wg-workouts-history-row__duration');
        expect(duration).not.toBeNull();
        expect(duration.textContent).toBe('1h 2m');

        const volume = row.querySelector('.wg-workouts-history-row__volume');
        expect(volume).not.toBeNull();
        expect(volume.textContent).toMatch(/kg/);
    });

    it('renders each row as a swipe host with an overflow menu (Edit / Delete), no icon cluster or view chevron', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window._renderWorkoutHistory(container, [makeSession({ session: { id: 42 } })], [], 'UTC');

        const row = container.querySelector('.wg-workouts-history-row');
        expect(row.classList.contains('wg-swipe')).toBe(true);
        const actions = row.querySelector('.wg-workouts-history-row__actions');
        expect(actions).not.toBeNull();
        expect(actions.querySelector('.wg-workouts-history-row__view')).toBeNull();
        expect(actions.querySelectorAll('button').length).toBe(1);
        expect(actions.querySelector('.wg-swipe__more').getAttribute('aria-label')).toBe('More actions for session');
        expect(Array.from(row.querySelectorAll('.wg-swipe__menu .wg-menu__item')).map((b) => b.textContent)).toEqual(['Edit', 'Delete']);
        expect(row.querySelector('.wg-icon-btn')).toBeNull();
    });

    it('gives Mi Band cardio rows the same overflow Edit / Delete as session rows', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const showSpy = vi.fn();
        const deleteSpy = vi.fn();
        window.showMiBandWorkoutModal = showSpy;
        window.deleteMiBandWorkoutById = deleteSpy;

        const miband = {
            id: 7,
            activity_name: 'outdoor_running',
            start_time: new Date().toISOString(),
            distance_m: 5200,
            duration_sec: 1800,
            heart_rate_avg: 142
        };
        window._renderWorkoutHistory(container, [], [miband], 'UTC');

        const row = container.querySelector('.wg-workouts-history-row--miband');
        expect(row).not.toBeNull();
        expect(row.querySelector('.wg-workouts-history-row__view')).toBeNull();
        expect(row.querySelector('.wg-swipe__more').getAttribute('aria-label')).toBe('More actions for workout');

        clickRowAction(row, 'Edit');
        expect(showSpy).toHaveBeenCalledTimes(1);
        expect(showSpy).toHaveBeenCalledWith(miband);

        // Delete straight from the list — no modal open first.
        clickRowAction(row, 'Delete');
        expect(deleteSpy).toHaveBeenCalledWith(7);
        expect(showSpy).toHaveBeenCalledTimes(1);
    });

    it('clicking the Mi Band row body (not the icon cluster) still opens its modal', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const showSpy = vi.fn();
        window.showMiBandWorkoutModal = showSpy;

        const miband = {
            id: 9,
            activity_name: 'outdoor_running',
            start_time: new Date().toISOString(),
            distance_m: 3000,
            duration_sec: 1200
        };
        window._renderWorkoutHistory(container, [], [miband], 'UTC');

        container.querySelector('.wg-workouts-history-row--miband').click();
        expect(showSpy).toHaveBeenCalledTimes(1);
    });

    it('clicking the row (not the icon cluster) opens the session-detail modal', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const showSpy = vi.fn();
        window.showWorkoutSessionModal = showSpy;

        window._renderWorkoutHistory(container, [makeSession({ session: { id: 77 } })], [], 'UTC');
        const row = container.querySelector('.wg-workouts-history-row');

        row.click();
        expect(showSpy).toHaveBeenCalledWith(77);
    });

    it('menu Edit opens the session modal once and stops row propagation', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const showSpy = vi.fn();
        window.showWorkoutSessionModal = showSpy;

        window._renderWorkoutHistory(container, [makeSession({ session: { id: 88 } })], [], 'UTC');
        // Opening the menu does not fall through to the card-body handler either.
        container.querySelector('.wg-swipe__more').click();
        expect(showSpy).not.toHaveBeenCalled();
        container.querySelector('.wg-swipe__more').click();
        clickRowAction(container.querySelector('.wg-workouts-history-row'), 'Edit');
        expect(showSpy).toHaveBeenCalledTimes(1);
        expect(showSpy).toHaveBeenCalledWith(88);
    });

    it('menu Delete shows an Undo toast; the DELETE runs only when the Undo window closes (med-xso6.5)', async () => {
        env.cleanup();
        env = loadFrontendEnv({ withWorkout: true, withSync: true });
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window.safeConfirm = vi.fn();
        const apiSpy = vi.fn(async () => true);
        window.apiCall = apiSpy;
        window.loadWorkoutHistoryTab = vi.fn();

        window._renderWorkoutHistory(container, [makeSession({ session: { id: 99 } })], [], 'UTC');
        clickRowAction(container.querySelector('.wg-workouts-history-row'), 'Delete');

        const undo = document.querySelector('.wg-toasts .wg-toast__undo');
        expect(undo.textContent).toBe('Undo');
        undo.click();
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
        expect(apiSpy).not.toHaveBeenCalledWith('/api/workout/sessions/delete?id=99', 'DELETE');

        expect(await window.deleteWorkoutSessionById(99).flush()).toBe('deleted');
        expect(apiSpy).toHaveBeenCalledWith('/api/workout/sessions/delete?id=99', 'DELETE');
        expect(window.loadWorkoutHistoryTab).toHaveBeenCalled();
        expect(window.safeConfirm).not.toHaveBeenCalled();
    });

    it('surfaces the shared Pending sync chip on rows with isLocal=true', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window._renderWorkoutHistory(
            container,
            [Object.assign(makeSession({ session: { id: 201 } }), { isLocal: true })],
            [],
            'UTC'
        );

        const row = container.querySelector('.wg-workouts-history-row');
        expect(row.classList.contains('wg-workouts-history-row--pending')).toBe(true);
        const pending = row.querySelector('.wg-chip--pending');
        expect(pending).not.toBeNull();
        expect(pending.classList.contains('wg-chip')).toBe(true);
        expect(pending.textContent).toBe('Pending');
    });

    it('surfaces a rejected tag with its error tooltip on rows with isRejected=true', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window._renderWorkoutHistory(
            container,
            [Object.assign(makeSession({ session: { id: 202 } }), {
                isRejected: true,
                errorMessage: 'Payload rejected by server'
            })],
            [],
            'UTC'
        );

        const row = container.querySelector('.wg-workouts-history-row');
        expect(row.classList.contains('wg-workouts-history-row--rejected')).toBe(true);
        const rejected = row.querySelector('.wg-chip--danger');
        expect(rejected).not.toBeNull();
        expect(rejected.textContent).toBe('Sync failed');
        expect(rejected.title).toBe('Payload rejected by server');
    });

    // med-laj4: a Finish that never landed left the session in_progress, and
    // the next day it vanished — the next-workout card only shows today's and
    // History hid non-terminal rows. A past-day in_progress row now renders
    // with an Unfinished badge; today's stays on the next-workout card.
    it('shows a day-old in_progress session as Unfinished and hides today\'s', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const yesterday = new Date(Date.now() - 86400000);
        window._renderWorkoutHistory(container, [
            makeSession({ session: {
                id: 301, status: 'in_progress',
                scheduled_date: yesterday.toISOString().slice(0, 10),
                started_at: yesterday.toISOString(), completed_at: null, duration_minutes: undefined
            } }),
            makeSession({ session: {
                id: 302, status: 'in_progress', completed_at: null, duration_minutes: undefined
            } })
        ], [], 'UTC');

        const rows = container.querySelectorAll('.wg-workouts-history-row');
        expect(rows.length).toBe(1);
        expect(rows[0].dataset.sessionId).toBe('301');
        const badge = rows[0].querySelector('.wg-tag--unfinished');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('Unfinished — finish?');
    });

    it('Finish from an Unfinished row persists status=completed', async () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const yesterday = new Date(Date.now() - 86400000);
        const day = yesterday.toISOString().slice(0, 10);
        window.loadWorkoutHistoryTab = vi.fn();
        window.apiCall = vi.fn(async (endpoint) => {
            if (endpoint.startsWith('/api/workout/sessions/details')) {
                return {
                    session: {
                        id: 303, group_id: 1, variant_id: 0, status: 'in_progress',
                        scheduled_date: day, scheduled_time: '09:00',
                        started_at: yesterday.toISOString()
                    },
                    logs: [{ id: 5, exercise_id: 10, exercise_name: 'Bench', sets_completed: 3,
                        reps_completed: 8, weight_kg: 60, notes: '', status: 'completed' }]
                };
            }
            return true;
        });
        window._renderWorkoutHistory(container, [makeSession({ session: {
            id: 303, status: 'in_progress', scheduled_date: day,
            started_at: yesterday.toISOString(), completed_at: null, duration_minutes: undefined
        } })], [], 'UTC');

        container.querySelector('.wg-workouts-history-row').click();
        await vi.waitFor(() => expect(document.getElementById('workout-session-finish-btn')).not.toBeNull());
        document.getElementById('workout-session-finish-btn').click();
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__confirm')).not.toBeNull());
        document.querySelector('.mt-confirm-modal__confirm').click();
        await vi.waitFor(() => expect(window.WorkoutSessionsState.data).toBeNull());
        expect(window.apiCall).toHaveBeenCalledWith(
            '/api/workout/sessions/status?id=303', 'PUT', { status: 'completed' }, expect.anything());
    });
});
