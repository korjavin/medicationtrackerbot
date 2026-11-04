// Workouts Timeline sub-tab (id history; med-soo0.4, kit WN2).
//
// Exercises `_renderWorkoutHistory`: Mon–Sun week sections (head with count
// + total time, seven day dots), kit `.wg-row.wg-workouts-history-row` rows
// with Off plan / Band tags, dim skipped rows, the Unfinished chip + Finish,
// and "Show 4 earlier weeks" paging. Offline-pending and rejected badges
// surface as the shared sync chips.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickRowAction, loadFrontendEnv } from './helpers/frontend-harness.js';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

// "YYYY-MM-DD" (UTC) `days` from today, and the Monday of today's week
// shifted by `weeks` — the renders below run with userTz 'UTC'.
function utcDay(days) {
    return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}
function weekDay(weeks, dow) {
    const now = new Date();
    const mon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((now.getUTCDay() + 6) % 7) * 86400000;
    return new Date(mon + (weeks * 7 + dow) * 86400000).toISOString().slice(0, 10);
}

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

    // A plan session this Monday; last week a skipped plan Monday, an
    // off-plan Telegram "walk" on Wednesday and a band run on Thursday; then
    // six older weeks with one session each.
    function timelineFixture() {
        const at = (day) => `${day}T10:00:00.000Z`;
        const sessions = [
            makeSession({ variant_name: 'Upper Back & Grip', session: { id: 1, scheduled_date: weekDay(0, 0), started_at: `${weekDay(0, 0)}T16:04:00.000Z` } }),
            makeSession({ variant_name: 'Pull', total_volume: 0, session: {
                id: 2, status: 'skipped', scheduled_date: weekDay(-1, 0), scheduled_time: '18:00',
                started_at: null, completed_at: null, duration_minutes: undefined } }),
            makeSession({ group_name: 'Ad-hoc', variant_name: '', total_volume: 0, exercises_count: 0, exercises_completed: 0,
                session: { id: 3, group_id: -1, notes: 'Morning run', scheduled_date: weekDay(-1, 2), started_at: at(weekDay(-1, 2)) } }),
        ];
        for (let w = 2; w <= 7; w += 1) {
            sessions.push(makeSession({ session: { id: 10 + w, scheduled_date: weekDay(-w, 0), started_at: at(weekDay(-w, 0)) } }));
        }
        const miband = [{ id: 7, activity_name: 'running', start_time: at(weekDay(-1, 3)), distance_m: 5400, duration_sec: 1800, source: 'device' }];
        return { sessions, miband };
    }

    it('groups rows into Mon–Sun weeks, newest first, with count, total time and day dots (WN2)', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const { sessions, miband } = timelineFixture();
        window._renderWorkoutHistory(container, sessions, miband, 'UTC');

        const weeks = Array.from(container.querySelectorAll('.wg-workouts-history__week'));
        expect(weeks.map((w) => w.dataset.week)).toEqual([weekDay(0, 0), weekDay(-1, 0), weekDay(-2, 0)]);
        const labels = weeks.map((w) => w.querySelector('.wg-section__head .wg-eyebrow').textContent);
        expect(labels[0]).toMatch(/^This week · \d{2}(\.\d{2})?–\d{2}\.\d{2}/);
        expect(labels[1]).toMatch(/^Last week · /);
        expect(labels[2]).toMatch(/^\d{2}(\.\d{2})?–\d{2}\.\d{2}/);
        const metas = weeks.map((w) => w.querySelector('.wg-workouts-history__week-meta').textContent);
        // The skipped plan day is not a workout; the run (45 min) + band (30 min) are.
        expect(metas.slice(0, 2)).toEqual(['1 workout · 45 min', '2 workouts · 1h 15m']);

        const dots = (w) => Array.from(w.querySelectorAll('.wg-dots:not([aria-hidden]) .wg-dot'));
        const thisWeek = dots(weeks[0]);
        expect(thisWeek).toHaveLength(7);
        expect(thisWeek[0].classList.contains('wg-dot--hit')).toBe(true);
        const today = thisWeek.find((d) => d.dataset.day === utcDay(0));
        expect(today.classList.contains('wg-dot--today')).toBe(true);
        thisWeek.filter((d) => d.dataset.day > utcDay(0)).forEach((d) => expect(d.classList.contains('wg-dot--future')).toBe(true));
        const lastWeek = dots(weeks[1]).map((d) => ['hit', 'rest'].find((k) => d.classList.contains(`wg-dot--${k}`)) || '');
        expect(lastWeek).toEqual(['rest', '', 'hit', 'hit', '', '', '']);
        expect(Array.from(weeks[0].querySelectorAll('.wg-dots__lbl')).map((l) => l.textContent).join('')).toBe('MTWTFSS');
    });

    it('tags Off plan and Band rows and dims a skipped plan day without red', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const { sessions, miband } = timelineFixture();
        window._renderWorkoutHistory(container, sessions, miband, 'UTC');

        const lastWeek = container.querySelectorAll('.wg-workouts-history__week')[1];
        const rows = Array.from(lastWeek.querySelectorAll('.wg-workouts-history-row'));
        expect(rows.map((r) => r.querySelector('.wg-workouts-history-row__name').textContent)).toEqual(['Running', 'Morning run', 'Pull']);
        expect(rows[0].querySelector('.wg-workouts-history-row__tag').textContent).toBe('Band');
        const bandParts = Array.from(rows[0].querySelectorAll('.wg-workouts-history-row__part')).map((p) => p.textContent);
        expect(bandParts[0]).toBe('Thu 10:00');
        expect(bandParts.slice(1)).toEqual(['30 min', '5.4 km']);
        expect(rows[1].querySelector('.wg-workouts-history-row__tag').textContent).toBe('Off plan');
        expect(rows[1].querySelector('.wg-row__lead--ok')).not.toBeNull();
        const skipped = rows[2];
        expect(skipped.querySelector('.wg-row__lead--stale')).not.toBeNull();
        expect(Array.from(skipped.querySelectorAll('.wg-workouts-history-row__part')).map((p) => p.textContent)).toEqual(['Mon', 'skipped']);
        expect(skipped.querySelector('.wg-workouts-history-row__tag')).toBeNull();
        expect(skipped.querySelector('.wg-row__body [class*="danger"], .wg-row__lead--danger, .wg-dot--miss')).toBeNull();
        expect(container.querySelector('.wg-dot--miss')).toBeNull();
        // A plan session carries no tag; the plan day names it.
        const planRow = container.querySelector('[data-session-id="1"]');
        expect(planRow.querySelector('.wg-workouts-history-row__tag')).toBeNull();
        expect(planRow.querySelector('.wg-workouts-history-row__name').textContent).toBe('Upper Back & Grip');
        // 24h clock, as the kit and the card read.
        expect(planRow.querySelector('.wg-workouts-history-row__time').textContent).toBe('Mon 16:04');
    });

    it('"Show 4 earlier weeks" adds four weeks per tap from the rows already read; a visit starts short again', async () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const { sessions, miband } = timelineFixture();
        window._renderWorkoutHistory(container, sessions, miband, 'UTC');

        const count = () => container.querySelectorAll('.wg-workouts-history__week').length;
        const more = () => container.querySelector('.wg-tl-more');
        expect(count()).toBe(3);
        expect(more().textContent).toBe('Show 4 earlier weeks');
        more().click();
        expect(count()).toBe(7);
        more().click();
        expect(count()).toBe(8);
        expect(more()).toBeNull();

        // A refresh after a write keeps the open weeks; a visit resets them.
        window.apiCall = vi.fn(async (url) => {
            if (url.startsWith('/api/workout/sessions')) return sessions;
            if (url.startsWith('/api/workout/miband')) return miband;
            if (url.startsWith('/api/settings')) return { timezone: 'UTC' };
            return null;
        });
        await window.loadWorkoutHistoryTab();
        await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalledWith('/api/workout/miband?limit=1000'));
        expect(count()).toBe(8);
        await window.loadWorkoutHistoryTab({ resetWeeks: true });
        await vi.waitFor(() => expect(count()).toBe(3));
        expect(window.apiCall).toHaveBeenCalledWith('/api/workout/sessions?limit=500');
    });

    it('renders kit history rows with plan-day name, duration and volume', () => {
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
        expect(row.classList.contains('wg-row')).toBe(true);
        expect(row.getAttribute('role')).toBe('button');
        expect(row.querySelector('.wg-workouts-history-row__name').textContent).toBe('Legs');
        expect(row.querySelector('.wg-workouts-slot-tag')).toBeNull();

        const duration = row.querySelector('.wg-workouts-history-row__duration');
        expect(duration).not.toBeNull();
        expect(duration.textContent).toBe('1h 02m');

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
        const badge = rows[0].querySelector('.wg-workouts-history-row__unfinished');
        expect(badge).not.toBeNull();
        expect(badge.classList.contains('wg-chip--pending')).toBe(true);
        expect(badge.textContent).toBe('Unfinished');
        expect(rows[0].querySelector('.wg-row__lead--warn')).not.toBeNull();
        expect(rows[0].querySelector('.wg-workouts-history-row__finish').textContent).toBe('Finish');
    });

    it('the Unfinished row\'s Finish completes it in place, without opening the session', async () => {
        const { window, document } = env;
        const container = document.getElementById('workout-history-display');
        const yesterday = new Date(Date.now() - 86400000);
        window.loadWorkoutHistoryTab = vi.fn();
        window.loadNextWorkout = vi.fn();
        window.showWorkoutSessionModal = vi.fn();
        window.apiCall = vi.fn(async () => true);
        window._renderWorkoutHistory(container, [makeSession({ session: {
            id: 304, group_id: -1, status: 'in_progress', scheduled_date: yesterday.toISOString().slice(0, 10),
            started_at: yesterday.toISOString(), completed_at: null, duration_minutes: undefined
        } })], [], 'UTC');
        // An off-plan Unfinished row carries Finish, not the Off plan tag (WN6).
        expect(container.querySelector('.wg-workouts-history-row__tag')).toBeNull();

        container.querySelector('.wg-workouts-history-row__finish').click();
        await vi.waitFor(() => expect(document.querySelector('.mt-confirm-modal__confirm')).not.toBeNull());
        document.querySelector('.mt-confirm-modal__confirm').click();
        await vi.waitFor(() => expect(window.apiCall).toHaveBeenCalledWith(
            '/api/workout/sessions/status?id=304', 'PUT', { status: 'completed' }));
        expect(window.showWorkoutSessionModal).not.toHaveBeenCalled();
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

// med-soo0.5: listSessions stamps pr_count per session from one oldest-first
// fold (the stats pr_count rule), so the Timeline chip never disagrees with
// the Stats total.
describe('listSessions pr_count (cloud shim)', () => {
    it('counts a new heaviest confirmed weight per session; a flagged outlier never counts', async () => {
        const env = loadCloudShimFrontendEnv({ wrapApiCallDirect: true });
        try {
            const { window } = env;
            const ids = [];
            // 20, 20, 20, then a 255 slip (flagged), then 45 and 50 kg.
            for (const [daysAgo, kg] of [[9, 20], [8, 20], [7, 20], [6, 255], [5, 45], [4, 50]]) {
                const session = (await window.apiCall('/api/workout/sessions/adhoc', 'POST')).session;
                await window.apiCall('/api/workout/sessions/logs/create', 'POST', {
                    session_id: session.id, exercise_id: 999, exercise_name: 'Back Squat',
                    source: 'library', status: 'completed', sets: [{ weight_kg: kg, reps: 8 }],
                });
                await window.apiCall(`/api/workout/sessions/status?id=${session.id}`, 'PUT', { status: 'completed' });
                const backdated = new Date(Date.now() - daysAgo * 86400000).toISOString();
                for (const rec of await env.records.list('workoutsession')) {
                    if (rec.id === session.id) await env.records.put('workoutsession', { ...rec, scheduled_date: backdated });
                }
                ids.push(session.id);
            }
            const rows = await window.apiCallDirect('/api/workout/sessions');
            const byId = new Map(rows.map((r) => [r.session.id, r.pr_count]));
            expect(ids.map((id) => byId.get(id))).toEqual([1, 0, 0, 0, 1, 1]);
            const stats = await window.apiCallDirect('/api/workout/stats');
            expect(stats.totals.pr_count).toBe(rows.reduce((n, r) => n + r.pr_count, 0));
        } finally {
            env.cleanup();
        }
    });
});
