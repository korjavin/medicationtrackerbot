// bd med-76c.2 part 2 — applying a sealed Telegram tap through the real intake
// domain. These run against createIntakeDomain (not a stub) because the two
// properties that matter — a re-drain converging instead of double-decrementing
// inventory, and a 09:00 tap recording 09:00 — are properties of that domain's
// behavior, not of this module's bookkeeping.
import { describe, expect, it, vi } from 'vitest';
import { createIntakeDomain } from '../../../domain/medintake.js';
import { applyIntakeSlotAction, createInboxApplier, INTAKE_SLOT_ACTION } from '../inbox-apply.js';

const SLOT_UNIX = 1767225600; // 2026-01-01T00:00:00Z
const SLOT_ISO = new Date(SLOT_UNIX * 1000).toISOString();
const TAP_UNIX = SLOT_UNIX + 600; // tapped 10 minutes after the dose was due
const DRAIN_MS = (SLOT_UNIX + 4 * 3600) * 1000; // app first opened 4h later

// Records port over an in-memory map, keyed by recordId within each type.
function fakeRecords(seed = {}) {
    const store = JSON.parse(JSON.stringify(seed));
    return {
        dump: () => store,
        list: async (type) => (store[type] || []).map((r) => ({ ...r })),
        put: async (type, record) => {
            store[type] = (store[type] || []).filter((r) => r.recordId !== record.recordId);
            store[type].push({ ...record });
            return record;
        },
        del: async (type, id) => {
            store[type] = (store[type] || []).filter((r) => r.recordId !== id);
        },
    };
}

// Two meds due at the same instant — the whole reason callback_data is
// slot-scoped rather than intake-scoped.
function seed() {
    return {
        medication: [
            { recordId: 'med-a', deleted: false, name: 'Lisinopril', dosage: '10mg', schedule: '', inventory_count: 30 },
            { recordId: 'med-b', deleted: false, name: 'Metformin', dosage: '500mg', schedule: '', inventory_count: 20 },
        ],
        intake: [
            { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            { recordId: `intake-med-b-${SLOT_UNIX}`, deleted: false, medication_id: 'med-b', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            // A different slot must be left alone.
            { recordId: `intake-med-a-${SLOT_UNIX + 43200}`, deleted: false, medication_id: 'med-a', scheduled_at: new Date((SLOT_UNIX + 43200) * 1000).toISOString(), status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
        ],
    };
}

function domainFor(records, now) {
    return createIntakeDomain({ records, now, timeZone: 'UTC' });
}

const confirmEvent = { kind: INTAKE_SLOT_ACTION, slot_unix: SLOT_UNIX, action: 'confirm', at_unix: TAP_UNIX };
const snoozeEvent = { kind: INTAKE_SLOT_ACTION, slot_unix: SLOT_UNIX, action: 'snooze', at_unix: TAP_UNIX };

describe('inbox-apply.js — a Telegram Confirm/Snooze tap', () => {
    it('confirms every med due at the slot, backdated to the tap, not to the drain', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        const atSlot = intakes.filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot).toHaveLength(2);
        for (const i of atSlot) {
            expect(i.status).toBe('TAKEN');
            // Rule 4: the tap's instant, hours before this drain ran.
            expect(Date.parse(i.taken_at)).toBe(TAP_UNIX * 1000);
            expect(Date.parse(i.taken_at)).toBeLessThan(DRAIN_MS);
        }

        // The 12h-later dose is untouched.
        const other = intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX + 43200}`);
        expect(other.status).toBe('PENDING');

        // Inventory decremented once per confirmed med.
        const meds = await records.list('medication');
        expect(meds.find((m) => m.recordId === 'med-a').inventory_count).toBe(29);
        expect(meds.find((m) => m.recordId === 'med-b').inventory_count).toBe(19);
    });

    // Rule 2. The mailbox is at-least-once: a crash between the vault write and
    // the ack re-delivers this exact event. It must converge, not double-count.
    it('re-applying the same event converges instead of double-decrementing inventory', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;

        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });

        const meds = await records.list('medication');
        expect(meds.find((m) => m.recordId === 'med-a').inventory_count).toBe(29); // not 28
        expect(meds.find((m) => m.recordId === 'med-b').inventory_count).toBe(19);

        const takenAt = (await records.list('intake'))
            .filter((i) => i.scheduled_at === SLOT_ISO)
            .map((i) => Date.parse(i.taken_at));
        expect(takenAt).toEqual([TAP_UNIX * 1000, TAP_UNIX * 1000]);
    });

    it('snoozes from the tap instant, not from the drain', async () => {
        const records = fakeRecords(seed());
        // Drain runs 1 minute after the tap, so the 10-minute window is still open.
        const now = () => (TAP_UNIX + 60) * 1000;
        await applyIntakeSlotAction(snoozeEvent, { intake: domainFor(records, now), records, now });

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        for (const i of atSlot) {
            expect(i.status).toBe('PENDING');
            // snoozed_until lands ~10min after the TAP (domain adds the remaining
            // minutes to its own now), never 10min after the drain.
            expect(Date.parse(i.snoozed_until)).toBe((TAP_UNIX + 600) * 1000);
        }
    });

    it('ignores a snooze whose window already elapsed while the app was closed', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS; // hours after the tap
        await applyIntakeSlotAction(snoozeEvent, { intake: domainFor(records, now), records, now });

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        for (const i of atSlot) {
            expect(i.snoozed_until).toBeNull(); // a snooze into the past is meaningless
            expect(i.status).toBe('PENDING');
        }
    });

    // Rule 3: two unlocked devices may drain the same event at once. Both see a
    // PENDING intake, both call confirm; the loser gets the domain's not_pending
    // guard. That is convergence, not failure — it must not strand the event.
    it('swallows the domain not_pending throw a concurrent drainer causes', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const real = domainFor(records, now);
        const raced = {
            materializeDueDoses: real.materializeDueDoses,
            confirm: vi.fn(async () => {
                const err = new Error('intake is not pending');
                err.code = 'not_pending';
                throw err;
            }),
            snooze: real.snooze,
        };

        await expect(
            applyIntakeSlotAction(confirmEvent, { intake: raced, records, now }),
        ).resolves.toBeUndefined();
        expect(raced.confirm).toHaveBeenCalledTimes(2);
    });

    // ...but a real failure must propagate, so drainInbox leaves the event queued.
    it('propagates a genuine failure so the event stays queued', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const real = domainFor(records, now);
        const broken = {
            materializeDueDoses: real.materializeDueDoses,
            confirm: async () => { throw new Error('vault write failed'); },
            snooze: real.snooze,
        };

        await expect(
            applyIntakeSlotAction(confirmEvent, { intake: broken, records, now }),
        ).rejects.toThrow(/vault write failed/);
    });

    it('confirming a slot with nothing pending is a no-op, not a throw', async () => {
        const records = fakeRecords({ medication: seed().medication, intake: [] });
        const now = () => DRAIN_MS;
        await expect(
            applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now }),
        ).resolves.toBeUndefined();
    });
});

describe('inbox-apply.js — createInboxApplier routing', () => {
    it('ignores unknown kinds and unknown actions rather than stalling the drain', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const records = fakeRecords(seed());
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });

        await expect(apply({ kind: 'something_newer', at_unix: TAP_UNIX })).resolves.toBeUndefined();
        await expect(apply({ kind: INTAKE_SLOT_ACTION, action: 'detonate', slot_unix: SLOT_UNIX, at_unix: TAP_UNIX })).resolves.toBeUndefined();

        // Nothing was applied.
        const intakes = await records.list('intake');
        expect(intakes.every((i) => i.status === 'PENDING')).toBe(true);
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it('routes a real intake_slot_action through the domain', async () => {
        const records = fakeRecords(seed());
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });
        await apply(confirmEvent);

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot.every((i) => i.status === 'TAKEN')).toBe(true);
    });
});
