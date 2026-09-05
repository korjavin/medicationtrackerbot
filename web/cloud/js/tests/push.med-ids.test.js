// bd med-kbpf — the reminder ROW carries the identity of the meds its message
// names (`tg_med_ids`), so a Telegram Confirm tap seals that identity and the
// drain confirms exactly those doses. This replaces the `slotmeds` vault
// side-table (med-eas.65/med-onzf), whose every reconstruction failure — a lost
// record, a legacy record, an IndexedDB throw — degraded to "never cancel the
// relay's chain" and nagged the user hourly for 6h for doses already taken.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recomputeAndPush, cancelMedRefire, rearmMedRefire } from '../reminders.js';

const NOW_UNIX = 1767225600; // 2026-01-01T00:00:00Z
const NOW_MS = NOW_UNIX * 1000;

// Records port over an in-memory map, keyed by recordId within each type —
// same shape as sync.js's recordsPort, matching inbox-apply.test.js's fake.
function fakeRecords(seed = {}) {
  const store = JSON.parse(JSON.stringify(seed));
  return {
    dump: () => store,
    list: async (type) => (store[type] || []).map((r) => ({ ...r })),
    // Tombstones included, like sync.js recordsPort.listRaw (bd med-w0fe).
    listRaw: async (type) => (store[type] || []).map((r) => ({ ...r })),
    put: async (type, record) => {
      store[type] = (store[type] || []).filter((r) => r.recordId !== record.recordId);
      store[type].push({ ...record });
      return record;
    },
    del: async (type, id) => {
      store[type] = (store[type] || []).filter((r) => r.recordId !== id);
      store[type].push({ recordId: id, clientTs: NOW_MS, deleted: true });
    },
    listRange: async (type, fromId, toId) => (store[type] || [])
      .filter((r) => !r.deleted && r.recordId >= fromId && r.recordId <= toId)
      .map((r) => ({ ...r })),
  };
}

describe('pushSchedule carries the named med ids on the reminder row (med-kbpf)', () => {
  const ctx = { accountId: 'acct-1' };
  // Telegram-only delivery: needsCT is false, so pushSchedule never touches the
  // NK / crypto path. Numeric recordIds, as the real vault mints them.
  const seed = (verbosity = 'detailed') => ({
    medication: [
      { recordId: 2, deleted: false, name: 'A', dosage: '10mg', schedule: '{"type":"daily","times":["09:00"]}' },
      { recordId: 9, deleted: false, name: 'B', dosage: '5mg', schedule: '{"type":"daily","times":["09:00"]}' },
    ],
    reminderdeliverypref: [
      { recordId: 'reminderdeliverypref', deleted: false, delivery: 'telegram', verbosity },
    ],
  });

  let entries;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    entries = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      entries = JSON.parse(init.body).entries;
      return { ok: true };
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.fetch;
    vi.restoreAllMocks();
  });

  const medEntries = () => entries.filter((e) => (e.tg_callback || '').startsWith('s:'));

  it('sends every med slot with its named ids, and nothing else with any', async () => {
    await recomputeAndPush(ctx, { records: fakeRecords(seed()), timeZone: 'UTC' });

    expect(medEntries().length).toBeGreaterThan(0);
    for (const e of medEntries()) expect(e.tg_med_ids).toBe('2,9');
    // BP/weight reminders name no medication and carry no stem — nothing to seal.
    for (const e of entries.filter((x) => !(x.tg_callback || '').startsWith('s:'))) {
      expect(e.tg_med_ids).toBeUndefined();
    }
  });

  it('still sends the ids at generic verbosity — the tap must resolve either way', async () => {
    await recomputeAndPush(ctx, { records: fakeRecords(seed('generic')), timeZone: 'UTC' });

    expect(medEntries().length).toBeGreaterThan(0);
    for (const e of medEntries()) {
      expect(e.tg_med_ids).toBe('2,9');
      expect(e.tg_text).not.toContain('A'); // generic text: no medication names
    }
  });

  // The server rejects a non-numeric id list, and a rejected PUT is a whole
  // horizon not scheduled. A vault with an odd id must lose identity, not
  // reminders — and lose it for the WHOLE slot: a partial list would let one
  // tap confirm some named meds and still cancel the chain for the rest
  // (codex review, 2026-08-29).
  it('omits the whole id list when one id is non-numeric, never a partial one', async () => {
    const records = fakeRecords(seed());
    records.dump().medication.push({ recordId: 'med-x', deleted: false, name: 'X', schedule: '{"type":"daily","times":["09:00"]}' });
    await recomputeAndPush(ctx, { records, timeZone: 'UTC' });

    const entries = medEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.tg_med_ids).toBeUndefined();
  });

  it('omits the id list when it would exceed the relay cap, keeping the entry', async () => {
    const records = fakeRecords(seed());
    for (let i = 0; i < 130; i++) {
      records.dump().medication.push({ recordId: 1787000000000000 + i, deleted: false, name: `M${i}`, schedule: '{"type":"daily","times":["09:00"]}' });
    }
    await recomputeAndPush(ctx, { records, timeZone: 'UTC' });

    const entries = medEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.tg_med_ids).toBeUndefined();
  });
});

// A swallowed cancel is not one stray nag: the relay re-fires hourly to its 6h
// cap, so a lost cancel on an evening slot is a night of Telegram nags for
// doses already taken. The old code only caught a REJECTED fetch, so a 5xx
// resolved and vanished (codex review, 2026-08-28, bd med-om6l).
describe('the re-fire controls check the response and retry once', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retries the cancel once when the relay answers non-2xx', async () => {
    const calls = [];
    const fetchImpl = vi.fn((url, init) => {
      calls.push([url, JSON.parse(init.body).callback]);
      return Promise.resolve({ ok: calls.length > 1, status: calls.length > 1 ? 204 : 502 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    cancelMedRefire(NOW_MS, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    expect(calls).toEqual([
      ['/api/telegram/cancel-refire', `s:${NOW_UNIX}`],
      ['/api/telegram/cancel-refire', `s:${NOW_UNIX}`],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when both cancel attempts fail, and never throws', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => cancelMedRefire(NOW_MS, { fetchImpl })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // The re-arm is the ONLY thing that turns nagging back on after a tap, so it
  // gets the same treatment — and it names the still-due meds so a tap on the
  // re-fired message resolves by identity.
  it('posts the still-due med ids on a re-arm, with the same one retry', async () => {
    const bodies = [];
    const fetchImpl = vi.fn((url, init) => {
      bodies.push([url, JSON.parse(init.body)]);
      return Promise.resolve({ ok: bodies.length > 1, status: bodies.length > 1 ? 204 : 503 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    rearmMedRefire(NOW_MS, [2, 9], { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    expect(bodies[0]).toEqual(['/api/telegram/rearm-refire', { callback: `s:${NOW_UNIX}`, med_ids: '2,9' }]);
    expect(warn).not.toHaveBeenCalled();
  });
});
