import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const PUSH_JS = path.join(REPO_ROOT, 'web/static/js/push.js');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

function makeSubscription() {
  return {
    endpoint: 'https://push.example/sub-1',
    getKey(name) {
      if (name === 'auth') return new Uint8Array([1, 2, 3]).buffer;
      if (name === 'p256dh') return new Uint8Array([4, 5, 6]).buffer;
      return null;
    },
    async unsubscribe() { return true; }
  };
}

export function loadPushEnv({ support = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const { window } = dom;

  const registration = {
    pushManager: {
      async getSubscription() { return null; },
      async subscribe() { return makeSubscription(); }
    }
  };

  if (support) {
    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: function PushManagerMock() {}
    });
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        controller: {}
      }
    });
  }

  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: {
      async requestPermission() { return 'granted'; }
    }
  });

  window.fetch = async () => ({
    ok: true,
    async json() { return { public_key: 'BEl6nA' }; },
    async text() { return ''; }
  });

  // Load core/api.js first so window.makeAuthHeaders is available to
  // push.js's authenticated fetch calls (matches the production load
  // order in index.html where core/api.js is included before push.js).
  const coreApiSource = fs.readFileSync(CORE_API_JS, 'utf8');
  evalWithSourceURL(window, coreApiSource, CORE_API_JS);

  const source = fs.readFileSync(PUSH_JS, 'utf8');
  evalWithSourceURL(window, source, PUSH_JS);

  return {
    window,
    registration,
    makeSubscription,
    cleanup: () => dom.window.close()
  };
}
