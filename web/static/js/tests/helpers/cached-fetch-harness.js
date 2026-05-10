import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CACHED_FETCH_JS = path.join(REPO_ROOT, 'web/static/js/cached-fetch.js');

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

export function loadCachedFetchEnv({ initialCache = {}, online = true } = {}) {
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
    }
  };

  window.MedTrackerDB = { ApiCache: apiCache };

  // navigator.onLine is read-only by default; redefine it for the suite.
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online
  });

  // Default cacheApiSnapshot mock — writes through to the same map.
  window.cacheApiSnapshot = async (key, value, _tags = []) => {
    await apiCache.set(key, value);
  };

  const source = fs.readFileSync(CACHED_FETCH_JS, 'utf8');
  evalWithSourceURL(window, source, CACHED_FETCH_JS);

  return {
    window,
    cacheMap: map,
    apiCache,
    cleanup: () => dom.window.close()
  };
}
