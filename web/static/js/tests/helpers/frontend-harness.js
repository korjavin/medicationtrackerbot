import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

const INDEX_HTML = path.join(REPO_ROOT, 'web/static/index.html');
const UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/utils.js');
const TIME_FORMAT_JS = path.join(REPO_ROOT, 'web/static/js/core/time-format.js');
const MT_ELEMENTS_JS = path.join(REPO_ROOT, 'web/static/js/components/mt-elements.js');
const EMPTY_STATE_JS = path.join(REPO_ROOT, 'web/static/js/components/empty-state.js');
const STAT_CARD_JS = path.join(REPO_ROOT, 'web/static/js/components/stat-card.js');
const ACTION_ROW_JS = path.join(REPO_ROOT, 'web/static/js/components/action-row.js');
const WG_ICONS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-icons.js');
const WG_BOTTOM_NAV_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-bottom-nav.js');
const WG_SPARKLINE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sparkline.js');
const WG_BP_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-bp-chart.js');
const WG_WEIGHT_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-weight-chart.js');
const WG_WORKOUT_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-workout-chart.js');
const WG_SLEEP_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-sleep-chart.js');
const WG_STEPS_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-steps-chart.js');
const WG_VITALS_CHART_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-vitals-chart.js');
const WG_MACRO_BAR_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-macro-bar.js');
const WG_STALE_BADGE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-stale-badge.js');
const WG_TOGGLE_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-toggle.js');
const WG_SETTINGS_JS = path.join(REPO_ROOT, 'web/static/js/components/wg-settings.js');
const MODAL_MANAGER_JS = path.join(REPO_ROOT, 'web/static/js/core/modal-manager.js');
const CORE_API_JS = path.join(REPO_ROOT, 'web/static/js/core/api.js');
const APP_KERNEL_JS = path.join(REPO_ROOT, 'web/static/js/core/app-kernel.js');
const STORE_JS = path.join(REPO_ROOT, 'web/static/js/core/store.js');
const MODAL_CONTROLLER_JS = path.join(REPO_ROOT, 'web/static/js/core/modal-controller.js');
const CHART_UTILS_JS = path.join(REPO_ROOT, 'web/static/js/core/chart-utils.js');
const CACHE_KEYS_JS = path.join(REPO_ROOT, 'web/static/js/core/cache-keys.js');
const DATA_STORE_JS = path.join(REPO_ROOT, 'web/static/js/data-store.js');
const APP_JS = path.join(REPO_ROOT, 'web/static/js/app.js');
const WEIGHT_UNIT_STATE_JS = path.join(REPO_ROOT, 'web/static/js/features/weight-unit-state.js');
const AUTH_BOOTSTRAP_JS = path.join(REPO_ROOT, 'web/static/js/features/auth-bootstrap.js');
const MEDS_JS = path.join(REPO_ROOT, 'web/static/js/features/meds.js');
const FOOD_PHOTO_SUMMARY_JS = path.join(REPO_ROOT, 'web/static/js/features/food-photo-summary.js');
// features/food.js was split into per-concern sub-files under
// features/food/ (2026-05-13). The harness loads them in dependency order:
// products.js first (decodeFoodDisplayText / renderFoodAutocomplete shared
// utilities used by log.js + meals.js + db.js), then scanner.js + photo.js,
// then log.js (the daily-log + targets + modal lifecycle), then meals.js +
// db.js (My Meals + Food DB browse), and finally index.js (orchestrator).
const FOOD_PRODUCTS_JS = path.join(REPO_ROOT, 'web/static/js/features/food/products.js');
const FOOD_SCANNER_JS = path.join(REPO_ROOT, 'web/static/js/features/food/scanner.js');
const FOOD_PHOTO_JS = path.join(REPO_ROOT, 'web/static/js/features/food/photo.js');
const FOOD_LOG_JS = path.join(REPO_ROOT, 'web/static/js/features/food/log.js');
const FOOD_MEALS_JS = path.join(REPO_ROOT, 'web/static/js/features/food/meals.js');
const FOOD_DB_JS = path.join(REPO_ROOT, 'web/static/js/features/food/db.js');
const FOOD_INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/food/index.js');
const BP_JS = path.join(REPO_ROOT, 'web/static/js/features/bp.js');
const WEIGHT_JS = path.join(REPO_ROOT, 'web/static/js/features/weight.js');
const AUTH_FLOW_JS = path.join(REPO_ROOT, 'web/static/js/features/auth-flow.js');
const MODAL_HISTORY_JS = path.join(REPO_ROOT, 'web/static/js/features/modal-history.js');
const BACK_BUTTON_JS = path.join(REPO_ROOT, 'web/static/js/features/back-button.js');
const DEEPLINK_ROUTER_JS = path.join(REPO_ROOT, 'web/static/js/features/deeplink-router.js');
const HEALTH_JS = path.join(REPO_ROOT, 'web/static/js/features/health.js');
// features/workout.js was split into per-concern sub-files under
// features/workout/ (2026-05-13). The harness loads them in dependency order:
// next-card.js first (it provides getRotationSlot/_slotTagModifier shared
// utils consumed by groups.js / history.js / library.js / sessions.js),
// followed by domain CRUD files, then sessions/history wiring, and finally
// index.js (orchestrator) which binds controls + sub-tab routing.
const WORKOUT_NEXT_CARD_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/next-card.js');
const WORKOUT_GROUPS_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/groups.js');
const WORKOUT_VARIANTS_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/variants.js');
const WORKOUT_EXERCISES_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/exercises.js');
const WORKOUT_LIBRARY_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/library.js');
const WORKOUT_HISTORY_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/history.js');
const WORKOUT_MIBAND_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/miband.js');
const WORKOUT_SESSIONS_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/sessions.js');
const WORKOUT_STATS_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/stats.js');
const WORKOUT_INDEX_JS = path.join(REPO_ROOT, 'web/static/js/features/workout/index.js');

const _sourceCache = new Map();
function readCached(filePath) {
  let src = _sourceCache.get(filePath);
  if (src === undefined) {
    src = fs.readFileSync(filePath, 'utf8');
    _sourceCache.set(filePath, src);
  }
  return src;
}

function evalWithSourceURL(window, source, scriptPath) {
  window.eval(`${source}\n//# sourceURL=file://${scriptPath}`);
}

function evalFileCached(window, scriptPath) {
  evalWithSourceURL(window, readCached(scriptPath), scriptPath);
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
  const html = readCached(INDEX_HTML);
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
  evalFileCached(window, UTILS_JS);
  // time-format.js owns Settings timezone/server-clock render helpers; loads
  // right after utils.js since app.js delegates renderSettingsTimeInfo to it.
  evalFileCached(window, TIME_FORMAT_JS);
  // wg-toggle.js must load before mt-elements.js so <mt-setting-toggle>
  // upgrades can pick up window.WGToggle in its connectedCallback.
  evalFileCached(window, WG_TOGGLE_JS);
  evalFileCached(window, MT_ELEMENTS_JS);
  evalFileCached(window, EMPTY_STATE_JS);
  evalFileCached(window, STAT_CARD_JS);
  evalFileCached(window, ACTION_ROW_JS);
  evalFileCached(window, WG_ICONS_JS);
  evalFileCached(window, WG_BOTTOM_NAV_JS);
  evalFileCached(window, WG_SPARKLINE_JS);
  evalFileCached(window, WG_BP_CHART_JS);
  evalFileCached(window, WG_WEIGHT_CHART_JS);
  evalFileCached(window, WG_WORKOUT_CHART_JS);
  evalFileCached(window, WG_SLEEP_CHART_JS);
  evalFileCached(window, WG_STEPS_CHART_JS);
  evalFileCached(window, WG_VITALS_CHART_JS);
  evalFileCached(window, WG_MACRO_BAR_JS);
  evalFileCached(window, WG_STALE_BADGE_JS);
  evalFileCached(window, WG_SETTINGS_JS);
  evalFileCached(window, MODAL_MANAGER_JS);
  evalFileCached(window, CORE_API_JS);
  evalFileCached(window, APP_KERNEL_JS);
  evalFileCached(window, STORE_JS);
  evalFileCached(window, MODAL_CONTROLLER_JS);
  evalFileCached(window, CHART_UTILS_JS);

  // cache-keys.js must load before data-store.js so CacheKeys.registerAll
  // can wire static keys + dynamic key families into the freshly-evaluated
  // DataStore on the same boot path the production index.html uses.
  evalFileCached(window, CACHE_KEYS_JS);

  evalFileCached(window, DATA_STORE_JS);

  // Bootstrap parity: in production bootstrap.js calls registerAll(DataStore)
  // after auth resolves; the harness skips bootstrap.js (its checkAuth side
  // effects collide with test setup), so register tags eagerly here.
  if (window.CacheKeys && typeof window.CacheKeys.registerAll === 'function') {
    window.CacheKeys.registerAll(window.DataStore);
  }

  const appSource = disableAutoBootstrap(readCached(APP_JS));
  evalWithSourceURL(window, appSource, APP_JS);

  // weight-unit-state.js owns the kg/lb preference state machine extracted
  // from app.js (Plan 2026-05-13, Task 2). Loaded immediately after app.js so
  // app.js's bind-time delegate calls (DOMContentLoaded handlers for the
  // segmented control, hydration in applyBootstrapPayload) find
  // window.WeightUnitState.
  evalFileCached(window, WEIGHT_UNIT_STATE_JS);

  // auth-bootstrap.js owns SettingsState + bootstrap hydration helpers
  // extracted from app.js (Plan 2026-05-13, Task 3). Loaded after
  // weight-unit-state.js because applyBootstrapPayload calls
  // WeightUnitState.applyAuthoritative; before feature modules that read
  // window.featureSettings at load time (e.g. tests asserting it's defined).
  evalFileCached(window, AUTH_BOOTSTRAP_JS);

  // Feature modules extracted from app.js (meds, food, bp, weight, health).
  evalFileCached(window, MEDS_JS);
  evalFileCached(window, FOOD_PHOTO_SUMMARY_JS);
  // Order matters: products.js defines decodeFoodDisplayText /
  // renderFoodAutocomplete which the other food sub-files reference; the
  // orchestrator (index.js) is loaded last because its bindFoodControls IIFE
  // wires handlers that live in those siblings.
  evalFileCached(window, FOOD_PRODUCTS_JS);
  evalFileCached(window, FOOD_SCANNER_JS);
  evalFileCached(window, FOOD_PHOTO_JS);
  evalFileCached(window, FOOD_LOG_JS);
  evalFileCached(window, FOOD_MEALS_JS);
  evalFileCached(window, FOOD_DB_JS);
  evalFileCached(window, FOOD_INDEX_JS);
  evalFileCached(window, BP_JS);
  evalFileCached(window, WEIGHT_JS);
  evalFileCached(window, HEALTH_JS);

  // auth-flow.js: provides saveAuthState / getCachedAuthState / clearAuthState.
  evalFileCached(window, AUTH_FLOW_JS);

  // modal-history.js must load BEFORE DOMContentLoaded fires so its internal
  // 'DOMContentLoaded' listener can call setupObserver() at the right time.
  // (JSDOM keeps readyState='loading' until its own lifecycle completes.)
  evalFileCached(window, MODAL_HISTORY_JS);

  // back-button.js must load before AppBackButton.setup() is called; it also
  // owns the Telegram BackButton onClick handler that modal-history relies on.
  evalFileCached(window, BACK_BUTTON_JS);

  // Fire DOMContentLoaded – triggers setupObserver() inside modal-history.js.
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  // Wire AppBackButton the way bootstrap.js does in production.
  if (window.AppBackButton && typeof window.AppBackButton.setup === 'function') {
    window.AppBackButton.setup();
  }

  // deeplink-router.js: provides handleDeepLinks() on window.
  // The Telegram start_param auto-run is harmless (initDataUnsafe={} in tests).
  evalFileCached(window, DEEPLINK_ROUTER_JS);

  if (withWorkout) {
    // Order matters: next-card.js defines getRotationSlot / _slotTagModifier
    // consumed by the renderer helpers in groups.js / history.js / library.js
    // / sessions.js. The orchestrator (index.js) is loaded last because its
    // `bindWorkoutControls` IIFE attaches click handlers that reference
    // functions declared in the other sub-files.
    evalFileCached(window, WORKOUT_NEXT_CARD_JS);
    evalFileCached(window, WORKOUT_GROUPS_JS);
    evalFileCached(window, WORKOUT_VARIANTS_JS);
    evalFileCached(window, WORKOUT_EXERCISES_JS);
    evalFileCached(window, WORKOUT_LIBRARY_JS);
    evalFileCached(window, WORKOUT_HISTORY_JS);
    evalFileCached(window, WORKOUT_MIBAND_JS);
    evalFileCached(window, WORKOUT_SESSIONS_JS);
    evalFileCached(window, WORKOUT_STATS_JS);
    evalFileCached(window, WORKOUT_INDEX_JS);
  }

  return {
    window,
    document: window.document,
    backButtonState,
    cleanup: () => dom.window.close()
  };
}
