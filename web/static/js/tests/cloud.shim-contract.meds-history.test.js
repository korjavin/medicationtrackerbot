// Plan 2026-07-05 cloud-c2b, Task 8 — shim-mode contract run of the intake
// state machine (web/domain/medintake.js) and the reminder-horizon
// compute-and-upload loop (web/domain/reminders.js + web/cloud/js/
// reminders.js). Drives the real /api/medications/* + /api/intakes/update
// contract through window.apiCall, which routes to the cloud shim
// (web/cloud/js/apishim.js) instead of the network — same pattern as
// cloud.shim-contract.bp.test.js. This suite asserts the domain contract
// (statuses, inventory side effects, idempotency), not the DOM/optimistic-
// cache wiring already covered by the unshimmed features.meds.test.js.
import {
    afterEach, beforeEach, describe, expect, it, vi
} from 'vitest';
import { loadCloudShimFrontendEnv } from './helpers/cloud-shim-harness.js';

vi.mock('../../../cloud/js/push.js', () => ({ pushSchedule: vi.fn() }));
// eslint-disable-next-line import/first
import { pushSchedule } from '../../../cloud/js/push.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function seedMedication(overrides = {}) {
    return {
        recordId: 1,
        clientTs: Date.now(),
        deleted: false,
        name: 'Metformin',
        dosage: '500mg',
        schedule: JSON.stringify({ type: 'as_needed' }),
        archived: false,
        supplement: false,
        start_date: null,
        end_date: null,
        rxcui: '',
        normalized_name: '',
        inventory_count: 5,
        tz_shift_policy: 'flexible',
        created_at: new Date().toISOString(),
        ...overrides
    };
}

function seedIntake(overrides = {}) {
    return {
        recordId: `intake-${Math.random()}`,
        clientTs: Date.now(),
        deleted: false,
        medication_id: 1,
        scheduled_at: new Date().toISOString(),
        taken_at: null,
        status: 'PENDING',
        snoozed_until: null,
        source: 'schedule',
        ...overrides
    };
}

describe('cloud shim contract — intake state machine (web/domain/medintake.js)', () => {
    let env;

    afterEach(() => {
        if (env) env.cleanup();
        env = null;
    });

    it('confirm-schedule (by intake_id) flips PENDING to TAKEN and decrements inventory once, idempotently', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'intake-1', medication_id: 1 })]
            }
        });
        const { window } = env;

        const res = await window.apiCall('/api/medications/confirm-schedule', 'POST', { intake_ids: ['intake-1'] });
        expect(res).toEqual({ status: 'confirmed' });

        let meds = await window.apiCall('/api/medications');
        expect(meds[0].inventory_count).toBe(4);

        let history = await window.apiCall('/api/history?days=0');
        expect(history[0].status).toBe('TAKEN');

        // Idempotency guard: re-confirming an already-TAKEN intake must not
        // double-decrement inventory (the "already confirmed" skip-the-decrement path).
        const res2 = await window.apiCall('/api/medications/confirm-schedule', 'POST', { intake_ids: ['intake-1'] });
        expect(res2).toEqual({ status: 'confirmed' });

        meds = await window.apiCall('/api/medications');
        expect(meds[0].inventory_count).toBe(4);
    });

    it('confirm-schedule with scheduled_at tells the relay to cancel that slot re-fire (med-eas.74)', async () => {
        // A dose confirmed in the app never taps Telegram, so the shim best-effort
        // POSTs /api/telegram/cancel-refire so the relay's server-owned nag chain
        // stops for the slot. Fire-and-forget on the global fetch.
        const slotIso = new Date(Date.UTC(2026, 6, 7, 8, 0, 0)).toISOString();
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ recordId: 1, inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'intake-1', medication_id: 1, scheduled_at: slotIso })]
            }
        });
        const { window } = env;
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        globalThis.fetch = fetchMock;
        try {
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slotIso, medication_ids: [1] });
            const slotUnix = Math.floor(Date.parse(slotIso) / 1000);
            expect(fetchMock).toHaveBeenCalledWith('/api/telegram/cancel-refire', expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ callback: `s:${slotUnix}` })
            }));
        } finally {
            delete globalThis.fetch;
        }
    });

    it('confirm-schedule of a SUBSET of a shared slot leaves the re-fire alive for the still-pending med (med-eas.74)', async () => {
        // Two meds due at the same instant; the user confirms only one. The
        // relay re-fire is keyed slot-wide ("s:<slotUnix>"), so cancelling it
        // would silence the reminder for the med still PENDING at that slot.
        const slotIso = new Date(Date.UTC(2026, 6, 7, 8, 0, 0)).toISOString();
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [
                    seedMedication({ recordId: 1, inventory_count: 5 }),
                    seedMedication({ recordId: 2, name: 'Aspirin', inventory_count: 5 })
                ],
                intake: [
                    seedIntake({ recordId: 'intake-1', medication_id: 1, scheduled_at: slotIso }),
                    seedIntake({ recordId: 'intake-2', medication_id: 2, scheduled_at: slotIso })
                ]
            }
        });
        const { window } = env;
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        globalThis.fetch = fetchMock;
        try {
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slotIso, medication_ids: [1] });
            expect(fetchMock).not.toHaveBeenCalledWith('/api/telegram/cancel-refire', expect.anything());

            // Confirming BOTH meds for the slot leaves nothing PENDING, so the
            // slot re-fire is cancelled.
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slotIso, medication_ids: [1, 2] });
            const slotUnix = Math.floor(Date.parse(slotIso) / 1000);
            expect(fetchMock).toHaveBeenCalledWith('/api/telegram/cancel-refire', expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ callback: `s:${slotUnix}` })
            }));
        } finally {
            delete globalThis.fetch;
        }
    });

    it('confirm-schedule by intake_id only (no scheduled_at) sends no cancel-refire POST', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ recordId: 1, inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'intake-1', medication_id: 1 })]
            }
        });
        const { window } = env;
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        globalThis.fetch = fetchMock;
        try {
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { intake_ids: ['intake-1'] });
            expect(fetchMock).not.toHaveBeenCalledWith('/api/telegram/cancel-refire', expect.anything());
        } finally {
            delete globalThis.fetch;
        }
    });

    it('skip flips PENDING to SKIPPED without touching inventory', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'intake-1', medication_id: 1 })]
            }
        });
        const { window } = env;

        const res = await window.apiCall('/api/medications/skip', 'POST', { intake_id: 'intake-1' });
        expect(res).toEqual({ status: 'skipped' });

        const meds = await window.apiCall('/api/medications');
        expect(meds[0].inventory_count).toBe(5);

        const history = await window.apiCall('/api/history?days=0');
        expect(history[0].status).toBe('SKIPPED');
    });

    it('log-past inserts a TAKEN record and decrements inventory', async () => {
        env = loadCloudShimFrontendEnv({ seedRecords: { medication: [seedMedication({ inventory_count: 5 })] } });
        const { window } = env;

        const takenAt = new Date().toISOString();
        const res = await window.apiCall('/api/medications/log-past', 'POST', { medication_id: 1, taken_at: takenAt });
        expect(res.status).toBe('TAKEN');
        expect(res.medication_id).toBe(1);

        const meds = await window.apiCall('/api/medications');
        expect(meds[0].inventory_count).toBe(4);
    });

    it('cancel-intake reverts a TAKEN intake back to PENDING and restores inventory', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'intake-1', medication_id: 1, status: 'TAKEN', taken_at: new Date().toISOString() })]
            }
        });
        const { window } = env;

        const res = await window.apiCall('/api/medications/cancel-intake', 'POST', { intake_ids: ['intake-1'] });
        expect(res).toEqual({ status: 'cancelled', cancelled_count: 1, requested_count: 1 });

        const meds = await window.apiCall('/api/medications');
        expect(meds[0].inventory_count).toBe(6);

        const history = await window.apiCall('/api/history?days=0');
        expect(history[0].status).toBe('PENDING');
    });

    it('delete-intake hard-deletes only a future PENDING intake, preserving past history', async () => {
        const future = new Date(Date.now() + DAY_MS).toISOString();
        const past = new Date(Date.now() - DAY_MS).toISOString();
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication()],
                intake: [
                    seedIntake({ recordId: 'future-1', medication_id: 1, scheduled_at: future, status: 'PENDING' }),
                    seedIntake({
                        recordId: 'past-1', medication_id: 1, scheduled_at: past, status: 'TAKEN', taken_at: past
                    })
                ]
            }
        });
        const { window } = env;

        const res = await window.apiCall('/api/medications/delete-intake', 'POST', { intake_ids: ['future-1', 'past-1'] });
        expect(res).toEqual({ status: 'deleted', deleted_count: 1, requested_count: 2 });

        const history = await window.apiCall('/api/history?days=3');
        expect(history.map((h) => h.id)).toEqual(['past-1']);
    });

    it('bulk update via /api/intakes/update reports per-row failures alongside successes', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'intake-1', medication_id: 1 })]
            }
        });
        const { window } = env;

        const res = await window.apiCall('/api/intakes/update', 'POST', {
            updates: [
                { id: 'intake-1', status: 'TAKEN', taken_at: new Date().toISOString() },
                { id: 'does-not-exist', status: 'TAKEN' }
            ]
        });

        expect(res.updated).toBe(1);
        expect(res.failed).toBe(1);
        expect(res.failures).toEqual([{ id: 'does-not-exist', reason: 'not_found_or_forbidden' }]);

        const meds = await window.apiCall('/api/medications');
        expect(meds[0].inventory_count).toBe(4);
    });

    it('history filters by med_id', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ recordId: 1 }), seedMedication({ recordId: 2, name: 'Lisinopril' })],
                intake: [
                    seedIntake({ recordId: 'i-1', medication_id: 1 }),
                    seedIntake({ recordId: 'i-2', medication_id: 2 })
                ]
            }
        });
        const { window } = env;

        const all = await window.apiCall('/api/history?days=0');
        expect(all).toHaveLength(2);

        const filtered = await window.apiCall('/api/history?days=0&med_id=2');
        expect(filtered).toHaveLength(1);
        expect(filtered[0].medication_id).toBe(2);
    });
});

describe('cloud shim contract — reminder horizon recompute-and-upload (web/domain/reminders.js)', () => {
    let env;

    beforeEach(() => {
        vi.useFakeTimers();
        pushSchedule.mockClear();
    });

    afterEach(() => {
        if (env) env.cleanup();
        env = null;
        vi.useRealTimers();
    });

    // bd med-tc1.3 — scheduleReminderRecompute keys its 2s debounce off the shim
    // ctx, and the harness makes a fresh ctx per env, so nothing ever cleared a
    // prior env's timer. On a loaded runner (where 2s elapses inside a suite) a
    // timer from an earlier test fired during a later one and called the shared
    // pushSchedule mock — the later test then saw "called 2 times, but got 1",
    // or read the stale empty-entry call as its own. Teardown must cancel it.
    it('tearing down an env cancels its pending debounced push (no cross-test leak)', async () => {
        const stale = loadCloudShimFrontendEnv({
            seedRecords: { medication: [seedMedication({ inventory_count: 5 })] }
        });
        await stale.window.apiCall('/api/medication/reminder/toggle', 'POST', { enabled: true });
        stale.cleanup(); // the debounce is still pending here

        await vi.advanceTimersByTimeAsync(2100);

        expect(pushSchedule).not.toHaveBeenCalled();
    });

    it('a mutating med route re-emits a debounced push carrying only the forward slot fire, never a client re-reminder (med-eas.74)', async () => {
        // Re-reminders moved server-side to the relay, so the client-uploaded
        // schedule for a still-PENDING dose 2h ago must contain the forward
        // primary slot fire but NO hourly "REMINDER" nag entries.
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ recordId: 1, schedule: '08:00', inventory_count: 5 })],
                intake: [seedIntake({
                    recordId: 'intake-1', medication_id: 1, scheduled_at: new Date(Date.now() - 2 * HOUR_MS).toISOString()
                })]
            }
        });
        const { window } = env;

        // Any mutating med route schedules a debounced recompute+push
        // (apishim.js's scheduleReminderRecompute) — the reminder-pref
        // toggle is a convenient one that doesn't itself touch the intake.
        await window.apiCall('/api/medication/reminder/toggle', 'POST', { enabled: true });
        await vi.advanceTimersByTimeAsync(2100);
        expect(pushSchedule).toHaveBeenCalledTimes(1);
        const entries = pushSchedule.mock.calls[0][1];
        expect(entries.some((e) => e.kind === 'medication')).toBe(true);
        expect(entries.filter((e) => e.text.includes('REMINDER'))).toHaveLength(0);

        // Confirming still re-runs the debounced push (mutations recompute).
        await window.apiCall('/api/medications/confirm-schedule', 'POST', { intake_ids: ['intake-1'] });
        await vi.advanceTimersByTimeAsync(2100);
        expect(pushSchedule).toHaveBeenCalledTimes(2);
        expect(pushSchedule.mock.calls[1][1].filter((e) => e.text.includes('REMINDER'))).toHaveLength(0);
    });
});
