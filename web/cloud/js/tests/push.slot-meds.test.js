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
import { recomputeAndPush, cancelMedRefire } from '../reminders.js';
import { pushSchedule } from '../push.js';

const HOUR = 3600;
const NOW_UNIX = 1767225600; // 2026-01-01T00:00:00Z
const NOW_MS = NOW_UNIX * 1000;

// Records port over an in-memory map, keyed by recordId within each type —
// same shape as sync.js's recordsPort, matching inbox-apply.test.js's fake.
// del writes a tombstone stamped by `clock` (sync.js's del stamps Date.now()),
// so a merge can rank it against a live record by clientTs the way sync does.
function fakeRecords(seed = {}, clock = Date.now) {
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
      store[type].push({ recordId: id, clientTs: clock(), deleted: true });
    },
    listRange: async (type, fromId, toId) => (store[type] || [])
      .filter((r) => !r.deleted && r.recordId >= fromId && r.recordId <= toId)
      .map((r) => ({ ...r })),
  };
}

// lww merges two devices' record sets the way sync does: per recordId, the
// higher clientTs wins, tombstones included.
function lww(a, b) {
  const merged = fakeRecords();
  for (const r of [...(a.dump().slotmeds || []), ...(b.dump().slotmeds || [])]) {
    const cur = (merged.dump().slotmeds || []).find((x) => x.recordId === r.recordId);
    if (!cur || r.clientTs > cur.clientTs) {
      merged.dump().slotmeds = (merged.dump().slotmeds || []).filter((x) => x.recordId !== r.recordId).concat([{ ...r }]);
    }
  }
  return merged;
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

  // Retention is a property of the ANSWER, not of when a recompute last ran: a
  // device closed for a week drains an old tap before it ever prunes, and must
  // still take the ±band path for it.
  it('refuses an entry past the retention window even when nothing has pruned it', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a'])]);

    expect(await domainAt(records, NOW_MS + 47 * HOUR * 1000).getSlotMedications(NOW_UNIX)).toEqual(['med-a']);
    expect(await domainAt(records, NOW_MS + 49 * HOUR * 1000).getSlotMedications(NOW_UNIX)).toBeNull();
  });

  // A stale entry for a slot that has NOT fired yet is the one genuinely
  // dangerous state: if the relay is serving a reminder that names fewer meds
  // than the map still claims, Confirm would mark an unnamed med taken. So the
  // pre-upload drop keeps only what has already been delivered.
  it('drops not-yet-fired slots before an upload, keeping the delivered ones', async () => {
    const records = fakeRecords();
    await domainAt(records, NOW_MS).recordSlotMedications([
      rem(NOW_UNIX - HOUR, ['med-a', 'med-d']), // already fired: its message is out
      rem(NOW_UNIX + HOUR, ['med-a', 'med-d']), // not yet fired
    ]);

    await domainAt(records, NOW_MS).dropFutureSlotMedications();

    const domain = domainAt(records, NOW_MS);
    expect(await domain.getSlotMedications(NOW_UNIX - HOUR)).toEqual(['med-a', 'med-d']);
    expect(await domain.getSlotMedications(NOW_UNIX + HOUR)).toBeNull();
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
  // bd med-onzf — the interleaving that lost a fired slot under the singleton.
  // Device A drops its future slots (write 1) and uploads; device B syncs THAT
  // state and goes quiet; A's post-upload write (2) restores the slots. The slot
  // fires. B wakes, recomputes off its stale post-drop copy: the slot is now
  // past, so nothing re-lists it, and B's newer write won LWW without it. With
  // per-slot records B's writes never touch that slot: A's live record (write 2)
  // outranks the write-1 tombstone B holds, and the drain resolves by identity.
  it('keeps a fired slot when a stale device recomputes off the first device\'s post-drop state', async () => {
    const slot = NOW_UNIX + HOUR; // future at A's upload, fired by the time B recomputes
    let clockA = NOW_MS - HOUR * 1000;
    const deviceA = fakeRecords({}, () => clockA);
    await domainAt(deviceA, clockA).recordSlotMedications([rem(slot, ['med-a'])]);

    clockA = NOW_MS;
    await domainAt(deviceA, clockA).dropFutureSlotMedications(); // write 1: tombstone, PUT in flight
    const synced = JSON.parse(JSON.stringify(deviceA.dump().slotmeds)); // B syncs exactly this
    expect(synced.find((r) => r.recordId === `slotmeds-${slot}`).deleted).toBe(true);
    clockA = NOW_MS + 500;
    await domainAt(deviceA, clockA).recordSlotMedications([rem(slot, ['med-a'])]); // write 2

    const later = NOW_MS + 2 * HOUR * 1000; // slot fired an hour ago; B never saw write 2
    const deviceB = fakeRecords({ slotmeds: synced }, () => later);
    await domainAt(deviceB, later).dropFutureSlotMedications();
    await domainAt(deviceB, later).recordSlotMedications([rem(slot + 24 * HOUR, ['med-a'])]);
    expect(await domainAt(deviceB, later).getSlotMedications(slot)).toBeNull(); // B alone is honestly stale

    expect(await domainAt(lww(deviceA, deviceB), later).getSlotMedications(slot)).toEqual(['med-a']);
    expect(await domainAt(lww(deviceB, deviceA), later).getSlotMedications(slot)).toEqual(['med-a']);
  });

  // A stale device that still holds a LIVE copy of an expired slot cannot
  // resurrect it: the pruning device's tombstone is newer and wins the merge,
  // and the getter's own age guard refuses the record before any sync anyway.
  it('an expiry tombstone outranks a stale device\'s live copy', async () => {
    const deviceA = fakeRecords({}, () => NOW_MS);
    await domainAt(deviceA, NOW_MS).recordSlotMedications([rem(NOW_UNIX, ['med-a'])]);
    const stale = fakeRecords({ slotmeds: deviceA.dump().slotmeds }, () => NOW_MS);

    const muchLater = NOW_MS + 49 * HOUR * 1000;
    const pruner = fakeRecords({ slotmeds: deviceA.dump().slotmeds }, () => muchLater);
    await domainAt(pruner, muchLater).recordSlotMedications([]);

    const merged = lww(stale, pruner);
    expect(merged.dump().slotmeds.find((r) => r.recordId === `slotmeds-${NOW_UNIX}`).deleted).toBe(true);
    expect(await domainAt(merged, muchLater).getSlotMedications(NOW_UNIX)).toBeNull();
  });

  // Cutover from the pre-med-onzf singleton: it is tombstoned by the first
  // prune and NOTHING in it is honoured, fired entries included — a tap on a
  // pre-deploy message takes the ±band fallback for the 48h window.
  it('tombstones the legacy singleton on the first prune and never reads it', async () => {
    const fired = NOW_UNIX - HOUR;
    const future = NOW_UNIX + HOUR;
    const records = fakeRecords({ slotmeds: [{ recordId: 'slotmeds-current', deleted: false, clientTs: 1, slots: { [fired]: ['med-a', 'med-b'], [future]: ['med-a', 'med-b'] } }] }, () => NOW_MS);
    expect(await domainAt(records, NOW_MS).getSlotMedications(fired)).toBeNull();

    await domainAt(records, NOW_MS).dropFutureSlotMedications(); // the pre-PUT step
    expect(records.dump().slotmeds.find((r) => r.recordId === 'slotmeds-current').deleted).toBe(true);
    const domain = domainAt(records, NOW_MS);
    expect(await domain.getSlotMedications(fired)).toBeNull();
    expect(await domain.getSlotMedications(future)).toBeNull();
    await domain.recordSlotMedications([rem(future, ['med-a'])]);
    expect(await domain.getSlotMedications(future)).toEqual(['med-a']);
  });

  // Why nothing is migrated (codex review of PR #804): device A upgrades before
  // S, drops, PUTs a schedule naming S=[a] and records it. Device B, never
  // synced, wakes after S with the old singleton still saying S=[a,b]. Had B
  // migrated "fired" entries, its later-clientTs S=[a,b] would win LWW over A's
  // correct [a] and a tap on the [a] message could confirm b.
  it('a late-waking device with the old singleton cannot overwrite an upgraded device\'s per-slot record', async () => {
    const S = NOW_UNIX + HOUR;
    const legacy = { recordId: 'slotmeds-current', deleted: false, clientTs: NOW_MS - 2 * HOUR * 1000, slots: { [S]: ['med-a', 'med-b'] } };

    let clockA = NOW_MS;
    const deviceA = fakeRecords({ slotmeds: [legacy] }, () => clockA);
    await domainAt(deviceA, clockA).dropFutureSlotMedications();
    clockA = NOW_MS + 500;
    await domainAt(deviceA, clockA).recordSlotMedications([rem(S, ['med-a'])]); // the served message names only a

    const later = NOW_MS + 2 * HOUR * 1000; // S fired an hour ago
    const deviceB = fakeRecords({ slotmeds: [legacy] }, () => later);
    await domainAt(deviceB, later).dropFutureSlotMedications();
    await domainAt(deviceB, later).recordSlotMedications([rem(S + 24 * HOUR, ['med-a', 'med-b'])]);

    expect(await domainAt(lww(deviceA, deviceB), later).getSlotMedications(S)).toEqual(['med-a']);
    expect(await domainAt(lww(deviceB, deviceA), later).getSlotMedications(S)).toEqual(['med-a']);
  });

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

    const recs = (records.dump().slotmeds || []).filter((r) => !r.deleted);
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) expect(r.medicationIds).toEqual(['med-a']);
  });

  it('records nothing when the relay upload fails — no map ahead of the schedule', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const records = fakeRecords(seed());

    await expect(recomputeAndPush(ctx, { records, timeZone: 'UTC' })).rejects.toThrow();
    expect((records.dump().slotmeds || []).filter((r) => !r.deleted)).toEqual([]);
  });

  // The failure the pre-upload drop exists for: a push whose PUT lands but whose
  // follow-up map write never runs (tab closed, vault write errored). The
  // previous horizon's future slots must NOT survive to name meds the new
  // reminder dropped — the tap has to take the ±band fallback instead.
  it('leaves no stale future slot when the map write after a successful PUT is lost', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    const records = fakeRecords(seed());
    await recomputeAndPush(ctx, { records, timeZone: 'UTC' });
    const staleSlots = (records.dump().slotmeds || []).filter((r) => !r.deleted).map((r) => String(r.slotUnix));
    expect(staleSlots.length).toBeGreaterThan(0);

    // Next recompute: the PUT lands, then the post-upload write is lost.
    const boom = new Error('vault write lost');
    const put = records.put;
    let uploaded = false;
    globalThis.fetch = vi.fn(async () => { uploaded = true; return { ok: true }; });
    records.put = async (type, record) => {
      if (type === 'slotmeds' && uploaded) throw boom;
      return put(type, record);
    };
    await expect(recomputeAndPush(ctx, { records, timeZone: 'UTC' })).rejects.toThrow(boom);
    records.put = put;

    const domain = createRemindersDomain({ records, now: () => NOW_MS });
    for (const slotUnix of staleSlots) {
      expect(await domain.getSlotMedications(Number(slotUnix))).toBeNull();
    }
  });

  // The map write rides INSIDE pushSchedule's per-account chain. Outside it, a
  // slow recompute could record its med sets after a newer recompute's schedule
  // had already become the one the relay serves — and Confirm would then resolve
  // a delivered message against a set the relay never sent.
  it('records the map inside the per-account push chain, in push order', async () => {
    const order = [];
    let releaseFirst;
    let firstEntered;
    const entered = new Promise((r) => { firstEntered = r; });
    let puts = 0;
    globalThis.fetch = vi.fn(() => {
      puts += 1;
      order.push(`put${puts}`);
      if (puts === 1) {
        firstEntered();
        return new Promise((r) => { releaseFirst = () => r({ ok: true }); });
      }
      return Promise.resolve({ ok: true });
    });

    const pA = pushSchedule(ctx, [rem(NOW_UNIX, ['med-a'])], { delivery: 'telegram' }, async () => { order.push('mapA'); }, async () => { order.push('dropA'); });
    const pB = pushSchedule(ctx, [rem(NOW_UNIX, ['med-b'])], { delivery: 'telegram' }, async () => { order.push('mapB'); }, async () => { order.push('dropB'); });

    // A's PUT hangs; B is chained behind it and has not started.
    await entered;
    expect(order).toEqual(['dropA', 'put1']);

    releaseFirst();
    await Promise.all([pA, pB]);
    // B's drop waits for A's record: prune → PUT → record is one step per account.
    expect(order).toEqual(['dropA', 'put1', 'mapA', 'dropB', 'put2', 'mapB']);
  });

  // A swallowed cancel is not one stray nag: the relay re-fires hourly to its 6h
  // cap, so a lost cancel on an evening slot is a night of Telegram nags for
  // doses already taken. The old code only caught a REJECTED fetch, so a 5xx
  // resolved and vanished (codex review, 2026-08-28).
  it('retries the re-fire cancel once when the relay answers non-2xx', async () => {
    const calls = [];
    const fetchImpl = vi.fn((url, init) => {
      calls.push(JSON.parse(init.body).callback);
      return Promise.resolve({ ok: calls.length > 1, status: calls.length > 1 ? 204 : 502 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    cancelMedRefire(NOW_MS, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    expect(calls).toEqual([`s:${NOW_UNIX}`, `s:${NOW_UNIX}`]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns once when both cancel attempts fail, and never throws', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => cancelMedRefire(NOW_MS, { fetchImpl })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
