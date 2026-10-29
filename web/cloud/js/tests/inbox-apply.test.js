// bd med-76c.2 part 2 — applying a sealed Telegram tap through the real intake
// domain. These run against createIntakeDomain (not a stub) because the two
// properties that matter — a re-drain converging instead of double-decrementing
// inventory, and a 09:00 tap recording 09:00 — are properties of that domain's
// behavior, not of this module's bookkeeping.
import { describe, expect, it, vi } from 'vitest';
import { createIntakeDomain, dosesAtInstant } from '../../../domain/medintake.js';
import { boundary } from '../../../domain/lineage.js';
import { applyIntakeSlotAction, OUT_OF_DATE_TEXT, applyWorkoutSessionAction, applyMeasureReminderAction, applyTGCommand, applyTGPhoto, applyTGText, createInboxApplier, createInboxRouter, makeTGPrefsPort, makeTGHistoryPort, INTAKE_SLOT_ACTION, TG_COMMAND, TG_PHOTO, TG_TEXT, VITALS_IMPORT, WORKOUT_SESSION_ACTION, MEASURE_REMINDER_ACTION } from '../inbox-apply.js';
import { createRemindersDomain, DONT_BUG_MS } from '../../../domain/reminders.js';
import { createTGAgent } from '../tg-agent.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createFoodDomain } from '../../../domain/food.js';
import { createFoodAIDomain } from '../../../domain/foodai.js';
import { createActivityAIDomain } from '../../../domain/activityai.js';
import { createWorkoutDomain } from '../../../domain/workout.js';
import { createVitalsDomain } from '../../../domain/vitals.js';
import { vaultToRecords } from '../../../domain/vault.js';
import { withMaterializationStopped, MaterializationPausedError } from '../materialize-gate.js';
import { commandToken, parseCommand } from '../../../domain/tgcommand.js';

const SLOT_UNIX = 1767225600; // 2026-01-01T00:00:00Z
const SLOT_ISO = new Date(SLOT_UNIX * 1000).toISOString();
const TAP_UNIX = SLOT_UNIX + 600; // tapped 10 minutes after the dose was due
const DRAIN_MS = (SLOT_UNIX + 4 * 3600) * 1000; // app first opened 4h later
// The account's ledger cut, a day before the slot: regeneration starts at the
// cut instant (bd med-wi09.12), so a vault with no cut row regenerates nothing
// before "now".
const CUT_BEFORE_SLOT = [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: new Date((SLOT_UNIX - 86400) * 1000).toISOString() }];
// A cut the day after the slot: the slot's day is wholly before the cut, where
// stored rows are the whole truth. The drift tests pin that pre-cut path — a
// drifted row is an old client's materialization. From the cut day on a slot is
// covered only by a row at its own instant, so a drifted row there sits next to
// the regenerated dose (N5, known; bd med-wi09.12).
const CUT_AFTER_SLOT_DAY = [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: new Date((SLOT_UNIX + 86400) * 1000).toISOString() }];

// Records port over an in-memory map, keyed by recordId within each type.
function fakeRecords(seed = {}) {
    const store = JSON.parse(JSON.stringify(seed));
    return {
        dump: () => store,
        list: async (type) => (store[type] || []).map((r) => ({ ...r })),
        // Mirrors sync.js recordsPort.listRaw: tombstones included, for the
        // readers whose state includes "deliberately deleted" (bd med-w0fe).
        listRaw: async (type) => (store[type] || []).map((r) => ({ ...r })),
        put: async (type, record) => {
            store[type] = (store[type] || []).filter((r) => r.recordId !== record.recordId);
            store[type].push({ ...record });
            return record;
        },
        // Mirrors sync.js recordsPort.putIfAbsent (bd med-qhpu) — the raw slot
        // decides, and the stored winner comes back either way.
        putIfAbsent: async (type, record) => {
            const existing = (store[type] || []).find((r) => r.recordId === record.recordId);
            if (existing) return { ...existing };
            store[type] = store[type] || [];
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

// The relay seals the med identity the reminder row carried into every tap
// (med-kbpf), so a slot event names its meds. medsNamed() overrides that set for
// the tests that need a different one.
const confirmEvent = { kind: INTAKE_SLOT_ACTION, slot_unix: SLOT_UNIX, action: 'confirm', at_unix: TAP_UNIX, medication_ids: ['med-a', 'med-b'] };
const snoozeEvent = { kind: INTAKE_SLOT_ACTION, slot_unix: SLOT_UNIX, action: 'snooze', at_unix: TAP_UNIX, medication_ids: ['med-a', 'med-b'] };
const medsNamed = (event, medication_ids) => ({ ...event, medication_ids });

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

    // bd med-wi09.11 / med-944k — the tap is stamped rev 1 / via telegram; after
    // an in-app undo (rev 2, UNTAKEN, acted after the tap) a re-drained copy of
    // the same tap is older than that undo and changes nothing.
    it('a callback writes rev 1 via telegram, and a re-drained tap never undoes an in-app undo', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const tg = createIntakeDomain({ records, now, timeZone: 'UTC', via: 'telegram' });
        const tapA = medsNamed(confirmEvent, ['med-a']);
        const id = `intake-med-a-${SLOT_UNIX}`;
        await applyIntakeSlotAction(tapA, { intake: tg, records, now });
        expect((await records.list('intake')).find((i) => i.recordId === id))
            .toMatchObject({ status: 'TAKEN', rev: 1, via: 'telegram', tz: 'UTC' });

        await domainFor(records, now).act({ occIds: [id], action: 'undo' });
        await applyIntakeSlotAction(tapA, { intake: tg, records, now });
        expect((await records.list('intake')).find((i) => i.recordId === id))
            .toMatchObject({ status: 'UNTAKEN', rev: 2, via: 'app' });
        expect((await records.list('medication')).find((m) => m.recordId === 'med-a').inventory_count).toBe(30);
    });

    // Two meds due at the same instant, seeded with a REAL schedule and NO
    // intake rows (bd med-wi09.12: nothing stores a PENDING prediction): the
    // projection lists both doses, and Confirm must record BOTH at their exact
    // ids.
    it('confirms every med at its exact id when the slot had no intake rows yet', async () => {
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'Lisinopril', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'Metformin', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 20 },
            ],
            intake: [],
            ledgercut: CUT_BEFORE_SLOT,
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now });

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot).toHaveLength(2);
        for (const i of atSlot) expect(i.status).toBe('TAKEN');
    });

    // The silent-revert regression (bd med-d4w) is gone at the root (bd
    // med-wi09.12): a device whose mirror predates the tap no longer writes a
    // PENDING row for the slot at all — it only shows the dose as due until
    // the confirm syncs in.
    it('a device that missed the confirm shows the dose as due and writes nothing', async () => {
        const med = { recordId: 'med-a', deleted: false, name: 'Lisinopril', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 };
        const now = () => DRAIN_MS;

        // Device A drained the Telegram tap and holds the confirmed dose.
        const deviceA = fakeRecords({ medication: [med], intake: [], ledgercut: CUT_BEFORE_SLOT });
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(deviceA, now), records: deviceA, now });
        const confirmed = (await deviceA.list('intake')).find((i) => i.scheduled_at === SLOT_ISO);
        expect(confirmed.status).toBe('TAKEN');

        // Device B was closed through all of it: same med, no intake rows yet.
        const deviceB = fakeRecords({ medication: [med], intake: [], ledgercut: CUT_BEFORE_SLOT });
        const due = await domainFor(deviceB, now).occurrences({ fromMs: SLOT_UNIX * 1000, toMs: DRAIN_MS });
        expect(due.map((r) => [r.occId, r.state])).toEqual([[confirmed.recordId, 'due']]);
        expect(await deviceB.list('intake')).toEqual([]);
    });

    // bd med-wi09.4 — reminder actions resolve exact ids only. One med's dose
    // sits 8min off the slot the reminder was built from: the old band fallback
    // confirmed it, which could be a different dose. Now the on-slot med is
    // confirmed, the drifted one is left alone, the message says "out of date"
    // and the app is handed the MT6 landing for that med, nothing preselected.
    it('a drifted slot does not confirm the neighbour: out of date + MT6 landing', async () => {
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
            ledgercut: CUT_AFTER_SLOT_DAY,
        });
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction({ ...confirmEvent, message_id: 3 }, { intake: domainFor(records, now), records, now, editReply, onOutOfDate });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === 'intake-med-b-drift').status).toBe('PENDING');
        expect(intakes.some((i) => i.recordId === `intake-med-b-${SLOT_UNIX}`)).toBe(false);
        expect((await records.list('medication')).find((m) => m.recordId === 'med-b').inventory_count).toBe(20);
        expect(editReply).toHaveBeenCalledWith(3, `✅ Confirmed 1 medication.\n${OUT_OF_DATE_TEXT}`);
        expect(onOutOfDate).toHaveBeenCalledWith({ medId: 'med-b', scheduled: SLOT_ISO, count: 1 });
    });

    // The deleted dose: the user removed this slot, so the tap is a silent
    // no-op for that med — not "out of date", and no landing.
    it('a tombstoned slot id is a silent no-op for that med', async () => {
        const s = seed();
        s.intake[0] = { ...s.intake[0], deleted: true };
        const records = fakeRecords(s);
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction({ ...confirmEvent, message_id: 8 }, { intake: domainFor(records, now), records, now, editReply, onOutOfDate });

        const intakes = await records.listRaw('intake');
        const a = intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`);
        expect(a).toMatchObject({ deleted: true, status: 'PENDING' });
        expect(intakes.find((i) => i.recordId === `intake-med-b-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect((await records.list('medication')).find((m) => m.recordId === 'med-a').inventory_count).toBe(30);
        expect(editReply).toHaveBeenCalledWith(8, '✅ Confirmed 1 medication.');
        expect(onOutOfDate).not.toHaveBeenCalled();
    });

    // An old client's post-cut PENDING prediction at a slot a schedule edit
    // removed: the projection hides it, so the exact-id row does not count — the
    // tap is out of date and logs nothing.
    it('an orphaned stored prediction at the exact id is out of date, not confirmed', async () => {
        const orphanUnix = SLOT_UNIX + 3600; // DAILY runs at 00:00 only
        const records = fakeRecords({
            medication: [{ recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 }],
            intake: [{ recordId: `intake-med-a-${orphanUnix}`, deleted: false, medication_id: 'med-a', scheduled_at: new Date(orphanUnix * 1000).toISOString(), status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' }],
            ledgercut: CUT_BEFORE_SLOT,
        });
        const now = () => DRAIN_MS;
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction(
            { ...medsNamed(confirmEvent, ['med-a']), slot_unix: orphanUnix, at_unix: orphanUnix + 60 },
            { intake: domainFor(records, now), records, now, onOutOfDate },
        );

        expect((await records.list('intake'))[0].status).toBe('PENDING');
        expect((await records.list('medication'))[0].inventory_count).toBe(30);
        expect(onOutOfDate).toHaveBeenCalledWith({ medId: 'med-a', scheduled: new Date(orphanUnix * 1000).toISOString(), count: 1 });
    });

    // A stored row for the named med at that very second under another id (a
    // vault-imported tz_step dose) is the same dose: the projection resolves it.
    it('resolves a legacy-id row for the named med at the exact slot instant', async () => {
        const records = fakeRecords({
            medication: seed().medication,
            intake: [{ recordId: `intake-med-a-${SLOT_UNIX}-tz_step`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'tz_step' }],
        });
        const now = () => DRAIN_MS;
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now, onOutOfDate });

        expect((await records.list('intake'))[0].status).toBe('TAKEN');
        expect(onOutOfDate).not.toHaveBeenCalled();
    });

    // R3 (bd med-wi09.4): the device clock trails the relay's, so the drain runs
    // before the slot instant — the dose is still a forecast with no row. The
    // callback confirms it at its exact id (confirm-or-create), never a no-op.
    it('confirms a forecast dose with no row yet at its exact id when the drain beats the slot', async () => {
        const records = fakeRecords({
            medication: [{ recordId: 'med-a', deleted: false, name: 'A', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 }],
            intake: [],
            ledgercut: CUT_BEFORE_SLOT,
        });
        const now = () => SLOT_UNIX * 1000 - 5000;
        const onOutOfDate = vi.fn();
        const cancelRefire = vi.fn();
        await applyIntakeSlotAction(
            { ...medsNamed(confirmEvent, ['med-a']), at_unix: SLOT_UNIX - 2 },
            { intake: domainFor(records, now), records, now, onOutOfDate, cancelRefire },
        );

        const row = (await records.list('intake')).find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`);
        expect(row).toMatchObject({ status: 'TAKEN', scheduled_at: SLOT_ISO });
        expect(onOutOfDate).not.toHaveBeenCalled();
        expect(cancelRefire).toHaveBeenCalledWith(SLOT_UNIX * 1000);
    });

    // The opposite failure the drift fallback must NOT cause: a med due at a
    // genuinely different time of day is its OWN message (grouped by exact slot)
    // and is not among the ids this reminder named, so tapping Confirm here must
    // not touch it — even though 4h sits well inside its 14.4h band.
    it('does not confirm a med the reminder did not name, hours away from the slot', async () => {
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
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        // The 4h-away dose belongs to its own reminder — untouched by this tap.
        expect(intakes.find((i) => i.recordId === 'intake-med-b-other').status).toBe('PENDING');
        expect((await records.list('medication')).find((m) => m.recordId === 'med-b').inventory_count).toBe(20);
    });

    // Medication safety, boundary: a dose belonging to a med this reminder did NOT
    // name stays PENDING and is re-reminded (a safe false-negative) rather than
    // risking a false adherence record — a false-positive is worse for meds, and
    // identity is what draws the line.
    it('leaves an unnamed med\'s nearby dose PENDING (safe re-reminder, not a false confirm)', async () => {
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
        const rearmRefire = vi.fn();
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now, rearmRefire });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === 'intake-med-b-far').status).toBe('PENDING');
        // ...and that dose is not this reminder's business, so the chain the tap
        // already cancelled server-side is not re-armed for it (bd med-kbpf).
        expect(rearmRefire).not.toHaveBeenCalled();
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
        const notPending = () => Object.assign(new Error('intake is not pending'), { code: 'not_pending' });
        const raced = {
            occurrences: real.occurrences,
            getIntake: real.getIntake,
            // The other drainer lands the dose first; this one loses the race.
            confirm: vi.fn(async (id, at) => { await real.confirm(id, at); throw notPending(); }),
            snooze: real.snooze,
        };

        await expect(
            applyIntakeSlotAction(confirmEvent, { intake: raced, records, now }),
        ).resolves.toBeUndefined();
        expect(raced.confirm).toHaveBeenCalledTimes(2);
    });

    // bd med-944k: not_pending is "already applied" only for a dose that IS
    // settled. On a dose still open it is a bug, and swallowing it is how a tap
    // vanished — it propagates, so the event stays queued.
    it('a not_pending on a dose still open propagates instead of acking the tap', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const real = domainFor(records, now);
        const refused = { ...real, confirm: async () => { throw Object.assign(new Error('intake is not pending'), { code: 'not_pending' }); } };
        await expect(applyIntakeSlotAction(confirmEvent, { intake: refused, records, now }))
            .rejects.toMatchObject({ code: 'not_pending' });
    });

    // ...but a real failure must propagate, so drainInbox leaves the event queued.
    it('propagates a genuine failure so the event stays queued', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const real = domainFor(records, now);
        const broken = {
            occurrences: real.occurrences,
            getIntake: real.getIntake,
            confirm: async () => { throw new Error('vault write failed'); },
            snooze: real.snooze,
        };

        await expect(
            applyIntakeSlotAction(confirmEvent, { intake: broken, records, now }),
        ).rejects.toThrow(/vault write failed/);
    });

    // bd med-o7zq.41: a restore replaces the store. A tap whose dose write read
    // the old medications lands before the replace starts, and a tap during
    // the replace writes nothing: it fails, so drainInbox leaves it queued.
    it('a store replace waits out a tap\'s dose write, and a tap during it stays queued', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const real = domainFor(records, now);
        let release;
        const held = new Promise((r) => { release = r; });
        const order = [];
        const slow = {
            ...real,
            occurrences: async (w) => { await held; const rows = await real.occurrences(w); order.push('doses'); return rows; },
        };
        const tap = applyIntakeSlotAction(confirmEvent, { intake: slow, records, now });
        const during = { ...real, occurrences: vi.fn(real.occurrences) };
        const replace = withMaterializationStopped(async () => {
            order.push('replace');
            await expect(applyIntakeSlotAction(confirmEvent, { intake: during, records, now }))
                .rejects.toThrow(MaterializationPausedError);
        });
        release();
        await tap;
        await replace;
        // The gated read lands before the replace; the receipt's read-only
        // re-read after the write may follow it.
        expect(order.slice(0, 2)).toEqual(['doses', 'replace']);
        expect(during.occurrences).not.toHaveBeenCalled();
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

    // --- bd med-eas.67 / med-kbpf: confirm the reminder's NAMED meds by identity ---
    const DAILY = '{"type":"daily","times":["00:00"]}'; // minDoseInterval = 14.4h

    // A grouped 4-med reminder where one med's ONLY dose drifted hours off its
    // clock slot (a tz-plan/cluster step). The old interval fallback confirmed
    // it; since bd med-wi09.4 that is a guess, so the three on-slot meds are
    // confirmed and the drifted one is left for the user (out of date).
    it('confirms the on-slot meds of a grouped reminder and never a drifted course dose', async () => {
        const driftedIso = new Date((SLOT_UNIX - 2 * 3600) * 1000).toISOString(); // 2h: > band, < 14.4h interval
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
            ledgercut: CUT_AFTER_SLOT_DAY,
        });
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(
            { ...confirmEvent, message_id: 9, medication_ids: ['med-a', 'med-b', 'med-c', 'med-d'] },
            { intake: domainFor(records, now), records, now, editReply },
        );

        const intakes = await records.list('intake');
        for (const id of [`intake-med-a-${SLOT_UNIX}`, `intake-med-b-${SLOT_UNIX}`, `intake-med-c-${SLOT_UNIX}`]) {
            expect(intakes.find((i) => i.recordId === id).status).toBe('TAKEN');
        }
        expect(intakes.find((i) => i.recordId === 'intake-med-d-drift').status).toBe('PENDING');
        expect(editReply).toHaveBeenCalledWith(9, `✅ Confirmed 3 medications.\n${OUT_OF_DATE_TEXT}`);
    });

    // F5 (bd med-wi09.12), kept under exact-only resolution (med-wi09.4): the
    // tap only. The on-slot dose was already taken in the app; a later dose of
    // the same med sits inside the band and is due by the time the drain runs —
    // still not the dose this tap confirmed.
    it('never band-matches a dose scheduled after the tap, even one due by drain time', async () => {
        const laterIso = new Date((SLOT_UNIX + 3 * 3600) * 1000).toISOString(); // in band, after the tap
        const records = fakeRecords({
            medication: [{ recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 }],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'TAKEN', taken_at: SLOT_ISO, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-a-later', deleted: false, medication_id: 'med-a', scheduled_at: laterIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS; // 4h after the slot: the later dose is due now
        const rearmRefire = vi.fn();
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now, rearmRefire });

        expect((await records.list('intake')).find((i) => i.recordId === 'intake-med-a-later').status).toBe('PENDING');
        expect((await records.list('medication'))[0].inventory_count).toBe(30);
        expect(rearmRefire).not.toHaveBeenCalled();
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
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === `intake-med-b-${SLOT_UNIX}`).status).toBe('PENDING'); // not named
        expect(intakes.find((i) => i.recordId === 'intake-med-a-far').status).toBe('PENDING'); // far dose
    });

    // --- bd med-kbpf: who stops the slot's relay re-fire chain ---
    // The relay cancels the chain the instant the button is tapped — the tap is
    // the user's explicit statement, and the event now names the meds. The drain
    // only puts ONE re-fire back, and only when a med the message NAMED still has
    // a due dose after the tap has been applied.
    const slotDoseFixture = () => fakeRecords({
        medication: [
            { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
            { recordId: 'med-b', deleted: false, name: 'B', schedule: DAILY, inventory_count: 30 },
        ],
        intake: [
            { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            { recordId: `intake-med-b-${SLOT_UNIX}`, deleted: false, medication_id: 'med-b', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
        ],
    });

    it('never re-arms the chain when the tap settled every med it named', async () => {
        const records = slotDoseFixture();
        const now = () => DRAIN_MS;
        const rearmRefire = vi.fn();
        const cancelRefire = vi.fn();
        await applyIntakeSlotAction(confirmEvent, { intake: domainFor(records, now), records, now, rearmRefire, cancelRefire });

        for (const i of await records.list('intake')) expect(i.status).toBe('TAKEN');
        expect(rearmRefire).not.toHaveBeenCalled();
        // Backstop for a tap that raced the relay's successor insert.
        expect(cancelRefire).toHaveBeenCalledWith(SLOT_UNIX * 1000);
    });

    // A med the message did NOT name is not this reminder's business: it has its
    // own reminder and its own chain, and re-arming for it would nag the user for
    // the dose they just confirmed until the relay's 6h cap.
    it('does not re-arm for a dose the reminder never named', async () => {
        const records = slotDoseFixture();
        const now = () => DRAIN_MS;
        const rearmRefire = vi.fn();
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now, rearmRefire });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === `intake-med-b-${SLOT_UNIX}`).status).toBe('PENDING');
        expect(rearmRefire).not.toHaveBeenCalled();
    });

    // The case the re-arm exists for: a NAMED med's exact slot dose is still
    // open after the tap — here a confirm that returned without its write
    // landing left it PENDING. Without the re-arm the relay would stay silent
    // about it.
    it('re-arms the chain, naming the meds still due, when a resolved dose is left over', async () => {
        const records = slotDoseFixture();
        const now = () => DRAIN_MS;
        const real = domainFor(records, now);
        const raced = {
            ...real,
            confirm: async (id, at) => {
                if (id.startsWith('intake-med-b-')) return undefined;
                return real.confirm(id, at);
            },
        };
        const rearmRefire = vi.fn();
        const cancelRefire = vi.fn();
        await applyIntakeSlotAction(confirmEvent, { intake: raced, records, now, rearmRefire, cancelRefire });

        expect(rearmRefire).toHaveBeenCalledWith(SLOT_UNIX * 1000, ['med-b']);
        expect(cancelRefire).not.toHaveBeenCalled();
    });

    // An out-of-date med is not due at this slot: re-arming would only repeat
    // the stale reminder, so the backstop cancel still runs.
    it('does not re-arm for an unresolved med — the chain stays cancelled', async () => {
        const records = slotDoseFixture();
        const now = () => DRAIN_MS;
        const rearmRefire = vi.fn();
        const cancelRefire = vi.fn();
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a', 'med-gone']), { intake: domainFor(records, now), records, now, rearmRefire, cancelRefire });

        expect(rearmRefire).not.toHaveBeenCalled();
        expect(cancelRefire).toHaveBeenCalledWith(SLOT_UNIX * 1000);
    });

    it('never re-arms on a snooze — the relay already rescheduled that chain', async () => {
        const records = slotDoseFixture();
        const now = () => (TAP_UNIX + 60) * 1000;
        const rearmRefire = vi.fn();
        await applyIntakeSlotAction(snoozeEvent, { intake: domainFor(records, now), records, now, rearmRefire });

        expect(rearmRefire).not.toHaveBeenCalled();
    });

    // The deterministic `intake-<medId>-<slotUnix>` row IS the dose the reminder
    // was built from, so it wins over whatever happens to sit nearest in time.
    it('confirms the exact-id dose for the slot ahead of a nearer one in the band', async () => {
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                // The slot's own row, drifted 2h off its instant.
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: new Date((SLOT_UNIX - 2 * 3600) * 1000).toISOString(), status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                // A closer-in-time dose of the same med that is NOT this slot's row.
                { recordId: 'intake-med-a-other', deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
        });
        const now = () => DRAIN_MS;
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(intakes.find((i) => i.recordId === 'intake-med-a-other').status).toBe('PENDING');
    });

    // An id the vault does not know (a med deleted since the reminder was pushed)
    // applies nothing, never widens the match to somebody else's dose, and says
    // the reminder is out of date.
    it('skips a named id the vault no longer has and says the reminder is out of date', async () => {
        const records = slotDoseFixture();
        const now = () => DRAIN_MS;
        const rearmRefire = vi.fn();
        const editReply = vi.fn(async () => {});
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction({ ...medsNamed(confirmEvent, ['med-gone']), message_id: 21 }, { intake: domainFor(records, now), records, now, rearmRefire, editReply, onOutOfDate });

        for (const i of await records.list('intake')) expect(i.status).toBe('PENDING');
        expect(rearmRefire).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(21, OUT_OF_DATE_TEXT);
        expect(onOutOfDate).toHaveBeenCalledWith({ medId: 'med-gone', scheduled: SLOT_ISO, count: 1 });
    });

    // A tap with no identity at all: a reminder pushed by a pre-med-kbpf client,
    // or one so old the relay's chain (and the row that named the meds) is gone.
    // Guessing a band-wide set is exactly the false-positive risk this design
    // removed, so it applies NOTHING — but still answers the message.
    it('applies nothing and says so when the tap carries no medication identity', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const rearmRefire = vi.fn();
        await applyIntakeSlotAction(
            { kind: INTAKE_SLOT_ACTION, slot_unix: SLOT_UNIX, action: 'confirm', at_unix: TAP_UNIX, message_id: 13 },
            { intake: domainFor(records, now), records, now, editReply, rearmRefire },
        );

        for (const i of await records.list('intake')) expect(i.status).toBe('PENDING');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(13, expect.stringMatching(/Nothing was due/));
        expect(rearmRefire).not.toHaveBeenCalled();
        // Generic verbosity never turns the no-op into "✅ Recorded." (Argus 6065).
        await applyIntakeSlotAction(
            { kind: INTAKE_SLOT_ACTION, slot_unix: SLOT_UNIX, action: 'confirm', at_unix: TAP_UNIX, message_id: 14 },
            { intake: domainFor(records, now), records, now, editReply, rearmRefire, verbosity: 'generic' },
        );
        expect(editReply).toHaveBeenCalledWith(14, expect.stringMatching(/Nothing was due/));
        warn.mockRestore();
    });

    // Exact only: when a named med has BOTH an on-slot and a drifted PENDING dose,
    // only the slot's own dose is acted on — never the neighbour.
    it('confirms only the exact slot dose of a named med, never its drifted neighbour', async () => {
        const driftedIso = new Date((SLOT_UNIX - 2 * 3600) * 1000).toISOString(); // 2h: in band, farther than the on-slot dose
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
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now });

        const intakes = await records.list('intake');
        expect(intakes.find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN'); // the slot's own dose
        expect(intakes.find((i) => i.recordId === 'intake-med-a-drift').status).toBe('PENDING'); // not double-confirmed
    });

    // Redelivery must not "walk" a named med onto its NEXT in-band dose: drain 1
    // confirms the on-slot dose, a failed flush re-queues the event, and drain 2
    // (same deterministic atMs) must see that med as already handled and skip it —
    // not confirm the drifted dose the user never took.
    it('identity path does not confirm a second drifted dose on redelivery', async () => {
        const driftedIso = new Date((SLOT_UNIX - 2 * 3600) * 1000).toISOString(); // in band, farther than on-slot
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
        const opts = { records, now };
        const evt = medsNamed(confirmEvent, ['med-a']);
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), ...opts });
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), ...opts }); // redelivery

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
        const opts = { records, now, editReply };
        const evt = { ...confirmEvent, message_id: 5 };
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), ...opts });
        await applyIntakeSlotAction(evt, { intake: domainFor(records, now), ...opts });

        expect(editReply).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(5, expect.stringMatching(/Confirmed 2 medications/));
        const meds = await records.list('medication');
        expect(meds.find((m) => m.recordId === 'med-a').inventory_count).toBe(29); // not 28
        expect(meds.find((m) => m.recordId === 'med-b').inventory_count).toBe(29);
    });

    // Snooze resolves exactly too: the on-slot dose is snoozed, a drifted one is
    // not touched and the receipt says the reminder is out of date for it.
    it('snoozes the exact slot doses only; a drifted dose is out of date', async () => {
        const driftedIso = new Date((SLOT_UNIX - 2 * 3600) * 1000).toISOString();
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'B', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-b-drift', deleted: false, medication_id: 'med-b', scheduled_at: driftedIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
            ledgercut: CUT_AFTER_SLOT_DAY,
        });
        const now = () => (TAP_UNIX + 60) * 1000; // window still open
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction({ ...snoozeEvent, message_id: 6 }, { intake: domainFor(records, now), records, now, editReply });

        const intakes = await records.list('intake');
        const a = intakes.find((r) => r.recordId === `intake-med-a-${SLOT_UNIX}`);
        expect(a.status).toBe('PENDING');
        expect(Date.parse(a.snoozed_until)).toBe((TAP_UNIX + 600) * 1000);
        expect(intakes.find((r) => r.recordId === 'intake-med-b-drift').snoozed_until).toBeNull();
        expect(editReply).toHaveBeenCalledWith(6, `⏰ Snoozed — will remind you again shortly.\n${OUT_OF_DATE_TEXT}`);
    });

    // A DST / tz-plan step: the approved plan walks a dose off its clock slot, so
    // the projection keeps the shifted `tz_step` row and the reminder's slot no
    // longer matches any dose instant — not even the deterministic id. That
    // reminder is stale: nothing is confirmed, the app gets the MT6 landing for
    // the med (bd med-wi09.4).
    it('a tz-plan step dose that moved off the reminder slot is out of date, not confirmed', async () => {
        const steppedIso = new Date((SLOT_UNIX - 90 * 60) * 1000).toISOString(); // 1h30 tz step
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, tz_shift_policy: 'flexible', inventory_count: 30 },
            ],
            intake: [
                { recordId: 'intake-med-a-step', deleted: false, medication_id: 'med-a', scheduled_at: steppedIso, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'tz_step' },
            ],
            ledgercut: CUT_AFTER_SLOT_DAY,
        });
        const now = () => DRAIN_MS;
        const onOutOfDate = vi.fn();
        const cancelRefire = vi.fn();
        await applyIntakeSlotAction(medsNamed(confirmEvent, ['med-a']), { intake: domainFor(records, now), records, now, onOutOfDate, cancelRefire });

        const stepped = (await records.list('intake')).find((i) => i.recordId === 'intake-med-a-step');
        expect(stepped.status).toBe('PENDING');
        expect((await records.list('medication'))[0].inventory_count).toBe(30);
        expect(onOutOfDate).toHaveBeenCalledWith({ medId: 'med-a', scheduled: SLOT_ISO, count: 1 });
        expect(cancelRefire).toHaveBeenCalledWith(SLOT_UNIX * 1000);
    });

    // bd med-944k — the production shape: a 08:20 Asia/Tbilisi reminder (04:20Z)
    // for five meds whose slot rows an in-app take + undo (21:40:12Z) had left
    // UNTAKEN rev 2. The tap (relay refire message 1041, tapped 07:14:56Z)
    // recorded nothing and acked with the relay's static "✅ Confirmed —
    // waiting for your device" still on the message. The tap is newer than the
    // undo, so it is the user's newest intent: it records (rev seen+1).
    const OWNER_SLOT = 1792988400;
    const OWNER_MEDS = [2, 4, 7, 9, 16];
    const ownerUntaken = (m, actedAt = '2026-10-25T21:40:12.818Z') => ({
        recordId: `intake-${m}-${OWNER_SLOT}`, deleted: false, medication_id: m, scheduled_at: '2026-10-26T04:20:00.000Z', taken_at: null,
        status: 'UNTAKEN', snoozed_until: null, source: 'schedule', clientTs: 1792964411771, rev: 2,
        acted_at: actedAt, via: 'app', tz: 'Asia/Tbilisi', note: 'Undone; was taken at 2026-10-25T21:40:00.802Z',
    });
    const ownerFixture = (actedAt) => fakeRecords({
        medication: OWNER_MEDS.map((m) => ({ recordId: m, deleted: false, name: `Med ${m}`, schedule: '{"type":"daily","times":["08:20"]}', inventory_count: 30 })),
        intake: OWNER_MEDS.map((m) => ownerUntaken(m, actedAt)),
        ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: '2026-10-20T00:00:00.000Z' }],
    });
    const ownerNow = () => Date.parse('2026-10-26T07:30:00Z');
    const ownerTap = { kind: INTAKE_SLOT_ACTION, action: 'confirm', slot_unix: OWNER_SLOT, at_unix: 1792998896, message_id: 1041, medication_ids: OWNER_MEDS };
    const ownerIntake = (records) => createIntakeDomain({ records, now: ownerNow, timeZone: 'Asia/Tbilisi', via: 'telegram' });

    it('a tap newer than an undo confirms the UNTAKEN doses at the tap time', async () => {
        const records = ownerFixture();
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(ownerTap, { intake: ownerIntake(records), records, now: ownerNow, editReply });

        for (const row of await records.list('intake')) {
            expect(row).toMatchObject({ status: 'TAKEN', taken_at: '2026-10-26T07:14:56.000Z', rev: 3, via: 'telegram' });
        }
        for (const m of await records.list('medication')) expect(m.inventory_count).toBe(29);
        expect(editReply).toHaveBeenCalledWith(1041, '✅ Confirmed 5 medications.');
    });

    it('a redelivered tap finds the doses TAKEN: no second write, no receipt clobber', async () => {
        const records = ownerFixture();
        const editReply = vi.fn(async () => {});
        const opts = { records, now: ownerNow, editReply };
        await applyIntakeSlotAction(ownerTap, { intake: ownerIntake(records), ...opts });
        const once = JSON.stringify(await records.list('intake'));
        await applyIntakeSlotAction(ownerTap, { intake: ownerIntake(records), ...opts });

        expect(JSON.stringify(await records.list('intake'))).toBe(once);
        for (const m of await records.list('medication')) expect(m.inventory_count).toBe(29);
        expect(editReply).toHaveBeenCalledTimes(1);
    });

    it('a tap older than the undo records nothing and says why', async () => {
        const records = ownerFixture('2026-10-26T07:20:00.000Z'); // undone after the 07:14:56 tap
        const editReply = vi.fn(async () => {});
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction(ownerTap, { intake: ownerIntake(records), records, now: ownerNow, editReply, onOutOfDate });

        expect(await records.list('intake')).toEqual(OWNER_MEDS.map((m) => ownerUntaken(m, '2026-10-26T07:20:00.000Z')));
        for (const m of await records.list('medication')) expect(m.inventory_count).toBe(30);
        expect(editReply).toHaveBeenCalledWith(1041, '⚠️ Not recorded: 5 medications changed in the app after this tap.');
        expect(onOutOfDate).not.toHaveBeenCalled();
    });

    it('a tap on a dose already taken in the app reports it done, with no second write', async () => {
        const s = seed();
        const takenIso = new Date((SLOT_UNIX + 120) * 1000).toISOString();
        s.intake[0] = { ...s.intake[0], status: 'TAKEN', taken_at: takenIso, rev: 1, via: 'app' };
        s.medication[0] = { ...s.medication[0], inventory_count: 29 };
        const records = fakeRecords(s);
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction({ ...medsNamed(confirmEvent, ['med-a']), message_id: 31 }, { intake: domainFor(records, now), records, now, editReply });

        expect((await records.list('intake')).find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`))
            .toMatchObject({ status: 'TAKEN', taken_at: takenIso, rev: 1, via: 'app' });
        expect((await records.list('medication')).find((m) => m.recordId === 'med-a').inventory_count).toBe(29);
        expect(editReply).toHaveBeenCalledWith(31, '✅ Already taken: 1 medication.');
    });

    it('a tap on a dose skipped in the app says it was skipped, with no write (generic: no counts)', async () => {
        const s = seed();
        s.intake[0] = { ...s.intake[0], status: 'SKIPPED', rev: 1, via: 'app' };
        const records = fakeRecords(s);
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction({ ...medsNamed(confirmEvent, ['med-a']), message_id: 32 }, { intake: domainFor(records, now), records, now, editReply, verbosity: 'generic' });

        expect((await records.list('intake')).find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('SKIPPED');
        expect(editReply).toHaveBeenCalledWith(32, '⚠️ Not recorded: marked skipped in the app.');
    });

    // Archie (bd med-944k): a projection id the domain's resolver cannot act
    // on used to reach confirm(), throw not_pending, and be swallowed as
    // "already applied". It is out of date instead, and confirm is never asked.
    it('a projection dose the domain cannot resolve is out of date, never a swallowed not_pending', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const real = domainFor(records, now);
        const confirm = vi.fn(real.confirm);
        const intake = {
            ...real,
            confirm,
            occurrences: async () => [{ occId: `intake-med-c-${SLOT_UNIX}-tz_step`, medId: 'med-c', state: 'due', plannedAt: SLOT_ISO }],
        };
        const editReply = vi.fn(async () => {});
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction({ ...medsNamed(confirmEvent, ['med-c']), message_id: 33 }, { intake, records, now, editReply, onOutOfDate });

        expect(confirm).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(33, OUT_OF_DATE_TEXT);
        expect(onOutOfDate).toHaveBeenCalledWith({ medId: 'med-c', scheduled: SLOT_ISO, count: 1 });
    });

    // LOW-5 (known, bd med-wi09.12): ON the cut day a stored row covers a slot
    // only at its own instant (Archie, N2 — no band). An old client's drifted
    // PENDING from before the cut instant therefore sits next to the
    // regenerated on-schedule dose: two doses due that day. The tap confirms
    // the exact-id one; the drifted row stays due. One day only.
    it('on the cut day, a drifted pre-cut row shows next to the regenerated slot (pinned double dose)', async () => {
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 },
                { recordId: 'med-b', deleted: false, name: 'B', schedule: DAILY, inventory_count: 30 },
            ],
            intake: [
                { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: false, medication_id: 'med-a', scheduled_at: SLOT_ISO, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
                { recordId: 'intake-med-b-drift', deleted: false, medication_id: 'med-b', scheduled_at: new Date((SLOT_UNIX + 8 * 60) * 1000).toISOString(), status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' },
            ],
            ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: new Date((SLOT_UNIX + 3600) * 1000).toISOString() }],
        });
        const now = () => DRAIN_MS;
        const intake = domainFor(records, now);
        const span = { fromMs: (SLOT_UNIX - 3600) * 1000, toMs: DRAIN_MS };
        expect((await intake.occurrences(span)).map((r) => [r.occId, r.state])).toEqual([
            [`intake-med-a-${SLOT_UNIX}`, 'due'],
            [`intake-med-b-${SLOT_UNIX}`, 'due'],
            ['intake-med-b-drift', 'due'],
        ]);

        await applyIntakeSlotAction(confirmEvent, { intake, records, now });
        expect((await intake.occurrences(span)).map((r) => [r.occId, r.state])).toEqual([
            [`intake-med-a-${SLOT_UNIX}`, 'taken'],
            [`intake-med-b-${SLOT_UNIX}`, 'taken'],
            ['intake-med-b-drift', 'due'],
        ]);
    });
});

describe('inbox-apply.js — createInboxApplier routing', () => {
    // bd med-wi09.19 (Argus r2): the drain can run before this page's first
    // pull, so the agent's router never floors the account zone.
    it('the agent router never floors the account zone on an unpinned account', async () => {
        const records = fakeRecords(seed());
        const call = createInboxRouter({ accountId: 'a' }, { records, now: () => DRAIN_MS, timeZone: 'Europe/Berlin' });
        expect(await call.floorTimeZone()).toBe(false);
        expect((await call('/api/settings')).timezone_source).toBe('device');
        await call(`/api/doses?from=${new Date(DRAIN_MS).toISOString()}&to=${new Date(DRAIN_MS + 86400000).toISOString()}`);
        expect(await records.list('tzfloor')).toEqual([]);
    });

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

    it('routes a real intake_slot_action through the domain, and wires the re-fire re-arm', async () => {
        const records = fakeRecords(seed());
        // rearmRefire is the applier's job to supply (in production, the real
        // rearmMedRefire POST) — applyIntakeSlotAction itself defaults to a no-op,
        // so this asserts the wiring, not the default (bd med-kbpf).
        const rearmRefire = vi.fn();
        const cancelRefire = vi.fn();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS, rearmRefire, cancelRefire });
        await apply(confirmEvent);

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot.every((i) => i.status === 'TAKEN')).toBe(true);
        // Everything the reminder named is settled, so the chain the relay already
        // cancelled at tap time stays cancelled.
        expect(rearmRefire).not.toHaveBeenCalled();
        expect(cancelRefire).toHaveBeenCalledWith(SLOT_UNIX * 1000);
    });

    // bd med-wi09.12 N3: the drain stamps the account's zone on the confirm —
    // the stamp is that day's evidence zone — never the draining device's.
    it('stamps the pinned zone on a drained confirm, not the device zone', async () => {
        const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const pinned = device === 'Pacific/Auckland' ? 'Europe/Berlin' : 'Pacific/Auckland';
        const records = fakeRecords({ ...seed(), settings: [{ recordId: 'settings', deleted: false, timezone: pinned }] });
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS, rearmRefire: vi.fn(), cancelRefire: vi.fn() });
        await apply(confirmEvent);

        const atSlot = (await records.list('intake')).filter((i) => i.scheduled_at === SLOT_ISO);
        expect(atSlot.map((i) => [i.status, i.tz])).toEqual([['TAKEN', pinned], ['TAKEN', pinned]]);
    });

    it('hands an out-of-date tap to the injected MT6 hook', async () => {
        const records = fakeRecords(seed());
        const onOutOfDate = vi.fn();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS, rearmRefire: vi.fn(), cancelRefire: vi.fn(), editReply: vi.fn(async () => {}), onOutOfDate });
        await apply(medsNamed(confirmEvent, ['med-a', 'med-x']));

        expect((await records.list('intake')).find((i) => i.recordId === `intake-med-a-${SLOT_UNIX}`).status).toBe('TAKEN');
        expect(onOutOfDate).toHaveBeenCalledWith({ medId: 'med-x', scheduled: SLOT_ISO, count: 1 });
    });

    // A drain runs in the background: the default hook only queues MT6 and
    // offers it in a toast — it never switches the open app's section.
    it('by default queues the MT6 landing on the page instead of navigating', async () => {
        const records = fakeRecords(seed());
        const queue = vi.fn();
        const show = vi.fn();
        globalThis.queueMedsReminderOutOfDate = queue;
        globalThis.showMedsReminderOutOfDate = show;
        try {
            const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS, rearmRefire: vi.fn(), cancelRefire: vi.fn(), editReply: vi.fn(async () => {}) });
            await apply(medsNamed(confirmEvent, ['med-x']));
            expect(queue).toHaveBeenCalledWith({ medId: 'med-x', scheduled: SLOT_ISO, count: 1 });
            expect(show).not.toHaveBeenCalled();
        } finally {
            delete globalThis.queueMedsReminderOutOfDate;
            delete globalThis.showMedsReminderOutOfDate;
        }
    });
});

// bd med-wi09.12 — doses due before the first v2 boot (NEW-1) and doses on a
// day an old tab logged (NEW-2) are regenerated, so a queued tap lands.
describe('inbox-apply.js — taps on regenerated doses around the ledger cut', () => {
    const DAY0 = Date.UTC(2026, 9, 20);
    const at = (h, m = 0) => DAY0 + h * 3600e3 + m * 60e3;
    const twice = { recordId: 'med-a', deleted: false, name: 'Lisinopril', schedule: '{"type":"daily","times":["08:00","20:00"]}', inventory_count: 30, created_at: '2026-10-01T00:00:00Z' };
    const tap = (slotMs, atMs) => ({ kind: INTAKE_SLOT_ACTION, slot_unix: slotMs / 1000, action: 'confirm', at_unix: atMs / 1000, medication_ids: ['med-a'] });

    it('a Confirm tapped at 08:05 with no app open, drained by the first v2 boot at noon, records the 08:00 dose', async () => {
        const records = fakeRecords({ medication: [twice], intake: [] });
        const now = () => at(12);
        const intake = createIntakeDomain({ records, now, timeZone: 'UTC', via: 'telegram' });
        await intake.ensureLedgerCut(); // the install write: the cut is noon
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(tap(at(8), at(8, 5)), { intake, records, now, editReply });

        const row = (await records.list('intake')).find((i) => i.recordId === `intake-med-a-${at(8) / 1000}`);
        expect(row).toMatchObject({ status: 'TAKEN', taken_at: new Date(at(8, 5)).toISOString() });
        expect((await records.list('medication'))[0].inventory_count).toBe(29);
        expect(editReply.mock.calls.at(-1)[1]).toMatch(/Confirmed 1 medication/);
    });

    it('an old tab\'s tz-less TAKEN at 08:00 after the cut leaves 20:00 due, and a tap on it confirms', async () => {
        const records = fakeRecords({
            medication: [twice],
            ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: new Date(DAY0 - 86400e3).toISOString() }],
            intake: [{ recordId: `intake-med-a-${at(8) / 1000}`, deleted: false, medication_id: 'med-a', scheduled_at: new Date(at(8)).toISOString(), status: 'TAKEN', taken_at: new Date(at(8, 3)).toISOString(), snoozed_until: null, source: 'schedule', clientTs: at(8, 3) }],
        });
        const now = () => at(21);
        const intake = createIntakeDomain({ records, now, timeZone: 'UTC', via: 'telegram' });
        expect((await intake.occurrences({ fromMs: at(0), toMs: at(23) })).map((r) => [r.localTime, r.state]))
            .toEqual([['08:00', 'taken'], ['20:00', 'due']]);
        await applyIntakeSlotAction(tap(at(20), at(20, 10)), { intake, records, now });

        const row = (await records.list('intake')).find((i) => i.recordId === `intake-med-a-${at(20) / 1000}`);
        expect(row).toMatchObject({ status: 'TAKEN' });
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
                day: '2026-01-01', total_minutes: 480, light_minutes: 300, deep_minutes: 120, rem_minutes: 60, heart_rate_avg: 58,
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

        // The session is the ledger, its sleep day the projection (bd med-0xad.9).
        expect((await records.list('sleep')).map((r) => r.recordId).sort())
            .toEqual([`sleep-${Date.parse(SLEEP_START)}`, 'sleep-hk-2026-01-02']);
        expect((await records.list('sleep')).every((r) => r.heart_rate_avg === 58)).toBe(true);
        expect(await records.list('daystats')).toHaveLength(1);
        expect((await records.list('daystats'))[0].steps).toBe(8000);

        // HR day-batched: two UTC days, the 01-01 batch holds both samples.
        const hr = await records.list('hrsample');
        expect(hr).toHaveLength(2);
        const jan1 = hr.find((r) => r.recordId === 'hrsample-2026-01-01');
        expect(jan1.samples).toHaveLength(2);
        expect(await records.list('spo2sample')).toHaveLength(1);
        // Stress is dropped (bd med-0xad.4).
        expect(await records.list('stresssample')).toEqual([]);

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

        expect(await records.list('sleep')).toHaveLength(2); // one session + its day row
        expect(await records.list('daystats')).toHaveLength(1);
        expect(await records.list('hrsample')).toHaveLength(2);
        expect((await records.list('hrsample')).find((r) => r.recordId === 'hrsample-2026-01-01').samples).toHaveLength(2);
        expect(await records.list('spo2sample')).toHaveLength(1);
        expect(await records.list('stresssample')).toEqual([]);
        expect(await records.list('miband')).toHaveLength(1);
    });

    // med-356i — Mi-Band backups are cumulative, so every upload re-drains the
    // whole history. A put per unchanged record was thousands of no-op oplog ops
    // (a full-vault compaction per upload) and a fresh clientTs that could beat a
    // real edit. Only records whose body changed may be written.
    it('re-draining an unchanged import writes nothing; a new day writes only that day', async () => {
        const records = fakeRecords();
        const puts = [];
        const realPut = records.put;
        records.put = async (type, record) => { puts.push(record.recordId); return realPut(type, record); };
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => DRAIN_MS });
        await apply(vitalsEvent(), 42);
        expect(puts.length).toBeGreaterThan(0);

        puts.length = 0;
        await apply(vitalsEvent(), 42);
        expect(puts).toEqual([]);

        // A cumulative backup that adds one HR sample on a new day.
        const grown = vitalsEvent();
        grown.hr.push({ date_time: '2026-01-03T08:00:00.000Z', tz_offset: 0, value: 66, type: 0 });
        await apply(grown, 43);
        expect(puts).toEqual(['hrsample-2026-01-03']);
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
                        day: '2026-01-01', total_minutes: 480, light_minutes: 300, deep_minutes: 120, rem_minutes: 60, heart_rate_avg: 58,
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

        // Both paths minted the same natural-key recordId → still one session
        // (plus its day row, bd med-0xad.9), one workout.
        expect((await records.list('sleep')).map((r) => r.recordId).sort())
            .toEqual([`sleep-${Date.parse(SLEEP_START)}`, 'sleep-hk-2026-01-02']);
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
        return { parseMealFromDescription: noKey, parseMealFromImage: noKey, parseActivityFromDescription: noKey };
    }
    // The AI parse an /activity message runs through, stubbed at the provider
    // boundary — the real activityAI domain (validation + duration sum) still runs.
    function stubActivityAIClient({ name = 'Bicycle ride', durationMinutes = 12, distanceM = null } = {}) {
        return {
            parseActivityFromDescription: async () => ({
                name,
                exercises: [{ name: 'cycling', sets: null, reps: null, weight_kg: null, duration_minutes: durationMinutes, distance_m: distanceM, notes: '' }],
            }),
        };
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
        return { parseMealFromDescription: refuse, parseMealFromImage: refuse, parseActivityFromDescription: refuse };
    }

    function domainsFor(records, now, aiClient = stubAIClient(TWO_EGGS), activityAIClient = stubActivityAIClient()) {
        return {
            bp: createBPDomain({ records, now, timeZone: 'UTC' }),
            weight: createWeightDomain({ records, now, timeZone: 'UTC' }),
            notes: createNotesDomain({ records, now }),
            intake: domainFor(records, now),
            foodAI: createFoodAIDomain({ aiClient, foodDomain: createFoodDomain({ records, now, timeZone: 'UTC' }), now }),
            activityAI: createActivityAIDomain({ aiClient: activityAIClient }),
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

    // F4 (bd med-wi09.12): "took my meds" is today's due doses only — never an
    // earlier day's missed one (that would fake adherence and move stock).
    it('/intake leaves an earlier day\'s missed dose alone', async () => {
        const seeded = seed();
        const yesterday = new Date((SLOT_UNIX - 12 * 3600) * 1000).toISOString();
        seeded.intake.push({ recordId: 'intake-med-a-yesterday', deleted: false, medication_id: 'med-a', scheduled_at: yesterday, status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' });
        const records = fakeRecords(seeded);
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/intake'), 12, { ...domainsFor(records, now), editReply });

        const intakes = await records.list('intake');
        expect(intakes.filter((i) => i.scheduled_at === SLOT_ISO).every((i) => i.status === 'TAKEN')).toBe(true);
        expect(intakes.find((i) => i.recordId === 'intake-med-a-yesterday').status).toBe('PENDING');
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

    // bd med-3q8.2: the drain is idempotent by its deterministic recordId, so it
    // must not go through createAdHocSession's resume-the-live-session guard —
    // adopting the app's in-flight session would complete someone's workout out
    // from under them, and leave the tg-<id> record unwritten (so a re-drain
    // would log yet another session).
    it('/workout logs its own session instead of completing one the user has in progress', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const opts = { ...domainsFor(records, now), editReply: vi.fn() };
        const live = await opts.workout.createAdHocSession();

        await applyTGCommand(commandEvent('/workout legs'), 14, opts);

        const sessions = await records.list('workoutsession');
        expect(sessions).toHaveLength(2);
        expect(sessions.find((s) => s.id === live.id).status).toBe('in_progress');
        expect(sessions.find((s) => s.recordId === 'tg-14')).toMatchObject({ status: 'completed', notes: 'legs' });
    });

    it('/activity parses the description client-side and logs one manual mi-band activity', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/activity 2km bicycle'), 25, { ...domainsFor(records, now), editReply });

        const miband = await records.list('miband');
        expect(miband).toHaveLength(1);
        expect(miband[0]).toMatchObject({ activity_name: 'Bicycle ride', source: 'manual', activity_type: 0, recordId: 'tg-25' });
        // duration_minutes (12) summed → seconds.
        expect(miband[0].duration_sec).toBe(720);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Logged cardio: Bicycle ride/));
    });

    it('/activity records the parsed distance (2km bicycle -> distance_m 2000) and shows it in the reply', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        const domains = domainsFor(records, now, stubAIClient(TWO_EGGS), stubActivityAIClient({ distanceM: 2000 }));
        await applyTGCommand(commandEvent('/activity 2km bicycle'), 25, { ...domains, editReply });

        const miband = await records.list('miband');
        expect(miband[0].distance_m).toBe(2000);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Logged cardio: Bicycle ride — 2\.0km/));
    });

    it('/activity with a mile distance records ~8047m', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const domains = domainsFor(records, now, stubAIClient(TWO_EGGS), stubActivityAIClient({ name: 'Run', distanceM: 8047 }));
        await applyTGCommand(commandEvent('/activity 5 mi run'), 25, { ...domains, editReply: vi.fn() });

        const miband = await records.list('miband');
        expect(miband[0].distance_m).toBe(8047);
    });

    it('/activity with no stated distance records distance_m 0 (no regression)', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/activity bench press'), 25, { ...domainsFor(records, now), editReply });

        const miband = await records.list('miband');
        expect(miband[0].distance_m).toBe(0);
        // reply has no distance suffix when distance is 0.
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Logged cardio: Bicycle ride\./));
    });

    it('re-draining the same /activity event overwrites its own row instead of logging a second activity', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const opts = { ...domainsFor(records, now), editReply: vi.fn() };
        await applyTGCommand(commandEvent('/activity 2km bicycle'), 25, opts);
        await applyTGCommand(commandEvent('/activity 2km bicycle'), 25, opts);

        expect(await records.list('miband')).toHaveLength(1);
    });

    it('bare /activity is refused with a usage hint and logs nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await applyTGCommand(commandEvent('/activity'), 26, { ...domainsFor(records, now), editReply });

        expect(await records.list('miband')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/Usage: \/activity/));
    });

    it('/activity with no configured key tells the user to add one, acks, and logs nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        // Resolves (event acked) rather than throwing — a missing key is permanent
        // for this message, so re-queuing forever would stall the mailbox.
        await expect(applyTGCommand(commandEvent('/activity 2km bicycle'), 27, { ...domainsFor(records, now, stubAIClient(TWO_EGGS), noKeyAIClient()), editReply }))
            .resolves.toBeUndefined();

        expect(await records.list('miband')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/add an OpenAI key/));
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

    it('/food with trial consent not granted offers the one-tap Allow button, acks, and logs nothing', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        // Resolves (event acked): ungranted consent is permanent for this
        // message — re-queuing would retry it on every drain tick forever.
        await expect(applyTGCommand(commandEvent('/food 2 eggs'), 23, { ...domainsFor(records, now, consentRefusingAIClient()), editReply }))
            .resolves.toBeUndefined();

        expect(await records.list('foodlog')).toHaveLength(0);
        // The button (med-eas.61) carries the navigation, so the text no longer
        // spells out a Settings path — and it rides the scope the gate refused.
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/trial AI/), { trialConsentScope: 'ai' });
    });

    it('/activity with trial consent not granted offers the same Allow button', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const editReply = vi.fn();
        await expect(applyTGCommand(commandEvent('/activity 30 min run'), 24, { ...domainsFor(records, now, stubAIClient(TWO_EGGS), consentRefusingAIClient()), editReply }))
            .resolves.toBeUndefined();

        expect(await records.list('miband')).toHaveLength(0);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/trial AI/), { trialConsentScope: 'ai' });
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

    it('a photo caption reaches the vision model — it is where portions come from', async () => {
        const records = fakeRecords(seed());
        const now = () => DRAIN_MS;
        const parseMealFromImage = vi.fn().mockResolvedValue({ items: TWO_EGGS });
        const foodAI = createFoodAIDomain({
            aiClient: { ...stubAIClient(TWO_EGGS), parseMealFromImage },
            foodDomain: createFoodDomain({ records, now, timeZone: 'UTC' }),
            now,
        });
        const event = { ...photoEvent(), caption: 'chicken salad, 300g' };
        await applyTGPhoto(event, 34, { foodAI, editReply: vi.fn(), fetchPhoto: okFetchPhoto() });

        expect(parseMealFromImage).toHaveBeenCalledWith(expect.anything(), 'chicken salad, 300g');
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
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/trial AI/), { trialConsentScope: 'ai' });
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
        // 2nd arg: the SENT time, which ages the conversation history (med-48x).
        expect(agent.run).toHaveBeenCalledWith('i ate two eggs', CMD_UNIX * 1000);
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

    // med-3q8.3: the at-most-once marker is written BEFORE the agent runs, so
    // the skip branch must still ANSWER. It used to return silently, which left
    // the user's "⏳ Queued" dangling forever whenever a run was cut short
    // between the marker and its reply (closed tab, reload, a throw in the
    // drain) — the next drain then acked the event having said nothing.
    it('a redelivery re-issues the answer the first run composed', async () => {
        const records = fakeRecords();
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('Your BP averaged 128/84.') };
        const opts = { agent, records, editReply };
        await applyTGText(textEvent('what was my bp'), 47, opts);
        await applyTGText(textEvent('what was my bp'), 47, opts);
        expect(agent.run).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledTimes(2);
        expect(editReply.mock.calls[1]).toEqual([REPLY_ID, 'Your BP averaged 128/84.']);
    });

    it('a replayed trial-consent refusal keeps its Allow button — the text points at one', async () => {
        const records = fakeRecords();
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(Object.assign(new Error('consent'), { code: 'trial_consent_required', scope: 'tg' })) };
        const opts = { agent, records, editReply };
        await applyTGText(textEvent('hi'), 49, opts);
        await applyTGText(textEvent('hi'), 49, opts);
        expect(editReply.mock.calls[1]).toEqual([REPLY_ID, expect.stringMatching(/trial AI/), { trialConsentScope: 'tg' }]);
    });

    // bd med-ramv: a marker with no reply is an interrupted run (iOS suspended
    // the page, a reload) — or one still going in another tab. Four steps.
    const NOW = 1_800_000_000_000;
    const staleMarker = (extra = {}) => fakeRecords({ tgagentrun: [{ recordId: 'tgtext-48', deleted: false, clientTs: NOW - 3 * 60 * 1000, startedAt: NOW - 3 * 60 * 1000, ...extra }] });

    it('an older bundle\'s reply-less marker is terminal, never retried — it may already have written', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn() };
        const records = fakeRecords({ tgagentrun: [{ recordId: 'tgtext-48', deleted: false, clientTs: NOW - 30 * 1000 }] });
        await applyTGText(textEvent('log 80kg'), 48, { agent, records, editReply, now: () => NOW });
        expect(agent.run).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, '🤖 I could not finish handling that message.');
    });

    it('a startedAt beyond the lease in the future (clock jumped back) is stale, not leased', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('Hello.') };
        await applyTGText(textEvent('hi'), 48, { agent, records: staleMarker({ startedAt: NOW + 3 * 60 * 1000 }), editReply, now: () => NOW });
        expect(agent.run).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, 'Hello.');
    });

    it('a fresh reply-less marker is leased to another tab: throws, no edit, no run', async () => {
        const records = fakeRecords({ tgagentrun: [{ recordId: 'tgtext-48', deleted: false, clientTs: NOW - 30 * 1000, startedAt: NOW - 30 * 1000 }] });
        const editReply = vi.fn();
        const agent = { run: vi.fn() };
        await expect(applyTGText(textEvent('what was my bp'), 48, { agent, records, editReply, now: () => NOW })).rejects.toThrow();
        expect(agent.run).not.toHaveBeenCalled();
        expect(editReply).not.toHaveBeenCalled();
    });

    // Argus P1: the sync port skew-corrects clientTs into server time, so the
    // lease must age on startedAt (this device's clock), not clientTs.
    it('the lease holds on a clock-skewed port that rewrites clientTs', async () => {
        const records = fakeRecords();
        const put = records.put;
        records.put = (type, record) => put(type, { ...record, clientTs: record.clientTs - 10 * 60 * 1000 }); // device 10 min fast
        const secondTab = { run: vi.fn() };
        const editReply = vi.fn();
        let leased;
        const agent = { run: async () => {
            leased = await applyTGText(textEvent('hi'), 48, { agent: secondTab, records, editReply, now: () => NOW }).then(() => false, () => true);
            return 'Hello.';
        } };
        await applyTGText(textEvent('hi'), 48, { agent, records, editReply, now: () => NOW });
        expect(leased).toBe(true);
        expect(secondTab.run).not.toHaveBeenCalled();
        expect(editReply.mock.calls).toEqual([[REPLY_ID, 'Hello.']]);
    });

    it('a stale interrupted run with no write is retried once and answered', async () => {
        const records = staleMarker();
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('Your BP averaged 128/84.') };
        await applyTGText(textEvent('what was my bp'), 48, { agent, records, editReply, now: () => NOW });
        expect(agent.run).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, 'Your BP averaged 128/84.');
        expect(await records.list('tgagentrun')).toEqual([expect.objectContaining({ attempts: 1, reply: 'Your BP averaged 128/84.' })]);
    });

    it('a stale interrupted run that already wrote answers Done without a second run', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn() };
        await applyTGText(textEvent('log 80kg'), 48, { agent, records: staleMarker({ wrote: true }), editReply, now: () => NOW });
        expect(agent.run).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, '✅ Done.');
    });

    it('a stale interrupted retry gives up honestly, never asking to send it again', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn() };
        await applyTGText(textEvent('what was my bp'), 48, { agent, records: staleMarker({ attempts: 1 }), editReply, now: () => NOW });
        expect(agent.run).not.toHaveBeenCalled();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, '🤖 I could not finish handling that message; nothing was saved.');
    });

    it('a tool write through the agent router flags the marker wrote BEFORE the row lands', async () => {
        const records = fakeRecords();
        const order = [];
        const put = records.put;
        records.put = async (type, record) => {
            order.push(type === 'tgagentrun' ? `marker${record.wrote ? ':wrote' : ''}` : type);
            return put(type, record);
        };
        const router = createInboxRouter({ accountId: 'a' }, { records, now: () => NOW, timeZone: 'Europe/Berlin' });
        const agent = { run: async () => { await router('/api/notes', 'POST', { content: 'felt dizzy' }); return 'Noted.'; } };
        await applyTGText(textEvent('note: felt dizzy'), 48, { agent, records, editReply: vi.fn(), now: () => NOW });
        expect(order.slice(0, 3)).toEqual(['marker', 'marker:wrote', 'note']);
        // Outside a run the router writes without touching any marker.
        await router('/api/notes', 'POST', { content: 'later' });
        expect(order.at(-1)).toBe('note');
        expect(order.filter((t) => t === 'marker:wrote')).toHaveLength(1);
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

    it('an agent refused for missing trial consent offers the one-tap Allow button, not "try again"', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(Object.assign(new Error('consent'), { code: 'trial_consent_required', scope: 'tg' })) };
        await expect(applyTGText(textEvent('hi'), 45, { agent, records: fakeRecords(), editReply })).resolves.toBeUndefined();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/trial AI/), { trialConsentScope: 'tg' });
    });

    // The other refusal: no key of the user's own AND no trial to allow. An
    // "Allow trial AI" button there would deep-link to a toggle that changes
    // nothing, so the reply must stay button-less (2-arg editReply call).
    it('a no-key agent gets no consent button — there is no trial to allow', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(Object.assign(new Error('no key'), { code: 'no_api_key' })) };
        await applyTGText(textEvent('hi'), 46, { agent, records: fakeRecords(), editReply });
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/add an OpenAI key/));
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

    it('/activity keeps the free-text remainder verbatim and no longer refuses', () => {
        expect(parseCommand('/activity 2km bicycle')).toMatchObject({ kind: 'activity', command: '/activity', text: '2km bicycle' });
        expect(parseCommand('/activity').kind).toBe('invalid');
        expect(parseCommand('/activity')).toMatchObject({ command: '/activity', hint: expect.stringMatching(/Usage: \/activity/) });
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
    const TXT_MS = TXT_UNIX * 1000; // when the message was SENT — 3h before DRAIN_MS
    const REPLY_ID = 4343;
    const now = () => DRAIN_MS;
    const stubDispatcher = { handle: vi.fn() }; // no mcp_* tool is exercised here
    const textEvent = (text, atUnix = TXT_UNIX) => ({ kind: TG_TEXT, text, at_unix: atUnix, reply_message_id: REPLY_ID });
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

    // bd med-48x — the rolling conversation window. Same posture as the tgprefs
    // cases above: the REAL tg-agent over the REAL vault history port, only the
    // LLM boundary stubbed, because what matters is what actually reaches the
    // prompt and what actually survives in the record.
    const userTexts = (messages) => messages.filter((m) => m.role === 'user').map((m) => m.content);
    const chatRecord = async (records) => (await records.list('tgchat')).find((r) => r.recordId === 'tgchat' && !r.deleted);

    it('carries the previous exchange into the NEXT message context', async () => {
        const records = fakeRecords();
        const captured = [];
        // Snapshot: run() keeps pushing into the same array after this returns.
        const chat = vi.fn(async ({ messages }) => { captured.push([...messages]); return { content: `answer ${captured.length}` }; });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, history: makeTGHistoryPort(records, now) });
        const opts = { agent, records, editReply: vi.fn(), now };

        await applyTGText(textEvent('what was my bp this week'), 60, opts);
        await applyTGText(textEvent('and last week?'), 61, opts);

        // The first turn is spliced in as a plain user/assistant pair, in order,
        // ahead of the new question — that is the whole point of the feature.
        expect(captured[1].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
        expect(captured[1].slice(1).map((m) => m.content)).toEqual([
            'what was my bp this week',
            'answer 1',
            'and last week?',
        ]);
    });

    it('sends at most the last 5 turns even when more are stored', async () => {
        const turns = Array.from({ length: 7 }, (_, i) => ({ ts: TXT_MS - (7 - i) * 60_000, user: `u${i}`, assistant: `a${i}` }));
        const records = fakeRecords({ tgchat: [{ recordId: 'tgchat', deleted: false, turns }] });
        const captured = [];
        const chat = vi.fn(async ({ messages }) => { captured.push([...messages]); return { content: 'ok' }; });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, history: makeTGHistoryPort(records, now) });

        await applyTGText(textEvent('now what'), 62, { agent, records, editReply: vi.fn(), now });

        expect(userTexts(captured[0])).toEqual(['u2', 'u3', 'u4', 'u5', 'u6', 'now what']);
    });

    // Ages by the message's own SENT time, not the drain clock (here 3h later):
    // drainInbox applies a whole backlog in one loop, so drain-time aging would
    // make days of queued messages look like one live conversation.
    it('drops a turn older than the 1h window from the prompt AND from the record', async () => {
        const stale = { ts: TXT_MS - 2 * 3600_000, user: 'ancient', assistant: 'ancient answer' };
        const fresh = { ts: TXT_MS - 60_000, user: 'recent', assistant: 'recent answer' };
        const records = fakeRecords({ tgchat: [{ recordId: 'tgchat', deleted: false, turns: [stale, fresh] }] });
        const captured = [];
        const chat = vi.fn(async ({ messages }) => { captured.push([...messages]); return { content: 'ok' }; });
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, history: makeTGHistoryPort(records, now) });

        await applyTGText(textEvent('still there?'), 63, { agent, records, editReply: vi.fn(), now });

        expect(userTexts(captured[0])).toEqual(['recent', 'still there?']);
        // Pruned on write too, so an idle tab cannot resurrect it later.
        expect((await chatRecord(records)).turns.map((t) => t.user)).toEqual(['recent', 'still there?']);
    });

    // bd med-egxt — turns are aged by the message's OWN send time (med-3hr), so a
    // backlog drain can append a turn OLDER than one already stored. The
    // transcript must still read oldest-first, or the next prompt replays the
    // conversation out of order.
    it('keeps the transcript oldest-first when a backdated message is appended', async () => {
        const stored = { ts: TXT_MS, user: 'newer', assistant: 'newer answer' };
        const records = fakeRecords({ tgchat: [{ recordId: 'tgchat', deleted: false, turns: [stored] }] });
        const chat = vi.fn(async () => ({ content: 'ok' }));
        const agent = createTGAgent({ chat, dispatcher: stubDispatcher, history: makeTGHistoryPort(records, now) });

        await applyTGText(textEvent('older', TXT_UNIX - 600), 65, { agent, records, editReply: vi.fn(), now });

        expect((await chatRecord(records)).turns.map((t) => t.user)).toEqual(['older', 'newer']);
    });

    it('stores ONLY the final plain-text pair — a persisted tool_calls round would 400 the next request', async () => {
        const records = fakeRecords();
        const chat = vi.fn()
            .mockResolvedValueOnce({ content: '', tool_calls: [{ id: 'c1', function: { name: 'mcp_call', arguments: JSON.stringify({ operation_id: 'bp_list' }) } }] })
            .mockResolvedValueOnce({ content: 'Your BP averaged 128/84.' });
        const agent = createTGAgent({ chat, dispatcher: { handle: vi.fn().mockResolvedValue({ readings: [] }) }, history: makeTGHistoryPort(records, now) });

        await applyTGText(textEvent('what was my bp'), 64, { agent, records, editReply: vi.fn(), now });

        const { turns } = await chatRecord(records);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ user: 'what was my bp', assistant: 'Your BP averaged 128/84.' });
        expect(JSON.stringify(turns)).not.toContain('tool_call');
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

    // bd med-w0fe — the day was deleted in the app (deleteSession tombstones the
    // slot), but the reminder carrying these buttons was already in the chat. A
    // tap must not resurrect a day the card and the horizon both treat as gone.
    it('snooze and skip both no-op on a slot the user deleted', async () => {
        for (const event of [snooze1hEvent, skipEvent]) {
            const records = fakeRecords({
                workoutsession: [{ recordId: WRECORD, clientTs: WTAP_MS - 1000, deleted: true }],
            });
            await applyWorkoutSessionAction(event, { workout: workoutFor(records), editReply: vi.fn() });
            const live = (await records.list('workoutsession')).filter((r) => !r.deleted);
            expect(live).toHaveLength(0);
        }
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

describe('inbox-apply.js — a Telegram BP/weight reminder Snooze/Skip tap', () => {
    const MTAP_UNIX = 1784592000; // 2026-07-20T16:00:00Z
    const MTAP_MS = MTAP_UNIX * 1000;
    // The Telegram measure button is "Snooze 1h", so the drain mutes for 1h —
    // deliberately shorter than the in-app Snooze button's default 2h.
    const MEASURE_SNOOZE_MS = 60 * 60 * 1000;

    function remindersFor(records) {
        return createRemindersDomain({ records, now: () => MTAP_MS });
    }

    it('bp snooze sets snoozed_until pinned to the tap time', async () => {
        const records = fakeRecords();
        const event = { kind: MEASURE_REMINDER_ACTION, measure: 'bp', action: 'snooze', at_unix: MTAP_UNIX, message_id: 700 };
        await applyMeasureReminderAction(event, { reminders: remindersFor(records), editReply: vi.fn() });
        const status = await remindersFor(records).getBPStatus();
        expect(status.snoozed_until).toBe(MTAP_MS + MEASURE_SNOOZE_MS);
        expect(status.dont_remind_until).toBe(0);
    });

    it('weight skip sets dont_remind_until (24h mute)', async () => {
        const records = fakeRecords();
        const event = { kind: MEASURE_REMINDER_ACTION, measure: 'weight', action: 'skip', at_unix: MTAP_UNIX, message_id: 701 };
        await applyMeasureReminderAction(event, { reminders: remindersFor(records), editReply: vi.fn() });
        const status = await remindersFor(records).getWeightStatus();
        expect(status.dont_remind_until).toBe(MTAP_MS + DONT_BUG_MS);
        expect(status.snoozed_until).toBe(0);
    });

    it('is idempotent on redelivery — the pinned tap time yields the same mute instant', async () => {
        const records = fakeRecords();
        const event = { kind: MEASURE_REMINDER_ACTION, measure: 'bp', action: 'snooze', at_unix: MTAP_UNIX, message_id: 702 };
        await applyMeasureReminderAction(event, { reminders: remindersFor(records), editReply: vi.fn() });
        await applyMeasureReminderAction(event, { reminders: remindersFor(records), editReply: vi.fn() });
        const status = await remindersFor(records).getBPStatus();
        expect(status.snoozed_until).toBe(MTAP_MS + MEASURE_SNOOZE_MS);
    });

    it('edits the Telegram reply via the tap message id', async () => {
        const records = fakeRecords();
        const editReply = vi.fn(async () => {});
        const event = { kind: MEASURE_REMINDER_ACTION, measure: 'bp', action: 'snooze', at_unix: MTAP_UNIX, message_id: 700 };
        await applyMeasureReminderAction(event, { reminders: remindersFor(records), editReply });
        expect(editReply).toHaveBeenCalledWith(700, expect.stringMatching(/Snoozed/));
    });

    it('routes through createInboxApplier by event kind', async () => {
        const records = fakeRecords();
        const apply = createInboxApplier({ accountId: 'a' }, { records, now: () => MTAP_MS, editReply: vi.fn() });
        await apply({ kind: MEASURE_REMINDER_ACTION, measure: 'weight', action: 'snooze', at_unix: MTAP_UNIX, message_id: 703 });
        const status = await remindersFor(records).getWeightStatus();
        expect(status.snoozed_until).toBe(MTAP_MS + MEASURE_SNOOZE_MS);
    });
});

// bd med-x7x2 — the residual race after the horizon fix: a "Time to take" push
// was already in flight when the user deleted that dose. The tap must stay a
// clean no-op — no row minted over the tombstone, no "Confirmed N" receipt.
describe('inbox-apply.js — a tap on a deleted dose slot', () => {
    it('creates nothing over the tombstone and reports no confirmation', async () => {
        const records = fakeRecords({
            medication: [
                { recordId: 'med-a', deleted: false, name: 'Lisinopril', schedule: '{"type":"daily","times":["00:00"]}', inventory_count: 30 },
            ],
            // The tombstone deleteFutureIntakes leaves behind: recordId + deleted,
            // no body (sync.js records.del).
            intake: [{ recordId: `intake-med-a-${SLOT_UNIX}`, deleted: true }],
        });
        const now = () => DRAIN_MS;
        const editReply = vi.fn(async () => {});
        await applyIntakeSlotAction(
            { ...medsNamed(confirmEvent, ['med-a']), message_id: 77 },
            { intake: domainFor(records, now), records, now, editReply },
        );

        // The slot is still a tombstone — the projection lists nothing there,
        // so the tap minted nothing.
        expect(await records.listRaw('intake')).toEqual([
            { recordId: `intake-med-a-${SLOT_UNIX}`, deleted: true },
        ]);
        expect((await records.list('intake')).filter((i) => !i.deleted)).toHaveLength(0);
        // Never "✅ Confirmed …" — and never the relay's static "waiting for
        // your device" left standing either (bd med-944k): it says nothing was due.
        expect(editReply).toHaveBeenCalledTimes(1);
        expect(editReply).toHaveBeenCalledWith(77, 'ℹ️ Nothing was due — no medications to confirm.');

        // Generic verbosity too (Argus 6065): a no-op never reads "✅ Recorded.".
        const generic = vi.fn(async () => {});
        await applyIntakeSlotAction(
            { ...medsNamed(confirmEvent, ['med-a']), message_id: 78 },
            { intake: domainFor(records, now), records, now, editReply: generic, verbosity: 'generic' },
        );
        expect(generic).toHaveBeenCalledWith(78, 'ℹ️ Nothing was due — no medications to confirm.');
        // Nothing was taken, so nothing came off the shelf.
        expect((await records.list('medication'))[0].inventory_count).toBe(30);
    });
});

// bd med-wi09.4 (Argus 5031, Archie 5034) — lineage resolved at the root, no
// read pad: a cancelled dose whose canonical lies outside the read is hidden
// (it belongs to the canonical's read, when some read lists it: at or after the
// cut, or stored); a canonical no read lists leaves it standing in (Archie 5078).
describe('inbox-apply.js — taps on lineage-cancelled slots', () => {
    const DAILY = '{"type":"daily","times":["00:00"]}';
    const sec = (s) => Date.parse(s) / 1000;
    const iso = (s) => new Date(s * 1000).toISOString();
    const id = (s) => `intake-med-a-${s}`;
    const pending = (s) => ({ recordId: id(s), deleted: false, medication_id: 'med-a', scheduled_at: iso(s), status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' });
    const edit = (n, fromS, replacement) => ({
        recordId: `medsched-med-a-${n}`, clientTs: 1, deleted: false, medication_id: 'med-a', schedule: DAILY, tz_shift_policy: 'flexible', from: iso(fromS),
        boundary: [{ medId: 'med-a', kept: [], cancelled: Object.keys(replacement), replacement }],
    });
    const med = { recordId: 'med-a', deleted: false, name: 'A', schedule: DAILY, inventory_count: 30 };

    // A daily 00:00 dose moved UTC+14 → UTC−12 (A → B, +26h), then 00:00 →
    // 23:00 before B (B → C, +23h): A → C is 49h, old-client rows stored pre-cut.
    const A = sec('2026-06-30T10:00:00Z');
    const B = sec('2026-07-01T12:00:00Z');
    const C = sec('2026-07-02T11:00:00Z');
    const chain = () => fakeRecords({
        medication: [med],
        intake: [pending(A), pending(B), pending(C)],
        medsched: [edit(1, A - 3600, { [id(A)]: id(B) }), edit(2, A + 3600, { [id(B)]: id(C) })],
        ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: iso(C + 2 * 86400) }],
    });
    const chainNow = () => (C + 86400) * 1000;

    it('a chained replacement 49h away hides the cancelled slot at its instant; the canonical is listed', async () => {
        const records = chain();
        const intake = domainFor(records, chainNow);
        expect(await dosesAtInstant(intake, A * 1000)).toEqual([]);
        expect(await dosesAtInstant(intake, B * 1000)).toEqual([]);
        expect((await dosesAtInstant(intake, C * 1000)).map((r) => r.occId)).toEqual([id(C)]);
        // getIntake(A) resolves nothing: no action reaches the cancelled row.
        await expect(intake.confirm(id(A), A * 1000)).rejects.toMatchObject({ code: 'not_pending' });
        expect((await records.list('intake')).every((i) => i.status === 'PENDING')).toBe(true);
    });

    it('a tap on the chain-cancelled slot writes nothing and is out of date', async () => {
        const records = chain();
        const onOutOfDate = vi.fn();
        await applyIntakeSlotAction(
            { kind: INTAKE_SLOT_ACTION, slot_unix: A, action: 'confirm', at_unix: A + 60, medication_ids: ['med-a'] },
            { intake: domainFor(records, chainNow), records, now: chainNow, onOutOfDate },
        );

        expect((await records.list('intake')).every((i) => i.status === 'PENDING')).toBe(true);
        expect((await records.list('medication'))[0].inventory_count).toBe(30);
        expect(onOutOfDate).toHaveBeenCalledWith({ medId: 'med-a', scheduled: iso(A), count: 1 });
    });

    // A switch before the cut: the same-day replacement was never regenerated,
    // so the stored cancelled row is the dose — the day lists it, and an
    // action on it (the timeline's Take) still lands.
    it('a pre-cut stored dose whose same-day canonical never regenerated still stands in', async () => {
        const a = sec('2026-06-30T08:00:00Z');
        const k = sec('2026-06-30T20:00:00Z');
        const records = fakeRecords({
            medication: [med],
            intake: [pending(a)],
            medsched: [edit(1, a - 3600, { [id(a)]: id(k) })],
            ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: iso(a + 3 * 86400) }],
        });
        const now = () => (a + 2 * 86400) * 1000;
        const intake = domainFor(records, now);
        const day = Date.parse('2026-06-30T00:00:00Z');
        expect((await intake.occurrences({ fromMs: day, toMs: day + 86400000 - 1 })).map((r) => r.occId)).toEqual([id(a)]);

        await intake.confirm(id(a), a * 1000);
        expect((await records.list('intake'))[0].status).toBe('TAKEN');
    });

    // Archie 5078: a daily 23:00 dose, UTC → UTC−2 switched before the cut,
    // nothing regenerated. The 07-01 dose's canonical (01:00 UTC on 07-02) is
    // before the cut and never stored, so no read lists it: the stored dose
    // stays in its own day cell and confirm() works on it.
    it('a pre-cut stand-in whose canonical is on the neighbouring day stays in its day cell', async () => {
        const m = { recordId: 1, name: 'Met', dosage: '1', schedule: '{"type":"daily","times":["23:00"]}', created_at: '2026-01-01T00:00:00Z', deleted: false };
        const switchAt = Date.parse('2026-06-30T20:00:00Z');
        const bnd = boundary({ oldGen: { timeZone: 'UTC', medications: [m] }, newGen: { timeZone: 'Etc/GMT+2', medications: [m] }, switchAt });
        const c = `intake-1-${Date.parse('2026-07-01T23:00:00Z') / 1000}`;
        const records = fakeRecords({
            ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: '2026-07-05T00:00:00Z' }],
            medication: [m],
            tztransition: [{ recordId: 't1', deleted: false, switch_at: new Date(switchAt).toISOString(), old_tz: 'UTC', new_tz: 'Etc/GMT+2', boundary: bnd }],
            intake: [{ recordId: c, deleted: false, medication_id: 1, scheduled_at: '2026-07-01T23:00:00.000Z', status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' }],
        });
        const now = () => Date.parse('2026-07-10T12:00:00Z');
        const intake = domainFor(records, now);
        const day = Date.parse('2026-07-01T00:00:00Z');
        expect((await intake.occurrences({ fromMs: day, toMs: day + 86400000 - 1 })).map((r) => r.occId)).toEqual([c]);

        await intake.confirm(c);
        expect((await records.list('intake'))[0].status).toBe('TAKEN');
    });

    // Argus 5086: the same switch with the cut at 01:30 UTC on 07-02. The
    // canonical (01:00 UTC on 07-02) is before the cut instant but after the
    // regeneration start (local midnight of the cut day), so it IS listed:
    // the stored dose is cancelled into it in every read, counted once.
    it('on the cut day, a canonical regenerated before the cut instant hides its cancelled dose in every read', async () => {
        const m = { recordId: 1, name: 'Met', dosage: '1', schedule: '{"type":"daily","times":["23:00"]}', created_at: '2026-01-01T00:00:00Z', deleted: false };
        const switchAt = Date.parse('2026-06-30T20:00:00Z');
        const bnd = boundary({ oldGen: { timeZone: 'UTC', medications: [m] }, newGen: { timeZone: 'Etc/GMT+2', medications: [m] }, switchAt });
        const c = `intake-1-${Date.parse('2026-07-01T23:00:00Z') / 1000}`;
        const k = `intake-1-${Date.parse('2026-07-02T01:00:00Z') / 1000}`;
        const records = fakeRecords({
            ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: '2026-07-02T01:30:00Z' }],
            medication: [m],
            tztransition: [{ recordId: 't1', deleted: false, switch_at: new Date(switchAt).toISOString(), old_tz: 'UTC', new_tz: 'Etc/GMT+2', boundary: bnd }],
            intake: [{ recordId: c, deleted: false, medication_id: 1, scheduled_at: '2026-07-01T23:00:00.000Z', status: 'PENDING', taken_at: null, snoozed_until: null, source: 'schedule' }],
        });
        const now = () => Date.parse('2026-07-10T12:00:00Z');
        const intake = domainFor(records, now);
        const dayRead = async (iso) => (await intake.occurrences({ fromMs: Date.parse(iso), toMs: Date.parse(iso) + 86400000 - 1 })).map((r) => r.occId);
        expect(await dayRead('2026-07-01T00:00:00Z')).toEqual([]);
        expect(await dayRead('2026-07-02T00:00:00Z')).toEqual([k]);
        const wide = (await intake.occurrences({ fromMs: Date.parse('2026-06-30T00:00:00Z'), toMs: Date.parse('2026-07-02T23:59:59Z') })).map((r) => r.occId);
        expect(wide).toEqual([k]);
        expect(await dosesAtInstant(intake, Date.parse('2026-07-01T23:00:00Z'))).toEqual([]);
        // The logical dose is K: acting on it writes at K's id.
        await intake.confirm(k);
        expect((await records.list('intake')).find((i) => i.recordId === k).status).toBe('TAKEN');
    });

    // Argus 5057: an imported tz_step row keys `intake-<m>-<s>-tz_step`, while
    // lineage keys are bare slot ids — the resolver looks its canonical up by
    // (med, second), so the stand-in stays actionable under its own id.
    it('an imported -tz_step stand-in is listed and actionable under its own id', async () => {
        const a = sec('2026-06-30T08:00:00Z');
        const k = sec('2026-06-30T20:00:00Z');
        const stepId = `${id(a)}-tz_step`;
        const records = fakeRecords({
            medication: [med],
            intake: [{ ...pending(a), recordId: stepId, source: 'tz_step' }],
            medsched: [edit(1, a - 3600, { [id(a)]: id(k) })],
            ledgercut: [{ recordId: 'ledgercut', clientTs: 0, deleted: false, at: iso(a + 3 * 86400) }],
        });
        const now = () => (a + 2 * 86400) * 1000;
        const intake = domainFor(records, now);
        const day = Date.parse('2026-06-30T00:00:00Z');
        expect((await intake.occurrences({ fromMs: day, toMs: day + 86400000 - 1 })).map((r) => r.occId)).toEqual([stepId]);

        await intake.confirm(stepId, a * 1000);
        expect((await records.list('intake'))[0]).toMatchObject({ recordId: stepId, status: 'TAKEN' });
    });
});
