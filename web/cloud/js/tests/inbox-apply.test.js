// bd med-76c.2 part 2 — applying a sealed Telegram tap through the real intake
// domain. These run against createIntakeDomain (not a stub) because the two
// properties that matter — a re-drain converging instead of double-decrementing
// inventory, and a 09:00 tap recording 09:00 — are properties of that domain's
// behavior, not of this module's bookkeeping.
import { describe, expect, it, vi } from 'vitest';
import { createIntakeDomain } from '../../../domain/medintake.js';
import { applyIntakeSlotAction, applyWorkoutSessionAction, applyTGCommand, applyTGPhoto, applyTGText, createInboxApplier, makeTGPrefsPort, INTAKE_SLOT_ACTION, TG_COMMAND, TG_PHOTO, TG_TEXT, VITALS_IMPORT, WORKOUT_SESSION_ACTION } from '../inbox-apply.js';
import { createTGAgent } from '../tg-agent.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createFoodDomain } from '../../../domain/food.js';
import { createFoodAIDomain } from '../../../domain/foodai.js';
import { createWorkoutDomain } from '../../../domain/workout.js';
import { createVitalsDomain } from '../../../domain/vitals.js';
import { vaultToRecords } from '../../../domain/vault.js';
import { commandToken, parseCommand } from '../../../domain/tgcommand.js';

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
        // Mirrors sync.js recordsPort: inclusive primary-key range, live only —
        // what vitals.readSamples uses to bound its day-batch window.
        listRange: async (type, fromId, toId) => (store[type] || [])
            .filter((r) => !r.deleted && r.recordId >= fromId && r.recordId <= toId)
            .map((r) => ({ ...r })),
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

    // Two meds due at the same instant, seeded with a REAL schedule and NO
    // intake rows: materializeDueDoses mints them at drain, then Confirm must
    // record BOTH. (The empty-schedule seed above pre-materializes at the exact
    // slot, which masked the drift bug — this exercises the real path.)
    it('materializes then confirms every med when the slot had no intake rows yet', async () => {
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'Lisinopril', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'Metformin', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 20 },
            ],
            intake: [],
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot).toHaveLength(2);
        for (const i of atSlot) expect(i.status).toBe('TAKEN');
    });

    // The data-loss regression: the callback slot and the stored intake's
    // scheduled_at are re-derived independently and drift when a dose is clustered
    // (triggerNext/confirmSchedule store it at clusterEarliestMs, up to the 10min
    // CLUSTER_WINDOW). One med's intake sits 8min off the slot — inside the band.
    // Exact-=== leaves it PENDING (silent adherence loss); the band confirms it.
    it('confirms a drifted intake within the cluster drift band', async () => {
        const driftedIso = new Date((SLOT_UNIX + 8 * 60) * 1000).toISOString(); // 8min: inside the 10min band
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'Lisinopril', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'Metformin', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 20 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                // med-b's dose drifted 8min past the callback slot (cluster window).
                { recordId: `intake-med-b-drift`, deleted: false, medication_id: 'med-b', scheduled_at: driftedIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        // Would be PENDING under the old exact-=== match — the whole bug.
        expect(intakes.find((i) => i.recordId === 'intake-med-b-drift').status).toBe('TAKEN');
    });

    // The opposite failure the band must NOT cause: a different med due at a
    // genuinely different time of day is its OWN message (grouped by exact slot),
    // and tapping Confirm on this slot must not confirm it. A different dose is
    // >= the med's minDoseInterval (hours) away — far outside the 10min band.
    it('does not confirm a different med scheduled hours away from the slot', async () => {
        const otherIso = new Date((SLOT_UNIX + 4 * 3600) * 1000).toISOString(); // 4h later, own message
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'Morning', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'Afternoon', schedule: '{"type":"daily","times":["04:00"]}', inventory_count: 20 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-b-other', deleted: false, medication_id: 'med-b', scheduled_at: otherIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        // The 4h-away dose belongs to its own reminder — untouched by this tap.
        expect(intakes.find((i) => i.recordId === 'intake-med-b-other').status).toBe('PENDING');
        expect((await records.list('medication')).find((m) => m.recordId === 'med-b').inventory_count).toBe(20);
    });

    // Medication safety, boundary: a dose drifted BEYOND the cluster band (a DST/
    // tz-plan step or a big schedule edit — 1h here) is NOT auto-confirmed by this
    // slot's tap. It stays PENDING and is re-reminded (a safe false-negative)
    // rather than risking a false adherence record — the deliberate narrow-band
    // trade-off (a false-positive is worse for meds).
    it('leaves a dose drifted beyond the band PENDING (safe re-reminder, not a false confirm)', async () => {
        const farIso = new Date((SLOT_UNIX + 3600) * 1000).toISOString(); // 1h: outside the 10min band
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'Lisinopril', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'Metformin', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 20 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-b-far', deleted: false, medication_id: 'med-b', scheduled_at: farIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === 'intake-med-b-far').status).toBe('PENDING');
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

    // Bug 1: Confirm must edit the original reminder message to a receipt (which
    // also drops its inline buttons, since the edit sends no reply_markup).
    it('edits the reminder message with the count actually confirmed', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(
            { ...confirmEvent, message_id: 4242 },
            { intake: domainFor(records, now), records, now, editReply },
        );
        expect(editReply).toHaveBeenCalledWith(4242, expect.stringMatching(/Confirmed 2 medications/));
    });

    it('edits the reminder message to a snoozed receipt', async () => {
        const records = fakeRecords(seed());
        const now = () => (TAP_UNIX + 60) * 1000; // window still open
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(
            { ...snoozeEvent, message_id: 77 },
            { intake: domainFor(records, now), records, now, editReply },
        );
        expect(editReply).toHaveBeenCalledWith(77, expect.stringMatching(/Snoozed/));
    });

    // A flush-false re-queues the event (inbox.js) and a Telegram double-tap
    // queues a second callback: both re-run this applier. The second pass finds
    // every intake already TAKEN (applied === 0) and must NOT re-edit the message
    // — otherwise it clobbers the good "✅ Confirmed 2" receipt with "Nothing was
    // due".
    it('does not clobber the confirm receipt when re-drained with nothing left pending', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        const evt = { ...confirmEvent, message_id: 4242 };
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), records, now, editReply });
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), records, now, editReply });
        expect(editReply).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(4242, expect.stringMatching(/Confirmed 2 medications/));
    });

    it('respects generic verbosity in the confirm receipt', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(
            { ...confirmEvent, message_id: 1 },
            { intake: domainFor(records, now), records, now, editReply, verbosity: 'generic' },
        );
        expect(editReply).toHaveBeenCalledWith(1, '✅ Recorded.');
    });

    it('a failed message edit never fails the drain (record already in the vault)', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => { throw new Error('telegram down'); });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(
            applyIntakeSlotAction(
                { ...confirmEvent, message_id: 9 },
                { intake: domainFor(records, now), records, now, editReply },
            ),
        ).resolves.toBeUndefined();
        warn.mockRestore();
        // The confirm still landed.
        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        for (const i of atSlot) expect(i.status).toBe('TAKEN');
    });

    it('confirming a slot with nothing pending is a no-op, not a throw', async () => {
        const records = fakeRecords({ medication: seed().medication, intake: [] });
        const now = () => DRAIN_MS;
        await expect(
            applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now }),
        ).resolves.toBeUndefined();
    });

    // --- bd med-eas.67: confirm the reminder's NAMED meds by identity ---
    // getSlotMeds injects the push-time slot→medIds map (in production it reads a
    // device-local store; here we hand it the list the reminder named).
    const slotMeds = (ids) => async () => ids;
    const DAILY = '{"type":"daily","times":["00:00"]}'; // minDoseInterval = 14.4h

    // The reported P1: a grouped 4-med reminder where one med's ONLY dose drifted
    // hours off its clock slot (a tz-plan/cluster step) — beyond the ±10min band
    // but well inside its own minDoseInterval. Under the band it stays PENDING
    // (adherence lost, re-nagged an hour later); the identity path confirms all 4.
    it('confirms a course med whose dose drifted beyond the band but within its interval', async () => {
        const driftedIso = new Date((SLOT_UNIX + 2 * 3600) * 1000).toISOString(); // 2h: > band, < 14.4h interval
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'B', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-c', deleted: false, name: 'C', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-d', deleted: false, name: 'Coclav', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: `intake-med-b-${SLOT_UNIX}`, deleted: false, medication_id: 'med-b', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: `intake-med-c-${SLOT_UNIX}`, deleted: false, medication_id: 'med-c', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-d-drift', deleted: false, medication_id: 'med-d', scheduled_at: driftedIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(
            { ...confirmEvent, message_id: 9 },
            { intake: domainFor(records, now), records, now, editReply, getSlotMeds: slotMeds(['med-a', 'med-b', 'med-c', 'med-d']) },
        );

        const intakes = await records.list('intake');
        for (const id of [`intake-med-a-${SLOT_UNIX}`, `intake-med-b-${SLOT_UNIX}`, `intake-med-c-${SLOT_UNIX}`, 'intake-med-d-drift']) {
            expect(intakes.find((i) => i.recordId === id).status).toBe('TAKEN');
        }
        // Receipt counts distinct named meds (4), not band-matched rows (the drifted
        // one is >10min from the slot, so a time filter would have said 3).
        expect(editReply).toHaveBeenCalledWith(9, expect.stringMatching(/Confirmed 4 medications/));
    });

    // A false positive is the one thing the wider interval must never cause: a
    // PENDING dose of a med the reminder did NOT name (its own later message), and
    // a different dose of a named med ≥ its interval away, both stay untouched.
    it('never confirms a med the reminder did not name, nor a named med\'s far-off dose', async () => {
        const farIso = new Date((SLOT_UNIX + 20 * 3600) * 1000).toISOString(); // 20h: > med-a's 14.4h interval
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'B', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                // med-b is due right at the slot but was NOT named for it.
                { recordId: `intake-med-b-${SLOT_UNIX}`, deleted: false, medication_id: 'med-b', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                // med-a's tomorrow dose, past its own interval — a different dose.
                { recordId: 'intake-med-a-far', deleted: false, medication_id: 'med-a', scheduled_at: farIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now, getSlotMeds: slotMeds(['med-a']) });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === `intake-med-b-${SLOT_UNIX}`).status).toBe('PENDING'); // not named
        expect(intakes.find((i) => i.recordId === 'intake-med-a-far').status).toBe('PENDING'); // far dose
    });

    // With no stored map, the identity path is skipped and the fixed ±band match
    // runs exactly as before — the null return the fallback depends on.
    it('falls back to the ±band match when no slot→meds map is stored', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now, getSlotMeds: async () => null });

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot).toHaveLength(2);
        for (const i of atSlot) expect(i.status).toBe('TAKEN');
    });

    // A throwing device store (no IndexedDB, a read error) must never fail the
    // drain — getSlotMedicationsSafe swallows it to null so the ±band fallback still
    // confirms the on-slot intakes. This is the load-bearing medication-safety guard.
    it('falls back to the ±band match when the slot→meds store throws', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, {
            intake: domainFor(records, now), records, now,
            getSlotMeds: async () => { throw new Error('no idb'); },
        });

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot).toHaveLength(2);
        for (const i of atSlot) expect(i.status).toBe('TAKEN');
    });

    // Nearest-wins: when a named med has BOTH an on-slot and a drifted PENDING dose
    // inside its band, only the nearest is acted on — never both (no double-confirm).
    it('confirms only the nearest PENDING dose of a named med, not both in-band doses', async () => {
        const driftedIso = new Date((SLOT_UNIX + 2 * 3600) * 1000).toISOString(); // 2h: in band, farther than the on-slot dose
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-a-drift', deleted: false, medication_id: 'med-a', scheduled_at: driftedIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now, getSlotMeds: slotMeds(['med-a']) });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN'); // nearest
        expect(intakes.find((i) => i.recordId === 'intake-med-a-drift').status).toBe('PENDING'); // not double-confirmed
    });

    // Redelivery must not "walk" a named med onto its NEXT in-band dose: drain 1
    // confirms the on-slot dose, a failed flush re-queues the event, and drain 2
    // (same deterministic atMs) must see that med as already handled and skip it —
    // not confirm the drifted dose the user never took.
    it('identity path does not confirm a second drifted dose on redelivery', async () => {
        const driftedIso = new Date((SLOT_UNIX + 2 * 3600) * 1000).toISOString(); // in band, farther than on-slot
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-a-drift', deleted: false, medication_id: 'med-a', scheduled_at: driftedIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        const opts = { records, now, getSlotMeds: slotMeds(['med-a']) };
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), ...opts });
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), ...opts }); // redelivery

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === 'intake-med-a-drift').status).toBe('PENDING'); // never taken
        expect((await records.list('medication')).find((m) => m.recordId === 'med-a').inventory_count).toBe(29); // decremented once
    });

    // Idempotency holds on the identity path too: a redelivery / double-tap re-runs
    // with the named meds already TAKEN → nothing left to apply → the receipt is
    // not clobbered and inventory is not double-decremented.
    it('identity path is idempotent across redelivery (no double-confirm, no receipt clobber)', async () => {
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'B', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: `intake-med-b-${SLOT_UNIX}`, deleted: false, medication_id: 'med-b', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        const opts = { records, now, editReply, getSlotMeds: slotMeds(['med-a', 'med-b']) };
        const evt = { ...confirmEvent, message_id: 5 };
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), ...opts });
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), ...opts });

        expect(editReply).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(5, expect.stringMatching(/Confirmed 2 medications/));
        const meds = await records.list('medication');
        expect(meds.find((m) => m.recordId === 'med-a').inventory_count).toBe(29); // not 28
        expect(meds.find((m) => m.recordId === 'med-b').inventory_count).toBe(29);
    });

    // Snooze resolves by identity too: each named med's due PENDING dose is snoozed.
    it('snoozes the named meds by identity, including a drifted dose', async () => {
        const driftedIso = new Date((SLOT_UNIX + 2 * 3600) * 1000).toISOString();
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'B', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-b-drift', deleted: false, medication_id: 'med-b', scheduled_at: driftedIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => (TAP_UNIX + 60) * 1000; // window still open
        await applyIntakeSlotAction(snoozeEvent, { intake: domainFor(records, now), records, now, getSlotMeds: slotMeds(['med-a', 'med-b']) });

        const intakes = await records.list('intake');
        for (const id of [`intake-med-a-${SLOT_UNIX}`, 'intake-med-b-drift']) {
            const i = intakes.find((r) => r.recordId === id);
            expect(i.status).toBe('PENDING');
            expect(Date.parse(i.snoozed_until)).toBe((TAP_UNIX + 600) * 1000);
        }
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

// bd med-nzz Task 4 — a server-parsed NXK import sealed as one vitals_import
// event, drained and written into vault vitals records through the real
// createVitalsDomain. The properties that matter — every stream lands, GPS never
// does, and a re-drain converges (day-batched samples merge by instant, the rest
// upsert by natural key) — are properties of that domain, so it runs unstubbed.
describe('inbox-apply.js — a server-parsed NXK vitals_import', () => {
    const SLEEP_START = '2026-01-01T23:00:00.000Z';
    const SLEEP_END = '2026-01-02T07:00:00.000Z';

    function vitalsEvent() {
        return {
            kind: VITALS_IMPORT,
            at_unix: SLOT_UNIX,
            sleep: [{
                start_time: SLEEP_START, end_time: SLEEP_END, timezone_offset: 0,
                day: '2026-01-01', total_minutes: 480, deep_minutes: 120, heart_rate_avg: 58,
                user_modified: false,
            }],
            hr: [
                { date_time: '2026-01-01T08:00:00.000Z', tz_offset: 0, value: 70, type: 0 },
                { date_time: '2026-01-01T09:00:00.000Z', tz_offset: 0, value: 72, type: 0 },
                { date_time: '2026-01-02T08:00:00.000Z', tz_offset: 0, value: 68, type: 0 },
            ],
            spo2: [{ date_time: '2026-01-01T08:00:00.000Z', tz_offset: 0, value: 98, type: 0 }],
            stress: [{ date_time: '2026-01-01T08:00:00.000Z', tz_offset: 0, value: 30, type: 0, info: 'relaxed' }],
            daystats: [{ day: '2026-01-01', steps: 8000, calories: 400, distance: 6000 }],
            workouts: [{
                source_start_ms: 1767250800000, source_end_ms: 1767252600000,
                activity_type: 1, activity_name: 'Outdoor Run', duration_sec: 1800,
                distance_m: 5000, steps: 6000, calories: 300, heart_rate_avg: 140,
                spo2_avg: 97, pause_ms: 0, tz_offset: 0,
            }],
        };
    }

    it('writes every stream into vault records and never carries GPS', async () => {
        const records = fakeRecords();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });
        await apply(vitalsEvent(), 42);

        expect(await records.list('sleep')).toHaveLength(1);
        expect((await records.list('sleep'))[0].heart_rate_avg).toBe(58);
        expect(await records.list('daystats')).toHaveLength(1);
        expect((await records.list('daystats'))[0].steps).toBe(8000);

        // HR day-batched: two UTC days, the 01-01 batch holds both samples.
        const hr = await records.list('hrsample');
        expect(hr).toHaveLength(2);
        const jan1 = hr.find((r) => r.recordId === 'hrsample-2026-01-01');
        expect(jan1.samples).toHaveLength(2);
        expect(await records.list('spo2sample')).toHaveLength(1);
        expect(await records.list('stresssample')).toHaveLength(1);

        const miband = await records.list('miband');
        expect(miband).toHaveLength(1);
        expect(miband[0].source_start_ms).toBe(1767250800000);
        // GPS is never sealed and must never appear on the record.
        expect('gps' in miband[0]).toBe(false);
    });

    it('re-draining the same import converges with no duplicates', async () => {
        const records = fakeRecords();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });
        await apply(vitalsEvent(), 42);
        await apply(vitalsEvent(), 42);

        expect(await records.list('sleep')).toHaveLength(1);
        expect(await records.list('daystats')).toHaveLength(1);
        expect(await records.list('hrsample')).toHaveLength(2);
        expect((await records.list('hrsample')).find((r) => r.recordId === 'hrsample-2026-01-01').samples).toHaveLength(2);
        expect(await records.list('spo2sample')).toHaveLength(1);
        expect(await records.list('stresssample')).toHaveLength(1);
        expect(await records.list('miband')).toHaveLength(1);
    });

    // med-1tj — the cross-path convergence bug. A full-vault import (vault.js
    // vaultToRecords) and a later .nxk browser migration (this vitals_import
    // path) must mint the SAME recordId for one physical night/session, or
    // overview() blind-sums the duplicates (the reported 35h sleep). Seed the
    // store exactly as an archive import would, then drain the .nxk import of the
    // same night — one record must survive, and the sleep total must not double.
    it('a full-vault import then an nxk import of the same night converges to one record', async () => {
        const records = fakeRecords();
        const NOW = Date.parse('2026-01-02T12:00:00.000Z'); // 1 day after the night → in the 7d window
        const vault = {
            format: 'medtracker-vault', version: 1,
            data: {
                vitals: {
                    sleep: [{
                        start_time: SLEEP_START, end_time: SLEEP_END, timezone_offset: 0,
                        day: '2026-01-01', total_minutes: 480, deep_minutes: 120, heart_rate_avg: 58,
                    }],
                },
                workouts: {
                    miband: [{
                        source_start_ms: 1767250800000, source_end_ms: 1767252600000,
                        activity_type: 1, activity_name: 'Outdoor Run', duration_sec: 1800,
                        distance_m: 5000, steps: 6000, calories: 300, heart_rate_avg: 140,
                        spo2_avg: 97, pause_ms: 0, tz_offset: 0,
                    }],
                },
            },
        };
        for (const r of vaultToRecords(vault, { now: NOW })) await records.put(r.recordType, r);
        expect(await records.list('sleep')).toHaveLength(1);
        expect(await records.list('miband')).toHaveLength(1);

        // Now the .nxk migration drains for the SAME night/session.
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => NOW });
        await apply(vitalsEvent(), 42);

        // Both paths minted the same natural-key recordId → still one record each.
        expect(await records.list('sleep')).toHaveLength(1);
        expect(await records.list('miband')).toHaveLength(1);

        // overview() sums per-day sleep minutes with no identity awareness, so a
        // duplicate would read as 16h. One record → 480min = exactly 8h.
        const vitals = createVitalsDomain({ records, now: () => NOW, timeZone: 'UTC' });
        const ov = await vitals.overview();
        expect(ov.average_sleep_hours_7d).toBe(8);
    });

    it('a stale/partial re-import never downgrades richer stored data (mirrors bot-mode MAX/COALESCE)', async () => {
        const records = fakeRecords();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });
        // First a full/newer import, then an older partial one for the SAME
        // day/session/workout (the drain's replay-on-failed-flush can reorder).
        await apply(vitalsEvent(), 42);
        const stale = vitalsEvent();
        stale.daystats = [{ day: '2026-01-01', steps: 3000, calories: 100, distance: 2000 }];
        stale.sleep = [{
            start_time: SLEEP_START, end_time: SLEEP_END, timezone_offset: 0,
            day: '2026-01-01', total_minutes: 200, user_modified: false,
        }];
        stale.workouts = [{
            source_start_ms: 1767250800000, source_end_ms: 1767252600000,
            activity_type: 0, activity_name: '', duration_sec: 0,
            distance_m: 0, steps: 0, calories: 0, heart_rate_avg: 0,
            spo2_avg: 0, pause_ms: 0, tz_offset: 0,
        }];
        await apply(stale, 43);

        // daystats: MAX wins — the higher earlier totals survive.
        expect((await records.list('daystats'))[0].steps).toBe(8000);
        // sleep: the longer session (and its deep_minutes / heart_rate_avg) survives.
        const sleep = (await records.list('sleep'))[0];
        expect(sleep.total_minutes).toBe(480);
        expect(sleep.deep_minutes).toBe(120);
        expect(sleep.heart_rate_avg).toBe(58);
        // workout: zeroed incoming fields fall back to the populated stored row.
        const miband = (await records.list('miband'))[0];
        expect(miband.steps).toBe(6000);
        expect(miband.distance_m).toBe(5000);
        expect(miband.activity_name).toBe('Outdoor Run');
    });

    // Task 4/5 (med-0cf) — the defensive client record split. A day whose merged
    // sample count exceeds MAX_SAMPLES_PER_RECORD (500) must fan out into
    // '<type>-<day>' + '<type>-<day>#k' sub-records so no single op's ct blows the
    // server's 64 KiB cap. The read side must still union every part.
    const MAX_PER_RECORD = 500; // must match web/domain/vitals.js MAX_SAMPLES_PER_RECORD

    // 600 HR samples on one UTC day, 2 min apart from 00:00 (20h, all in-day). The
    // first 500 (by instant → part 0) read 60, the last 100 (→ #1) read 120, so a
    // 30d average of exactly 70 is reachable only if BOTH parts are read.
    function denseDayEvent() {
        const day0 = Date.parse('2026-01-01T00:00:00.000Z');
        const hr = Array.from({ length: 600 }, (_, i) => ({
            date_time: new Date(day0 + i * 120000).toISOString(),
            tz_offset: 0, value: i < MAX_PER_RECORD ? 60 : 120, type: 0,
        }));
        return { kind: VITALS_IMPORT, at_unix: SLOT_UNIX, hr };
    }
    // Read after the day so every sample is <= now and inside the 7d/30d window.
    const readNow = () => Date.parse('2026-01-02T12:00:00.000Z');

    it('splits a dense day into ≤MAX sub-records the read side still unions whole', async () => {
        const records = fakeRecords();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });
        await apply(denseDayEvent(), 42);

        const hrRecs = await records.list('hrsample');
        expect(hrRecs.map((r) => r.recordId).sort())
            .toEqual(['hrsample-2026-01-01', 'hrsample-2026-01-01#1']);
        for (const r of hrRecs) expect(r.samples.length).toBeLessThanOrEqual(MAX_PER_RECORD);
        expect(hrRecs.reduce((n, r) => n + r.samples.length, 0)).toBe(600);

        // The read path unions both parts: avg 70 requires all 600 (part 0 alone → 60).
        const vitals = createVitalsDomain({ records, now: readNow, timeZone: 'UTC' });
        const ov = await vitals.overview();
        expect(ov.average_heart_rate_30d).toBe(70);
    });

    it('re-applying a dense-day import is idempotent (no duplicate samples across parts)', async () => {
        const records = fakeRecords();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });
        await apply(denseDayEvent(), 42);
        await apply(denseDayEvent(), 42);

        const hrRecs = await records.list('hrsample');
        expect(hrRecs).toHaveLength(2);
        expect(hrRecs.reduce((n, r) => n + r.samples.length, 0)).toBe(600);
        const vitals = createVitalsDomain({ records, now: readNow, timeZone: 'UTC' });
        expect((await vitals.overview()).average_heart_rate_30d).toBe(70);
    });
});

// bd med-eas.29.2 — a data command sealed as RAW text by the relay, parsed and
// written HERE, by the same domain modules the UI uses. These run against the
// real bp/weight/notes domains for the same reason the tap tests do: the
// properties that matter (backdating to arrival, and a re-drain overwriting
// rather than appending) belong to those domains, not to this module.
describe('inbox-apply.js — a Telegram data command', () => {
    const CMD_UNIX = SLOT_UNIX + 3600;
    const CMD_MS = CMD_UNIX * 1000;
    const REPLY_ID = 4242;

    // The raw AI shape (per-100g macros), stubbed at the provider boundary — the
    // real foodAI + food domains still run, so recordId threading and the actual
    // meal write are exercised, not mocked.
    const TWO_EGGS = [{ name: 'eggs', weight_grams: 100, carbs_100g: 1, protein_100g: 13, fat_100g: 11 }];
    function stubAIClient(items) {
        return {
            parseMealFromDescription: async () => ({ items }),
            parseMealFromImage: async () => ({ items }),
        };
    }
    function noKeyAIClient() {
        const noKey = () => {
            const e = new Error('no api key');
            e.code = 'no_api_key';
            throw e;
        };
        return { parseMealFromDescription: noKey, parseMealFromImage: noKey };
    }
    // The trial gate's refusal (web/cloud/js/aiclient.js) — like no_api_key,
    // a permanent condition for the message: must be answered and acked,
    // never re-queued.
    function consentRefusingAIClient() {
        const refuse = () => {
            const e = new Error('trial consent required');
            e.code = 'trial_consent_required';
            e.scope = 'ai';
            throw e;
        };
        return { parseMealFromDescription: refuse, parseMealFromImage: refuse };
    }

    function domainsFor(records, now, aiClient = stubAIClient(TWO_EGGS)) {
        return {
            bp: createBPDomain({ records, now, timeZone: 'UTC' }),
            weight: createWeightDomain({ records, now, timeZone: 'UTC' }),
            notes: createNotesDomain({ records, now }),
            intake: domainFor(records, now),
            foodAI: createFoodAIDomain({ aiClient, foodDomain: createFoodDomain({ records, now, timeZone: 'UTC' }), now }),
            workout: createWorkoutDomain({ records, now, timeZone: 'UTC' }),
            records,
            now,
        };
    }

    function commandEvent(text) {
        return { kind: TG_COMMAND, text, at_unix: CMD_UNIX, reply_message_id: REPLY_ID };
    }

    it('/bp writes through the BP domain, backdated to when the message arrived', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/bp 128 84 66'), 7, { ...domainsFor(records, now), editReply });

        const bps = await records.list('bp');
        expect(bps).toHaveLength(1);
        expect(bps[0]).toMatchObject({ systolic: 128, diastolic: 84, pulse: 66 });
        // Backdated to arrival (drain rule 4), NOT to the drain 3h later.
        expect(Date.parse(bps[0].measured_at)).toBe(CMD_MS);
        // Deterministic id derived from the mailbox event.
        expect(bps[0].recordId).toBe('tg-7');
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Recorded BP 128\/84/));
    });

    it('re-draining the same event overwrites its own row instead of logging a second reading', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const opts = { ...domainsFor(records, now), editReply: vi.fn() };
        await applyTGCommand(commandEvent('/bp 128 84'), 7, opts);
        await applyTGCommand(commandEvent('/bp 128 84'), 7, opts);

        expect(await records.list('bp')).toHaveLength(1);
    });

    it('/weight and /note write through their own domains', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/weight 81,2'), 8, { ...domainsFor(records, now), editReply });
        await applyTGCommand(commandEvent('/note felt dizzy after lunch'), 9, { ...domainsFor(records, now), editReply });

        expect(await records.list('weight')).toMatchObject([{ weight: 81.2, recordId: 'tg-8' }]);
        expect(await records.list('note')).toMatchObject([{ content: 'felt dizzy after lunch', recordId: 'tg-9' }]);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/81\.2 kg/));
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Note saved/));
    });

    it('/intake confirms every dose already due, and reports how many', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/intake'), 10, { ...domainsFor(records, now), editReply });

        const intakes = await records.list('intake');
        const atSlot = intakes.filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot.every((i) => i.status === 'TAKEN')).toBe(true);
        // The dose 12h later was NOT due at message time — confirming it would be a lie.
        const later = intakes.find((i) => i.scheduled_at !== SLOT_ISO);
        expect(later.status).toBe('PENDING');
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Confirmed 2 medications/));
    });

    it('generic verbosity never echoes a health value back through Telegram', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/bp 128 84'), 11, { ...domainsFor(records, now), verbosity: 'generic', editReply });

        const [, text] = editReply.mock.calls[0];
        expect(text).toBe('✅ Recorded.');
        expect(text).not.toContain('128');
        expect(text).not.toContain('84');
    });

    it('an invalid reading is refused with a usage hint and writes nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        // Transposed systolic/diastolic — unrecoverable once it is a chart point.
        await applyTGCommand(commandEvent('/bp 12 80'), 12, { ...domainsFor(records, now), editReply });

        expect(await records.list('bp')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/systolic must be the larger/));
    });

    it('unknown and not-yet-supported commands are answered, not silently dropped', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/bogus'), 13, { ...domainsFor(records, now), editReply });
        await applyTGCommand(commandEvent('/tz'), 14, { ...domainsFor(records, now), editReply });

        expect(editReply).toHaveBeenNthCalledWith(1, REPLY_ID, expect.stringMatching(/don't understand \/bogus/));
        expect(editReply).toHaveBeenNthCalledWith(2, REPLY_ID, expect.stringMatching(/\/tz isn't available over chat yet/));
    });

    it('/workout logs a completed ad-hoc session through the shared workout domain', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        // The domain injected by domainsFor stamps from `now`; the applier wires
        // the arrival clock in production, but here we only assert the session is
        // created, completed, and labelled — not the backdating (its own test).
        await applyTGCommand(commandEvent('/workout legs'), 14, { ...domainsFor(records, now), editReply });

        const sessions = await records.list('workoutsession');
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ status: 'completed', notes: 'legs', recordId: 'tg-14' });
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Logged workout: legs/));
    });

    it('a bare /workout logs an unnamed completed workout', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/workout'), 15, { ...domainsFor(records, now), editReply });

        const sessions = await records.list('workoutsession');
        expect(sessions).toMatchObject([{ status: 'completed', recordId: 'tg-15' }]);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Workout logged/));
    });

    it('re-draining the same /workout event overwrites its session instead of logging a second workout', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const opts = { ...domainsFor(records, now), editReply: vi.fn() };
        await applyTGCommand(commandEvent('/workout legs'), 14, opts);
        await applyTGCommand(commandEvent('/workout legs'), 14, opts);

        expect(await records.list('workoutsession')).toHaveLength(1);
    });

    it('/food parses the description client-side and logs the meal, backdated to arrival', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/food 2 eggs'), 20, { ...domainsFor(records, now), editReply });

        const logs = await records.list('foodlog');
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ name: 'eggs', weight: 100, recordId: 'tg-20-0' });
        // Backdated to when the message arrived (drain rule 4), not the drain.
        expect(Date.parse(logs[0].eaten_at)).toBe(CMD_MS);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Logged 1 food item/));
    });

    it('re-draining the same /food event overwrites its own rows instead of duplicating', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const opts = { ...domainsFor(records, now), editReply: vi.fn() };
        await applyTGCommand(commandEvent('/food 2 eggs'), 20, opts);
        await applyTGCommand(commandEvent('/food 2 eggs'), 20, opts);

        expect(await records.list('foodlog')).toHaveLength(1);
    });

    it('bare /food is refused with a usage hint and logs nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/food'), 21, { ...domainsFor(records, now), editReply });

        expect(await records.list('foodlog')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Usage: \/food/));
    });

    it('/food with no configured key tells the user to add one, acks, and logs nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        // Resolves (event acked) rather than throwing — a missing key is permanent
        // for this message, so re-queuing forever would stall the mailbox.
        await expect(applyTGCommand(commandEvent('/food 2 eggs'), 22, { ...domainsFor(records, now, noKeyAIClient()), editReply }))
            .resolves.toBeUndefined();

        expect(await records.list('foodlog')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/add an OpenAI key/));
    });

    it('/food with trial consent not granted points at Settings, acks, and logs nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        // Resolves (event acked): ungranted consent is permanent for this
        // message — re-queuing would retry it on every drain tick forever.
        await expect(applyTGCommand(commandEvent('/food 2 eggs'), 23, { ...domainsFor(records, now, consentRefusingAIClient()), editReply }))
            .resolves.toBeUndefined();

        expect(await records.list('foodlog')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/allow it first in Settings/));
    });

    it('a failed edit never fails the drain — the record is already in the vault', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const editReply = vi.fn().mockRejectedValue(new Error('telegram down'));
        // Resolves: a Telegram outage must not strand an event whose write landed.
        await expect(applyTGCommand(commandEvent('/bp 128 84'), 15, { ...domainsFor(records, now), editReply }))
            .resolves.toBeUndefined();
        expect(await records.list('bp')).toHaveLength(1);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    // --- Photo food logging (bd med-vcv.1) ---
    function photoEvent() {
        return { kind: TG_PHOTO, file_id: 'large', mime: 'image/jpeg', size: 9000, at_unix: CMD_UNIX, reply_message_id: REPLY_ID };
    }
    // A fetch that returns a Blob-like the aiClient stub never actually reads.
    function okFetchPhoto() {
        return vi.fn().mockResolvedValue({ type: 'image/jpeg', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    }
    // foodAI only (the piece applyTGPhoto needs) built from a real domain + stub aiClient.
    function foodAIFor(records, now, aiClient = stubAIClient(TWO_EGGS)) {
        return createFoodAIDomain({ aiClient, foodDomain: createFoodDomain({ records, now, timeZone: 'UTC' }), now });
    }

    it('a photo is fetched, AI-parsed, and logged — backdated to arrival', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGPhoto(photoEvent(), 30, { foodAI: foodAIFor(records, now), editReply, fetchPhoto: okFetchPhoto() });

        const logs = await records.list('foodlog');
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ name: 'eggs', weight: 100, recordId: 'tg-30-0' });
        expect(Date.parse(logs[0].eaten_at)).toBe(CMD_MS);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Logged 1 food item/));
    });

    it('re-draining the same photo event overwrites its own rows instead of duplicating', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const opts = { foodAI: foodAIFor(records, now), editReply: vi.fn(), fetchPhoto: okFetchPhoto() };
        await applyTGPhoto(photoEvent(), 30, opts);
        await applyTGPhoto(photoEvent(), 30, opts);

        expect(await records.list('foodlog')).toHaveLength(1);
    });

    it('a photo the relay cannot fetch is answered and acked, logging nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const editReply = vi.fn();
        const fetchPhoto = vi.fn().mockRejectedValue(new Error('photo fetch failed: 502'));
        await expect(applyTGPhoto(photoEvent(), 31, { foodAI: foodAIFor(records, now), editReply, fetchPhoto }))
            .resolves.toBeUndefined();

        expect(await records.list('foodlog')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Couldn't fetch that photo/));
        warn.mockRestore();
    });

    it('a photo with no configured key tells the user to add one, acks, and logs nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await expect(applyTGPhoto(photoEvent(), 32, { foodAI: foodAIFor(records, now, noKeyAIClient()), editReply, fetchPhoto: okFetchPhoto() }))
            .resolves.toBeUndefined();

        expect(await records.list('foodlog')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/add an OpenAI key/));
    });

    it('a photo with trial consent not granted points at Settings — not the misleading "no food" reply', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await expect(applyTGPhoto(photoEvent(), 33, { foodAI: foodAIFor(records, now, consentRefusingAIClient()), editReply, fetchPhoto: okFetchPhoto() }))
            .resolves.toBeUndefined();

        expect(await records.list('foodlog')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/allow it first in Settings/));
    });

    // --- Free-text AI agent (bd med-vcv.2) ---
    // The loop itself is pinned in tg-agent.test.js; here the agent is a stub so
    // only applyTGText's own responsibility — reply, verbosity, error-ack — is
    // under test, the same way the food tests stub the provider boundary.
    function textEvent(text) {
        return { kind: TG_TEXT, text, at_unix: CMD_UNIX, reply_message_id: REPLY_ID };
    }

    it('a free-text message gets the agent answer as its edited reply', async () => {
        const records = fakeRecords();
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('Logged 2 eggs (140 kcal).') };
        await applyTGText(textEvent('i ate two eggs'), 40, { agent, records, editReply });
        expect(agent.run).toHaveBeenCalledWith('i ate two eggs');
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, 'Logged 2 eggs (140 kcal).');
    });

    it('re-draining the same free-text event does NOT re-run the (non-idempotent, billed) agent', async () => {
        const records = fakeRecords();
        const agent = { run: vi.fn().mockResolvedValue('done') };
        const opts = { agent, records, editReply: vi.fn() };
        await applyTGText(textEvent('log my weight 80kg'), 40, opts);
        await applyTGText(textEvent('log my weight 80kg'), 40, opts);
        expect(agent.run).toHaveBeenCalledTimes(1);
    });

    it('generic verbosity suppresses the answer so no health value crosses Telegram', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('Your BP this week averaged 128/84.') };
        await applyTGText(textEvent('what was my bp?'), 41, { agent, records: fakeRecords(), verbosity: 'generic', editReply });
        const [, text] = editReply.mock.calls[0];
        expect(text).toBe('✅ Done.');
        expect(text).not.toContain('128');
    });

    it('a long answer is truncated under the relay edit cap', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('x'.repeat(5000)) };
        await applyTGText(textEvent('tell me everything'), 42, { agent, records: fakeRecords(), editReply });
        const [, text] = editReply.mock.calls[0];
        expect([...text].length).toBeLessThanOrEqual(900);
        expect(text.endsWith('…')).toBe(true);
    });

    it('a no-key agent tells the user to add one and acks', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(Object.assign(new Error('no key'), { code: 'no_api_key' })) };
        await expect(applyTGText(textEvent('hi'), 43, { agent, records: fakeRecords(), editReply })).resolves.toBeUndefined();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/add an OpenAI key/));
    });

    it('an agent refused for missing trial consent points at Settings, not "try again"', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(Object.assign(new Error('consent'), { code: 'trial_consent_required', scope: 'tg' })) };
        await expect(applyTGText(textEvent('hi'), 45, { agent, records: fakeRecords(), editReply })).resolves.toBeUndefined();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/allow it first in Settings/));
    });

    it('any other agent failure is answered and acked, never left dangling', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(new Error('provider exploded')) };
        await expect(applyTGText(textEvent('hi'), 44, { agent, records: fakeRecords(), editReply })).resolves.toBeUndefined();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/went wrong/));
        warn.mockRestore();
    });

    it('an empty agent answer still edits the placeholder to a done ack', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('   ') };
        await applyTGText(textEvent('hi'), 45, { agent, records: fakeRecords(), editReply });
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, '✅ Done.');
    });
});

// The parser lives in web/domain/tgcommand.js (pure, runtime-agnostic) and is
// exercised end-to-end above; this table pins the edges that are cheap to get
// wrong and expensive to notice — the "@botname" group form especially, since
// the relay's Go botCommand() and this must agree on what counts as a command.
describe('tgcommand.js — parsing', () => {
    it('normalizes the command token the same way the relay does', () => {
        expect(commandToken('/BP 120 80')).toBe('/bp');
        expect(commandToken('/bp@my_med_bot 120 80')).toBe('/bp');
        expect(commandToken('  /note hello')).toBe('/note');
        expect(commandToken('two eggs')).toBe('');
        expect(commandToken('')).toBe('');
    });

    it('accepts both separator styles bot mode accepts', () => {
        expect(parseCommand('/bp 120 80')).toMatchObject({ kind: 'bp', systolic: 120, diastolic: 80, pulse: null });
        expect(parseCommand('/bp 120/80')).toMatchObject({ kind: 'bp', systolic: 120, diastolic: 80 });
        expect(parseCommand('/bp 120/80 65')).toMatchObject({ kind: 'bp', pulse: 65 });
    });

    it('rejects readings that would silently corrupt a chart', () => {
        expect(parseCommand('/bp 12 80').kind).toBe('invalid');   // transposed
        expect(parseCommand('/bp 120').kind).toBe('invalid');     // missing diastolic
        expect(parseCommand('/bp abc def').kind).toBe('invalid');
        expect(parseCommand('/weight 900').kind).toBe('invalid');
        expect(parseCommand('/weight').kind).toBe('invalid');
        expect(parseCommand('/note').kind).toBe('invalid');
    });

    it('accepts a decimal comma, which half of Europe types', () => {
        expect(parseCommand('/weight 81,2')).toMatchObject({ kind: 'weight', weight: 81.2 });
    });

    it('separates "not yet" from "no idea", because they are different apologies', () => {
        expect(parseCommand('/tz')).toMatchObject({ kind: 'unsupported', command: '/tz' });
        expect(parseCommand('/bogus')).toMatchObject({ kind: 'unknown', command: '/bogus' });
    });

    it('/food keeps the free-text remainder verbatim for a client-side AI parse', () => {
        expect(parseCommand('/food two eggs')).toMatchObject({ kind: 'food', command: '/food', text: 'two eggs' });
        expect(parseCommand('/food').kind).toBe('invalid');
    });

    it('/workout keeps an optional name and treats a bare command as valid', () => {
        expect(parseCommand('/workout legs')).toMatchObject({ kind: 'workout', command: '/workout', name: 'legs' });
        expect(parseCommand('/workout')).toMatchObject({ kind: 'workout', command: '/workout', name: '' });
    });

    it('marks relay-answered commands local, and free text as not a command', () => {
        expect(parseCommand('/start').kind).toBe('local');
        expect(parseCommand('/help').kind).toBe('local');
        expect(parseCommand('I ate two eggs').kind).toBe('not_a_command');
    });
});

// bd med-vcv.3 — the self-refining tgprefs note. These drive the REAL tg-agent
// (with a stub `chat`) and the REAL vault prefs port (makeTGPrefsPort over the
// fake records), so the two properties that matter — the note reaching the
// system prompt, and remember_preference appending oldest-out under the cap —
// are exercised end-to-end, not mocked. Only the LLM boundary is stubbed.
describe('inbox-apply.js — self-refining tgprefs (med-vcv.3)', () => {
    const TXT_UNIX = SLOT_UNIX + 3600;
    const REPLY_ID = 4343;
    const now = () => DRAIN_MS;
    const stubDispatcher = { handle: vi.fn() }; // no mcp_* tool is exercised here
    const textEvent = (text) => ({ kind: TG_TEXT, text, at_unix: TXT_UNIX, reply_message_id: REPLY_ID });
    const rememberCall = (note, id = 't1') => ({
        content: '',
        tool_calls: [{ id, function: { name: 'remember_preference', arguments: JSON.stringify({ note }) } }],
    });

    // (a) INJECT
    it('injects the stored tgprefs note into the agent system prompt', async () => {
        const records = fakeRecords({ tgprefs: [{ recordId: 'tgprefs', deleted: false, note: '"my usual" = 2 eggs + toast' }] });
        const captured = [];
        const chat = vi.fn(async ({ messages }) => { captured.push(messages); return { content: 'ok' }; });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, prefs: makeTGPrefsPort(records, now) });

        await applyTGText(textEvent('what did i have'), 50, { agent, records, editReply: vi.fn(), now });

        const system = captured[0].find((m) => m.role === 'system').content;
        expect(system).toContain('"my usual" = 2 eggs + toast');
        expect(system).toContain('how THIS user talks');
    });

    it('leaves the system prompt at the base when no note is stored', async () => {
        const records = fakeRecords();
        const captured = [];
        const chat = vi.fn(async ({ messages }) => { captured.push(messages); return { content: 'ok' }; });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, prefs: makeTGPrefsPort(records, now) });

        await applyTGText(textEvent('hi'), 51, { agent, records, editReply: vi.fn(), now });

        const system = captured[0].find((m) => m.role === 'system').content;
        // No note → no injection header dangling on the base prompt.
        expect(system).not.toContain('how THIS user talks');
    });

    // (b) APPEND + CAP
    it('the agent appends a durable preference to the tgprefs vault record', async () => {
        const records = fakeRecords();
        const chat = vi.fn()
            .mockResolvedValueOnce(rememberCall('"my usual" = 2 eggs + toast'))
            .mockResolvedValueOnce({ content: 'Noted.' });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, prefs: makeTGPrefsPort(records, now) });

        await applyTGText(textEvent('by my usual i mean 2 eggs and toast'), 52, { agent, records, editReply: vi.fn(), now });

        const rec = (await records.list('tgprefs')).find((r) => r.recordId === 'tgprefs' && !r.deleted);
        expect(rec.note).toContain('"my usual" = 2 eggs + toast');
    });

    it('appending past the cap drops the OLDEST whole lines and stays within it', async () => {
        // 40 lines × exactly 100 chars each = 4039 with newlines, just under the 4096 cap.
        const seedLines = Array.from({ length: 40 }, (_, i) => `line${i}`.padEnd(100, '.'));
        const records = fakeRecords({ tgprefs: [{ recordId: 'tgprefs', deleted: false, note: seedLines.join('\n') }] });
        const newLine = 'newpref'.padEnd(100, '.');
        const chat = vi.fn()
            .mockResolvedValueOnce(rememberCall(newLine))
            .mockResolvedValueOnce({ content: 'Noted.' });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, prefs: makeTGPrefsPort(records, now) });

        await applyTGText(textEvent('remember this'), 53, { agent, records, editReply: vi.fn(), now });

        const note = (await records.list('tgprefs')).find((r) => r.recordId === 'tgprefs' && !r.deleted).note;
        expect(note.length).toBeLessThanOrEqual(4096);
        const noteLines = note.split('\n');
        expect(noteLines[0]).toBe(seedLines[1]);                 // oldest (line0) evicted
        expect(noteLines[noteLines.length - 1]).toBe(newLine);   // newest appended at the end
        expect(note.includes(seedLines[0])).toBe(false);
    });

    // (c) IDEMPOTENCY — no second gate; the existing tgagentrun marker gates the whole run.
    it('re-draining a free-text event runs remember_preference only ONCE', async () => {
        const records = fakeRecords();
        const chat = vi.fn()
            .mockResolvedValueOnce(rememberCall('my usual = 2 eggs'))
            .mockResolvedValueOnce({ content: 'Noted.' });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, prefs: makeTGPrefsPort(records, now) });
        const opts = { agent, records, editReply: vi.fn(), now };

        await applyTGText(textEvent('by my usual i mean 2 eggs'), 54, opts);
        await applyTGText(textEvent('by my usual i mean 2 eggs'), 54, opts);

        // First drain: one run = two chat calls. Second drain: marker present → skipped.
        expect(chat).toHaveBeenCalledTimes(2);
        const note = (await records.list('tgprefs')).find((r) => r.recordId === 'tgprefs' && !r.deleted).note;
        const occurrences = note.split('\n').filter((l) => l === 'my usual = 2 eggs').length;
        expect(occurrences).toBe(1);
    });
});

// med-eas.70 — a Telegram workout Snooze/Skip tap drains onto the deterministic
// session-<groupId>-<date> slot (find-or-create — the tap can arrive before the
// session is materialized).
describe('inbox-apply.js — a Telegram workout Snooze/Skip tap', () => {
    const WGROUP = 6;
    const WDATE = '2026-07-20';
    const WRECORD = `session-${WGROUP}-${WDATE}`;
    const WTAP_UNIX = 1784592000; // 2026-07-20T16:00:00Z
    const WTAP_MS = WTAP_UNIX * 1000;

    function workoutFor(records) {
        return createWorkoutDomain({ records, now: () => WTAP_MS, timeZone: 'UTC' });
    }
    const snooze1hEvent = { kind: WORKOUT_SESSION_ACTION, group_id: WGROUP, date: WDATE, action: 'snooze1h', at_unix: WTAP_UNIX, message_id: 900 };
    const skipEvent = { kind: WORKOUT_SESSION_ACTION, group_id: WGROUP, date: WDATE, action: 'skip', at_unix: WTAP_UNIX, message_id: 901 };

    it('snooze1h creates the deterministic session and sets snoozed_until + snooze_count', async () => {
        const records = fakeRecords();
        await applyWorkoutSessionAction(snooze1hEvent, { workout: workoutFor(records), editReply: vi.fn() });
        const s = (await records.list('workoutsession')).find((r) => r.recordId === WRECORD);
        expect(s).toBeTruthy();
        expect(s.group_id).toBe(WGROUP);
        expect(s.snooze_count).toBe(1);
        expect(Date.parse(s.snoozed_until)).toBe(WTAP_MS + 60 * 60 * 1000);
    });

    it('snooze2h fires ~2h out on an already-materialized session, bumping snooze_count', async () => {
        const records = fakeRecords({
            workoutsession: [{
                recordId: WRECORD, deleted: false, id: 42, group_id: WGROUP, variant_id: 0,
                scheduled_date: WDATE, status: 'notified', snoozed_until: null, snooze_count: 1,
            }],
        });
        await applyWorkoutSessionAction(
            { ...snooze1hEvent, action: 'snooze2h' },
            { workout: workoutFor(records), editReply: vi.fn() },
        );
        const s = (await records.list('workoutsession')).find((r) => r.recordId === WRECORD);
        expect(s.snooze_count).toBe(2);
        expect(Date.parse(s.snoozed_until)).toBe(WTAP_MS + 120 * 60 * 1000);
    });

    it('skip marks the session skipped (creating it if absent)', async () => {
        const records = fakeRecords();
        await applyWorkoutSessionAction(skipEvent, { workout: workoutFor(records), editReply: vi.fn() });
        const s = (await records.list('workoutsession')).find((r) => r.recordId === WRECORD);
        expect(s.status).toBe('skipped');
    });

    // Regression (codex): a stale/re-delivered Skip that drains AFTER the session
    // was completed in-app must no-op — not overwrite 'completed' back to 'skipped'
    // and not advance rotation a second time on top of the completion.
    it('skip no-ops on a session already completed elsewhere', async () => {
        const records = fakeRecords({
            workoutsession: [{
                recordId: WRECORD, deleted: false, id: 42, group_id: WGROUP, variant_id: 0,
                scheduled_date: WDATE, status: 'completed', snoozed_until: null, snooze_count: 0,
            }],
        });
        await applyWorkoutSessionAction(skipEvent, { workout: workoutFor(records), editReply: vi.fn() });
        const s = (await records.list('workoutsession')).find((r) => r.recordId === WRECORD);
        expect(s.status).toBe('completed');
    });

    it('edits the Telegram reply to a receipt via the tap message id', async () => {
        const records = fakeRecords();
        const editReply = vi.fn(async () => {});
        await applyWorkoutSessionAction(snooze1hEvent, { workout: workoutFor(records), editReply });
        expect(editReply).toHaveBeenCalledWith(900, expect.stringMatching(/Snoozed/));
    });

    // Regression: a drain-created session must resolve the group's variant +
    // scheduled_time (not variant_id 0 / '') so getNext — which surfaces this very
    // session (P0 while notified today, P1 after the snooze elapses) and reads
    // variant_id/scheduled_time straight off it — renders the real workout instead
    // of "Unknown" variant / 0 exercises / no time.
    it('resolves the group variant so getNext shows the real workout, not "Unknown"', async () => {
        const records = fakeRecords({
            workoutgroup: [{ recordId: 'wg-6', deleted: false, id: WGROUP, name: 'Push Day', scheduled_time: '18:00', is_rotating: false }],
            workoutvariant: [{ recordId: 'wv-11', deleted: false, id: 11, group_id: WGROUP, name: 'Variant A' }],
            workoutexercise: [{ recordId: 'we-21', deleted: false, id: 21, variant_id: 11, exercise_name: 'Bench', order_index: 0, target_sets: 3, target_reps_min: 8 }],
        });
        // now() pinned to noon UTC on WDATE so the drain-created session is "today"
        // and getNext surfaces it via PRIORITY 0 (still notified) → buildSessionResponse.
        const nowMs = Date.UTC(2026, 6, 20, 12, 0, 0);
        const workout = createWorkoutDomain({ records, now: () => nowMs, timeZone: 'UTC' });
        await applyWorkoutSessionAction(
            { ...snooze1hEvent, at_unix: nowMs / 1000 },
            { workout, editReply: vi.fn() },
        );

        const s = (await records.list('workoutsession')).find((r) => r.recordId === WRECORD);
        expect(s.variant_id).toBe(11);
        expect(s.scheduled_time).toBe('18:00');

        const next = await workout.getNext();
        expect(next.variant_name).toBe('Variant A');
        expect(next.exercises_count).toBe(1);
        expect(next.session.scheduled_time).toBe('18:00');
    });

    // Regression: the created session's scheduled_date must carry the local offset
    // (like every other materializer) so new Date(scheduled_date) doesn't shift the
    // day backward in negative-offset zones and break is_today / sorting.
    it('stamps scheduled_date with the local offset, not a bare date', async () => {
        const records = fakeRecords();
        const workout = createWorkoutDomain({ records, now: () => WTAP_MS, timeZone: 'America/New_York' });
        await applyWorkoutSessionAction(snooze1hEvent, { workout, editReply: vi.fn() });
        const s = (await records.list('workoutsession')).find((r) => r.recordId === WRECORD);
        expect(s.scheduled_date).toBe('2026-07-20T00:00:00-04:00');
        expect(s.scheduled_date.split('T')[0]).toBe(WDATE);
    });
});
