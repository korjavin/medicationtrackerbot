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

    it('confirm-schedule records the take sheet\'s taken_at when given (med-xso6.19)', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'intake-1', medication_id: 1 })]
            }
        });
        const { window } = env;
        const takenAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();

        await window.apiCall('/api/medications/confirm-schedule', 'POST', { intake_ids: ['intake-1'], taken_at: takenAt });

        const history = await window.apiCall('/api/history?days=0');
        expect(history[0].status).toBe('TAKEN');
        expect(Date.parse(history[0].taken_at)).toBe(Date.parse(takenAt));
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

    it('confirm-schedule of an upcoming, not-yet-materialized slot records it TAKEN once (Meds "Take N", med-xso6.18)', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({
                    recordId: 1,
                    inventory_count: 5,
                    schedule: JSON.stringify({ type: 'daily', times: ['00:00', '06:00', '12:00', '18:00'] })
                })]
            }
        });
        const { window } = env;
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        try {
            const upcoming = await window.apiCall('/api/medications/upcoming?days=1');
            const next = upcoming.find((d) => Date.parse(d.scheduled_at) > Date.now() + 60 * 1000);
            expect(next).toBeTruthy();
            const slot = next.scheduled_at;

            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slot, medication_ids: [1] });
            let meds = await window.apiCall('/api/medications');
            expect(meds[0].inventory_count).toBe(4);
            const after = await window.apiCall('/api/medications/upcoming?days=1');
            expect(after.some((d) => d.scheduled_at === slot)).toBe(false);

            // Re-confirming the now-TAKEN slot changes nothing.
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slot, medication_ids: [1] });
            meds = await window.apiCall('/api/medications');
            expect(meds[0].inventory_count).toBe(4);

            // An instant that is no real slot is never invented.
            const bogus = new Date(Date.parse(slot) + 7 * 60 * 1000).toISOString();
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: bogus, medication_ids: [1] });
            meds = await window.apiCall('/api/medications');
            expect(meds[0].inventory_count).toBe(4);
        } finally {
            delete globalThis.fetch;
        }
    });

    it('taking an upcoming shared slot one med at a time is additive (never reverts the earlier one)', async () => {
        const schedule = JSON.stringify({ type: 'daily', times: ['00:00', '06:00', '12:00', '18:00'] });
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [
                    seedMedication({ recordId: 1, inventory_count: 5, schedule }),
                    seedMedication({ recordId: 2, name: 'Aspirin', inventory_count: 5, schedule })
                ]
            }
        });
        const { window } = env;
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        try {
            const upcoming = await window.apiCall('/api/medications/upcoming?days=1');
            const slot = upcoming.find((d) => Date.parse(d.scheduled_at) > Date.now() + 60 * 1000).scheduled_at;

            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slot, medication_ids: [1] });
            // Med 1 left the forecast, so the bucket now offers only med 2.
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slot, medication_ids: [2] });

            const meds = await window.apiCall('/api/medications');
            const count = (id) => meds.find((m) => String(m.id) === String(id)).inventory_count;
            expect(count(1)).toBe(4);
            expect(count(2)).toBe(4);
            const after = await window.apiCall('/api/medications/upcoming?days=1');
            expect(after.some((d) => d.scheduled_at === slot)).toBe(false);
        } finally {
            delete globalThis.fetch;
        }
    });

    // bd med-9d1a — a reminder tap carries ids + slot only (no intake ids), and
    // the slot is already past. Its confirm must be ADDITIVE: the sheet lists
    // only the reminder's meds, so a slot-mate taken before the tap is absent
    // without having been unchecked and must never revert to PENDING.
    const waitFor = async (pred) => {
        for (let i = 0; i < 100 && !(await pred()); i++) await new Promise((r) => setTimeout(r, 20));
    };
    const reminderTapEnv = (statusB, statusA = 'PENDING') => {
        const slotIso = new Date(Math.floor((Date.now() - HOUR_MS) / 60000) * 60000).toISOString();
        env = loadCloudShimFrontendEnv({
            url: `https://acct.example.test/?action=medication_confirm&ids=1%2C2&scheduled=${encodeURIComponent(slotIso)}`,
            seedRecords: {
                medication: [
                    seedMedication({ recordId: 1, name: 'Metformin', inventory_count: 5 }),
                    seedMedication({ recordId: 2, name: 'Aspirin', inventory_count: 5 })
                ],
                intake: [
                    seedIntake({ recordId: 'intake-a', medication_id: 1, scheduled_at: slotIso, status: statusA, taken_at: statusA === 'TAKEN' ? slotIso : null }),
                    seedIntake({ recordId: 'intake-b', medication_id: 2, scheduled_at: slotIso, status: statusB, taken_at: statusB === 'TAKEN' ? slotIso : null })
                ]
            }
        });
        return slotIso;
    };
    const stateOf = async (window) => {
        const meds = await window.apiCall('/api/medications');
        const history = await window.apiCall('/api/history?days=2');
        const status = (medId) => history.find((h) => h.medication_id === medId).status;
        const stock = (medId) => meds.find((m) => String(m.id) === String(medId)).inventory_count;
        return { a: status(1), b: status(2), stockA: stock(1), stockB: stock(2) };
    };

    it('a reminder-tap confirm takes the pending dose and never reverts a TAKEN slot-mate', async () => {
        reminderTapEnv('TAKEN');
        const { window, document } = env;
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        try {
            window.handleDeepLinks();
            const list = document.getElementById('med-confirm-list');
            await waitFor(() => list.querySelectorAll('.med-confirm-check').length > 0);

            // Only the still-due med is offered.
            expect([...list.querySelectorAll('.med-confirm-check')].map((c) => c.textContent)).toEqual([expect.stringContaining('Metformin')]);

            // The post-confirm repaint (loadMeds / loadHistory) would outlive
            // the env teardown; the state below is read from the shim directly.
            const refresh = vi.spyOn(window, 'refreshMedsAfterMutation').mockImplementation(() => {});
            document.getElementById('med-confirm-action-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
            await waitFor(() => refresh.mock.calls.length > 0);

            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'TAKEN', stockA: 4, stockB: 5 });
        } finally {
            delete globalThis.fetch;
        }
    });

    it('a reminder tap for a slot already fully logged opens no sheet and changes nothing', async () => {
        reminderTapEnv('TAKEN', 'TAKEN');
        const { window, document } = env;
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        try {
            const toast = vi.spyOn(window, 'safeToast').mockImplementation(() => null);
            const modal = vi.spyOn(window, 'showMedicationConfirmModal');

            window.handleDeepLinks();
            await waitFor(() => toast.mock.calls.length > 0);

            expect(toast).toHaveBeenCalledWith('Already logged — nothing left to take for this reminder.', 'info');
            expect(modal).not.toHaveBeenCalled();
            expect(document.querySelectorAll('#med-confirm-list .med-confirm-check').length).toBe(0);
            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'TAKEN', stockA: 5, stockB: 5 });
        } finally {
            delete globalThis.fetch;
        }
    });

    // bd med-wi09.2 — explicit dose actions on explicit occIds. Two meds share
    // a past slot: intake-a (Metformin) and intake-b (Aspirin).
    const slotEnv = (statusA, statusB) => {
        const slotIso = new Date(Math.floor((Date.now() - HOUR_MS) / 60000) * 60000).toISOString();
        const row = (recordId, medication_id, status) => seedIntake({
            recordId, medication_id, scheduled_at: slotIso, status, taken_at: status === 'TAKEN' ? slotIso : null
        });
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [
                    seedMedication({ recordId: 1, name: 'Metformin', inventory_count: 5 }),
                    seedMedication({ recordId: 2, name: 'Aspirin', inventory_count: 5 })
                ],
                intake: [row('intake-a', 1, statusA), row('intake-b', 2, statusB)]
            }
        });
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        return slotIso;
    };
    const act = (window, body) => window.apiCall('/api/doses/act', 'POST', body);

    it('a partial sheet never flips a TAKEN slot-mate — confirm-schedule is additive, act touches only its ids', async () => {
        const slotIso = slotEnv('PENDING', 'TAKEN');
        const { window } = env;
        try {
            // The old revert pass un-took every TAKEN slot-mate absent from the list.
            await window.apiCall('/api/medications/confirm-schedule', 'POST', { scheduled_at: slotIso, medication_ids: [1] });
            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'TAKEN', stockA: 4, stockB: 5 });

            await act(window, { action: 'undo', occ_ids: ['intake-a'] });
            await act(window, { action: 'take', occ_ids: ['intake-a'] });
            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'TAKEN', stockA: 4, stockB: 5 });
        } finally {
            delete globalThis.fetch;
        }
    });

    it('a bulk take of N ids is idempotent on repeat (no second decrement, taken_at kept)', async () => {
        slotEnv('PENDING', 'PENDING');
        const { window } = env;
        try {
            const takenAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const first = await act(window, { action: 'take', occ_ids: ['intake-a', 'intake-b'], taken_at: takenAt });
            expect(first).toMatchObject({ updated: 2, unchanged: 0, failed: 0, failures: [] });
            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'TAKEN', stockA: 4, stockB: 4 });

            const again = await act(window, { action: 'take', occ_ids: ['intake-a', 'intake-b'] });
            expect(again).toMatchObject({ updated: 0, unchanged: 2, failed: 0 });
            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'TAKEN', stockA: 4, stockB: 4 });
            const history = await window.apiCall('/api/history?days=2');
            expect(history.every((h) => Date.parse(h.taken_at) === Date.parse(takenAt))).toBe(true);
        } finally {
            delete globalThis.fetch;
        }
    });

    it('undo restores PENDING and stock (+1 only for a TAKEN dose); skip and take refuse a resolved dose', async () => {
        slotEnv('TAKEN', 'SKIPPED');
        const { window } = env;
        try {
            const refused = await act(window, { action: 'take', occ_ids: ['intake-b'] });
            expect(refused).toMatchObject({ updated: 0, failed: 1, failures: [{ id: 'intake-b', reason: 'not_pending' }] });

            const res = await act(window, { action: 'undo', occ_ids: ['intake-a', 'intake-b'] });
            expect(res).toMatchObject({ updated: 2, failed: 0 });
            expect(await stateOf(window)).toEqual({ a: 'PENDING', b: 'PENDING', stockA: 6, stockB: 5 });
            const history = await window.apiCall('/api/history?days=2');
            expect(history.some((h) => h.taken_at)).toBe(false);
            // Stored as UNTAKEN (bd med-wi09.11): an explicit app action at
            // seen-rev + 1, the reverted taken_at kept in the note.
            const a = (await env.records.list('intake')).find((i) => i.recordId === 'intake-a');
            expect(a).toMatchObject({ status: 'UNTAKEN', rev: 2, via: 'app', note: expect.stringContaining('was taken at') });
            const [row] = (await window.apiCall('/api/doses?from=1970-01-01T00:00:00Z&to=2100-01-01T00:00:00Z'))
                .filter((d) => d.occId === 'intake-a');
            expect(row).toMatchObject({ state: 'due', via: 'app' });

            // Undo of a pending dose is a no-op.
            expect(await act(window, { action: 'undo', occ_ids: ['intake-a'] })).toMatchObject({ updated: 0, unchanged: 1 });
        } finally {
            delete globalThis.fetch;
        }
    });

    it('edit_time moves taken_at of a TAKEN dose only, with no stock change', async () => {
        slotEnv('TAKEN', 'PENDING');
        const { window } = env;
        try {
            const takenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const res = await act(window, { action: 'edit_time', occ_ids: ['intake-a', 'intake-b'], taken_at: takenAt });
            expect(res).toMatchObject({ updated: 1, failed: 1, failures: [{ id: 'intake-b', reason: 'not_taken' }] });
            const history = await window.apiCall('/api/history?days=2');
            expect(Date.parse(history.find((h) => h.id === 'intake-a').taken_at)).toBe(Date.parse(takenAt));
            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'PENDING', stockA: 5, stockB: 5 });
        } finally {
            delete globalThis.fetch;
        }
    });

    it('snooze (bd med-4j49) writes snoozed_until on its own branch — status, rev and stock untouched — and refuses a resolved dose', async () => {
        const slotIso = slotEnv('PENDING', 'TAKEN');
        const { window } = env;
        try {
            const before = Date.now();
            const res = await act(window, { action: 'snooze', occ_ids: ['intake-a', 'intake-b'], minutes: 10 });
            expect(res).toMatchObject({ updated: 1, failed: 1, failures: [{ id: 'intake-b', reason: 'not_pending' }] });
            const a = (await env.records.list('intake')).find((i) => i.recordId === 'intake-a');
            expect(a).toMatchObject({ status: 'PENDING', rev: 0 });
            expect(Date.parse(a.snoozed_until) - Date.parse(a.snoozed_at)).toBe(10 * 60 * 1000);
            expect(Date.parse(a.snoozed_at)).toBeGreaterThanOrEqual(before);
            expect(res.doses[0]).toMatchObject({ id: 'intake-a', status: 'PENDING', snoozed_until: a.snoozed_until });
            const [row] = (await window.apiCall('/api/doses?from=1970-01-01T00:00:00Z&to=2100-01-01T00:00:00Z'))
                .filter((d) => d.occId === 'intake-a');
            expect(row).toMatchObject({ state: 'snoozed', snoozedUntil: a.snoozed_until });
            expect(await stateOf(window)).toEqual({ a: 'PENDING', b: 'TAKEN', stockA: 5, stockB: 5 });
            // The due dose's reminder re-arms on the relay chain at the snooze end.
            const rearm = globalThis.fetch.mock.calls.find(([url]) => url === '/api/telegram/rearm-refire');
            expect(JSON.parse(rearm[1].body)).toEqual({
                callback: `s:${Math.floor(Date.parse(slotIso) / 1000)}`, med_ids: '1', fire_at: Math.floor(Date.parse(a.snoozed_until) / 1000),
            });

            // `until` sets the end directly; a past or unparseable one is a 400.
            const until = new Date(Date.now() + 2 * HOUR_MS).toISOString();
            await act(window, { action: 'snooze', occ_ids: ['intake-a'], until });
            expect((await env.records.list('intake')).find((i) => i.recordId === 'intake-a').snoozed_until).toBe(until);
            await expect(window.offlineAwareApiCall('/api/doses/act', 'POST', { action: 'snooze', occ_ids: ['intake-a'], until: new Date(Date.now() - HOUR_MS).toISOString() }))
                .rejects.toMatchObject({ status: 400 });

            // A take after the snooze is an ordinary take.
            expect(await act(window, { action: 'take', occ_ids: ['intake-a'] })).toMatchObject({ updated: 1, failed: 0 });
            expect(await stateOf(window)).toEqual({ a: 'TAKEN', b: 'TAKEN', stockA: 4, stockB: 5 });
        } finally {
            delete globalThis.fetch;
        }
    });

    it('take / skip of a forecast occId creates that exact slot once; an id that is no real slot fails', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({
                    recordId: 1,
                    inventory_count: 5,
                    schedule: JSON.stringify({ type: 'daily', times: ['00:00', '06:00', '12:00', '18:00'] })
                })]
            }
        });
        const { window } = env;
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        try {
            const doses = await window.apiCall(`/api/doses?from=${new Date(Date.now() + 60 * 1000).toISOString()}`);
            const [first, second] = doses.filter((d) => d.state === 'upcoming');
            expect(first.occId).toBe(`intake-1-${Date.parse(first.plannedAt) / 1000}`);

            expect(await act(window, { action: 'take', occ_ids: [first.occId] })).toMatchObject({ updated: 1, failed: 0 });
            expect(await act(window, { action: 'take', occ_ids: [first.occId] })).toMatchObject({ updated: 0, unchanged: 1 });
            expect(await act(window, { action: 'skip', occ_ids: [second.occId] })).toMatchObject({ updated: 1, failed: 0 });
            const meds = await window.apiCall('/api/medications');
            expect(meds[0].inventory_count).toBe(4);
            const after = await window.apiCall(`/api/doses?from=${new Date(Date.now() + 60 * 1000).toISOString()}`);
            expect(after.find((d) => d.occId === first.occId).state).toBe('taken');
            expect(after.find((d) => d.occId === second.occId).state).toBe('skipped');

            const bogus = `intake-1-${Date.parse(first.plannedAt) / 1000 + 420}`;
            expect(await act(window, { action: 'take', occ_ids: [bogus, 'nope'] })).toMatchObject({
                updated: 0,
                failed: 2,
                failures: [{ id: bogus, reason: 'not_found' }, { id: 'nope', reason: 'not_found' }]
            });
        } finally {
            delete globalThis.fetch;
        }
    });

    it('a dose stored under a non-bare id (vault-imported tz_step) is not re-offered as a forecast, and act resolves it by slot', async () => {
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({
                    recordId: 1,
                    inventory_count: 5,
                    schedule: JSON.stringify({ type: 'daily', times: ['00:00', '06:00', '12:00', '18:00'] })
                })]
            }
        });
        const { window } = env;
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        try {
            const from = new Date(Date.now() + 60 * 1000).toISOString();
            const slot = (await window.apiCall(`/api/doses?from=${from}`)).find((d) => d.state === 'upcoming');
            await env.records.put('intake', seedIntake({
                recordId: `${slot.occId}-tz_step`, medication_id: 1, scheduled_at: slot.plannedAt, status: 'SKIPPED', source: 'tz_step'
            }));
            const rows = (await window.apiCall(`/api/doses?from=${from}`)).filter((d) => d.plannedAt === slot.plannedAt);
            expect(rows.map((d) => [d.occId, d.state])).toEqual([[`${slot.occId}-tz_step`, 'skipped']]);
            expect(await act(window, { action: 'undo', occ_ids: [slot.occId] })).toMatchObject({ updated: 1, failed: 0 });
        } finally {
            delete globalThis.fetch;
        }
    });

    it('act matches a string med recordId against a numeric intake medication_id — take + undo move stock once (med-wi09.15)', async () => {
        const slotIso = new Date(Math.floor((Date.now() - HOUR_MS) / 60000) * 60000).toISOString();
        const occId = `intake-7-${Date.parse(slotIso) / 1000}`;
        env = loadCloudShimFrontendEnv({
            seedRecords: {
                medication: [seedMedication({ recordId: '7', name: 'Metformin', inventory_count: 5 })],
                intake: [seedIntake({ recordId: 'legacy-7', medication_id: 7, scheduled_at: slotIso })]
            }
        });
        const { window } = env;
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
        const stock = async () => (await window.apiCall('/api/medications'))[0].inventory_count;
        const status = async () => (await window.apiCall('/api/history?days=2')).map((h) => [h.id, h.status]);
        try {
            // The slot occId resolves to the stored row — no forecast twin.
            expect(await act(window, { action: 'take', occ_ids: [occId] })).toMatchObject({ updated: 1, failed: 0 });
            expect(await status()).toEqual([['legacy-7', 'TAKEN']]);
            expect(await stock()).toBe(4);
            expect(await act(window, { action: 'take', occ_ids: [occId] })).toMatchObject({ updated: 0, unchanged: 1 });
            expect(await stock()).toBe(4);

            expect(await act(window, { action: 'undo', occ_ids: ['legacy-7'] })).toMatchObject({ updated: 1, failed: 0 });
            expect(await status()).toEqual([['legacy-7', 'PENDING']]);
            expect(await stock()).toBe(5);
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
