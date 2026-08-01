// Wandergeek Workouts session-detail view (Phase 7, Task 4).
//
// Covers the rebuilt session-detail pieces: the mono header + slot tag
// rendered by `renderWorkoutSessionInfo`, the per-exercise card list
// rendered by `renderWorkoutSessionLogs` with set-by-set mono rows, and
// the Log set / Finish / Delete action cluster rendered by
// `renderSessionDetailActions`.

import { readFileSync } from 'node:fs';
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

    // The session identity moved into the PINNED modal header — the body used
    // to repeat it above the first exercise card, which cost a screen of
    // vertical space on a list that never fits one screen anyway.
    it('renders the pinned header with slot tag, formatted date/weekday and status', () => {
        const { window, document } = env;
        window.renderWorkoutSessionHeader(sessionFixture());

        const heading = document.getElementById('workout-session-modal-heading');
        const slotTag = heading.querySelector('.wg-workouts-slot-tag');
        expect(slotTag).not.toBeNull();
        expect(slotTag.textContent).toBe('PUSH');
        expect(slotTag.classList.contains('wg-workouts-slot-tag--push')).toBe(true);

        const title = heading.querySelector('.wg-workouts-session-modal__title');
        expect(title).not.toBeNull();
        expect(title.classList.contains('wg-mono-display')).toBe(true);
        // "22.04.2026 · Wed" (Europe-style) — assert the mono date + separator
        // pattern without coupling to weekday locale differences across
        // environments. Year must be present.
        expect(title.textContent).toMatch(/\d{2}[./]\d{2}[./]\d{4}\s*·\s*\S+/);
        expect(title.textContent).toContain('2026');

        expect(heading.querySelector('.wg-workouts-session-modal__status').textContent).toBe('In Progress');
        // …and the body no longer repeats any of it.
        const infoContainer = document.getElementById('workout-session-info');
        window.renderWorkoutSessionInfo(infoContainer, sessionFixture());
        expect(infoContainer.querySelector('.wg-workouts-slot-tag')).toBeNull();
    });

    it('keeps the header status in step with the body status select', () => {
        const { window, document } = env;
        window.renderWorkoutSessionHeader(sessionFixture());
        window.renderWorkoutSessionInfo(document.getElementById('workout-session-info'), sessionFixture());

        const select = document.getElementById('session-status-select');
        select.value = 'skipped';
        select.dispatchEvent(new window.Event('change'));

        expect(document.getElementById('workout-session-modal-status').textContent).toBe('Skipped');
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

    // renderSessionDetailActions reads the open session's status off
    // WorkoutSessionsState (showWorkoutSessionModal populates it before
    // calling), so seed it the way the modal would — bd med-4ca gates Finish
    // on `in_progress`.
    function openStatus(window, status) {
        window.WorkoutSessionsState.data = sessionFixture({ status });
    }

    it('renders Finish workout alone in the action cluster (no Log set / Delete / Add)', () => {
        const { window, document } = env;
        openStatus(window, 'in_progress');
        const actionsContainer = document.getElementById('workout-session-actions');
        const onFinish = vi.fn();

        window.renderSessionDetailActions(actionsContainer, { onFinish });

        expect(actionsContainer.classList.contains('wg-workouts-session-actions')).toBe(true);

        const logSetBtn = actionsContainer.querySelector('.wg-workouts-session-actions__log-set');
        const addBtn = actionsContainer.querySelector('.wg-workouts-session-actions__add');
        const finishBtn = actionsContainer.querySelector('.wg-workouts-session-actions__finish');
        const deleteBtn = actionsContainer.querySelector('.wg-workouts-session-actions__delete');
        expect(logSetBtn).toBeNull();
        expect(deleteBtn).toBeNull();
        // Add Exercise lives in the pinned header now — on screen at every
        // scroll position, so a bottom copy was a second button for one job.
        expect(addBtn).toBeNull();
        expect(finishBtn).not.toBeNull();

        expect(finishBtn.classList.contains('wg-gloss')).toBe(true);
        expect(finishBtn.classList.contains('wg-gloss--sun')).toBe(false);
        expect(finishBtn.textContent).toBe('Finish workout');
    });

    // bd med-4ca: a finished workout must not offer Finish. Re-completing it
    // re-stamped completed_at and skipped a rotation variant.
    it('omits Finish workout on a completed session', () => {
        const { window, document } = env;
        openStatus(window, 'completed');
        const actionsContainer = document.getElementById('workout-session-actions');

        window.renderSessionDetailActions(actionsContainer, { onFinish: vi.fn() });

        expect(actionsContainer.querySelector('.wg-workouts-session-actions__finish')).toBeNull();
        expect(document.getElementById('workout-session-finish-btn')).toBeNull();
        // Logging an exercise you forgot on a finished workout stays legitimate
        // — the header's + Exercise is never status-gated.
        expect(document.getElementById('workout-session-header-add-btn')).not.toBeNull();
    });

    it('omits Finish workout on a skipped session', () => {
        const { window, document } = env;
        openStatus(window, 'skipped');
        const actionsContainer = document.getElementById('workout-session-actions');

        window.renderSessionDetailActions(actionsContainer, { onFinish: vi.fn() });

        expect(actionsContainer.querySelector('.wg-workouts-session-actions__finish')).toBeNull();
    });

    it('has no Add Exercise button above the logs list or in the bottom row', async () => {
        const { document } = env;
        await openSession(env.window, [logFixture()]);

        // The Add Exercise button now lives only in the pinned modal header —
        // both the old logs-header and bottom-row entry points are gone.
        expect(document.getElementById('workout-session-logs-header')).toBeNull();
        expect(document.getElementById('workout-session-add-exercise-btn')).toBeNull();
        expect(document.querySelector('.wg-workouts-session-actions__add')).toBeNull();
    });

    it('dispatches the Finish callback', () => {
        const { window, document } = env;
        openStatus(window, 'in_progress');
        const actionsContainer = document.getElementById('workout-session-actions');
        const onFinish = vi.fn();
        window.renderSessionDetailActions(actionsContainer, { onFinish });

        actionsContainer.querySelector('.wg-workouts-session-actions__finish').click();

        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('tolerates omitted handlers without throwing on click', () => {
        const { window, document } = env;
        openStatus(window, 'in_progress');
        const actionsContainer = document.getElementById('workout-session-actions');
        window.renderSessionDetailActions(actionsContainer, {});

        expect(() => {
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

    // bd med-ci6 (replaces the old med-eas.71 Delete-gating pair): the header
    // carries + Exercise and an icon Close, nothing else. Deleting a session is
    // the History row's trash icon, and every entry point that can open a
    // completed/skipped session is such a row — so no surface lost the
    // capability.
    it('renders a header with + Exercise and an icon Close — no Delete button', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture()], { status: 'completed' });

        expect(document.getElementById('workout-session-delete-btn')).toBeNull();
        const headerBtns = document.querySelectorAll('.wg-workouts-session-modal__header-actions button');
        expect(headerBtns.length).toBe(2);
        expect(headerBtns[0].id).toBe('workout-session-header-add-btn');
        expect(headerBtns[0].textContent).toBe('+ Exercise');

        // Close is the compact icon button, not a full-width labelled one — the
        // old text button ate a whole row of a modal that is already too tall.
        const close = headerBtns[1];
        expect(close.id).toBe('workout-session-cancel-btn');
        expect(close.classList.contains('wg-icon-btn')).toBe(true);
        expect(close.getAttribute('aria-label')).toBe('Close');
        expect(close.querySelector('.wg-gloss svg')).not.toBeNull();
    });

    // The pinned header is what makes a long exercise list workable: the modal
    // itself is the scroll container, so the strip must stay stuck to its top.
    it('pins the header to the top of the scrolling modal', () => {
        const css = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8');
        const rule = css.match(/\.wg-workouts-session-modal__header\s*\{[^}]*\}/);
        expect(rule).not.toBeNull();
        expect(rule[0]).toMatch(/position:\s*sticky/);
        expect(rule[0]).toMatch(/top:/);
        // Opaque background, or exercise cards would show through as they pass under.
        expect(rule[0]).toMatch(/background:\s*var\(--wg-bg-card\)/);
    });

    // Friendly body-part chip (med-mj4): a card whose exercise resolves to a
    // catalog body_part with a friendly translation gets a chip next to the name;
    // an unmatched exercise gets none. The chip attaches fire-and-forget, so flush
    // microtasks (as the PR-badge flow does) before asserting.
    describe('friendly body-part chip', () => {
        function stubCatalog(window) {
            window.fetch = vi.fn(async (url) => {
                if (String(url).includes('/static/data/exercises-catalog.json')) {
                    return { ok: true, status: 200, json: async () => ({ exercises: [{ name: 'Bench', body_part: 'chest' }] }) };
                }
                return { ok: true, status: 200, json: async () => ({}) };
            });
        }

        it('shows a chip with the friendly label for a catalog-matched exercise', async () => {
            const { window, document } = env;
            stubCatalog(window);
            await openSession(window, [logFixture({ exercise_name: 'Bench' })]);
            await new Promise((r) => setTimeout(r, 0));

            const card = document.getElementById('workout-session-logs')
                .querySelector('.wg-workouts-session-exercise');
            const chip = card.querySelector('.wg-workouts-session-exercise__bodypart-chip');
            expect(chip).not.toBeNull();
            expect(chip.textContent).toBe('Chest');
        });

        it('renders no chip for an exercise absent from the catalog', async () => {
            const { window, document } = env;
            stubCatalog(window);
            await openSession(window, [logFixture({ exercise_name: 'Mystery Move' })]);
            await new Promise((r) => setTimeout(r, 0));

            const card = document.getElementById('workout-session-logs')
                .querySelector('.wg-workouts-session-exercise');
            expect(card.querySelector('.wg-workouts-session-exercise__bodypart-chip')).toBeNull();
        });
    });
});
