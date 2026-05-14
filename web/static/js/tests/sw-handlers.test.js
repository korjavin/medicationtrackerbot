// Integration tests for the rewritten SW notification-action handlers.
// Task 3 of the SW handler unification plan: every handleX function now
// routes its POST through self.swApiCall (auth-aware) and, on failure,
// enqueues an action via self.SwApi.enqueueFailedAction instead of
// dropping the error. The post-success client.postMessage notifications
// (`MEDICATION_CONFIRMED`, `WORKOUT_SKIPPED`, …) must NOT fire when the
// network call fails — only on success.
//
// We drive each handler through the SW's notificationclick listener
// (the real entry point) so the test exercises the same dispatch table
// that production uses. swApiCall is mocked at the self.* level.
//
// See docs/plans/2026-05-13-sw-handler-unification.md, Task 3.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { allowConsoleNoise } from './helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SW_PATH = path.resolve(REPO_ROOT, 'web/static/sw.js');
const SW_SOURCE = fs.readFileSync(SW_PATH, 'utf-8');

function loadServiceWorker() {
    const listeners = new Map();
    const postedClients = [{ postMessage: vi.fn() }];
    const swSelf = {
        addEventListener: vi.fn((type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        }),
        clients: {
            matchAll: vi.fn().mockResolvedValue(postedClients),
            claim: vi.fn(),
            openWindow: vi.fn().mockResolvedValue(undefined),
        },
        registration: {
            showNotification: vi.fn().mockResolvedValue(undefined),
            getNotifications: vi.fn().mockResolvedValue([]),
        },
        location: { origin: 'https://test.com' },
        skipWaiting: vi.fn(),
    };
    swSelf.swApiCall = vi.fn().mockResolvedValue(true);
    swSelf.SwApi = {
        authToken: null,
        call: swSelf.swApiCall,
        enqueueFailedAction: vi.fn().mockResolvedValue(true),
    };

    const fakeCacheInstance = {
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        addAll: vi.fn().mockResolvedValue(undefined),
    };
    const fakeCaches = {
        open: vi.fn().mockResolvedValue(fakeCacheInstance),
        match: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
    };
    const fakeFetch = vi.fn();
    // importScripts in tests is a no-op: we have already installed mock
    // swApiCall/SwApi on swSelf, so loading sw-api-helper.js would just
    // overwrite our mocks.
    const importScripts = () => {};

    // 'clients' is referenced bare in some openWindow paths inside the
    // notificationclick listener — provide it as a global within the
    // sandbox so those branches don't ReferenceError when they fire.
    // eslint-disable-next-line no-new-func
    const runSw = new Function(
        'self', 'caches', 'fetch', 'importScripts', 'clients',
        SW_SOURCE
    );
    runSw(swSelf, fakeCaches, fakeFetch, importScripts, swSelf.clients);

    const clickHandlers = listeners.get('notificationclick') || [];
    expect(clickHandlers.length).toBeGreaterThan(0);
    const onClick = clickHandlers[0];

    function fireClick({ action, data }) {
        const work = [];
        const event = {
            action,
            notification: {
                close: vi.fn(),
                title: 'Med Tracker',
                body: 'do something',
                data,
            },
            waitUntil(promise) { work.push(promise); },
        };
        onClick(event);
        return Promise.allSettled(work);
    }

    return { swSelf, fireClick, postedClient: postedClients[0] };
}

describe('sw.js — notification-action handlers (Task 3)', () => {
    beforeEach(() => {
        allowConsoleNoise();
    });

    // ---------- Medication: confirm-all ----------

    it('handleMedicationConfirm — happy path: posts to confirm-schedule and notifies clients', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        await fireClick({
            action: 'confirm_all',
            data: {
                type: 'medication',
                scheduled_at: '2026-05-13T08:00:00Z',
                medication_ids: [1, 2],
                intake_ids: [10, 11],
            },
        });

        expect(swSelf.swApiCall).toHaveBeenCalledWith(
            '/api/medications/confirm-schedule',
            'POST',
            {
                scheduled_at: '2026-05-13T08:00:00Z',
                medication_ids: [1, 2],
                intake_ids: [10, 11],
            }
        );
        expect(postedClient.postMessage).toHaveBeenCalledWith({ type: 'MEDICATION_CONFIRMED' });
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleMedicationConfirm — failure path: enqueues and does NOT notify clients', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(Object.assign(new Error('401'), { status: 401 }));

        await fireClick({
            action: 'confirm_all',
            data: {
                type: 'medication',
                scheduled_at: '2026-05-13T08:00:00Z',
                medication_ids: [3],
                intake_ids: [42],
            },
        });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/medications/confirm-schedule',
            method: 'POST',
            body: {
                scheduled_at: '2026-05-13T08:00:00Z',
                medication_ids: [3],
                intake_ids: [42],
            },
        });
        expect(postedClient.postMessage).not.toHaveBeenCalled();
    });

    // ---------- Medication: skip (individual) ----------

    it('handleMedicationSkip — happy path: posts intake_id and notifies clients', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        await fireClick({
            action: 'skip_7',
            data: { type: 'medication_individual', intake_id: 7 },
        });

        expect(swSelf.swApiCall).toHaveBeenCalledWith(
            '/api/medications/skip',
            'POST',
            { intake_id: 7 }
        );
        expect(postedClient.postMessage).toHaveBeenCalledWith({ type: 'MEDICATION_SKIPPED' });
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleMedicationSkip — failure path: enqueues and does NOT notify clients', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(new Error('offline'));

        await fireClick({
            action: 'skip_7',
            data: { type: 'medication_individual', intake_id: 7 },
        });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/medications/skip',
            method: 'POST',
            body: { intake_id: 7 },
        });
        expect(postedClient.postMessage).not.toHaveBeenCalled();
    });

    // ---------- Medication: server snooze ----------

    it('handleMedicationServerSnooze — happy path', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        await fireClick({
            action: 'snooze',
            data: { type: 'medication_individual', intake_id: 9 },
        });

        expect(swSelf.swApiCall).toHaveBeenCalledWith(
            '/api/medications/snooze',
            'POST',
            { intake_id: 9, duration_minutes: 10 }
        );
        expect(postedClient.postMessage).toHaveBeenCalledWith({ type: 'MEDICATION_SNOOZED' });
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleMedicationServerSnooze — failure path enqueues', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(new Error('500'));
        await fireClick({
            action: 'snooze',
            data: { type: 'medication_individual', intake_id: 9 },
        });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/medications/snooze',
            method: 'POST',
            body: { intake_id: 9, duration_minutes: 10 },
        });
        expect(postedClient.postMessage).not.toHaveBeenCalled();
    });

    // ---------- Cancel intake ----------

    it('handleCancelIntake — happy path: posts intake_ids, shows confirmation, notifies clients', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        await fireClick({
            action: 'cancel_intake',
            data: { type: 'medication_early_confirmed', intake_ids: [55, 56] },
        });

        expect(swSelf.swApiCall).toHaveBeenCalledWith(
            '/api/medications/cancel-intake',
            'POST',
            { intake_ids: [55, 56] }
        );
        expect(swSelf.registration.showNotification).toHaveBeenCalledWith(
            'Intake Cancelled',
            expect.objectContaining({ tag: 'intake-cancelled' })
        );
        expect(postedClient.postMessage).toHaveBeenCalledWith({ type: 'INTAKE_CANCELLED' });
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleCancelIntake — failure path: enqueues and does NOT post INTAKE_CANCELLED', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(new Error('boom'));
        await fireClick({
            action: 'cancel_intake',
            data: { type: 'medication_early_confirmed', intake_ids: [55, 56] },
        });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/medications/cancel-intake',
            method: 'POST',
            body: { intake_ids: [55, 56] },
        });
        expect(postedClient.postMessage).not.toHaveBeenCalled();
    });

    // ---------- BP reminder ----------

    it('handleBPSnooze — happy path: POSTs with no body', async () => {
        const { swSelf, fireClick } = loadServiceWorker();
        await fireClick({ action: 'bp_snooze', data: { type: 'bp_reminder' } });

        expect(swSelf.swApiCall).toHaveBeenCalledWith('/api/bp/reminder/snooze', 'POST');
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleBPDontBug — failure path enqueues with null body', async () => {
        const { swSelf, fireClick } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(new Error('401'));
        await fireClick({ action: 'bp_dontbug', data: { type: 'bp_reminder' } });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/bp/reminder/dontbug',
            method: 'POST',
            body: null,
        });
    });

    // ---------- Weight reminder ----------

    it('handleWeightSnooze — happy path: POSTs with no body', async () => {
        const { swSelf, fireClick } = loadServiceWorker();
        await fireClick({ action: 'weight_snooze', data: { type: 'weight_reminder' } });

        expect(swSelf.swApiCall).toHaveBeenCalledWith('/api/weight/reminder/snooze', 'POST');
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleWeightDontBug — failure path enqueues with null body', async () => {
        const { swSelf, fireClick } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(new Error('500'));
        await fireClick({ action: 'weight_dontbug', data: { type: 'weight_reminder' } });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/weight/reminder/dontbug',
            method: 'POST',
            body: null,
        });
    });

    // ---------- Workout ----------

    it('handleWorkoutSnooze — happy path: posts minutes body and notifies clients', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        await fireClick({
            action: 'snooze_1h',
            data: { type: 'workout', session_id: 100 },
        });

        expect(swSelf.swApiCall).toHaveBeenCalledWith(
            '/api/workout/sessions/100/snooze',
            'POST',
            { minutes: 60 }
        );
        expect(postedClient.postMessage).toHaveBeenCalledWith({ type: 'WORKOUT_SNOOZED' });
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleWorkoutSkip — failure path enqueues and does NOT post WORKOUT_SKIPPED', async () => {
        const { swSelf, fireClick, postedClient } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(new Error('offline'));
        await fireClick({
            action: 'workout_skip',
            data: { type: 'workout', session_id: 100 },
        });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/workout/sessions/100/skip',
            method: 'POST',
            body: null,
        });
        expect(postedClient.postMessage).not.toHaveBeenCalled();
    });

    // ---------- TZ plan ----------

    it('handleTZPlanAction — happy path: POSTs and shows success notification', async () => {
        const { swSelf, fireClick } = loadServiceWorker();
        await fireClick({
            action: 'tz_plan_approve:plan_42',
            data: { type: 'tz_plan', plan_id: 42 },
        });

        expect(swSelf.swApiCall).toHaveBeenCalledWith(
            '/api/tz-plan/42/approve',
            'POST'
        );
        expect(swSelf.registration.showNotification).toHaveBeenCalledWith(
            'Timezone Plan Approved',
            expect.objectContaining({ tag: 'tz_plan_result' })
        );
        expect(swSelf.SwApi.enqueueFailedAction).not.toHaveBeenCalled();
    });

    it('handleTZPlanAction — failure path: enqueues and shows failure notification', async () => {
        const { swSelf, fireClick } = loadServiceWorker();
        swSelf.swApiCall.mockRejectedValueOnce(new Error('500'));
        await fireClick({
            action: 'tz_plan_reject:plan_42',
            data: { type: 'tz_plan', plan_id: 42 },
        });

        expect(swSelf.SwApi.enqueueFailedAction).toHaveBeenCalledWith({
            endpoint: '/api/tz-plan/42/reject',
            method: 'POST',
            body: null,
        });
        expect(swSelf.registration.showNotification).toHaveBeenCalledWith(
            'Timezone Plan Action Failed',
            expect.objectContaining({ tag: 'tz_plan_result' })
        );
    });

    // ---------- No leftover direct fetch in handler bodies ----------

    it('handlers contain no direct fetch() — they all route through swApiCall', () => {
        // Locate the handler region (`handleTZPlanAction` onward) and
        // assert no `await fetch(` remains in the rewritten code.
        const handlerRegion = SW_SOURCE.slice(SW_SOURCE.indexOf('async function handleTZPlanAction'));
        expect(handlerRegion).not.toMatch(/await\s+fetch\s*\(/);
        expect(handlerRegion).not.toMatch(/console\.error/);
    });
});
