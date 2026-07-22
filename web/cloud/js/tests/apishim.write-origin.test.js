// bd med-dvr — "New data is available." appeared after the user's OWN actions:
// change a setting, get told there is new data.
//
// A regression from #548 (med-d5t.10), which correctly made non-UI writes
// repaint the screen but suppressed the UI's own writes with the wrong guard:
// DataStore.hasAnyPendingOptimistic(). That is only ever true for writes routed
// through applyOptimistic, and settings writes are not — toggleFeatureSetting
// POSTs straight through apiCall. So the guard passed, the emit fired, and the
// banner announced the user's own toggle back to them.
//
// The origin of a write is known at the call site. These drive the REAL router
// and the REAL settings domain over a real (fake-indexeddb) records store, so
// they fail if the origin stops reaching writeRecord for any reason.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiRouter } from '../apishim.js';
import { generateDEK } from '../crypto.js';
import { ORIGIN_EXTERNAL, ORIGIN_UI } from '../sync.js';

const accountId = 'amber-falcon-8k3q9x';

describe('write origin decides the repaint (med-dvr)', () => {
  let ctx;
  let ds;

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('medtracker-cloud');
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    ctx = { accountId, dek: await generateDEK() };

    ds = {
      invalidateTags: vi.fn(async () => {}),
      requestTabRefresh: vi.fn(),
      // Present and always false, exactly as it is during a settings write:
      // nothing in that path ever calls applyOptimistic.
      hasAnyPendingOptimistic: vi.fn(() => false),
    };
    vi.stubGlobal('window', { DataStore: ds });

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
  });

  // The reported bug, end to end. 'food' is in the shim's PORTED_SET, so the
  // route actually persists rather than rejecting the toggle before the write —
  // otherwise this would pass for the wrong reason.
  it('a UI settings toggle never says "New data is available"', async () => {
    const ui = createApiRouter(ctx, { origin: ORIGIN_UI });

    await ui('/api/settings/features/food', 'POST', { enabled: true });

    // The write really happened...
    expect(await ui('/api/settings/features', 'GET')).toMatchObject({ food: true });
    // ...and it stayed quiet.
    expect(ds.requestTabRefresh).not.toHaveBeenCalled();
    expect(ds.invalidateTags).not.toHaveBeenCalled();
    // The guard that used to be consulted is irrelevant now.
    expect(ds.hasAnyPendingOptimistic).not.toHaveBeenCalled();
  });

  it('the same toggle from a non-UI writer DOES repaint the open tab', async () => {
    const bg = createApiRouter(ctx, { origin: ORIGIN_EXTERNAL });

    await bg('/api/settings/features/food', 'POST', { enabled: true });

    expect(ds.requestTabRefresh).toHaveBeenCalledWith(
      expect.arrayContaining(['settings']), 'cloud-write',
    );
  });

  it('a voice/MCP-originated BP write still repaints, as med-d5t.10 requires', async () => {
    const bg = createApiRouter(ctx, { origin: ORIGIN_EXTERNAL });

    await bg('/api/bp', 'POST', { systolic: 120, diastolic: 80, pulse: 60 });

    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['bp'], 'cloud-write');
  });

  it("a UI BP write does not, because the screen that made it already repainted", async () => {
    const ui = createApiRouter(ctx, { origin: ORIGIN_UI });

    await ui('/api/bp', 'POST', { systolic: 120, diastolic: 80, pulse: 60 });

    expect(ds.requestTabRefresh).not.toHaveBeenCalled();
  });

  it('defaults to repainting when no origin is given — stale beats silent', async () => {
    const untagged = createApiRouter(ctx, {});

    await untagged('/api/bp', 'POST', { systolic: 120, diastolic: 80, pulse: 60 });

    expect(ds.requestTabRefresh).toHaveBeenCalledWith(['bp'], 'cloud-write');
  });
});
