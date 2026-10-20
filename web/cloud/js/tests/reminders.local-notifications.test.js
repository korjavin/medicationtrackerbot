// bd med-w6gx.5 — inside the iOS app shell the reminder horizon is also handed
// to window.LocalNotifications (replace-all, iOS's 64 cap, a lapse notice
// last). On the web LocalNotifications is unsupported or absent and nothing
// changes; the relay upload is the same either way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushSchedule } from '../push.js';
import { recomputeAndPush, localNotificationItems, scheduleReminderRecompute, cancelReminderRecompute } from '../reminders.js';

vi.mock('../push.js', () => ({ pushSchedule: vi.fn(async () => {}), sendTestPush: vi.fn() }));

const NOW_UNIX = 1767225600; // 2026-01-01T00:00:00Z
const NOW_MS = NOW_UNIX * 1000;

function fakeRecords(seed = {}) {
  const store = JSON.parse(JSON.stringify(seed));
  return {
    list: async (type) => (store[type] || []).map((r) => ({ ...r })),
    listRaw: async (type) => (store[type] || []).map((r) => ({ ...r })),
    put: async (type, record) => record,
    del: async () => {},
    listRange: async () => [],
  };
}

// The relay upload (push.js pushSchedule) is mocked: what it sends is pinned by
// the push.* suites; here it only has to keep being called.
const seed = (delivery, verbosity = 'detailed') => ({
  medication: [
    { recordId: 2, deleted: false, name: 'A', dosage: '10mg', schedule: '{"type":"daily","times":["09:00","21:00"]}' },
  ],
  reminderdeliverypref: [{ recordId: 'reminderdeliverypref', deleted: false, delivery, verbosity }],
});

describe('recomputeAndPush hands the horizon to LocalNotifications in the iOS app', () => {
  const ctx = { accountId: 'acct-1' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    pushSchedule.mockReset();
    pushSchedule.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.LocalNotifications;
    vi.restoreAllMocks();
  });

  it('web (no LocalNotifications, or unsupported): relay upload only', async () => {
    await recomputeAndPush(ctx, { records: fakeRecords(seed('telegram')), timeZone: 'UTC' });
    const schedule = vi.fn();
    globalThis.LocalNotifications = { isSupported: () => false, schedule };
    await recomputeAndPush(ctx, { records: fakeRecords(seed('telegram')), timeZone: 'UTC' });
    expect(schedule).not.toHaveBeenCalled();
    expect(pushSchedule).toHaveBeenCalledTimes(2);
  });

  it('ios: schedules the med slots, opening Meds, still uploads, and survives an offline PUT', async () => {
    const schedule = vi.fn(async () => 0);
    globalThis.LocalNotifications = { isSupported: () => true, schedule };
    pushSchedule.mockRejectedValue(new TypeError('offline'));
    // The device schedules first; only the relay PUT fails offline.
    const records = fakeRecords(seed('both'));
    await expect(recomputeAndPush(ctx, { records, timeZone: 'UTC' })).rejects.toThrow('offline');
    expect(schedule).toHaveBeenCalledTimes(1);
    const items = schedule.mock.calls[0][0];
    const meds = items.filter((i) => i.section === 'meds');
    expect(meds.length).toBeGreaterThan(0);
    for (const i of meds) {
      expect(i.fireAtUnix).toBeGreaterThan(NOW_UNIX);
      expect(i.body).not.toContain('**');
      // bd med-w6gx.20: the tap opens the take sheet for that slot (ids only, no names).
      const q = new URLSearchParams(i.url.slice(2));
      expect(i.url.startsWith('/?')).toBe(true);
      expect(q.get('action')).toBe('medication_confirm');
      expect(q.get('ids')).toBe('2');
      expect(q.get('scheduled')).toBe(new Date(i.fireAtUnix * 1000).toISOString());
    }
    expect(items[items.length - 1].body).toBe('Open the app to keep reminders running');
  });

  it('ios: Telegram-only delivery clears the device schedule', async () => {
    const schedule = vi.fn(async () => 0);
    globalThis.LocalNotifications = { isSupported: () => true, schedule };
    await recomputeAndPush(ctx, { records: fakeRecords(seed('telegram')), timeZone: 'UTC' });
    expect(schedule).toHaveBeenCalledWith([]);
    expect(pushSchedule).toHaveBeenCalledTimes(1);
  });

  it('ios: a hung bridge call neither delays the relay upload nor wedges later schedules', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const schedule = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(0);
    globalThis.LocalNotifications = { isSupported: () => true, schedule };
    let done = false;
    const run = recomputeAndPush(ctx, { records: fakeRecords(seed('both')), timeZone: 'UTC' }).then(() => { done = true; });
    await vi.waitFor(() => expect(pushSchedule).toHaveBeenCalledTimes(1));
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(10000); // the bridge call times out
    await run;
    await recomputeAndPush(ctx, { records: fakeRecords(seed('both')), timeZone: 'UTC' });
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(pushSchedule).toHaveBeenCalledTimes(2);
  });

  // bd med-o7zq.3 — local-only mode: no relay, the device is the only channel,
  // and the lock-screen body follows the verbosity pref.
  it('relay: false (local mode): never uploads, ignores Telegram-only, generic bodies carry no names', async () => {
    const schedule = vi.fn(async () => 0);
    globalThis.LocalNotifications = { isSupported: () => true, schedule };
    await recomputeAndPush(ctx, { records: fakeRecords(seed('telegram', 'generic')), timeZone: 'UTC', relay: false });
    expect(pushSchedule).not.toHaveBeenCalled();
    const meds = schedule.mock.calls[0][0].filter((i) => i.section === 'meds');
    expect(meds.length).toBeGreaterThan(0);
    for (const i of meds) {
      expect(i.body).toContain('Medication time');
      expect(i.body).not.toContain('A');
    }

    await recomputeAndPush(ctx, { records: fakeRecords(seed('telegram', 'detailed')), timeZone: 'UTC', relay: false });
    expect(schedule.mock.calls[1][0].find((i) => i.section === 'meds').body).toContain('Time to take: A');
    expect(pushSchedule).not.toHaveBeenCalled();
  });
});

// bd med-ckm5.4 (kit O3): a write-triggered schedule that would notify this
// device asks for the permission (features/notify-permission.js decides
// whether a sheet actually shows); boot recomputes never ask.
describe('recomputeAndPush asks for notification permission in context', () => {
  const ctx = { accountId: 'acct-ask' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    pushSchedule.mockReset();
    pushSchedule.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.LocalNotifications;
    delete globalThis.NotifyPermission;
    vi.restoreAllMocks();
  });

  it('boot (no askPermission) never asks; a UI write\'s debounced recompute does', async () => {
    const maybeAsk = vi.fn(async () => false);
    globalThis.NotifyPermission = { maybeAsk };
    globalThis.LocalNotifications = { isSupported: () => true, schedule: vi.fn(async () => 0) };
    const records = fakeRecords(seed('both'));
    await recomputeAndPush(ctx, { records, timeZone: 'UTC' });
    scheduleReminderRecompute(ctx, { records, timeZone: 'UTC' }, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(maybeAsk).not.toHaveBeenCalled();

    // apishim's UI-origin router adds the flag (cloud.shim-contract.reminders).
    scheduleReminderRecompute(ctx, { records, timeZone: 'UTC', askPermission: true }, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(maybeAsk).toHaveBeenCalledTimes(1);
  });

  it('a UI save followed within the debounce by a non-UI recompute still asks once', async () => {
    const maybeAsk = vi.fn(async () => false);
    globalThis.NotifyPermission = { maybeAsk };
    globalThis.LocalNotifications = { isSupported: () => true, schedule: vi.fn(async () => 0) };
    const records = fakeRecords(seed('both'));
    scheduleReminderRecompute(ctx, { records, timeZone: 'UTC', askPermission: true }, 10);
    scheduleReminderRecompute(ctx, { records, timeZone: 'UTC' }, 10); // agent/inbox write
    await vi.advanceTimersByTimeAsync(20);
    expect(maybeAsk).toHaveBeenCalledTimes(1);

    // A cancelled UI ask must not leak into the next non-UI recompute.
    maybeAsk.mockClear();
    scheduleReminderRecompute(ctx, { records, timeZone: 'UTC', askPermission: true }, 10);
    cancelReminderRecompute(ctx);
    scheduleReminderRecompute(ctx, { records, timeZone: 'UTC' }, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(maybeAsk).not.toHaveBeenCalled();
  });

  it('no ask when nothing would notify this device (Telegram-only, or local mode on the web)', async () => {
    const maybeAsk = vi.fn(async () => false);
    globalThis.NotifyPermission = { maybeAsk };
    await recomputeAndPush(ctx, { records: fakeRecords(seed('telegram')), timeZone: 'UTC', askPermission: true });
    await recomputeAndPush(ctx, { records: fakeRecords(seed('both')), timeZone: 'UTC', relay: false, askPermission: true });
    expect(maybeAsk).not.toHaveBeenCalled();
    // The web with Web Push delivery does ask.
    await recomputeAndPush(ctx, { records: fakeRecords(seed('both')), timeZone: 'UTC', askPermission: true });
    expect(maybeAsk).toHaveBeenCalledTimes(1);
  });

  it('a new grant reschedules the device right away', async () => {
    const maybeAsk = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    globalThis.NotifyPermission = { maybeAsk };
    const schedule = vi.fn(async () => 0);
    globalThis.LocalNotifications = { isSupported: () => true, schedule };
    await recomputeAndPush(ctx, { records: fakeRecords(seed('both')), timeZone: 'UTC', relay: false, askPermission: true });
    expect(schedule).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    expect(pushSchedule).not.toHaveBeenCalled(); // the reschedule kept local mode's relay: false
  });
});

describe('localNotificationItems', () => {
  it('keeps the earliest 63 future reminders plus a lapse notice a minute after the last', () => {
    const entries = [];
    for (let i = 100; i >= -5; i -= 1) entries.push({ fireAtUnix: NOW_UNIX + i * 60, kind: i % 2 ? 'bp' : 'workout', text: `r${i}` });
    const items = localNotificationItems(entries, { delivery: 'webpush' }, NOW_UNIX);
    expect(items).toHaveLength(64);
    expect(items[0]).toEqual({ fireAtUnix: NOW_UNIX + 60, title: 'Med Tracker', body: 'r1', section: 'bp', url: '/?tab=bp' });
    expect(items[62].fireAtUnix).toBe(NOW_UNIX + 63 * 60);
    expect(items[63]).toMatchObject({ fireAtUnix: NOW_UNIX + 64 * 60, section: 'today', url: '/?tab=today' });
    expect(items.find((i) => i.body === 'r2')).toMatchObject({ section: 'workouts', url: '/?tab=workouts' });
  });

  it('nothing due: nothing scheduled, no lapse notice', () => {
    expect(localNotificationItems([{ fireAtUnix: NOW_UNIX - 1, kind: 'bp', text: 'x' }], {}, NOW_UNIX)).toEqual([]);
  });
});
