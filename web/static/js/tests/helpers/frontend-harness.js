import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const DATA_STORE_JS = path.join(REPO_ROOT, 'web/static/js/data-store.js');
const COMPONENTS = [
  path.join(REPO_ROOT, 'web/static/js/components/mt-modal.js'),
  path.join(REPO_ROOT, 'web/static/js/components/mt-setting-toggle.js'),
  path.join(REPO_ROOT, 'web/static/js/components/mt-tab-group.js'),
  path.join(REPO_ROOT, 'web/static/js/components/mt-day-picker.js'),
  path.join(REPO_ROOT, 'web/static/js/components/mt-card.js'),
  path.join(REPO_ROOT, 'web/static/js/components/register-components.js')
];

// Feature modules loaded in dependency order
const FEATURE_SCRIPTS = [
  path.join(REPO_ROOT, 'web/static/js/features/core-utils.js'),
  path.join(REPO_ROOT, 'web/static/js/features/state.js'),
  path.join(REPO_ROOT, 'web/static/js/features/api.js'),
  path.join(REPO_ROOT, 'web/static/js/features/ui-manager.js'),
  path.join(REPO_ROOT, 'web/static/js/features/bp.js'),
  path.join(REPO_ROOT, 'web/static/js/features/weight.js'),
  path.join(REPO_ROOT, 'web/static/js/features/food.js'),
  path.join(REPO_ROOT, 'web/static/js/features/medications.js'),
  path.join(REPO_ROOT, 'web/static/js/features/medication-modals.js'),
  path.join(REPO_ROOT, 'web/static/js/features/health.js'),
  path.join(REPO_ROOT, 'web/static/js/features/hub.js'),
  path.join(REPO_ROOT, 'web/static/js/features/settings.js')
];

const APP_JS = path.join(REPO_ROOT, 'web/static/js/app.js');
const WORKOUT_JS = path.join(REPO_ROOT, 'web/static/js/workout.js');

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

function disableAutoBootstrap(source) {
  // Remove the DOMContentLoaded async handler that does auth/loading
  source = source.replace(
    /document\.addEventListener\('DOMContentLoaded',\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n\}\);/,
    '// DOMContentLoaded auto-bootstrap disabled in tests'
  );

  // Remove the Telegram start_param check
  source = source.replace(
    /\/\/ Check for Telegram start_param[\s\S]*?}, 100\);\s*\}/,
    '// Telegram start_param check disabled in tests'
  );

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

export function loadFrontendEnv({ withWorkout = false, telegramInitData = '', telegramVersion = '6.9' } = {}) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.test/',
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
      ready() { },
      expand() { },
      isVersionAtLeast(version) {
        return isVersionAtLeast(telegramVersion, version);
      },
      showAlert() { },
      showConfirm(_msg, cb) {
        cb(true);
      },
      BackButton: backButton
    }
  };

  window.OIDC_CONFIG = { enabled: false };
  window.BOT_USERNAME = 'test_bot';
  window.alert = () => { };
  window.confirm = () => true;
  window.fetch = async () => createMockResponse({ status: 200, json: {} });
  window.eval('var history = window.history;');

  const dataStoreSource = fs.readFileSync(DATA_STORE_JS, 'utf8');
  evalWithSourceURL(window, dataStoreSource, DATA_STORE_JS);

  for (const compPath of COMPONENTS) {
    const compSource = fs.readFileSync(compPath, 'utf8');
    evalWithSourceURL(window, compSource, compPath);
  }

  // Load all feature scripts in correct order
  for (const scriptPath of FEATURE_SCRIPTS) {
    const source = fs.readFileSync(scriptPath, 'utf8');
    evalWithSourceURL(window, source, scriptPath);
  }

  const appSource = disableAutoBootstrap(fs.readFileSync(APP_JS, 'utf8'));
  evalWithSourceURL(window, appSource, APP_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

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
