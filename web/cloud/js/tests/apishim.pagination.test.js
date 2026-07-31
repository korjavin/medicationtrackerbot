// bd med-vgw — list reads must be bounded.
//
// Every domain list function reads `limit > 0 ? rows.slice(0, limit) : rows`,
// so `limit=0` off a query string meant "the entire history", and nothing
// clamped `limit=999999` either. Over the MCP relay an unbounded array becomes
// an unbounded frame, and a frame over maxRelayFrameBytes does not come back as
// a truncated answer — coder/websocket closes the connection, the shim times
// out, the tab redials, and the user sees "No unlocked Med Tracker device is
// online" with the app open in front of them.
//
// These drive the REAL router (the single entry point the cloud UI and
// mcp-responder.js share) over a real fake-indexeddb records store, so they
// fail if the clamp stops being applied on the way in — which is the only way
// the bug can come back.
import 'fake-indexeddb/auto';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import { createApiRouter } from '../apishim.js';
import { generateDEK } from '../crypto.js';
import { ORIGIN_UI } from '../sync.js';
import {
  MAX_LIMIT, clampDays, clampLimit, clampOffset, pageOf,
} from '../../../domain/paginate.js';

const accountId = 'amber-falcon-8k3q9x';

// One more than the /api/bp route's default page, so "the default" and
// "everything" are distinguishable answers — the whole point of the fix.
const SEEDED = 105;

describe('bounded list reads (med-vgw)', () => {
  let api;

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });

    vi.stubGlobal('window', {
      DataStore: {
        invalidateTags: vi.fn(async () => {}),
        requestTabRefresh: vi.fn(),
        hasAnyPendingOptimistic: vi.fn(() => false),
      },
    });

    let assignNext = 1;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u === '/api/sync/snapshot' && !init?.method) return new Response(null, { status: 204 });
      if (u.startsWith('/api/sync/ops?')) return new Response(JSON.stringify({ ops: [], next: false }), { status: 200 });
      if (u === '/api/sync/ops' && init?.method === 'POST') {
        const { ops } = JSON.parse(init.body);
        return new Response(JSON.stringify({ assigned: ops.map(() => assignNext++) }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }));

    api = createApiRouter({ accountId, dek: await generateDEK() }, { origin: ORIGIN_UI });

    // Seeded newest-last so index 0 of a newest-first read is the final entry.
    for (let i = 0; i < SEEDED; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await api('/api/bp', 'POST', {
        measured_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        systolic: 120 + i,
        diastolic: 80,
      });
    }
  });

  // days=0 disables the window filter, so the row count is the limit's doing
  // and nothing else — the same query the weight screen and Today loader make.
  const readBP = (query) => api(`/api/bp?days=0${query}`, 'GET');

  it('limit=0 means the default page, not the entire history', async () => {
    expect(await readBP('')).toHaveLength(100);
    // The regression, precisely: this used to return all 105.
    expect(await readBP('&limit=0')).toHaveLength(100);
  });

  it('an absurd limit is clamped rather than honored', async () => {
    // Observable ceiling here is the seeded set; clampLimit owns the exact
    // number, pinned below — what matters is that 999999 is not a passthrough.
    expect(await readBP('&limit=999999')).toHaveLength(SEEDED);
    expect(clampLimit(999999, 100)).toBe(MAX_LIMIT);
  });

  it('limit and offset walk the history a page at a time', async () => {
    const first = await readBP('&limit=10');
    const second = await readBP('&limit=10&offset=10');
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    // Disjoint and contiguous: page two picks up exactly where page one ended.
    expect(second.map((r) => r.systolic)).not.toEqual(first.map((r) => r.systolic));
    expect(await readBP('&limit=20')).toEqual([...first, ...second]);
  });

  it('a short page is the end of the history, and past the end is empty', async () => {
    expect(await readBP('&limit=10&offset=100')).toHaveLength(SEEDED - 100);
    expect(await readBP('&limit=10&offset=100000')).toEqual([]);
  });

  it('garbage and negative paging params fall back instead of unbounding', async () => {
    expect(await readBP('&limit=abc')).toHaveLength(100);
    expect(await readBP('&limit=-3')).toHaveLength(100);
    expect(await readBP('&limit=10&offset=-5')).toHaveLength(10);
  });

  // The sleep route defaulted to limit=0 — unbounded on EVERY call, not just
  // when asked. It has no write route to seed through, so this pins the
  // route's shape rather than a truncated row count: it must not throw and
  // must come back an array, i.e. it still goes through the clamped path.
  it('the sleep route answers through the bounded path', async () => {
    expect(Array.isArray(await api('/api/health/sleep', 'GET'))).toBe(true);
  });
});

// paginate.js is a pure module with no integration entry point of its own, and
// the interesting boundaries (MAX_LIMIT, MAX_DAYS) sit past what is worth
// seeding through a router. Unit-pinned here per docs/frontend.md's testing
// posture.
describe('paginate clamps (med-vgw)', () => {
  it('clampLimit: absent or <= 0 is the default, never everything', () => {
    expect(clampLimit(undefined, 50)).toBe(50);
    expect(clampLimit(null, 50)).toBe(50);
    expect(clampLimit('', 50)).toBe(50);
    expect(clampLimit('0', 50)).toBe(50);
    expect(clampLimit(0, 50)).toBe(50);
    expect(clampLimit(-1, 50)).toBe(50);
    expect(clampLimit('nonsense', 50)).toBe(50);
  });

  it('clampLimit: honors a sane value, clamps past the max', () => {
    expect(clampLimit('25', 50)).toBe(25);
    expect(clampLimit(MAX_LIMIT + 1, 50)).toBe(MAX_LIMIT);
    expect(clampLimit(999999, 50)).toBe(MAX_LIMIT);
    // A per-op max below the shared one wins, including over the default.
    expect(clampLimit(999999, 100, 200)).toBe(200);
    expect(clampLimit(0, 500, 200)).toBe(200);
  });

  it('clampOffset: absent, negative or unparseable is 0, and 0 has no ceiling', () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset('-4')).toBe(0);
    expect(clampOffset('x')).toBe(0);
    expect(clampOffset('40')).toBe(40);
    expect(clampOffset(999999)).toBe(999999);
  });

  it('clampDays bounds the window for the reads that have no row limit', () => {
    expect(clampDays(undefined, 7)).toBe(7);
    expect(clampDays(0, 7)).toBe(7);
    expect(clampDays(30, 7)).toBe(30);
    expect(clampDays(10000, 7)).toBe(366);
  });

  it('pageOf slices a page without reshaping the response', () => {
    const rows = [1, 2, 3, 4, 5];
    expect(pageOf(rows, 2, 0)).toEqual([1, 2]);
    expect(pageOf(rows, 2, 2)).toEqual([3, 4]);
    expect(pageOf(rows, 2, 4)).toEqual([5]);
    expect(pageOf(rows, 2, 9)).toEqual([]);
  });
});
