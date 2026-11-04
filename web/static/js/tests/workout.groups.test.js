// Wandergeek Workouts Plans sub-tab (med-jqrf.2, kit screens-plans PL1/PL4/PL5).
//
// Exercises `_renderWorkoutGroups` over the GET /api/workout/plans payload:
// one `.wg-plan-card` per active plan (eyebrow, schedule line, every day with
// its count, last date and a Next tag, Share or print + Edit plan), a Paused
// list, the New plan / Import plan tail rows, and the PL5 empty state. Edit
// plan and a paused row open the Plan page (med-xso6.22), which ends with
// Delete. No "Add plan" sun in the Train app bar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

function makeGroup(overrides) {
    return {
        id: 1,
        name: 'Push Day',
        description: 'Chest + shoulders + triceps',
        is_rotating: false,
        days_of_week: '[1,3,5]',
        scheduled_time: '09:00',
        notification_advance_minutes: 15,
        active: true,
        exercises_count: 6,
        ...overrides
    };
}

const day = (id, name, extra) => ({ id, name, exercises_count: 3, last_completed_date: null, last_duration_min: null, is_next: false, ...extra });

// A /api/workout/plans entry (listPlans).
function makePlan(overrides) {
    return {
        id: 1, name: 'Bench 100', active: true, is_rotating: true, days_of_week: '[1,2,3,4,5,6]',
        scheduled_time: '18:00', training_goal: 'hypertrophy',
        next: { date: '2026-11-05', time: '18:00', variant_id: 11, session_id: 900 },
        days: [
            day(11, 'Chest & Triceps', { last_completed_date: '2026-10-26', is_next: true }),
            day(12, 'Back & Biceps', { last_completed_date: '2026-10-27' }),
            day(13, 'Quads & Calves', { last_completed_date: '2026-10-28' }),
            day(14, 'Upper Mix', { last_completed_date: '2026-10-29' }),
            day(15, 'Glutes, Hamstrings & Core', { exercises_count: 4, last_completed_date: '2026-10-30' }),
            day(16, 'Bench Technique & Shoulders', { last_completed_date: '2026-10-31' }),
            day(17, 'Upper Back & Grip', { last_completed_date: '2026-11-02' }),
        ],
        exercises: [],
        ...overrides
    };
}

const MOBILITY = makePlan({
    id: 2, name: 'Morning mobility', is_rotating: false, days_of_week: '[0,1,2,3,4,5,6]', scheduled_time: '07:30',
    next: { date: '2026-11-05', time: '07:30', variant_id: 21, session_id: 901 },
    days: [day(21, 'Morning mobility')],
    exercises: [
        { id: 1, exercise_name: 'Hip flexor stretch', target_sets: 2, target_reps_min: 30 },
        { id: 2, exercise_name: 'Cat–cow', target_sets: 2, target_reps_min: 10 },
        { id: 3, exercise_name: 'Bench press', target_sets: 3, target_reps_min: 8, target_reps_max: 12, target_weight_kg: 60 },
    ],
});

const PAUSED = makePlan({
    id: 3, name: 'Summer cut', active: false, next: null,
    days: [day(31, 'A', { last_completed_date: '2026-08-14' }), day(32, 'B', { last_completed_date: '2026-08-10' }), day(33, 'C')],
});

describe('Workouts groups (Phase 7, Task 5)', () => {
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

    const render = (plans) => {
        const container = env.document.getElementById('workout-groups-list');
        env.window._renderWorkoutGroups(container, { plans, active_session_id: null });
        return container;
    };
    const titles = (root) => Array.from(root.querySelectorAll('.wg-row__title')).map((t) => t.textContent);
    const metas = (root) => Array.from(root.querySelectorAll('.wg-row__meta')).map((t) => t.textContent);

    it('PL1: one active plan, every day with count, last date and a Next tag; Paused list; New / Import rows', () => {
        const c = render([makePlan(), PAUSED]);
        const cards = c.querySelectorAll('.wg-plan-card');
        expect(cards).toHaveLength(1);
        const card = cards[0];
        expect(card.querySelector('.wg-eyebrow').textContent).toBe('Current plan');
        expect(card.querySelector('.wg-card__title').textContent).toBe('Bench 100');
        expect(card.querySelector('.wg-pl__head .wg-meta').textContent).toBe('Mon–Sat at 18:00 · Muscle · 7-day rotation');
        const days = card.querySelector('.wg-pl__days');
        expect(titles(days)).toHaveLength(7);
        expect(metas(days)[0]).toBe('3 exercises · last Mon 26.10');
        expect(metas(days)[6]).toBe('3 exercises · last Mon 02.11');
        expect(Array.from(days.querySelectorAll('.wg-tag')).map((t) => t.closest('.wg-row').querySelector('.wg-row__title').textContent)).toEqual(['Chest & Triceps']);
        expect(card.querySelector('.wg-tl-more')).toBeNull();
        // Day rows open the day page (PL2, med-jqrf.3).
        expect(days.querySelectorAll('button.wg-row')).toHaveLength(7);
        expect(Array.from(card.querySelectorAll('.wg-card__foot .wg-btn')).map((b) => b.textContent)).toEqual(['Share or print', 'Edit plan']);
        // No sun anywhere on the tab, and none in the Train app bar.
        expect(c.querySelector('.wg-btn--primary')).toBeNull();
        expect(env.document.querySelector('#workouts-view .wg-appbar .wg-btn--primary')).toBeNull();

        const paused = c.querySelector('.wg-plan-paused');
        expect(paused.querySelector('.wg-eyebrow').textContent).toBe('Paused');
        expect(titles(paused)).toEqual(['Summer cut']);
        expect(metas(paused)).toEqual(['3 days · last used 14.08']);
        expect(paused.querySelector('.wg-chip').textContent).toBe('Paused');

        const tail = c.querySelector('.wg-plan-tail');
        expect(c.lastElementChild).toBe(tail);
        expect(titles(tail)).toEqual(['New plan', 'Import plan']);
        expect(metas(tail)).toEqual(['Days, exercises, schedule', 'From a shared link or QR code']);
    });

    it('PL1: day rows open the day page once it exists', () => {
        env.window.openWorkoutPlanDayPage = vi.fn();
        const plan = makePlan();
        const c = render([plan]);
        const row = c.querySelector('.wg-pl__days button.wg-row');
        expect(row).not.toBeNull();
        row.click();
        expect(env.window.openWorkoutPlanDayPage).toHaveBeenCalledWith(plan, plan.days[0]);
    });

    it('PL4: two active plans in payload order with "Next · …" eyebrows; a flat plan lists exercises; a long rotation folds', () => {
        const bench = makePlan();
        const c = render([{ ...MOBILITY, next: { ...MOBILITY.next, date: '2026-11-04', days_away: 0 } }, { ...bench, next: { ...bench.next, date: '2026-11-12', days_away: 8 } }]);
        const cards = c.querySelectorAll('.wg-plan-card');
        expect(Array.from(cards).map((x) => x.querySelector('.wg-card__title').textContent)).toEqual(['Morning mobility', 'Bench 100']);
        expect(cards[0].querySelector('.wg-eyebrow').textContent).toBe('Next · today 07:30');
        expect(cards[1].querySelector('.wg-eyebrow').textContent).toBe('Next · Thu 18:00');

        expect(cards[0].querySelector('.wg-pl__head .wg-meta').textContent).toBe('Every day at 07:30 · 3 exercises');
        expect(titles(cards[0])).toEqual(['Hip flexor stretch', 'Cat–cow', 'Bench press']);
        expect(metas(cards[0])).toEqual(['2 × 30', '2 × 10', '3 × 8–12 · 60 kg']);

        expect(titles(cards[1].querySelector('.wg-pl__days'))).toHaveLength(4);
        const more = cards[1].querySelector('.wg-tl-more');
        expect(more.textContent).toBe('All 7 days');
        more.click();
        expect(titles(cards[1].querySelector('.wg-pl__days'))).toHaveLength(7);
        expect(cards[1].querySelector('.wg-tl-more')).toBeNull();
    });

    // Argus P2: "today / tomorrow" is the domain's days_away (workout
    // timezone), not the device calendar: a device already on 11-04 still
    // reads a 11-04 slot as "tomorrow" when the workout zone is a day behind.
    it('PL4: "tomorrow" comes from next.days_away, not the device calendar', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 10, 4, 0, 30));
        const c = render([{ ...MOBILITY, next: { ...MOBILITY.next, date: '2026-11-04', days_away: 1 } }, makePlan()]);
        expect(c.querySelector('.wg-plan-card .wg-eyebrow').textContent).toBe('Next · tomorrow 07:30');
    });

    it('PL5: no active plan shows the empty state with Make a plan as the only sun, the Paused list under it, no tail rows', () => {
        let c = render([]);
        expect(c.querySelector('.wg-empty__title').textContent).toBe('No plan yet');
        expect(c.querySelector('.wg-empty__body').textContent).toBe('A plan is your workout days in order. The Timeline then tells you which one is next.');
        expect(Array.from(c.querySelectorAll('.wg-empty__acts .wg-btn')).map((b) => b.textContent)).toEqual(['Make a plan', 'Import plan']);
        expect(Array.from(c.querySelectorAll('.wg-btn--primary')).map((b) => b.textContent)).toEqual(['Make a plan']);
        expect(c.querySelector('.wg-plan-tail')).toBeNull();
        expect(c.querySelector('.wg-plan-paused')).toBeNull();

        c = render([PAUSED]);
        expect(c.querySelector('.wg-empty__title').textContent).toBe('No plan yet');
        expect(titles(c.querySelector('.wg-plan-paused'))).toEqual(['Summer cut']);
        expect(c.querySelector('.wg-plan-tail')).toBeNull();
    });

    it('a day never done reads "not done yet"', () => {
        const plan = makePlan({ days: [day(11, 'Push', { is_next: true }), day(12, 'Pull', { last_completed_date: '2026-10-27' })] });
        expect(metas(render([plan]).querySelector('.wg-pl__days'))).toEqual(['3 exercises · not done yet', '3 exercises · last Tue 27.10']);
    });

    it('a paused plan never done reads "never used"', () => {
        const c = render([{ ...PAUSED, days: [day(31, 'A')] }]);
        expect(metas(c.querySelector('.wg-plan-paused'))).toEqual(['1 day · never used']);
    });

    it('the schedule line collapses runs of three or more days and keeps the rest listed', () => {
        const line = (days_of_week) => render([makePlan({ days_of_week })]).querySelector('.wg-pl__head .wg-meta').textContent;
        expect(line('[1,3,5]')).toBe('Mon, Wed, Fri at 18:00 · Muscle · 7-day rotation');
        expect(line('[0,1,2,3,4,5,6]')).toBe('Every day at 18:00 · Muscle · 7-day rotation');
        expect(line('[0,1,2,3,5]')).toBe('Mon–Wed, Fri, Sun at 18:00 · Muscle · 7-day rotation');
        expect(line('[5,6,0]')).toBe('Fri–Sun at 18:00 · Muscle · 7-day rotation');
    });

    it('Edit plan and a paused row open that plan\'s page; New plan opens it empty', async () => {
        const { window } = env;
        window.apiCall = vi.fn(async (url) => (url === '/api/workout/groups'
            ? [makeGroup({ id: 1, name: 'Bench 100' }), makeGroup({ id: 3, name: 'Summer cut', active: false })]
            : []));
        const c = render([makePlan(), PAUSED]);

        c.querySelector('[data-action="edit-plan"]').click();
        await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).not.toBeNull());
        expect(window.WorkoutEdit.planDraft.groupId).toBe(1);
        expect(env.document.getElementById('workout-group-name').value).toBe('Bench 100');
        window.closeWorkoutPlanPage();
        await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).toBeNull());

        c.querySelector('.wg-plan-paused .wg-row').click();
        await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).not.toBeNull());
        expect(window.WorkoutEdit.planDraft.groupId).toBe(3);
        window.closeWorkoutPlanPage();
        await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).toBeNull());

        c.querySelector('[data-action="new-plan"]').click();
        await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).not.toBeNull());
        expect(window.WorkoutEdit.planDraft.groupId).toBeNull();
    });

    it('loadWorkoutGroups reads /api/workout/plans and empties the editor\'s group list', async () => {
        const { window } = env;
        window.WorkoutEdit.cachedGroups = [makeGroup({ name: 'Stale' })];
        window.apiCallDirect = vi.fn(async (url) => (url === '/api/workout/plans' ? { plans: [makePlan()], active_session_id: null } : null));
        await window.loadWorkoutGroups();
        const c = env.document.getElementById('workout-groups-list');
        await vi.waitFor(() => expect(c.querySelectorAll('.wg-plan-card')).toHaveLength(1));
        expect(window.apiCallDirect).toHaveBeenCalledWith('/api/workout/plans');
        expect(window.WorkoutEdit.cachedGroups).toEqual([]);
    });

    it('the Plan page Delete row confirms, closes the page and deletes optimistically', async () => {
        const { window, document } = env;
        window.WorkoutEdit.cachedGroups = [makeGroup({ id: 99 })];
        const apiSpy = vi.fn(async (url) => (String(url).startsWith('/api/workout/variants?') ? [] : true));
        window.apiCall = apiSpy;
        window.safeConfirm = vi.fn(async (_msg, cb) => { if (cb) await cb(true); return true; });
        window.loadWorkoutGroups = vi.fn();
        const commit = vi.fn();
        const rollback = vi.fn();
        window.DataStore.applyOptimistic = vi.fn(async () => ({ commit, rollback }));
        await window.openWorkoutPlanPage(99);

        document.getElementById('workout-group-delete-btn').click();
        await vi.waitFor(() => expect(window.loadWorkoutGroups).toHaveBeenCalled());

        expect(window.safeConfirm).toHaveBeenCalledTimes(1);
        expect(window.WorkoutEdit.planDraft).toBeNull();
        expect(apiSpy).toHaveBeenCalledWith(
            '/api/workout/groups/delete?id=99', 'DELETE', null, { suppressWriteAlert: true });
        expect(apiSpy.mock.calls.some((c) => String(c[0]).includes('cancel_sessions'))).toBe(false);
        expect(commit).toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
        expect(window.loadWorkoutGroups).toHaveBeenCalled();
    });
    // the count in a second confirm, and retries with the flag on accept.
    it('delete on a plan with open sessions confirms twice and retries with cancel_sessions', async () => {
        const { window } = env;
        const precondition = new Error('cannot delete group: it has 2 pending/active sessions');
        precondition.code = 'precondition_failed';
        precondition.openSessionCount = 2;
        const apiSpy = vi.fn(async (url) => {
            if (String(url).includes('cancel_sessions=true')) return true;
            throw precondition;
        });
        window.apiCall = apiSpy;
        const messages = [];
        window.safeConfirm = vi.fn(async (msg, cb) => { messages.push(msg); await cb(true); });
        window.loadWorkoutGroups = vi.fn();
        const commit = vi.fn();
        const rollback = vi.fn();
        window.DataStore.applyOptimistic = vi.fn(async () => ({ commit, rollback }));

        await window.deleteWorkoutGroup(99, { stopPropagation() {} });
        for (let i = 0; i < 24; i += 1) await Promise.resolve();

        expect(messages).toHaveLength(2);
        expect(messages[0]).toBe('Delete this plan?');
        expect(messages[1]).toBe('This plan has 2 pending/active sessions. Cancel them and delete the plan?');
        expect(apiSpy).toHaveBeenCalledWith(
            '/api/workout/groups/delete?id=99', 'DELETE', null, { suppressWriteAlert: true });
        expect(apiSpy).toHaveBeenCalledWith(
            '/api/workout/groups/delete?id=99&cancel_sessions=true', 'DELETE', null, { suppressWriteAlert: true });
        expect(rollback).toHaveBeenCalled();
        expect(commit).toHaveBeenCalled();
        expect(window.loadWorkoutGroups).toHaveBeenCalled();
    });

    // Round-1 review: a swallowed failure (offline/5xx/legacy 4xx → null)
    // must still explain itself — the delete's suppressWriteAlert silenced
    // apiCall's own toast — and leave the plan listed.
    it('a null delete result alerts and leaves the plan intact', async () => {
        const { window } = env;
        const apiSpy = vi.fn(async () => null);
        window.apiCall = apiSpy;
        window.safeConfirm = vi.fn(async (_msg, cb) => { await cb(true); });
        const alertSpy = vi.fn();
        window.safeAlert = alertSpy;
        window.loadWorkoutGroups = vi.fn();
        const commit = vi.fn();
        const rollback = vi.fn();
        window.DataStore.applyOptimistic = vi.fn(async () => ({ commit, rollback }));

        await window.deleteWorkoutGroup(99, { stopPropagation() {} });
        for (let i = 0; i < 24; i += 1) await Promise.resolve();

        expect(apiSpy).toHaveBeenCalledTimes(1);
        expect(alertSpy).toHaveBeenCalledWith("Couldn't delete the plan — try again online.");
        expect(commit).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalled();
        expect(window.loadWorkoutGroups).not.toHaveBeenCalled();
    });

    // bd med-qop3: declining the second confirm leaves the plan intact — no
    // retry, no reload, optimistic row rolled back.
    it('declining the cancel-sessions confirm leaves the plan intact', async () => {
        const { window } = env;
        const precondition = new Error('cannot delete group: it has 1 pending/active sessions');
        precondition.code = 'precondition_failed';
        precondition.openSessionCount = 1;
        const apiSpy = vi.fn(async () => { throw precondition; });
        window.apiCall = apiSpy;
        const messages = [];
        window.safeConfirm = vi.fn(async (msg, cb) => {
            messages.push(msg);
            await cb(messages.length === 1);
        });
        window.loadWorkoutGroups = vi.fn();
        const commit = vi.fn();
        const rollback = vi.fn();
        window.DataStore.applyOptimistic = vi.fn(async () => ({ commit, rollback }));

        await window.deleteWorkoutGroup(99, { stopPropagation() {} });
        for (let i = 0; i < 24; i += 1) await Promise.resolve();

        expect(messages).toHaveLength(2);
        expect(messages[1]).toBe('This plan has 1 pending/active session. Cancel them and delete the plan?');
        expect(apiSpy).toHaveBeenCalledTimes(1);
        expect(commit).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalled();
        expect(window.loadWorkoutGroups).not.toHaveBeenCalled();
    });

});
