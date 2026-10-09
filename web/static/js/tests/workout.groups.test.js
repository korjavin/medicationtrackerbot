// Wandergeek Workouts Plans sub-tab.
//
// Exercises `_renderWorkoutGroups`: one tappable kit `.wg-row` per plan
// (name, days · time · exercise count meta, a Rotating tag, an Inactive chip)
// with no per-row action strip — a tap opens the Plan page (med-xso6.22),
// which carries Share / Print / Scan / Delete. "Add plan" sits in the Train
// app bar; the tab itself keeps a single "Import plan" button.

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

describe('Workouts groups (Phase 7, Task 5)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv({ withWorkout: true });
    });

    afterEach(() => {
        try { env.window.localStorage.clear(); } catch (_) { /* ignore */ }
        env.cleanup();
        env = null;
    });

    it('renders the empty state when no groups are present', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-groups-list');
        window._renderWorkoutGroups(container, []);

        expect(container.textContent).toMatch(/No plans yet/);
        expect(container.querySelector('.wg-row')).toBeNull();
    });

    it('renders one kit row per plan with name and days · time · count meta', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-groups-list');
        window._renderWorkoutGroups(container, [makeGroup()]);

        const row = container.querySelector('.wg-list > .wg-row.wg-workout-plan-row');
        expect(row).not.toBeNull();
        expect(row.tagName).toBe('BUTTON');
        expect(row.querySelector('.wg-row__title').textContent).toBe('Push Day');
        expect(row.querySelector('.wg-row__meta').textContent).toBe('Mon, Wed, Fri · 09:00 · 6 exercises');
        expect(row.querySelector('.wg-row__chev')).not.toBeNull();
    });

    it('shows a Rotating tag when the group is_rotating', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-groups-list');
        window._renderWorkoutGroups(container, [makeGroup({ is_rotating: true })]);

        const tag = container.querySelector('.wg-row__meta .wg-tag');
        expect(tag).not.toBeNull();
        expect(tag.textContent).toBe('Rotating');
    });

    it('shows an Inactive chip when active is false', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-groups-list');
        window._renderWorkoutGroups(container, [makeGroup({ active: false }), makeGroup({ id: 2 })]);

        const rows = container.querySelectorAll('.wg-workout-plan-row');
        expect(rows[0].textContent).toContain('Inactive');
        expect(rows[1].textContent).not.toContain('Inactive');
    });

    it('rows carry no action strip (no edit / delete / print / share buttons)', () => {
        const { window, document } = env;
        const container = document.getElementById('workout-groups-list');
        window._renderWorkoutGroups(container, [makeGroup()]);

        const row = container.querySelector('.wg-workout-plan-row');
        expect(row.querySelectorAll('button')).toHaveLength(0);
        expect(container.querySelectorAll('button')).toHaveLength(1);
    });

    it('tapping a row opens that plan\'s page', async () => {
        const { window, document } = env;
        window.apiCall = vi.fn(async () => []);
        const container = document.getElementById('workout-groups-list');
        window._renderWorkoutGroups(container, [makeGroup({ id: 42, name: 'Legs' })]);

        container.querySelector('.wg-workout-plan-row').click();
        await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).not.toBeNull());

        expect(window.WorkoutEdit.planDraft.groupId).toBe(42);
        expect(document.getElementById('workout-group-name').value).toBe('Legs');
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

    it('Add plan sits in the Train app bar (Plans tab only); the tab keeps one Import plan button', async () => {
        const { window, document } = env;
        const add = document.getElementById('add-workout-group-btn');
        expect(add).not.toBeNull();
        expect(add.classList.contains('wg-btn--primary')).toBe(true);
        expect(document.getElementById('import-workout-plan-btn')).not.toBeNull();
        expect(document.querySelector('.wg-workouts-groups__add-cta')).toBeNull();

        window.apiCall = vi.fn(async () => []);
        add.click();
        await vi.waitFor(() => expect(window.WorkoutEdit.planDraft).not.toBeNull());
        expect(window.WorkoutEdit.planDraft.groupId).toBeNull();
    });
});
