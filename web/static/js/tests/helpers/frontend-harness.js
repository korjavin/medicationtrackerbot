import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const DATA_STORE_JS = path.join(REPO_ROOT, 'web/static/js/data-store.js');
const APP_JS = path.join(REPO_ROOT, 'web/static/js/app.js');
const AUTH_FLOW_JS = path.join(REPO_ROOT, 'web/static/js/features/auth-flow.js');
const DEEPLINK_ROUTER_JS = path.join(REPO_ROOT, 'web/static/js/features/deeplink-router.js');
const WORKOUT_JS = path.join(REPO_ROOT, 'web/static/js/workout.js');

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

function disableAutoBootstrap(source) {
  // The bootstrap block has been moved to features/bootstrap.js which the
  // harness intentionally does not load.  This function is kept as a no-op
  // stub so callers do not need to change.
  return source;
}

export function createMockResponse({ status = 200, json, text } = {}) {
  const payloadText = text ?? (json !== undefined ? JSON.stringify(json) : '');
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (json !== undefined) return json;
      if (!payloadText) return {};
      return JSON.parse(payloadText);
    },
    async text() {
      return payloadText;
    },
    async blob() {
      return new Blob([payloadText]);
    }
  };
}

function isVersionAtLeast(currentVersion, targetVersion) {
  const currentParts = String(currentVersion).split('.').map((v) => parseInt(v, 10) || 0);
  const targetParts = String(targetVersion).split('.').map((v) => parseInt(v, 10) || 0);
  const maxLength = Math.max(currentParts.length, targetParts.length);
  for (let i = 0; i < maxLength; i += 1) {
    const current = currentParts[i] || 0;
    const target = targetParts[i] || 0;
    if (current > target) return true;
    if (current < target) return false;
  }
  return true;
}

export function loadFrontendEnv({ withWorkout = false, telegramInitData = '', telegramVersion = '6.9', url = 'https://example.test/' } = {}) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });

  const { window } = dom;

  const backButtonState = {
    showCalls: 0,
    hideCalls: 0,
    clickHandler: null
  };

  const backButton = {
    show() {
      backButtonState.showCalls += 1;
    },
    hide() {
      backButtonState.hideCalls += 1;
    },
    onClick(cb) {
      backButtonState.clickHandler = cb;
    }
  };

  window.Telegram = {
    WebApp: {
      initData: telegramInitData,
      initDataUnsafe: {},
      ready() {},
      expand() {},
      isVersionAtLeast(version) {
        return isVersionAtLeast(telegramVersion, version);
      },
      showAlert() {},
      showConfirm(_msg, cb) {
        cb(true);
      },
      BackButton: backButton
    }
  };

  window.OIDC_CONFIG = { enabled: false };
  window.BOT_USERNAME = 'test_bot';
  window.alert = () => {};
  window.confirm = () => true;
  window.fetch = async () => createMockResponse({ status: 200, json: {} });
  window.eval('var history = window.history;');

  const dataStoreSource = fs.readFileSync(DATA_STORE_JS, 'utf8');
  evalWithSourceURL(window, dataStoreSource, DATA_STORE_JS);

  const appSource = disableAutoBootstrap(fs.readFileSync(APP_JS, 'utf8'));
  evalWithSourceURL(window, appSource, APP_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // Load feature modules that expose helpers used by tests.
  // auth-flow.js: provides saveAuthState / getCachedAuthState / clearAuthState.
  const authFlowSource = fs.readFileSync(AUTH_FLOW_JS, 'utf8');
  evalWithSourceURL(window, authFlowSource, AUTH_FLOW_JS);

  // deeplink-router.js: provides handleDeepLinks() on window.
  // The Telegram start_param auto-run is harmless (initDataUnsafe={} in tests).
  const deeplinkSource = fs.readFileSync(DEEPLINK_ROUTER_JS, 'utf8');
  evalWithSourceURL(window, deeplinkSource, DEEPLINK_ROUTER_JS);

  if (withWorkout) {
    const workoutSource = fs.readFileSync(WORKOUT_JS, 'utf8');
    evalWithSourceURL(window, workoutSource, WORKOUT_JS);
  }

  return {
    window,
    document: window.document,
    backButtonState,
    cleanup: () => dom.window.close()
  };
}
