// bd med-eas.67 + med-eas.65 — the reminder horizon records slotUnix → [medId…]
// so a Telegram Confirm can act on the meds the reminder NAMED, by identity,
// instead of re-deriving them from a ±10min band at drain time (which drops
// course meds whose materialized intake drifted off the clock slot).
//
// med-eas.65 moved that map out of a device-local store and INTO THE VAULT: the
// device that pushes a reminder is routinely not the device that drains the tap,
// so a device-local map left every cross-device Confirm on the ±band path. It is
// also merge-and-prune rather than replace-all — a delivered Telegram message
// stays tappable long after its slot has left the forward horizon.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRemindersDomain } from '../../../domain/reminders.js';
import { recomputeAndPush } from '../reminders.js';

const HOUR = 3600;
const NOW_UNIX = 1767225600; // 2026-01-01T00:00:00Z
const NOW_MS = NOW_UNIX * 1000;

// Records port over an in-memory map, keyed by recordId within each type —
// same shape as sync.js's recordsPort, matching inbox-apply.test.js's fake.
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
    listRange: async (type, fromId, toId) => (store[type] || [])
      .filter((r) => !r.deleted && r.recordId >= fromId && r.recordId <= toId)
      .map((r) => ({ ...r })),
  };
}

// A grouped dose reminder carries every med's id; a re-reminder carries its one
// med keyed to the same slot stem. BP reminders have no callback → no slot.
function rem(slotUnix, medicationIds) {
  return { fireAtUnix: slotUnix, kind: 'medication', text: 'meds', genericText: 'due', callback: `s:${slotUnix}`, medicationIds };
}

function domainAt(records, nowMs) {
  return createRemindersDomain({ records, now: () => nowMs });
}

describe('slot→meds map (med-eas.65: vault-resident, merge-and-prune)', () => {
  it('stores each slot with its named med ids', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([
      rem(NOW_UNIX, ['med-a', 'med-b', 'med-c']),
      rem(NOW_UNIX + HOUR, ['med-d']),
      { fireAtUnix: NOW_UNIX + 2 * HOUR, kind: 'bp', text: 'bp', genericText: 'bp' }, // no callback
    ]);

    const domain = domainAt(records, NOW_MS);
    expect(await domain.getSlotMedications(NOW_UNIX)).toEqual(['med-a', 'med-b', 'med-c']);
    expect(await domain.getSlotMedications(NOW_UNIX + HOUR)).toEqual(['med-d']);
    expect(await domain.getSlotMedications(NOW_UNIX + 2 * HOUR)).toBeNull(); // BP: no slot recorded
  });

  it('folds a re-reminder into its grouped slot and dedupes', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([
      rem(NOW_UNIX, ['med-a', 'med-b']),
      rem(NOW_UNIX, ['med-a']), // re-reminder for med-a on the same slot stem
    ]);

    expect(await domainAt(records, NOW_MS).getSlotMedications(NOW_UNIX)).toEqual(['med-a', 'med-b']);
  });

  it('returns null for a slot nothing ever named', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a'])]);
    expect(await domainAt(records, NOW_MS).getSlotMedications(NOW_UNIX + 9999)).toBeNull();
  });

  it('returns null when nothing has ever been recorded (a pre-med-eas.65 reminder)', async () => {
    expect(await domainAt(fakeRecords(), NOW_MS).getSlotMedications(NOW_UNIX)).toBeNull();
  });

  // The reason this is NOT replace-all. A slot leaves the forward horizon as soon
  // as the local day rolls over, but its Telegram message is still in the chat
  // and the relay re-fires it for ~6h. Dropping the entry on the next rebuild put
  // that tap back on the ±band path — the exact drift case the map exists to fix.
  it('keeps a fired slot the newest horizon no longer lists', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a', 'med-b'])]);

    // 8h later the dose is past; the rebuilt horizon only carries future slots.
    const later = NOW_MS + 8 * HOUR * 1000;
    await domainAt(records, later).recordSlotMedications([rem(NOW_UNIX + 24 * HOUR, ['med-a', 'med-b'])]);

    expect(await domainAt(records, later).getSlotMedications(NOW_UNIX)).toEqual(['med-a', 'med-b']);
    expect(await domainAt(records, later).getSlotMedications(NOW_UNIX + 24 * HOUR)).toEqual(['med-a', 'med-b']);
  });

  // …but not forever: past the retention window the entry is pruned, so the map
  // stays bounded and a very old tap takes the safe ±band path instead.
  it('prunes slots older than the 48h retention window', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a'])]);

    const muchLater = NOW_MS + 49 * HOUR * 1000;
    await domainAt(records, muchLater).recordSlotMedications([rem(NOW_UNIX + 72 * HOUR, ['med-a'])]);

    expect(await domainAt(records, muchLater).getSlotMedications(NOW_UNIX)).toBeNull();
    expect(await domainAt(records, muchLater).getSlotMedications(NOW_UNIX + 72 * HOUR)).toEqual(['med-a']);
  });

  // A later push that re-lists the same slot wins for that slot: it describes the
  // message the relay is actually serving for it now.
  it('a newer horizon replaces the med set of a slot it re-lists', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a', 'med-d'])]);
    await domainAt(records, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a'])]);

    expect(await domainAt(records, NOW_MS).getSlotMedications(NOW_UNIX)).toEqual(['med-a']);
  });

  // Cross-device, the med-eas.65 hole: device A pushes, device B drains the tap.
  // The map rides the vault, so B's records port sees exactly what A recorded —
  // the device-local store it replaced never did.
  it('is readable from another device through the same vault records', async () => {
    const deviceA = fakeRecords();
    await domainAt(deviceA, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a', 'med-b'])]);

    // B's port is a fresh domain over the SYNCED record set, no device state.
    const deviceB = fakeRecords({ slotmeds: deviceA.dump().slotmeds });
    expect(await domainAt(deviceB, NOW_MS).getSlotMedications(NOW_UNIX)).toEqual(['med-a', 'med-b']);
  });
});

// The seam: recomputeAndPush records the map only after the relay upload lands,
// so the identity map never gets ahead of the reminders actually being served.
describe('recomputeAndPush records the slot→meds map after a successful push', () => {
  const ctx = { accountId: 'acct-1' };
  // Telegram-only delivery: needsCT is false, so pushSchedule never touches the
  // NK / crypto path.
  const seed = () => ({
    medication: [
      { recordId: 'med-a', deleted: false, name: 'A', dosage: '10mg', schedule: '{"type":"daily","times":["09:00"]}' },
    ],
    reminderdeliverypref: [
      { recordId: 'reminderdeliverypref', deleted: false, delivery: 'telegram', verbosity: 'generic' },
    ],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.fetch;
    vi.restoreAllMocks();
  });

  it('writes the named meds for every slot the pushed horizon carried', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    const records = fakeRecords(seed());
    await recomputeAndPush(ctx, { records, timeZone: 'UTC' });

    const rec = (records.dump().slotmeds || [])[0];
    expect(rec).toBeDefined();
    const slots = Object.entries(rec.slots);
    expect(slots.length).toBeGreaterThan(0);
    for (const [, ids] of slots) expect(ids).toEqual(['med-a']);
  });

  it('records nothing when the relay upload fails — no map ahead of the schedule', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const records = fakeRecords(seed());

    await expect(recomputeAndPush(ctx, { records, timeZone: 'UTC' })).rejects.toThrow();
    expect(records.dump().slotmeds).toBeUndefined();
  });
});
