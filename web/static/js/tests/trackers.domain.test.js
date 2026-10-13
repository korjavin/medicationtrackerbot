// med-1vy5.1 — user trackers domain (web/domain/trackers.js) over an
// in-memory records port. No UI entry point yet (that is med-1vy5.2), so a
// pure-unit suite is the owning suite for this layer.
import { describe, it, expect } from 'vitest';
import { createTrackersDomain } from '../../../../web/domain/trackers.js';

const TZ = 'America/New_York'; // UTC-4 in July/August 2026

function memPort() {
  const store = new Map();
  return {
    store,
    async list(type) {
      return [...(store.get(type) || [])].filter((r) => !r.deleted);
    },
    async put(type, record) {
      const rows = store.get(type) || [];
      const i = rows.findIndex((r) => r.recordId === record.recordId);
      if (i === -1) rows.push(record);
      else rows[i] = record;
      store.set(type, rows);
      return record;
    },
    async del(type, recordId) {
      const rows = store.get(type) || [];
      const i = rows.findIndex((r) => r.recordId === recordId);
      if (i !== -1) rows[i] = { ...rows[i], deleted: true };
    },
  };
}

function setup(nowIso, records = memPort()) {
  const clock = { ms: Date.parse(nowIso) };
  const d = createTrackersDomain({ records, now: () => clock.ms, timeZone: TZ });
  return { d, records, clock };
}

const WATER = { name: 'Water', emoji: '💧', kind: 'count', unit: 'glass', target: { op: 'atLeast', value: 8, period: 'day' } };
const COFFEE = { name: 'Coffee', kind: 'count', target: { op: 'atMost', value: 3, period: 'day' } };
const STRETCH = { name: 'Stretch', kind: 'check', target: { op: 'atLeast', value: 3, period: 'week' } };

async function progressOf(d, id) {
  return (await d.list()).find((t) => t.id === id).progress;
}

describe('trackers domain — validation', () => {
  it('rejects bad names, kinds, ops, periods, values and steps', async () => {
    const { d } = setup('2026-07-08T12:00:00Z');
    await expect(d.create({ ...WATER, name: '  ' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.create({ ...WATER, name: 'x'.repeat(61) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.create({ ...WATER, kind: 'timer' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.create({ ...WATER, target: { ...WATER.target, op: 'exactly' } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.create({ ...WATER, target: { ...WATER.target, period: 'year' } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.create({ ...WATER, target: { ...WATER.target, value: 0 } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.create({ ...WATER, target: { op: 'atMost', value: -1, period: 'day' } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await d.create({ ...WATER, name: 'Cola', target: { op: 'atMost', value: 0, period: 'day' } })).target.value).toBe(0);
    await expect(d.create({ ...WATER, step: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    const ok = await d.create({ ...WATER, name: 'x'.repeat(60) });
    expect(ok.step).toBe(1);
    await expect(d.update(ok.id, { kind: 'check' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.log(ok.id, { amount: -1 })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('trackers domain — count', () => {
  it('two count logs on the same day sum', async () => {
    const { d } = setup('2026-07-08T16:00:00Z');
    const t = await d.create(WATER);
    await d.log(t.id, { amount: 2 });
    await d.log(t.id, { amount: 3 });
    expect(await progressOf(d, t.id)).toEqual({ total: 5, target: 8, met: false });
  });

  it('logs from two devices at the same instant both survive (no aggregate record)', async () => {
    const records = memPort();
    const a = setup('2026-07-08T16:00:00Z', records);
    const b = setup('2026-07-08T16:00:00Z', records);
    const t = await a.d.create(WATER);
    await a.d.log(t.id);
    await b.d.log(t.id);
    expect(await records.list('trackerlog')).toHaveLength(2);
    expect((await progressOf(a.d, t.id)).total).toBe(2);
  });

  it('unlog deletes exactly that tap', async () => {
    const { d } = setup('2026-07-08T16:00:00Z');
    const t = await d.create(WATER);
    const first = await d.log(t.id, { amount: 2 });
    await d.log(t.id, { amount: 1 });
    const [listed] = await d.list();
    expect(listed.todayLogs.map((l) => l.amount).sort()).toEqual([1, 2]);
    expect(listed.todayLogs.map((l) => l.id)).toContain(first.id);
    await d.unlog(t.id, first.id);
    expect((await progressOf(d, t.id)).total).toBe(1);
    await expect(d.unlog(t.id, first.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('atMost is met with zero logs and unmet once over the limit', async () => {
    const { d } = setup('2026-07-08T16:00:00Z');
    const t = await d.create(COFFEE);
    expect(await progressOf(d, t.id)).toEqual({ total: 0, target: 3, met: true, cleanDays: 1 });
    await d.log(t.id, { amount: 4 });
    expect((await progressOf(d, t.id)).met).toBe(false);
  });
});

describe('trackers domain — check', () => {
  it('check toggle is idempotent by deterministic id; uncheck writes done:false', async () => {
    const { d, records } = setup('2026-07-08T16:00:00Z');
    const t = await d.create(STRETCH);
    const a = await d.log(t.id);
    const b = await d.log(t.id);
    expect(a.id).toBe(`trackerlog:${t.id}:2026-07-08`);
    expect(b.id).toBe(a.id);
    expect(await records.list('trackerlog')).toHaveLength(1);
    expect((await progressOf(d, t.id)).total).toBe(1);
    expect((await d.list())[0].todayLogs).toEqual([{ id: a.id, trackerId: t.id, date: '2026-07-08', done: true }]);
    await d.unlog(t.id, a.id);
    const [row] = await records.list('trackerlog');
    expect(row).toMatchObject({ recordId: a.id, done: false, deleted: false });
    expect((await progressOf(d, t.id)).total).toBe(0);
    await d.setDay(t.id, '2026-07-06', true);
    expect((await progressOf(d, t.id)).total).toBe(1);
  });
});

describe('trackers domain — period rollover in a non-UTC zone', () => {
  // Each case logs 5 just before the local boundary and 1 just after; "now"
  // is just after it. In UTC both logs land in the same day/week/month, so
  // only correct zone handling yields 1.
  async function rollover(period, beforeIso, afterIso, nowIso) {
    const { d, clock } = setup(nowIso);
    const t = await d.create({ ...WATER, target: { op: 'atLeast', value: 1, period } });
    await d.log(t.id, { amount: 5, at: beforeIso });
    await d.log(t.id, { amount: 1, at: afterIso });
    clock.ms = Date.parse(nowIso);
    return (await progressOf(d, t.id)).total;
  }

  it('day rolls over at local midnight', async () => {
    // 2026-07-07 23:30 / 2026-07-08 00:10 New York.
    expect(await rollover('day', '2026-07-08T03:30:00Z', '2026-07-08T04:10:00Z', '2026-07-08T04:30:00Z')).toBe(1);
  });

  it('week rolls over at local Monday 00:00 (ISO week)', async () => {
    // Sun 2026-07-12 23:30 / Mon 2026-07-13 00:10 New York.
    expect(await rollover('week', '2026-07-13T03:30:00Z', '2026-07-13T04:10:00Z', '2026-07-13T04:30:00Z')).toBe(1);
  });

  it('week progress exposes Mon..Sun day totals in the account zone; day/month do not', async () => {
    // Wed 2026-07-15 12:00 New York; log at Mon 23:30 local (= Tue 03:30Z) must stay on Monday.
    const { d } = setup('2026-07-15T16:00:00Z');
    const t = await d.create({ ...WATER, target: { op: 'atLeast', value: 3, period: 'week' } });
    await d.log(t.id, { amount: 2, at: '2026-07-14T03:30:00Z' });
    const p = (await progressOf(d, t.id));
    expect(p.days.map((x) => x.day)).toEqual(['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19']);
    expect(p.days.map((x) => x.total)).toEqual([2, 0, 0, 0, 0, 0, 0]);
    const day = await d.create({ ...WATER });
    expect((await progressOf(d, day.id)).days).toBeUndefined();
  });

  it('month rolls over at the local first of the month', async () => {
    // 2026-07-31 23:30 / 2026-08-01 00:10 New York.
    expect(await rollover('month', '2026-08-01T03:30:00Z', '2026-08-01T04:10:00Z', '2026-08-01T04:30:00Z')).toBe(1);
  });
});

describe('trackers domain — archive + history', () => {
  it('archived trackers leave list but keep their logs', async () => {
    const { d, records } = setup('2026-07-08T16:00:00Z');
    const t = await d.create(WATER);
    await d.log(t.id, { amount: 2 });
    await d.archive(t.id);
    expect(await d.list()).toEqual([]);
    expect(await records.list('trackerlog')).toHaveLength(1);
    expect(await d.history(t.id, 2)).toEqual([
      { date: '2026-07-07', total: 0 },
      { date: '2026-07-08', total: 2 },
    ]);
  });

  // med-1vy5.6: log takes a name too (MCP trackers.log); archived trackers
  // never match, and two active ones sharing a name refuse to guess.
  it('log resolves a case-insensitive name, skipping archived, refusing ambiguity', async () => {
    const { d } = setup('2026-07-08T16:00:00Z');
    const old = await d.create(WATER);
    await d.archive(old.id);
    const t = await d.create(WATER);
    await d.log(' WATER ', { amount: 2 });
    expect((await progressOf(d, t.id)).total).toBe(2);
    await expect(d.log('juice')).rejects.toMatchObject({ code: 'not_found' });
    await d.create(WATER);
    await expect(d.log('water')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('update keeps id/createdAt and re-validates', async () => {
    const { d } = setup('2026-07-08T16:00:00Z');
    const t = await d.create(WATER);
    const u = await d.update(t.id, { name: 'H2O', target: { op: 'atLeast', value: 10, period: 'day' } });
    expect(u).toMatchObject({ id: t.id, name: 'H2O', createdAt: t.createdAt, target: { value: 10 } });
    await expect(d.update(t.id, { name: '' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.update('nope', { name: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

// med-1vy5.8: limits carry a derived days-clean streak; goals do not.
describe('trackers domain — cleanDays (atMost only)', () => {
  const NO_ALCOHOL = { name: 'No alcohol', kind: 'check', target: { op: 'atMost', value: 1, period: 'week' } };

  it('counts clean local days back to the creation day; a slip resets it; goals omit it', async () => {
    // Created Wed 2026-07-01 noon New York.
    const { d, clock } = setup('2026-07-01T16:00:00Z');
    const t = await d.create(NO_ALCOHOL);
    const water = await d.create(WATER);
    expect((await progressOf(d, t.id)).cleanDays).toBe(1); // created today, no slip
    expect((await progressOf(d, water.id)).cleanDays).toBeUndefined();
    clock.ms = Date.parse('2026-07-08T16:00:00Z'); // Wed a week later
    expect((await progressOf(d, t.id)).cleanDays).toBe(8); // never slipped: creation day through today
    await d.setDay(t.id, '2026-07-05', true); // slip 3 days ago (Sun, the previous ISO week)
    const p = await progressOf(d, t.id);
    expect(p.cleanDays).toBe(3); // the week rollover (Mon 07-06) does not reset it
    expect(p.total).toBe(0);
    await d.log(t.id); // slip today
    expect((await progressOf(d, t.id)).cleanDays).toBe(0);
    clock.ms = Date.parse('2026-07-09T16:00:00Z');
    expect((await progressOf(d, t.id)).cleanDays).toBe(1); // slipped yesterday
  });

  it('count limits use local-day totals: a slip at local 23:30 belongs to that day', async () => {
    const { d, clock } = setup('2026-07-01T16:00:00Z');
    const t = await d.create({ ...COFFEE, target: { op: 'atMost', value: 0, period: 'day' } });
    clock.ms = Date.parse('2026-07-08T16:00:00Z');
    // Mon 2026-07-06 23:30 New York = Tue 03:30Z.
    await d.log(t.id, { amount: 1, at: '2026-07-07T03:30:00Z' });
    expect((await progressOf(d, t.id)).cleanDays).toBe(2); // Tue + Wed
  });
});

// med-q2bq: a streak is a max-0 limit with target.days; achieved is derived
// from the best clean run since creation, never stored.
describe('trackers domain — streak (target.days on a max-0 limit)', () => {
  const STREAK = { name: 'No soda', kind: 'count', target: { op: 'atMost', value: 0, period: 'day', days: 7 } };

  it('validates days: only on atMost 0, integer 1..366', async () => {
    const { d } = setup('2026-07-01T16:00:00Z');
    const t = await d.create(STREAK);
    expect(t.target).toEqual({ op: 'atMost', value: 0, period: 'day', days: 7 });
    expect((await d.list()).find((x) => x.id === t.id).target.days).toBe(7);
    await expect(d.create({ ...WATER, target: { ...WATER.target, days: 7 } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(d.create({ ...COFFEE, target: { ...COFFEE.target, days: 7 } })).rejects.toMatchObject({ code: 'invalid_request' });
    for (const days of [0, 1.5, 400]) {
      await expect(d.create({ ...STREAK, target: { ...STREAK.target, days } })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect('days' in (await d.create({ ...STREAK, target: { op: 'atMost', value: 0, period: 'day' } })).target).toBe(false);
  });

  it('derives bestDays + goal.achieved; a later slip keeps it; raising days recomputes', async () => {
    const { d, clock } = setup('2026-07-01T16:00:00Z');
    const t = await d.create(STREAK);
    const plain = await d.create({ ...STREAK, name: 'Plain', target: { op: 'atMost', value: 0, period: 'day' } });
    clock.ms = Date.parse('2026-07-04T16:00:00Z'); // created 3 days ago
    expect(await progressOf(d, t.id)).toMatchObject({ cleanDays: 4, bestDays: 4, goal: { days: 7, achieved: false } });
    const p = await progressOf(d, plain.id);
    expect(p.cleanDays).toBe(4);
    expect('goal' in p || 'bestDays' in p).toBe(false);

    clock.ms = Date.parse('2026-07-07T16:00:00Z'); // 7 clean days
    expect(await progressOf(d, t.id)).toMatchObject({ cleanDays: 7, bestDays: 7, goal: { days: 7, achieved: true } });
    await d.update(t.id, { target: { ...STREAK.target, days: 14 } });
    expect(await progressOf(d, t.id)).toMatchObject({ cleanDays: 7, bestDays: 7, goal: { days: 14, achieved: false } });
    await d.update(t.id, { target: STREAK.target });

    clock.ms = Date.parse('2026-07-08T16:00:00Z');
    await d.log(t.id); // slip today, after 7 clean days (07-01..07-07)
    expect(await progressOf(d, t.id)).toMatchObject({ cleanDays: 0, bestDays: 7, goal: { days: 7, achieved: true } });
    clock.ms = Date.parse('2026-07-09T16:00:00Z');
    expect(await progressOf(d, t.id)).toMatchObject({ cleanDays: 1, bestDays: 7, goal: { days: 7, achieved: true } });
  });
});
