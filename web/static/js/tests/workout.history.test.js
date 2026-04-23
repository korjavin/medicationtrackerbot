// Wandergeek Workouts history sub-tab (Phase 7, Task 4).
//
// Exercises the rewritten `_renderWorkoutHistory` path. Each row is a
// `.wg-card.wg-workouts-history-row` carrying a rotation-slot tag, mono
// duration, optional volume, and a trailing icon-button cluster
// (view / edit / delete). Day clusters use `.wg-section-label` for the
// "Today" / "Yesterday" / explicit-date header. Offline-pending and
// rejected badges surface as `.wg-tag--mono` variants.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

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
        expect(row.dataset.slot).toBe('LEGS');

        const slotTag = row.querySelector('.wg-workouts-slot-tag');
        expect(slotTag).not.toBeNull();
        expect(slotTag.classList.contains('wg-workouts-slot-tag--legs')).toBe(true);
        expect(slotTag.textContent).toBe('LEGS');

        const duration = row.querySelector('.wg-workouts-history-row__duration');
        expect(duration).not.toBeNull();
        expect(duration.textContent).toBe('1h 2m');

        const volume = row.querySelector('.wg-workouts-history-row__volume');
        expect(volume).not.toBeNull();
        expect(volume.textContent).toMatch(/kg/);
    });

    it('renders a view / edit / delete icon-button cluster on each row', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window._renderWorkoutHistory(container, [makeSession({ session: { id: 42 } })], [], 'UTC');

        const actions = container.querySelector('.wg-workouts-history-row__actions');
        expect(actions).not.toBeNull();

        const viewBtn = actions.querySelector('.wg-workouts-history-row__view');
        const editBtn = actions.querySelector('.wg-workouts-history-row__edit');
        const deleteBtn = actions.querySelector('.wg-workouts-history-row__delete');
        expect(viewBtn).not.toBeNull();
        expect(editBtn).not.toBeNull();
        expect(deleteBtn).not.toBeNull();

        expect(viewBtn.getAttribute('aria-label')).toBe('View session');
        expect(editBtn.getAttribute('aria-label')).toBe('Edit session');
        expect(deleteBtn.getAttribute('aria-label')).toBe('Delete session');

        // All three render as .wg-icon-btn with a .wg-gloss inner.
        [viewBtn, editBtn, deleteBtn].forEach((btn) => {
            expect(btn.classList.contains('wg-icon-btn')).toBe(true);
            expect(btn.querySelector('.wg-gloss')).not.toBeNull();
        });
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

    it('clicking the view icon dispatches showWorkoutSessionModal and stops row propagation', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const showSpy = vi.fn();
        window.showWorkoutSessionModal = showSpy;

        window._renderWorkoutHistory(container, [makeSession({ session: { id: 88 } })], [], 'UTC');
        const viewBtn = container.querySelector('.wg-workouts-history-row__view');
        viewBtn.click();
        expect(showSpy).toHaveBeenCalledTimes(1);
        expect(showSpy).toHaveBeenCalledWith(88);
    });

    it('clicking the edit icon opens the session modal (same as view)', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const showSpy = vi.fn();
        window.showWorkoutSessionModal = showSpy;

        window._renderWorkoutHistory(container, [makeSession({ session: { id: 55 } })], [], 'UTC');
        const editBtn = container.querySelector('.wg-workouts-history-row__edit');
        editBtn.click();
        expect(showSpy).toHaveBeenCalledWith(55);
    });

    it('clicking the delete icon dispatches deleteWorkoutSessionById with confirm', async () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        const apiSpy = vi.fn(async () => true);
        window.apiCall = apiSpy;
        window.loadWorkoutHistoryTab = vi.fn();

        window._renderWorkoutHistory(container, [makeSession({ session: { id: 99 } })], [], 'UTC');
        const deleteBtn = container.querySelector('.wg-workouts-history-row__delete');
        deleteBtn.click();
        // Let the async chain flush (click → deleteWorkoutSessionById → safeConfirm → apiCall → loadWorkoutHistoryTab).
        for (let i = 0; i < 8; i += 1) await Promise.resolve();

        expect(window.safeConfirm).toHaveBeenCalled();
        expect(apiSpy).toHaveBeenCalledWith('/api/workout/sessions/delete?id=99', 'DELETE');
        expect(window.loadWorkoutHistoryTab).toHaveBeenCalled();
    });

    it('surfaces an offline-pending tag as .wg-tag--mono on rows with isLocal=true', () => {
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
        const pending = row.querySelector('.wg-workouts-history-row__sync');
        expect(pending).not.toBeNull();
        expect(pending.classList.contains('wg-tag')).toBe(true);
        expect(pending.classList.contains('wg-tag--mono')).toBe(true);
        expect(pending.classList.contains('wg-tag--pending')).toBe(true);
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
        const rejected = row.querySelector('.wg-workouts-history-row__sync');
        expect(rejected.classList.contains('wg-tag--rejected')).toBe(true);
        expect(rejected.textContent).toBe('Failed');
        expect(rejected.title).toBe('Payload rejected by server');
    });
});
