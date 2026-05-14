import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allowConsoleNoise } from './helpers/setup.js';

// Integration env that wires cache-keys.js, data-store.js, and cached-fetch.js
// into the same window, mirroring index.html's load order. Lets the test
// verify that cachedFetch can drop the inline `tags` arg because the registry
// supplies the tag via `CacheKeys.tagFor(key)`.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CACHE_KEYS_JS = path.join(REPO_ROOT, 'web/static/js/core/cache-keys.js');
const DATA_STORE_JS = path.join(REPO_ROOT, 'web/static/js/data-store.js');
const CACHED_FETCH_JS = path.join(REPO_ROOT, 'web/static/js/cached-fetch.js');

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

function loadRegistryEnv({ initialCache = {}, online = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  const map = new Map();
  for (const [key, value] of Object.entries(initialCache)) {
    if (value && typeof value === 'object' && 'data' in value && 'timestamp' in value) {
      map.set(key, { id: key, ...value });
    } else {
      map.set(key, { id: key, timestamp: Date.now(), data: value });
    }
  }

  const apiCache = {
    map,
    async get(key) {
      const entry = map.get(key);
      return entry ? entry.data : null;
    },
    async getWithMeta(key) {
      const entry = map.get(key);
      return entry ? { data: entry.data, timestamp: entry.timestamp } : null;
    },
    async set(key, data) {
      map.set(key, { id: key, timestamp: Date.now(), data });
    },
    async clear(key) {
      if (key) map.delete(key); else map.clear();
    },
    async keys(prefix) {
      const all = [...map.keys()];
      if (typeof prefix === 'string' && prefix.length > 0) {
        return all.filter((k) => k.startsWith(prefix));
      }
      return all;
    }
  };
  window.MedTrackerDB = { ApiCache: apiCache };

  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online
  });

  const snapshotCalls = [];
  window.cacheApiSnapshot = async (key, value, tags = []) => {
    snapshotCalls.push({ key, value, tags });
    await apiCache.set(key, value);
  };

  // Load in canonical order: registry → data-store → cached-fetch.
  evalWithSourceURL(window, fs.readFileSync(CACHE_KEYS_JS, 'utf8'), CACHE_KEYS_JS);
  evalWithSourceURL(window, fs.readFileSync(DATA_STORE_JS, 'utf8'), DATA_STORE_JS);
  evalWithSourceURL(window, fs.readFileSync(CACHED_FETCH_JS, 'utf8'), CACHED_FETCH_JS);

  // Mirror bootstrap.js: wire the registry into DataStore before any fetch.
  window.CacheKeys.registerAll(window.DataStore);

  return {
    window,
    cacheMap: map,
    snapshotCalls,
    cleanup: () => dom.window.close()
  };
}

describe('cachedFetch + CacheKeys registry', () => {
  beforeEach(() => {
    allowConsoleNoise();
  });

  it('cachedFetch resolves the tag from the registry when opts.tags is omitted', async () => {
    const { window, cacheMap, snapshotCalls, cleanup } = loadRegistryEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue([{ id: 1 }]);

      const result = await window.cachedFetch('medications', '/api/medications');

      expect(result.data).toEqual([{ id: 1 }]);
      expect(cacheMap.get('medications').data).toEqual([{ id: 1 }]);
      // cacheApiSnapshot must receive the tag the registry advertises so that
      // a server-side change-poll on 'medications' evicts this key.
      expect(snapshotCalls).toHaveLength(1);
      expect(snapshotCalls[0]).toMatchObject({
        key: 'medications',
        tags: ['medications']
      });
    } finally {
      cleanup();
    }
  });

  it('registry tag resolution lets invalidateByTag evict a key that never had inline tags', async () => {
    const { window, cacheMap, cleanup } = loadRegistryEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue([{ id: 1 }]);

      // Populate the cache via cachedFetch with no inline tags.
      await window.cachedFetch('medications', '/api/medications');
      expect(cacheMap.has('medications')).toBe(true);

      // A server-side change reports a medications-tag invalidation. The
      // registry-wired tag mapping is what makes this evict the row.
      await window.DataStore.invalidateTags(['medications']);
      expect(cacheMap.has('medications')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('explicit opts.tags overrides the registry for one-off keys', async () => {
    const { window, snapshotCalls, cleanup } = loadRegistryEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ items: [] });

      // 'medications' is registered with tag 'medications'; passing a custom
      // tag here must win over the registry. Behaviour useful when a caller
      // wants to scope a payload to a narrower invalidation surface.
      await window.cachedFetch('medications', '/api/medications', {
        tags: ['custom-override']
      });

      expect(snapshotCalls).toHaveLength(1);
      expect(snapshotCalls[0].tags).toEqual(['custom-override']);
    } finally {
      cleanup();
    }
  });

  it('dynamic family keys resolve to the family tag (e.g. food_<date>_day → "food")', async () => {
    const { window, snapshotCalls, cleanup } = loadRegistryEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ groups: [] });

      const key = window.CacheKeys.dayFoodKey('2026-05-14');
      await window.cachedFetch(key, '/api/food/log?date=2026-05-14');

      expect(snapshotCalls).toHaveLength(1);
      expect(snapshotCalls[0]).toMatchObject({
        key: 'food_2026-05-14_day',
        tags: ['food']
      });
    } finally {
      cleanup();
    }
  });

  it('unknown key with no inline tags falls back to no tags (does not throw)', async () => {
    const { window, snapshotCalls, cleanup } = loadRegistryEnv();

    try {
      window.apiCallDirect = vi.fn().mockResolvedValue({ ok: true });

      // A literal key not in the registry: tagFor returns null and the fetch
      // proceeds with an empty tag list. Caller is responsible for invalidation.
      await window.cachedFetch('some_one_off_key', '/api/ad-hoc');

      expect(snapshotCalls).toHaveLength(1);
      expect(snapshotCalls[0].tags).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
