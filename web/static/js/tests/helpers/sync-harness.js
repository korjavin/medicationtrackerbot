import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SYNC_JS = path.join(REPO_ROOT, 'web/static/js/sync.js');

function createStore(overrides = {}) {
  return {
    async getPendingCount() { return 0; },
    async getPending() { return []; },
    async getAll() { return []; },
    async getCache() { return null; },
    async save() { return { localId: 1 }; },
    async confirmDelete() {},
    async markSynced() {},
    async markError() {},
    ...overrides
  };
}

export function loadSyncEnv({ bpPending = 0, weightPending = 0, intakePending = 0 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="sync-status-bar"></div></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const { window } = dom;

  window.MedTrackerDB = {
    BPStore: createStore({
      async getPendingCount() { return bpPending; }
    }),
    WeightStore: createStore({
      async getPendingCount() { return weightPending; }
    }),
    IntakeQueueStore: createStore({
      async getPendingCount() { return intakePending; }
    })
  };

  window.apiCallDirect = async () => ({ id: 1 });

  const source = fs.readFileSync(SYNC_JS, 'utf8');
  window.eval(source);

  return {
    window,
    document: window.document,
    cleanup: () => dom.window.close()
  };
}
