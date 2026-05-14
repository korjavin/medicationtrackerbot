import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DATA_STORE_JS = path.join(REPO_ROOT, 'web/static/js/data-store.js');

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

function createApiCacheMock(initialCache = {}, initialMeta = {}) {
  const map = new Map(Object.entries(initialCache));
  // Per-key timestamp ledger that mirrors the {id, timestamp, data} row shape
  // of the real api_cache Dexie table. Keeps the simple `get(key)→data`
  // contract intact while letting tests exercise getWithMeta / setWithMeta
  // (used by hydrateFromDexie + WGStaleBadge.mountFromKey).
  const meta = new Map(Object.entries(initialMeta));

  return {
    map,
    meta,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async getWithMeta(key) {
      if (!map.has(key)) return null;
      return { data: map.get(key), timestamp: meta.has(key) ? meta.get(key) : null };
    },
    async set(key, value) {
      map.set(key, value);
      meta.set(key, Date.now());
    },
    async setWithMeta(key, value, timestamp) {
      map.set(key, value);
      meta.set(key, Number.isFinite(timestamp) ? timestamp : Date.now());
    },
    async clear(key) {
      map.delete(key);
      meta.delete(key);
    },
    async keys(prefix) {
      const all = [...map.keys()];
      if (typeof prefix === 'string' && prefix.length > 0) {
        return all.filter((k) => k.startsWith(prefix));
      }
      return all;
    }
  };
}

export function loadDataStoreEnv({ initialCache = {}, initialMeta = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const { window } = dom;
  const apiCache = createApiCacheMock(initialCache, initialMeta);

  window.MedTrackerDB = { ApiCache: apiCache };
  window.apiCallDirect = async () => ({ cursor: 0, changed_tags: [] });

  const source = fs.readFileSync(DATA_STORE_JS, 'utf8');
  evalWithSourceURL(window, source, DATA_STORE_JS);

  return {
    window,
    cacheMap: apiCache.map,
    metaMap: apiCache.meta,
    cleanup: () => dom.window.close()
  };
}
