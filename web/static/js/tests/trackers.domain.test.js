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
    await d.unlog(t.id, first.id);
    expect((await progressOf(d, t.id)).total).toBe(1);
    await expect(d.unlog(t.id, first.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('atMost is met with zero logs and unmet once over the limit', async () => {
    const { d } = setup('2026-07-08T16:00:00Z');
    const t = await d.create(COFFEE);
    expect(await progressOf(d, t.id)).toEqual({ total: 0, target: 3, met: true });
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
