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

function createApiCacheMock(initialCache = {}) {
  const map = new Map(Object.entries(initialCache));
  // Track timestamps for getWithMeta support
  const metaMap = new Map();

  return {
    map,
    metaMap,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
      metaMap.set(key, Date.now());
    },
    async clear(key) {
      map.delete(key);
      metaMap.delete(key);
    },
    async getWithMeta(key) {
      if (!map.has(key)) return null;
      return { data: map.get(key), cachedAt: metaMap.get(key) || 0 };
    }
  };
}

export function loadDataStoreEnv({ initialCache = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const { window } = dom;
  const apiCache = createApiCacheMock(initialCache);

  window.MedTrackerDB = { ApiCache: apiCache };
  window.apiCallDirect = async () => ({ cursor: 0, changed_tags: [] });

  const source = fs.readFileSync(DATA_STORE_JS, 'utf8');
  evalWithSourceURL(window, source, DATA_STORE_JS);

  return {
    window,
    cacheMap: apiCache.map,
    cleanup: () => dom.window.close()
  };
}
