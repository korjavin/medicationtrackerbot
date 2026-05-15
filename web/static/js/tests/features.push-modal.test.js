// Integration tests for features/push-modal.js (Plan 2026-05-13-split-app-js.md, Task 4).
//
// The module collapses five module-level vars previously scattered in app.js
// (pendingMedConfirmIds, pendingMedConfirmScheduled, pendingWorkoutSessionId,
// pendingMedConfirmMode, pendingMedConfirmIntakeIds) into closure-private
// fields behind a small open/close API: openMedConfirm, openWorkoutStart,
// clear, plus getters used by app.js's confirm/skip/snooze handlers.
//
// The "at most one push modal pending at a time" invariant was implicit in
// the original code (it held only because ModalManager closes one modal when
// another opens). These tests pin it down explicitly: opening a med modal
// clears any pending workout sessionId, opening a workout modal clears the
// med fields, and clear() resets every field.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFrontendEnv } from './helpers/frontend-harness.js';

describe('features/push-modal.js — PushModalState (Plan 2026-05-13, Task 4)', () => {
    let env;

    beforeEach(() => {
        env = loadFrontendEnv();
        env.window.PushModalState._resetForTesting();
    });

    afterEach(() => {
        env.cleanup();
        env = null;
    });

    it('exposes the PushModalState public surface on window', () => {
        const { window } = env;
        expect(typeof window.PushModalState).toBe('object');
        expect(typeof window.PushModalState.openMedConfirm).toBe('function');
        expect(typeof window.PushModalState.openWorkoutStart).toBe('function');
        expect(typeof window.PushModalState.clear).toBe('function');
        expect(typeof window.PushModalState.getMedConfirmIds).toBe('function');
        expect(typeof window.PushModalState.getMedConfirmScheduled).toBe('function');
        expect(typeof window.PushModalState.getMedConfirmMode).toBe('function');
        expect(typeof window.PushModalState.getMedConfirmIntakeIds).toBe('function');
        expect(typeof window.PushModalState.getWorkoutSessionId).toBe('function');
    });

    it('defaults: empty arrays, null scheduled, null sessionId, mode=confirm', () => {
        const { window } = env;
        expect(window.PushModalState.getMedConfirmIds()).toEqual([]);
        expect(window.PushModalState.getMedConfirmIntakeIds()).toEqual([]);
        expect(window.PushModalState.getMedConfirmScheduled()).toBeNull();
        expect(window.PushModalState.getMedConfirmMode()).toBe('confirm');
        expect(window.PushModalState.getWorkoutSessionId()).toBeNull();
    });

    it('openMedConfirm stores ids/scheduled/mode/intakeIds and defaults missing fields', () => {
        const { window } = env;
        window.PushModalState.openMedConfirm({
            ids: [10, 20],
            scheduled: '2026-02-27T10:00:00Z',
            mode: 'edit',
            intakeIds: [100, 200],
        });
        expect(window.PushModalState.getMedConfirmIds()).toEqual([10, 20]);
        expect(window.PushModalState.getMedConfirmScheduled()).toBe('2026-02-27T10:00:00Z');
        expect(window.PushModalState.getMedConfirmMode()).toBe('edit');
        expect(window.PushModalState.getMedConfirmIntakeIds()).toEqual([100, 200]);

        window.PushModalState.openMedConfirm({ ids: [1] });
        expect(window.PushModalState.getMedConfirmIds()).toEqual([1]);
        expect(window.PushModalState.getMedConfirmScheduled()).toBeNull();
        expect(window.PushModalState.getMedConfirmMode()).toBe('confirm');
        expect(window.PushModalState.getMedConfirmIntakeIds()).toEqual([]);
    });

    it('openMedConfirm clones the ids/intakeIds arrays so the caller cannot mutate state by reference', () => {
        const { window } = env;
        const ids = [1, 2, 3];
        const intakeIds = [10, 20, 30];
        window.PushModalState.openMedConfirm({
            ids,
            scheduled: '2026-02-27T10:00:00Z',
            mode: 'confirm',
            intakeIds,
        });
        ids.push(4);
        intakeIds.push(40);
        expect(window.PushModalState.getMedConfirmIds()).toEqual([1, 2, 3]);
        expect(window.PushModalState.getMedConfirmIntakeIds()).toEqual([10, 20, 30]);
    });

    it('openWorkoutStart stores sessionId', () => {
        const { window } = env;
        window.PushModalState.openWorkoutStart({ sessionId: 'sess-42' });
        expect(window.PushModalState.getWorkoutSessionId()).toBe('sess-42');
    });

    it('openMedConfirm clears any pending workout sessionId', () => {
        const { window } = env;
        // Workout modal pending → user taps med push → workout state must clear
        // so a stale snooze/skip click after switching modals cannot fire
        // against the old session.
        window.PushModalState.openWorkoutStart({ sessionId: 'sess-1' });
        window.PushModalState.openMedConfirm({
            ids: [7],
            scheduled: '2026-02-27T10:00:00Z',
            mode: 'confirm',
            intakeIds: [],
        });
        expect(window.PushModalState.getWorkoutSessionId()).toBeNull();
        expect(window.PushModalState.getMedConfirmIds()).toEqual([7]);
    });

    it('openWorkoutStart clears any pending medication fields', () => {
        const { window } = env;
        window.PushModalState.openMedConfirm({
            ids: [9, 11],
            scheduled: '2026-02-27T10:00:00Z',
            mode: 'edit',
            intakeIds: [90, 110],
        });
        window.PushModalState.openWorkoutStart({ sessionId: 'sess-7' });
        expect(window.PushModalState.getWorkoutSessionId()).toBe('sess-7');
        expect(window.PushModalState.getMedConfirmIds()).toEqual([]);
        expect(window.PushModalState.getMedConfirmIntakeIds()).toEqual([]);
        expect(window.PushModalState.getMedConfirmScheduled()).toBeNull();
        expect(window.PushModalState.getMedConfirmMode()).toBe('confirm');
    });

    it('clear() resets every field back to defaults', () => {
        const { window } = env;
        window.PushModalState.openMedConfirm({
            ids: [1, 2],
            scheduled: '2026-02-27T10:00:00Z',
            mode: 'edit',
            intakeIds: [10, 20],
        });
        // Also flip workout sessionId so we know clear() reaches both clusters.
        window.PushModalState.openWorkoutStart({ sessionId: 'sess-99' });

        window.PushModalState.clear();

        expect(window.PushModalState.getMedConfirmIds()).toEqual([]);
        expect(window.PushModalState.getMedConfirmIntakeIds()).toEqual([]);
        expect(window.PushModalState.getMedConfirmScheduled()).toBeNull();
        expect(window.PushModalState.getMedConfirmMode()).toBe('confirm');
        expect(window.PushModalState.getWorkoutSessionId()).toBeNull();
    });

    it('showMedicationConfirmModal delegates to PushModalState.openMedConfirm', () => {
        const { window } = env;
        window.showMedicationConfirmModal(
            [5, 6],
            ['Med A', 'Med B'],
            '2026-02-27T11:00:00Z',
            'confirm',
            [50, 60]
        );
        expect(window.PushModalState.getMedConfirmIds()).toEqual([5, 6]);
        expect(window.PushModalState.getMedConfirmScheduled()).toBe('2026-02-27T11:00:00Z');
        expect(window.PushModalState.getMedConfirmMode()).toBe('confirm');
        expect(window.PushModalState.getMedConfirmIntakeIds()).toEqual([50, 60]);
    });

    it('showWorkoutStartModal delegates to PushModalState.openWorkoutStart', () => {
        const { window } = env;
        window.showWorkoutStartModal('sess-abc');
        expect(window.PushModalState.getWorkoutSessionId()).toBe('sess-abc');
    });

    it('snoozeWorkout / skipWorkout no-op when no sessionId is pending', async () => {
        const { window } = env;
        // No openWorkoutStart called → sessionId is null → both should bail out
        // before touching the network.
        let called = 0;
        window.apiCall = async () => { called += 1; return { ok: true }; };

        await window.snoozeWorkout(10);
        await window.skipWorkout();

        expect(called).toBe(0);
    });
});
