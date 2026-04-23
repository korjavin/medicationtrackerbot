import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/utils.js');
const MT_ELEMENTS_JS = path.join(REPO_ROOT, 'web/static/js/components/mt-elements.js');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const STAT_CARD_JS = path.join(REPO_ROOT, 'web/static/js/components/stat-card.js');
const ACTION_ROW_JS = path.join(REPO_ROOT, 'web/static/js/components/action-row.js');
const SECTION_HEADER_JS = path.join(REPO_ROOT, 'web/static/js/components/section-header.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_BOTTOM_NAV_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-bottom-nav.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const WG_BP_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-bp-chart.js');
const WG_WEIGHT_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-weight-chart.js');
const WG_MACRO_BAR_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-macro-bar.js');
const MODAL_MANAGER_JS = path.join(REPO_ROOT, 'web/static/js/core/modal-manager.js');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');
const APP_KERNEL_JS = path.join(REPO_ROOT, 'web/static/js/core/app-kernel.js');
const STORE_JS = path.join(REPO_ROOT, 'web/static/js/core/store.js');
const MODAL_CONTROLLER_JS = path.join(REPO_ROOT, 'web/static/js/core/modal-controller.js');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const DATA_STORE_JS = path.join(REPO_ROOT, 'web/static/js/data-store.js');
const APP_JS = path.join(REPO_ROOT, 'web/static/js/app.js');
const MEDS_JS = path.join(REPO_ROOT, 'web/static/js/features/meds.js');
const FOOD_JS = path.join(REPO_ROOT, 'web/static/js/features/food.js');
const BP_JS = path.join(REPO_ROOT, 'web/static/js/features/bp.js');
const WEIGHT_JS = path.join(REPO_ROOT, 'web/static/js/features/weight.js');
const AUTH_FLOW_JS = path.join(REPO_ROOT, 'web/static/js/features/auth-flow.js');
const MODAL_HISTORY_JS = path.join(REPO_ROOT, 'web/static/js/features/modal-history.js');
const BACK_BUTTON_JS = path.join(REPO_ROOT, 'web/static/js/features/back-button.js');
const DEEPLINK_ROUTER_JS = path.join(REPO_ROOT, 'web/static/js/features/deeplink-router.js');
const HEALTH_JS = path.join(REPO_ROOT, 'web/static/js/features/health.js');
const WORKOUT_JS = path.join(REPO_ROOT, 'web/static/js/features/workout.js');

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

  // Core infrastructure files (loaded before data-store.js and app.js)
  evalWithSourceURL(window, fs.readFileSync(UTILS_JS, 'utf8'), UTILS_JS);
  evalWithSourceURL(window, fs.readFileSync(MT_ELEMENTS_JS, 'utf8'), MT_ELEMENTS_JS);
  evalWithSourceURL(window, fs.readFileSync(EMPTY_STATE_JS, 'utf8'), EMPTY_STATE_JS);
  evalWithSourceURL(window, fs.readFileSync(STAT_CARD_JS, 'utf8'), STAT_CARD_JS);
  evalWithSourceURL(window, fs.readFileSync(ACTION_ROW_JS, 'utf8'), ACTION_ROW_JS);
  evalWithSourceURL(window, fs.readFileSync(SECTION_HEADER_JS, 'utf8'), SECTION_HEADER_JS);
  evalWithSourceURL(window, fs.readFileSync(WG_ICONS_JS, 'utf8'), WG_ICONS_JS);
  evalWithSourceURL(window, fs.readFileSync(WG_BOTTOM_NAV_JS, 'utf8'), WG_BOTTOM_NAV_JS);
  evalWithSourceURL(window, fs.readFileSync(WG_SPARKLINE_JS, 'utf8'), WG_SPARKLINE_JS);
  evalWithSourceURL(window, fs.readFileSync(WG_BP_CHART_JS, 'utf8'), WG_BP_CHART_JS);
  evalWithSourceURL(window, fs.readFileSync(WG_WEIGHT_CHART_JS, 'utf8'), WG_WEIGHT_CHART_JS);
  evalWithSourceURL(window, fs.readFileSync(WG_MACRO_BAR_JS, 'utf8'), WG_MACRO_BAR_JS);
  evalWithSourceURL(window, fs.readFileSync(MODAL_MANAGER_JS, 'utf8'), MODAL_MANAGER_JS);
  evalWithSourceURL(window, fs.readFileSync(CORE_API_JS, 'utf8'), CORE_API_JS);
  evalWithSourceURL(window, fs.readFileSync(APP_KERNEL_JS, 'utf8'), APP_KERNEL_JS);
  evalWithSourceURL(window, fs.readFileSync(STORE_JS, 'utf8'), STORE_JS);
  evalWithSourceURL(window, fs.readFileSync(MODAL_CONTROLLER_JS, 'utf8'), MODAL_CONTROLLER_JS);
  evalWithSourceURL(window, fs.readFileSync(CHART_UTILS_JS, 'utf8'), CHART_UTILS_JS);

  const dataStoreSource = fs.readFileSync(DATA_STORE_JS, 'utf8');
  evalWithSourceURL(window, dataStoreSource, DATA_STORE_JS);

  const appSource = disableAutoBootstrap(fs.readFileSync(APP_JS, 'utf8'));
  evalWithSourceURL(window, appSource, APP_JS);

  // Feature modules extracted from app.js (meds, food, bp, weight, health).
  evalWithSourceURL(window, fs.readFileSync(MEDS_JS, 'utf8'), MEDS_JS);
  evalWithSourceURL(window, fs.readFileSync(FOOD_JS, 'utf8'), FOOD_JS);
  evalWithSourceURL(window, fs.readFileSync(BP_JS, 'utf8'), BP_JS);
  evalWithSourceURL(window, fs.readFileSync(WEIGHT_JS, 'utf8'), WEIGHT_JS);
  evalWithSourceURL(window, fs.readFileSync(HEALTH_JS, 'utf8'), HEALTH_JS);

  // auth-flow.js: provides saveAuthState / getCachedAuthState / clearAuthState.
  const authFlowSource = fs.readFileSync(AUTH_FLOW_JS, 'utf8');
  evalWithSourceURL(window, authFlowSource, AUTH_FLOW_JS);

  // modal-history.js must load BEFORE DOMContentLoaded fires so its internal
  // 'DOMContentLoaded' listener can call setupObserver() at the right time.
  // (JSDOM keeps readyState='loading' until its own lifecycle completes.)
  const modalHistorySource = fs.readFileSync(MODAL_HISTORY_JS, 'utf8');
  evalWithSourceURL(window, modalHistorySource, MODAL_HISTORY_JS);

  // back-button.js must load before AppBackButton.setup() is called; it also
  // owns the Telegram BackButton onClick handler that modal-history relies on.
  const backButtonSource = fs.readFileSync(BACK_BUTTON_JS, 'utf8');
  evalWithSourceURL(window, backButtonSource, BACK_BUTTON_JS);

  // Fire DOMContentLoaded – triggers setupObserver() inside modal-history.js.
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // Wire AppBackButton the way bootstrap.js does in production.
  if (window.AppBackButton && typeof window.AppBackButton.setup === 'function') {
    window.AppBackButton.setup();
  }

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
