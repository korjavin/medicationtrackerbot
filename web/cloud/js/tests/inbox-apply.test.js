// bd med-76c.2 part 2 — applying a sealed Telegram tap through the real intake
// domain. These run against createIntakeDomain (not a stub) because the two
// properties that matter — a re-drain converging instead of double-decrementing
// inventory, and a 09:00 tap recording 09:00 — are properties of that domain's
// behavior, not of this module's bookkeeping.
import { describe, expect, it, vi } from 'vitest';
import { createIntakeDomain } from '../../../domain/medintake.js';
import { applyIntakeSlotAction, applyTGCommand, applyTGPhoto, applyTGText, createInboxApplier, INTAKE_SLOT_ACTION, TG_COMMAND, TG_PHOTO, TG_TEXT } from '../inbox-apply.js';
import { createBPDomain } from '../../../domain/bp.js';
import { createWeightDomain } from '../../../domain/weight.js';
import { createNotesDomain } from '../../../domain/notes.js';
import { createFoodDomain } from '../../../domain/food.js';
import { createFoodAIDomain } from '../../../domain/foodai.js';
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

    function domainsFor(records, now, aiClient = stubAIClient(TWO_EGGS)) {
        return {
            bp: createBPDomain({ records, now, timeZone: 'UTC' }),
            weight: createWeightDomain({ records, now, timeZone: 'UTC' }),
            notes: createNotesDomain({ records, now }),
            intake: domainFor(records, now),
            foodAI: createFoodAIDomain({ aiClient, foodDomain: createFoodDomain({ records, now, timeZone: 'UTC' }), now }),
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
        await applyTGCommand(commandEvent('/workout legs'), 14, { ...domainsFor(records, now), editReply });

        expect(editReply).toHaveBeenNthCalledWith(1, REPLY_ID, expect.stringMatching(/don't understand \/bogus/));
        expect(editReply).toHaveBeenNthCalledWith(2, REPLY_ID, expect.stringMatching(/\/workout isn't available over chat yet/));
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

    // --- Free-text AI agent (bd med-vcv.2) ---
    // The loop itself is pinned in tg-agent.test.js; here the agent is a stub so
    // only applyTGText's own responsibility — reply, verbosity, error-ack — is
    // under test, the same way the food tests stub the provider boundary.
    function textEvent(text) {
        return { kind: TG_TEXT, text, at_unix: CMD_UNIX, reply_message_id: REPLY_ID };
    }

    it('a free-text message gets the agent answer as its edited reply', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('Logged 2 eggs (140 kcal).') };
        await applyTGText(textEvent('i ate two eggs'), 40, { agent, editReply });
        expect(agent.run).toHaveBeenCalledWith('i ate two eggs');
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, 'Logged 2 eggs (140 kcal).');
    });

    it('generic verbosity suppresses the answer so no health value crosses Telegram', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('Your BP this week averaged 128/84.') };
        await applyTGText(textEvent('what was my bp?'), 41, { agent, verbosity: 'generic', editReply });
        const [, text] = editReply.mock.calls[0];
        expect(text).toBe('✅ Done.');
        expect(text).not.toContain('128');
    });

    it('a long answer is truncated under the relay edit cap', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('x'.repeat(5000)) };
        await applyTGText(textEvent('tell me everything'), 42, { agent, editReply });
        const [, text] = editReply.mock.calls[0];
        expect([...text].length).toBeLessThanOrEqual(900);
        expect(text.endsWith('…')).toBe(true);
    });

    it('a no-key agent tells the user to add one and acks', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(Object.assign(new Error('no key'), { code: 'no_api_key' })) };
        await expect(applyTGText(textEvent('hi'), 43, { agent, editReply })).resolves.toBeUndefined();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/add an OpenAI key/));
    });

    it('any other agent failure is answered and acked, never left dangling', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockRejectedValue(new Error('provider exploded')) };
        await expect(applyTGText(textEvent('hi'), 44, { agent, editReply })).resolves.toBeUndefined();
        expect(editReply).toHaveBeenCalledWith(REPLY_ID, expect.stringMatching(/went wrong/));
        warn.mockRestore();
    });

    it('an empty agent answer still edits the placeholder to a done ack', async () => {
        const editReply = vi.fn();
        const agent = { run: vi.fn().mockResolvedValue('   ') };
        await applyTGText(textEvent('hi'), 45, { agent, editReply });
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
        expect(parseCommand('/workout')).toMatchObject({ kind: 'unsupported', command: '/workout' });
        expect(parseCommand('/bogus')).toMatchObject({ kind: 'unknown', command: '/bogus' });
    });

    it('/food keeps the free-text remainder verbatim for a client-side AI parse', () => {
        expect(parseCommand('/food two eggs')).toMatchObject({ kind: 'food', command: '/food', text: 'two eggs' });
        expect(parseCommand('/food').kind).toBe('invalid');
    });

    it('marks relay-answered commands local, and free text as not a command', () => {
        expect(parseCommand('/start').kind).toBe('local');
        expect(parseCommand('/help').kind).toBe('local');
        expect(parseCommand('I ate two eggs').kind).toBe('not_a_command');
    });
});
