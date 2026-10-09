// Workout session takeover (med-xso6.21, kit W1–W3).
//
// Covers the full-screen session view: the top bar (clock, plan · day · date,
// status chip), the progress segments + overview (+ Exercise, gym, status of a
// finished session), ONE exercise at a time with .wg-set rows (done rows =
// log.sets, pending rows = ghost values to accept), the rest timer docked
// after a done set, the footer (prev / next / Finish) and the Finish dialog.

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

describe('Workout session takeover (med-xso6.21)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    // showWorkoutSessionModal is the public entry point; a mocked apiCall feeds
    // it (and answers every write / history read with `extra(endpoint)`).
    async function openSession(window, logs, sessionOverrides, extra) {
        window.apiCall = vi.fn(async (endpoint, method, body) => {
            if (endpoint.startsWith('/api/workout/sessions/details')) {
                return { session: sessionFixture(sessionOverrides), logs };
            }
            if (extra) {
                const r = await extra(endpoint, method, body);
                if (r !== undefined) return r;
            }
            return [];
        });
        await window.showWorkoutSessionModal(77);
    }

    const logsEl = (document) => document.getElementById('workout-session-logs');
    const setRows = (document) => Array.from(logsEl(document).querySelectorAll('.wg-set'));

    it('renders the top bar: clock, plan · day · date line and a status chip', () => {
        const { window, document } = env;
        window.renderWorkoutSessionHeader(sessionFixture({ status: 'completed' }));

        const heading = document.getElementById('workout-session-modal-heading');
        expect(heading.querySelector('.wg-session-top__clock').textContent).toBe('42m');
        const sub = heading.querySelector('.wg-session-top__sub');
        expect(sub.textContent).toContain('PPL · Push Day · ');
        expect(sub.textContent).toMatch(/\d{2}[./]\d{2}[./]\d{4}\s*·\s*\S+/);
        expect(document.getElementById('workout-session-modal-status').textContent).toBe('Completed');
        // Status is shown, never edited, in the top bar.
        expect(document.getElementById('session-status-select')).toBeNull();
    });

    it('is a full-screen page with a minimise button and no sticky-header controls', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture()], { status: 'completed' });

        const modal = document.getElementById('workout-session-modal');
        expect(modal.classList.contains('wg-page')).toBe(true);
        expect(modal.querySelector('.wg-session-top')).not.toBeNull();
        expect(modal.querySelector('.wg-session-prog')).not.toBeNull();
        const close = document.getElementById('workout-session-cancel-btn');
        expect(close.classList.contains('wg-btn')).toBe(true);
        expect(close.getAttribute('aria-label')).toBe('Minimise');
        expect(document.getElementById('workout-session-delete-btn')).toBeNull();
        // + Exercise lives in the overview, not in the top bar.
        expect(document.getElementById('workout-session-header-add-btn')).toBeNull();
        expect(document.querySelector('.wg-workouts-session-modal__header')).toBeNull();
    });

    it('renders an empty state when no exercise logs are present', async () => {
        const { window, document } = env;
        await openSession(window, []);

        const empty = logsEl(document).querySelector('.wg-workouts-session-logs__empty');
        expect(empty).not.toBeNull();
        expect(empty.textContent).toBe('No exercises logged');
        expect(document.getElementById('workout-session-header-add-btn')).not.toBeNull();
    });

    it('shows one exercise at a time with a progress segment per exercise; Next / prev move between them', async () => {
        const { window, document } = env;
        await openSession(window, [
            logFixture({ exercise_name: 'Bench', sets_completed: 4, reps_completed: 8, weight_kg: 70 }),
            logFixture({ id: 2, exercise_name: 'Overhead', sets_completed: 3, reps_completed: 10, weight_kg: 40 })
        ]);

        const cards = logsEl(document).querySelectorAll('.wg-workouts-session-exercise');
        expect(cards.length).toBe(1);
        expect(cards[0].classList.contains('wg-ex')).toBe(true);
        expect(cards[0].querySelector('.wg-eyebrow').textContent).toBe('Exercise 1 of 2');
        expect(cards[0].querySelector('.wg-ex__name').textContent).toBe('Bench');
        expect(cards[0].querySelector('.wg-workouts-session-exercise__mono').textContent).toBe('4 × 8 · 70 kg');
        // Both exercises are fully logged → both segments are done.
        const segs = document.querySelectorAll('#workout-session-prog .wg-session-prog__seg');
        expect(segs.length).toBe(2);
        expect(segs[0].classList.contains('wg-session-prog__seg--done')).toBe(true);

        document.querySelector('.wg-workouts-session-actions__next').click();
        const card = logsEl(document).querySelector('.wg-workouts-session-exercise');
        expect(card.querySelector('.wg-ex__name').textContent).toBe('Overhead');
        expect(card.querySelector('.wg-workouts-session-exercise__mono').textContent).toBe('3 × 10 · 40 kg');
        expect(document.querySelector('.wg-workouts-session-actions__next').disabled).toBe(true);

        document.querySelector('.wg-workouts-session-actions__prev').click();
        expect(logsEl(document).querySelector('.wg-ex__name').textContent).toBe('Bench');
    });

    it('labels bodyweight sets (weight_kg = 0) as "bodyweight" in the mono row', async () => {
        const { window, document } = env;
        await openSession(window, [
            logFixture({ exercise_name: 'Pull-ups', sets_completed: 3, reps_completed: 8, weight_kg: 0 })
        ]);
        expect(logsEl(document).querySelector('.wg-workouts-session-exercise__mono').textContent).toBe('3 × 8 · bodyweight');
    });

    it('renders done sets as 56px .wg-set rows: index, weight, reps, done check', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture()]);

        expect(logsEl(document).querySelector('.wg-sethead')).not.toBeNull();
        const rows = setRows(document);
        expect(rows.length).toBe(3);
        rows.forEach((row, i) => {
            expect(row.classList.contains('wg-set--done')).toBe(true);
            expect(row.querySelector('.wg-set__idx').textContent).toBe(String(i + 1));
            const cells = row.querySelectorAll('.wg-set__cell');
            expect(cells.length).toBe(2);
            expect(cells[0].textContent).toBe('60');
            expect(cells[1].textContent).toBe('8');
            expect(row.querySelector('.wg-set__done').getAttribute('aria-pressed')).toBe('true');
        });
        // No RPE / type inputs on the row itself.
        expect(logsEl(document).querySelector('select, input[type="number"]')).toBeNull();
    });

    it('a planned exercise opens with its target as ghost rows; ticking one logs it (create) and starts the rest timer', async () => {
        const { window, document } = env;
        await openSession(window, [], { variant_id: 5, exercise_snapshot: [
            { exercise_id: 20, exercise_name: 'Fly', target_sets: 2, target_reps_min: 12, target_weight_kg: 15 }
        ] }, (endpoint) => (endpoint.includes('/logs/create') ? { id: 501 } : undefined));

        const rows = setRows(document);
        expect(rows.length).toBe(2);
        expect(rows[0].classList.contains('wg-set--done')).toBe(false);
        expect(rows[0].classList.contains('wg-set--active')).toBe(true);
        expect(rows[0].querySelector('.wg-set__adjust')).not.toBeNull();
        const ghost = rows[0].querySelectorAll('.wg-set__cell--ghost');
        expect(ghost.length).toBe(2);
        expect(ghost[0].textContent).toBe('15');
        expect(ghost[1].textContent).toBe('12');
        // No "Not yet logged" dim card any more.
        expect(logsEl(document).textContent).not.toContain('Not yet logged');

        vi.useFakeTimers();
        rows[0].querySelector('.wg-set__done').click();
        const after = setRows(document);
        expect(after[0].classList.contains('wg-set--done')).toBe(true);
        expect(after[1].classList.contains('wg-set--active')).toBe(true);

        const rest = document.getElementById('workout-session-rest');
        expect(rest.hidden).toBe(false);
        expect(rest.querySelector('.wg-rest__time').textContent).toBe('1:30');

        await vi.advanceTimersByTimeAsync(900);
        expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions/logs/create', 'POST', expect.objectContaining({
            session_id: 77,
            exercise_id: 20,
            target_sets: 1,
            target_reps_min: 12,
            target_weight_kg: 15,
            sets: [expect.objectContaining({ set_index: 0, weight_kg: 15, reps: 12, set_type: 'normal' })]
        }), { suppressWriteAlert: true });
    });

    it('ghost cells show last session\'s values and a tap accepts them; ± adjusts the active row', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture({ id: 1, sets_completed: 1, sets: [
            { set_index: 0, weight_kg: 60, reps: 8, set_type: 'normal' }
        ] })], { variant_id: 5, exercise_snapshot: [
            { exercise_id: 10, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_weight_kg: 60 }
        ] }, (endpoint) => {
            if (endpoint.startsWith('/api/workout/exercises/history')) {
                return [
                    { date: '2026-04-22', session_id: 77, sets: [{ weight_kg: 60, reps: 8 }] },
                    { date: '2026-04-19', session_id: 70, sets: [
                        { weight_kg: 60, reps: 8 }, { weight_kg: 62.5, reps: 7 }, { weight_kg: 62.5, reps: 6 }] }
                ];
            }
            return undefined;
        });
        await vi.waitFor(() => expect(setRows(document)[1].querySelector('.wg-set__cell--ghost').textContent).toContain('62.5'));

        const row = setRows(document)[1];
        const [w, r] = row.querySelectorAll('.wg-set__cell');
        expect(w.querySelector('small').textContent).toBe('last');
        expect(r.textContent).toContain('7');

        vi.useFakeTimers(); // so the autosave debounce could fire below
        w.click();
        let cells = setRows(document)[1].querySelectorAll('.wg-set__cell');
        expect(cells[0].classList.contains('wg-set__cell--ghost')).toBe(false);
        expect(cells[1].classList.contains('wg-set__cell--ghost')).toBe(true);

        const adjust = setRows(document)[1].querySelectorAll('.wg-set__adjust button');
        adjust[1].click(); // +2.5 kg
        adjust[3].click(); // +1 rep
        cells = setRows(document)[1].querySelectorAll('.wg-set__cell');
        expect(cells[0].firstChild.textContent).toBe('65');
        expect(cells[1].firstChild.textContent).toBe('8');
        // Pending rows are local only — nothing is written, even after the
        // autosave debounce.
        await vi.advanceTimersByTimeAsync(900);
        expect(window.apiCall).not.toHaveBeenCalledWith('/api/workout/sessions/logs/update', 'POST', expect.anything(), expect.anything());
    });

    it('un-ticking the only done set saves without a weight, so the plan keeps its target', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture({ sets_completed: 1, sets: [
            { set_index: 0, weight_kg: 60, reps: 8, set_type: 'normal' }
        ] })], undefined, (endpoint) => (endpoint.includes('/logs/update') ? { ok: true } : undefined));

        vi.useFakeTimers();
        setRows(document)[0].querySelector('.wg-set__done').click();
        await vi.advanceTimersByTimeAsync(900);
        const call = window.apiCall.mock.calls.find((c) => c[0] === '/api/workout/sessions/logs/update');
        expect(call).toBeDefined();
        expect(call[2]).toMatchObject({ id: 1, sets_completed: 0, sets: [] });
        expect('weight_kg' in call[2]).toBe(false);
    });

    it('a notes-only planned exercise is created without a weight', async () => {
        const { window, document } = env;
        await openSession(window, [], { variant_id: 5, exercise_snapshot: [
            { exercise_id: 20, exercise_name: 'Fly', target_sets: 2, target_reps_min: 12, target_weight_kg: 15 }
        ] }, (endpoint) => (endpoint.includes('/logs/create') ? { id: 501 } : undefined));

        vi.useFakeTimers();
        const notes = logsEl(document).querySelector('.wg-workouts-session-exercise__field--notes input');
        notes.value = 'shoulder twinge';
        notes.dispatchEvent(new window.Event('change'));
        await vi.advanceTimersByTimeAsync(900);
        const call = window.apiCall.mock.calls.find((c) => c[0] === '/api/workout/sessions/logs/create');
        expect(call).toBeDefined();
        expect(call[2]).toMatchObject({ exercise_id: 20, target_sets: 0, notes: 'shoulder twinge' });
        expect('target_weight_kg' in call[2]).toBe(false);
    });

    it('a minimise → reopen keeps the pending rows though autosave mirrored the plan down', async () => {
        const { window, document } = env;
        const plan = { id: 10, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_weight_kg: 60 };
        await openSession(window, [logFixture({ sets_completed: 1 })], { variant_id: 5 },
            (endpoint) => (endpoint.startsWith('/api/workout/exercises?variant_id=') ? [{ ...plan }] : undefined));
        expect(setRows(document).length).toBe(3);

        plan.target_sets = 1; // the domain mirrored the done count into the plan
        await window.closeWorkoutSessionModal();
        await window.showWorkoutSessionModal(77);
        expect(setRows(document).length).toBe(3);
        expect(setRows(document).filter((r) => r.classList.contains('wg-set--done')).length).toBe(1);
    });

    it('RPE and set type sit behind the row index toggle', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture({ sets_completed: 1 })], undefined,
            (endpoint) => (endpoint.includes('/logs/update') ? { ok: true } : undefined));

        expect(logsEl(document).querySelector('.wg-set__more')).toBeNull();
        setRows(document)[0].querySelector('.wg-set__idx').click();
        const more = logsEl(document).querySelector('.wg-set__more');
        expect(more).not.toBeNull();
        more.querySelector('[data-set-type="warmup"]').click();
        const idx = setRows(document)[0].querySelector('.wg-set__idx');
        expect(idx.textContent).toBe('W');
        expect(idx.classList.contains('wg-set__idx--warm')).toBe(true);
        expect(window.WorkoutSessionsState.logs[0].sets[0].set_type).toBe('warmup');

        logsEl(document).querySelector('.wg-set__more [aria-label="Raise RPE"]').click();
        expect(window.WorkoutSessionsState.logs[0].sets[0].rpe).toBe(8);
        expect(window.WorkoutSessionsState.logs[0]._setsDirty).toBe(true);
    });

    it('un-ticking a done set returns it to the pending rows', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture({ sets_completed: 2 })]);

        setRows(document)[1].querySelector('.wg-set__done').click();
        const rows = setRows(document);
        expect(rows.length).toBe(2);
        expect(rows[1].classList.contains('wg-set--done')).toBe(false);
        expect(rows[1].querySelectorAll('.wg-set__cell')[0].firstChild.textContent).toBe('60');
        expect(window.WorkoutSessionsState.logs[0].sets.length).toBe(1);
        expect(window.WorkoutSessionsState.logs[0].sets_completed).toBe(1);
    });

    it('the rest timer counts down, extends by 30s, can be skipped and clears itself at zero', async () => {
        const { window, document } = env;
        // Fake timers before the open: the session's 1s tick is created there.
        vi.useFakeTimers();
        await openSession(window, [logFixture({ sets_completed: 1 })]);

        document.querySelector('.wg-workouts-session-exercise__add-set').click();
        setRows(document)[1].querySelector('.wg-set__done').click();
        const rest = document.getElementById('workout-session-rest');
        expect(rest.querySelector('.wg-rest__time').textContent).toBe('1:30');

        await vi.advanceTimersByTimeAsync(10000);
        expect(rest.querySelector('.wg-rest__time').textContent).toBe('1:20');
        rest.querySelector('.wg-rest__plus').click();
        expect(rest.querySelector('.wg-rest__time').textContent).toBe('1:50');

        rest.querySelector('.wg-rest__skip').click();
        expect(rest.hidden).toBe(true);

        setRows(document)[1].querySelector('.wg-set__done').click(); // undo
        setRows(document)[1].querySelector('.wg-set__done').click(); // done again → new rest
        expect(rest.hidden).toBe(false);
        await vi.advanceTimersByTimeAsync(91000);
        expect(rest.hidden).toBe(true);
    });

    it('asks the service worker for a notification when rest ends while the page is hidden', async () => {
        const { window, document } = env;
        const showNotification = vi.fn(async () => {});
        Object.defineProperty(window.navigator, 'serviceWorker', {
            configurable: true,
            value: { ready: Promise.resolve({ showNotification }) }
        });
        vi.useFakeTimers();
        await openSession(window, [logFixture({ sets_completed: 1 })]);
        document.querySelector('.wg-workouts-session-exercise__add-set').click();
        setRows(document)[1].querySelector('.wg-set__done').click();

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        await vi.advanceTimersByTimeAsync(91000);
        expect(showNotification).toHaveBeenCalledWith('Rest over', expect.objectContaining({ tag: 'workout-rest' }));
    });

    it('a finished session does not start the rest timer', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture({ sets_completed: 1 })], { status: 'completed' });
        document.querySelector('.wg-workouts-session-exercise__add-set').click();
        setRows(document)[1].querySelector('.wg-set__done').click();
        expect(document.getElementById('workout-session-rest').hidden).toBe(true);
    });

    it('tapping the progress bar opens the overview: every exercise, + Exercise and the gym slot', async () => {
        const { window, document } = env;
        await openSession(window, [
            logFixture({ exercise_name: 'Bench' }),
            logFixture({ id: 2, exercise_name: 'Row', sets_completed: 2 })
        ]);

        document.getElementById('workout-session-prog').click();
        const rows = logsEl(document).querySelectorAll('.wg-session-overview__row');
        expect(rows.length).toBe(2);
        expect(rows[0].querySelector('.wg-row__title').textContent).toBe('Bench');
        expect(rows[0].querySelector('.wg-row__meta').textContent).toContain('3 of 3 sets');
        expect(rows[1].querySelector('.wg-row__meta').textContent).toContain('2 of 2 sets');
        expect(document.getElementById('workout-session-header-add-btn')).not.toBeNull();
        expect(document.getElementById('workout-session-gym')).not.toBeNull();
        // A running session has no status row (Finish changes it).
        expect(document.getElementById('workout-session-status-row')).toBeNull();

        rows[1].click();
        expect(logsEl(document).querySelector('.wg-ex__name').textContent).toBe('Row');
    });

    it('a finished session changes its status from the overview', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture()], { status: 'completed' });
        document.getElementById('workout-session-prog').click();

        document.getElementById('workout-session-status-row').click();
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__choice')).not.toBeNull());
        const choices = Array.from(document.querySelectorAll('.mt-confirm-modal__choice'));
        // No way back to In Progress from a finished session (no Finish path here).
        expect(choices.some((b) => b.textContent.includes('In Progress'))).toBe(false);
        choices.find((b) => b.textContent.includes('Skipped')).click();
        await vi.waitFor(() => expect(window.WorkoutSessionsState.targetStatus).toBe('skipped'));
        expect(document.getElementById('workout-session-modal-status').textContent).toBe('Skipped');
        // The row stays, so the pick can be reverted.
        expect(document.getElementById('workout-session-status-row')).not.toBeNull();
    });

    // renderSessionDetailActions reads the open session's status off
    // WorkoutSessionsState — bd med-4ca gates Finish on `in_progress`.
    function openStatus(window, status) {
        window.WorkoutSessionsState.data = sessionFixture({ status });
    }

    it('renders Finish as the sun primary in the footer', () => {
        const { window, document } = env;
        openStatus(window, 'in_progress');
        const actionsContainer = document.getElementById('workout-session-actions');
        window.renderSessionDetailActions(actionsContainer, { onFinish: vi.fn() });

        const finishBtn = actionsContainer.querySelector('.wg-workouts-session-actions__finish');
        expect(finishBtn.classList.contains('wg-btn--primary')).toBe(true);
        expect(finishBtn.textContent).toBe('Finish');
        expect(actionsContainer.querySelector('.wg-workouts-session-actions__delete')).toBeNull();
    });

    // bd med-4ca: a finished workout must not offer Finish.
    it('omits Finish on a completed or skipped session', () => {
        const { window, document } = env;
        const actionsContainer = document.getElementById('workout-session-actions');
        openStatus(window, 'completed');
        window.renderSessionDetailActions(actionsContainer, { onFinish: vi.fn() });
        expect(document.getElementById('workout-session-finish-btn')).toBeNull();
        openStatus(window, 'skipped');
        window.renderSessionDetailActions(actionsContainer, { onFinish: vi.fn() });
        expect(document.getElementById('workout-session-finish-btn')).toBeNull();
    });

    it('dispatches the Finish callback and tolerates an omitted one', () => {
        const { window, document } = env;
        openStatus(window, 'in_progress');
        const actionsContainer = document.getElementById('workout-session-actions');
        const onFinish = vi.fn();
        window.renderSessionDetailActions(actionsContainer, { onFinish });
        actionsContainer.querySelector('.wg-workouts-session-actions__finish').click();
        expect(onFinish).toHaveBeenCalledTimes(1);

        window.renderSessionDetailActions(actionsContainer, {});
        expect(() => actionsContainer.querySelector('.wg-workouts-session-actions__finish').click()).not.toThrow();
    });

    it('Finish opens a dialog listing unlogged sets and a summary; Keep going saves nothing', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture({ sets_completed: 2 })], { variant_id: 5, exercise_snapshot: [
            { exercise_id: 10, exercise_name: 'Bench', target_sets: 3, target_reps_min: 8, target_weight_kg: 60 },
            { exercise_id: 20, exercise_name: 'Fly', target_sets: 2, target_reps_min: 12, target_weight_kg: 15 }
        ] });

        document.getElementById('workout-session-finish-btn').click();
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal')).not.toBeNull());
        const dialog = document.querySelector('.mt-confirm-modal');
        expect(dialog.classList.contains('wg-dialog')).toBe(true);
        expect(dialog.querySelector('.mt-confirm-modal__title').textContent).toBe('Finish workout?');
        expect(dialog.textContent).toContain('Sets left: 3, across Bench and Fly');
        const stats = Array.from(dialog.querySelectorAll('.wg-stat__value')).map((s) => s.textContent);
        expect(stats[1]).toBe('2');
        expect(stats[2]).toBe('960 kg');
        const confirm = dialog.querySelector('.mt-confirm-modal__confirm');
        expect(confirm.classList.contains('wg-btn--primary')).toBe(true);
        expect(confirm.textContent).toBe('Finish');

        dialog.querySelector('.mt-confirm-modal__cancel').click();
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal')).toBeNull());
        expect(window.apiCall).not.toHaveBeenCalledWith('/api/workout/sessions/status?id=77', 'PUT', expect.anything(), expect.anything());
        expect(window.WorkoutSessionsState.data).not.toBeNull();
    });

    // bd med-mgvo: offline, Finish must stay live and write status=completed.
    it('Finish stays enabled offline and still completes the session', async () => {
        const { window, document } = env;
        window.eval(readFileSync(new URL('../sync.js', import.meta.url), 'utf8'));
        await openSession(window, [logFixture()]);

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        window.SyncManager.handleOffline();
        expect(logSpy).toHaveBeenCalledWith('[Sync WARN] Network: gone offline');

        const finishBtn = document.getElementById('workout-session-finish-btn');
        expect(finishBtn.disabled).toBe(false);
        expect(finishBtn.hasAttribute('data-offline-disabled')).toBe(false);

        finishBtn.click();
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__confirm')).not.toBeNull());
        expect(document.querySelector('.mt-confirm-modal').textContent).toContain('All sets logged');
        document.querySelector('.mt-confirm-modal__confirm').click();
        await vi.waitFor(() => expect(window.WorkoutSessionsState.data).toBeNull());
        expect(window.apiCall).toHaveBeenCalledWith(
            '/api/workout/sessions/status?id=77', 'PUT', { status: 'completed' }, expect.anything());
        expect(document.getElementById('workout-session-modal').classList.contains('hidden')).toBe(true);
    });

    // med-laj4: closing a running workout with saved sets nudges (never
    // blocks) — a forgotten Finish is otherwise silent.
    it('nudges on close while in_progress with logged sets, without blocking', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture()]);
        window.safeToast = vi.fn();

        await window.closeWorkoutSessionModal();

        expect(window.safeToast).toHaveBeenCalledWith(expect.stringContaining('unfinished'), 'info');
        expect(window.WorkoutSessionsState.data).toBeNull();
        expect(document.getElementById('workout-session-modal').classList.contains('hidden')).toBe(true);
    });

    it('does not nudge on close for a completed session or one with no logged sets', async () => {
        const { window } = env;
        window.safeToast = vi.fn();
        await openSession(window, [logFixture()], { status: 'completed' });
        await window.closeWorkoutSessionModal();
        await openSession(window, []);
        await window.closeWorkoutSessionModal();
        expect(window.safeToast).not.toHaveBeenCalled();
    });

    it('the exercise header carries an icon delete control', async () => {
        const { window, document } = env;
        await openSession(window, [logFixture()]);

        const deleteBtn = logsEl(document).querySelector('.wg-workouts-session-exercise__delete');
        expect(deleteBtn).not.toBeNull();
        expect(deleteBtn.classList.contains('wg-btn--icon')).toBe(true);
        expect(deleteBtn.querySelector('svg')).not.toBeNull();
        expect(deleteBtn.getAttribute('aria-label')).toBe('Remove exercise');
    });

    // Friendly body-part chip (med-mj4): fire-and-forget, so flush a tick.
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

            const chip = logsEl(document).querySelector('.wg-workouts-session-exercise__bodypart-chip');
            expect(chip).not.toBeNull();
            expect(chip.textContent).toBe('Chest');
            expect(chip.classList.contains('wg-tag')).toBe(true);
        });

        it('renders no chip for an exercise absent from the catalog', async () => {
            const { window, document } = env;
            stubCatalog(window);
            await openSession(window, [logFixture({ exercise_name: 'Mystery Move' })]);
            await new Promise((r) => setTimeout(r, 0));
            expect(logsEl(document).querySelector('.wg-workouts-session-exercise__bodypart-chip')).toBeNull();
        });
    });
});
