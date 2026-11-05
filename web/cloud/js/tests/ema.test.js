// The ema port's lazy loader + own cache (bd med-3u28.2, acceptance d).
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createEmaLoader, createEmaPort, emaAssetUrl, EMA_CACHE_PREFIX } from '../ema.js';

const source = JSON.parse(readFileSync(new URL('../../../../third_party/ema-article57/source.json', import.meta.url)));
const asset = (rows = [['Candecor', 'Candesartan Cilexetil', 'Oral Use', 'Germany']]) => JSON.stringify({
  schema_version: 1, source, columns: ['name', 'substances', 'route', 'jurisdiction'], source_rows: rows.length, rows,
});

// CacheStorage double: named caches of url → body text.
function fakeCaches({ failPut = false } = {}) {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(url) { return store.has(url) ? new Response(store.get(url)) : undefined; },
        async put(url, res) { if (failPut) throw new Error('QuotaExceededError'); store.set(url, await res.text()); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
}

const okFetch = (body = asset()) => vi.fn(async () => new Response(body, { headers: { 'Content-Length': String(body.length) } }));

async function settle(loader) {
  loader.ensure();
  await loader.ensure();
  return loader.state();
}

describe('ema loader', () => {
  it('one fetch for two concurrent checks, cached under its own name outside the SW prefix', async () => {
    const fetch = okFetch();
    const caches = fakeCaches();
    const loader = createEmaLoader({ fetch, caches });
    const a = loader.ensure();
    const b = loader.ensure();
    expect(a).toBe(b);
    expect(loader.state().status).toBe('loading');
    await a;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/static/data/ema-article57-rev90-v1.json', { cache: 'no-store' });
    expect(loader.state().status).toBe('ready');
    expect(loader.state().catalogue.exact('candecor').candidates).toHaveLength(1);
    expect([...caches.stores.keys()]).toEqual(['medtracker-ema-rev90-v1']);
    expect(loader.cacheName.startsWith('medtracker-cloud')).toBe(false);
  });

  it('reports download progress while the body streams', async () => {
    const body = asset();
    const half = Math.floor(body.length / 2);
    let push;
    const stream = new ReadableStream({ start(c) { push = c; } });
    const loader = createEmaLoader({
      fetch: async () => new Response(stream, { headers: { 'Content-Length': String(body.length) } }),
      caches: fakeCaches(),
    });
    const done = loader.ensure();
    push.enqueue(new TextEncoder().encode(body.slice(0, half)));
    await vi.waitFor(() => expect(loader.state().progress).toBeCloseTo(half / body.length, 2));
    push.enqueue(new TextEncoder().encode(body.slice(half)));
    push.close();
    await done;
    expect(loader.state().status).toBe('ready');
  });

  it('a second page load reads the cache first and never touches the network', async () => {
    const caches = fakeCaches();
    await settle(createEmaLoader({ fetch: okFetch(), caches }));
    const noNetwork = vi.fn(async () => { throw new Error('network must not be used'); });
    const next = createEmaLoader({ fetch: noNetwork, caches });
    expect((await settle(next)).status).toBe('ready');
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('a failing cache write still yields a working register', async () => {
    const loader = createEmaLoader({ fetch: okFetch(), caches: fakeCaches({ failPut: true }) });
    expect((await settle(loader)).status).toBe('ready');
    expect(createEmaLoader({ fetch: okFetch(), caches: undefined }).cacheName).toBe('medtracker-ema-rev90-v1');
    expect((await settle(createEmaLoader({ fetch: okFetch(), caches: undefined }))).status).toBe('ready');
  });

  it('a newer revision replaces the older only after it validated and was stored', async () => {
    const caches = fakeCaches();
    await settle(createEmaLoader({ fetch: okFetch(), caches, revision: 'rev90-v1' }));

    // An invalid new revision: the old copy stays.
    const bad = createEmaLoader({ fetch: okFetch('{"schema_version":2}'), caches, revision: 'rev91-v1' });
    expect((await settle(bad)).status).toBe('unavailable');
    expect(caches.stores.get('medtracker-ema-rev90-v1').has(emaAssetUrl('rev90-v1'))).toBe(true);
    expect(caches.stores.get('medtracker-ema-rev91-v1').size).toBe(0);

    const good = createEmaLoader({ fetch: okFetch(), caches, revision: 'rev91-v1' });
    expect((await settle(good)).status).toBe('ready');
    expect([...caches.stores.keys()].filter((n) => n.startsWith(EMA_CACHE_PREFIX))).toEqual(['medtracker-ema-rev91-v1']);
  });

  it('offline before the first download: unavailable, and the next check retries', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(okFetch());
    const loader = createEmaLoader({ fetch, caches: fakeCaches() });
    expect((await settle(loader)).status).toBe('unavailable');
    expect((await settle(loader)).status).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('ema port', () => {
  const win = (register) => ({ localStorage: { getItem: (k) => (k === 'medRegister:acct' ? register : null) }, MedTrackerCloud: { ctx: { accountId: 'acct' } } });

  it('is off with the US register picked and never starts the loader', async () => {
    const loader = { ensure: vi.fn(), state: vi.fn() };
    expect(await createEmaPort({ win: win(null), loader }).register()).toEqual({ status: 'off' });
    expect(await createEmaPort({ win: win('us'), loader }).register()).toEqual({ status: 'off' });
    expect(loader.ensure).not.toHaveBeenCalled();
  });

  it('with EU picked starts the load and reports its state without waiting', async () => {
    const loader = { ensure: vi.fn(), state: vi.fn(() => ({ status: 'loading', progress: 0.1 })) };
    expect(await createEmaPort({ win: win('eu'), loader }).register()).toEqual({ status: 'loading', progress: 0.1 });
    expect(loader.ensure).toHaveBeenCalledTimes(1);
  });
});
