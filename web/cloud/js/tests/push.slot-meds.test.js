// bd med-eas.67 — pushSchedule records a device-local slotUnix → [medId…] map
// so Confirm can act on the meds the reminder NAMED, by identity, instead of
// re-deriving them from a ±10min band at drain time (which drops course meds
// whose materialized intake drifted off the clock slot). Replace-all: each
// build overwrites, so stale slots never accumulate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { pushSchedule, getSlotMedications } from '../push.js';

// Telegram-only delivery: needsCT is false, so pushSchedule never touches the NK
// / crypto path — the map write is independent of channel anyway.
const PREF = { delivery: 'telegram', verbosity: 'detailed' };

// A grouped dose reminder carries every med's id; a re-reminder carries its one
// med keyed to the same slot stem. BP reminders have no callback → no slot.
function rem(slotUnix, medicationIds, extra = {}) {
  return { fireAtUnix: slotUnix, kind: 'medication', text: 'meds', genericText: 'due', callback: `s:${slotUnix}`, medicationIds, ...extra };
}

describe('pushSchedule slot→meds map (med-eas.67)', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    delete globalThis.fetch;
    vi.restoreAllMocks();
  });

  it('stores each slot with its named med ids', async () => {
    await pushSchedule({}, [
      rem(1000, ['med-a', 'med-b', 'med-c']),
      rem(2000, ['med-d']),
      { fireAtUnix: 3000, kind: 'bp', text: 'bp', genericText: 'bp' }, // no callback
    ], PREF);

    expect(await getSlotMedications(1000)).toEqual(['med-a', 'med-b', 'med-c']);
    expect(await getSlotMedications(2000)).toEqual(['med-d']);
    expect(await getSlotMedications(3000)).toBeNull(); // BP: no slot recorded
  });

  it('folds a re-reminder into its grouped slot and dedupes', async () => {
    await pushSchedule({}, [
      rem(1000, ['med-a', 'med-b']),
      rem(1000, ['med-a']), // re-reminder for med-a on the same slot stem
    ], PREF);

    expect(await getSlotMedications(1000)).toEqual(['med-a', 'med-b']);
  });

  it('overwrites the map each build — no stale slots accumulate', async () => {
    await pushSchedule({}, [rem(1000, ['med-a']), rem(2000, ['med-b'])], PREF);
    expect(await getSlotMedications(2000)).toEqual(['med-b']);

    // A schedule edit drops slot 2000 and moves med-b to a new slot.
    await pushSchedule({}, [rem(1000, ['med-a']), rem(4000, ['med-b'])], PREF);
    expect(await getSlotMedications(2000)).toBeNull();
    expect(await getSlotMedications(4000)).toEqual(['med-b']);
    expect(await getSlotMedications(1000)).toEqual(['med-a']);
  });

  it('returns null for an unknown slot', async () => {
    await pushSchedule({}, [rem(1000, ['med-a'])], PREF);
    expect(await getSlotMedications(9999)).toBeNull();
  });

  it('clears the prior map — a dropped med never survives a failed rewrite', async () => {
    // First build names med-a AND med-d for slot 1000.
    await pushSchedule({}, [rem(1000, ['med-a', 'med-d'])], PREF);
    expect(await getSlotMedications(1000)).toEqual(['med-a', 'med-d']);

    // Second build drops med-d, the relay upload lands, but the FRESH-map write
    // fails transiently (the store is fine when the map is cleared and when Confirm
    // reads it later — only the rewrite didn't persist). The stale [med-a, med-d]
    // must NOT survive — else Confirm would take med-d's dose the new reminder never
    // named (a forbidden false positive). pushSchedule clears the map before the
    // upload, so the failed rewrite leaves no map → band fallback.
    const realOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
    let opens = 0;
    globalThis.indexedDB.open = (...args) => {
      opens += 1;
      if (opens === 2) throw new Error('transient write failure'); // fresh-map write; clear (open #1) succeeded
      return realOpen(...args);
    };
    try {
      await pushSchedule({}, [rem(1000, ['med-a'])], PREF);
    } finally {
      globalThis.indexedDB.open = realOpen;
    }

    // Map is gone → inbox-apply falls back to the safe ±band match, not the stale map.
    expect(await getSlotMedications(1000)).toBeNull();
  });
});
