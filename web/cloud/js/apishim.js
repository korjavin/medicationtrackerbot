// The apiCall shim: installs into the window.offlineAwareApiCall seam that
// web/static/js/core/api.js already delegates through (api.js:203), rerouting
// every BP/weight call site to the runtime-agnostic web/domain/ modules
// instead of the Go server. See docs/cloud-mode.md "C1 shim architecture".
import { createBPDomain } from '../../domain/bp.js';
import { createWeightDomain } from '../../domain/weight.js';
import { createNotesDomain } from '../../domain/notes.js';
import { createSettingsDomain } from '../../domain/settings.js';
import { createVitalsDomain } from '../../domain/vitals.js';
import { recordsPort } from './sync.js';

function parseQuery(endpoint) {
  const qIndex = endpoint.indexOf('?');
  const path = qIndex === -1 ? endpoint : endpoint.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? '' : endpoint.slice(qIndex + 1));
  return { path, params };
}

function intParam(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

// Mirrors apiCallDirect's error shape (Error with .status) so apiCall's
// catch/alert/return-null behavior matches the real network path exactly.
function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const loggedOnce = new Set();
function debugOnce(key, ...args) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console.debug(`[cloud shim] ${key}`, ...args);
}

// installApiShim wires the domain instances to window.offlineAwareApiCall.
// ctx is the sync engine context (accountId, dek, ...) that recordsPort/
// writeRecord already expect. Tests inject an in-memory records port via
// opts.records to exercise the shim without crypto/IndexedDB (see
// tests/helpers/cloud-shim-harness.js) — the port interface makes this a
// drop-in swap with zero shim logic changes. opts.win overrides the target
// window (the JSDOM window in tests); defaults to the global window in the
// browser where this module actually runs in production.
export function installApiShim(ctx, { records: recordsOverride, win } = {}) {
  const targetWindow = win || (typeof window !== 'undefined' ? window : undefined);
  const records = recordsOverride || recordsPort(ctx);
  const now = () => Date.now();
  const timeZone = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const bp = createBPDomain({ records, now, timeZone });
  const weight = createWeightDomain({ records, now, timeZone });
  const notes = createNotesDomain({ records, now });
  const settings = createSettingsDomain({ records, now, timeZone });
  const vitals = createVitalsDomain({ records, now, timeZone });

  // PORTED_SET: the feature domains this shim can actually serve end-to-end
  // (records + domain module + shim routes wired). Clamped onto every read
  // of the features map so a stored/toggled flag for an unported domain
  // (food/medication/workout/gamification/weekly_digest — C2b/c/d) can never
  // surface as enabled, per docs/cloud-mode.md "C2 shim architecture".
  const PORTED_SET = new Set(['bp', 'weight', 'health']);
  function clampFeatures(flags) {
    const out = {};
    for (const key of Object.keys(flags)) out[key] = PORTED_SET.has(key) ? !!flags[key] : false;
    return out;
  }

  // Weight-unit preference: a singleton record (fixed recordId, LWW on
  // clientTs) so the Settings kg/lb toggle — always present in the nav, not
  // feature-gated — persists across reloads instead of hitting the unmapped-
  // route 404 (which api.js turns into a user-facing "Error:" alert + revert).
  const UNIT_RECORD_TYPE = 'weightunitpref';
  async function readWeightUnit() {
    const rows = (await records.list(UNIT_RECORD_TYPE)).filter((r) => !r.deleted);
    const latest = rows.sort((a, b) => b.clientTs - a.clientTs)[0];
    return latest && latest.unit === 'lb' ? 'lb' : 'kg';
  }
  async function writeWeightUnit(unit) {
    await records.put(UNIT_RECORD_TYPE, { recordId: 'weight-unit', clientTs: now(), deleted: false, unit });
  }

  // Mirrors handleBootstrap's shape (internal/server/settings_handlers.go)
  // closely enough for applyBootstrapPayload to hydrate the Today/BP/Weight
  // caches with real data — everything gated behind a clamped-off feature
  // flag is simply omitted, which applyBootstrapPayload already treats as
  // "leave that cache alone".
  async function bootstrapPayload() {
    const [readings, goal, stats, logs, weightGoal, weightUnit, features, foodTargets, tabOrder] = await Promise.all([
      bp.list({ days: 60, limit: 0 }),
      bp.getGoal(),
      bp.getStats(),
      weight.list({ days: 35, limit: 0 }),
      weight.getGoal(),
      readWeightUnit(),
      settings.getFeatures(),
      settings.getFoodTargets(),
      settings.getTabOrder(),
    ]);
    const payload = {
      cursor: 0,
      needs_first_run: false,
      features: clampFeatures(features),
      bp: { readings, goal, stats },
      weight: { logs, goal: weightGoal },
      settings: {
        food_targets: foodTargets,
        bp_reminder_status: { enabled: false, preferred_reminder_hour: 20 },
        weight_reminder_status: { enabled: false, preferred_reminder_hour: 9 },
        timezone: timeZone,
        weight_unit_preference: weightUnit,
        dismissed_tz_suggestion: '',
      },
    };
    if (tabOrder) payload.settings.tab_order = tabOrder;
    return payload;
  }

  // Stubs for boot-path endpoints the frontend calls unconditionally
  // regardless of which nav section is open (auth check, settings bundle).
  // Each one logs once at debug so gaps are discoverable without spamming
  // the console on every poll.
  const STUBS = {
    'GET /auth/status': () => ({ authenticated: true, method: 'cookie' }),
    'GET /api/bootstrap': bootstrapPayload,
    'GET /api/init': async () => ({ features: clampFeatures(await settings.getFeatures()) }),
    'GET /api/settings': async () => {
      const { settings: settingsBlock, features } = await bootstrapPayload();
      return { ...settingsBlock, features };
    },
    'GET /api/bp/reminder/status': () => ({ enabled: false, preferred_reminder_hour: 20 }),
    'GET /api/weight/reminder/status': () => ({ enabled: false, preferred_reminder_hour: 9 }),
  };

  // shimCall implements the window.offlineAwareApiCall(endpoint, method, body,
  // opts) contract (see api.js apiCall/apiCallDirect): resolves to the parsed
  // JSON payload, or throws an Error with .status on failure. Writes resolve
  // as soon as the domain call (and its underlying writeRecord) returns —
  // writeRecord's oplog flush already happens inline, matching the current
  // optimistic local-first UX.
  async function shimCall(endpoint, method = 'GET', body = null, _opts = {}) {
    const { path, params } = parseQuery(endpoint);

    if (path === '/api/bp') {
      if (method === 'POST') return bp.create(body);
      if (method === 'GET') return bp.list({ days: intParam(params, 'days', 30), limit: intParam(params, 'limit', 100) });
    }
    if (method === 'DELETE') {
      const m = /^\/api\/bp\/([^/]+)$/.exec(path);
      if (m) { await bp.remove(m[1]); return true; }
    }
    if (path === '/api/bp/goal' && method === 'GET') return bp.getGoal();
    if (path === '/api/bp/stats' && method === 'GET') return bp.getStats();

    if (path === '/api/weight') {
      if (method === 'POST') return weight.create(body, { replacesId: params.get('replaces') || undefined });
      if (method === 'GET') return weight.list({ days: intParam(params, 'days', 30), limit: intParam(params, 'limit', 100) });
    }
    if (method === 'DELETE') {
      const m = /^\/api\/weight\/([^/]+)$/.exec(path);
      if (m) { await weight.remove(m[1]); return true; }
    }
    if (path === '/api/weight/goal' && method === 'GET') return weight.getGoal();

    if (path === '/api/notes') {
      if (method === 'POST') return notes.create(body);
      if (method === 'GET') {
        return notes.list({ limit: intParam(params, 'limit', 50), beforeId: params.get('before_id') || undefined });
      }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/notes\/([^/]+)$/.exec(path);
      if (m) { await notes.remove(m[1]); return true; }
    }

    if (path === '/api/settings/weight-unit' && method === 'PATCH') {
      const unit = body && body.unit === 'lb' ? 'lb' : 'kg';
      await writeWeightUnit(unit);
      return { unit };
    }

    if (path === '/api/settings' && method === 'POST') {
      await settings.setTimezone(body && body.timezone);
      return true;
    }

    if (path === '/api/settings/features' && method === 'GET') return clampFeatures(await settings.getFeatures());

    if (method === 'POST') {
      const m = /^\/api\/settings\/features\/([^/]+)$/.exec(path);
      if (m) {
        const enabled = !!(body && body.enabled);
        await settings.setFeature(m[1], enabled);
        return { enabled };
      }
    }

    if (path === '/api/settings/tab-order' && method === 'POST') {
      await settings.setTabOrder(body && body.order);
      return true;
    }

    if (path === '/api/food/settings/targets') {
      if (method === 'GET') return settings.getFoodTargets();
      if (method === 'POST') return settings.setFoodTargets(body);
    }

    if (path === '/api/settings/integrations') {
      if (method === 'GET') return settings.getIntegrations();
      if (method === 'PATCH') return settings.patchIntegrations(body);
    }

    if (path === '/api/health/overview' && method === 'GET') return vitals.overview();
    if (path === '/api/health/sleep' && method === 'GET') {
      return vitals.sleep({
        from: params.get('from') || undefined,
        to: params.get('to') || undefined,
        days: intParam(params, 'days', 90),
        limit: intParam(params, 'limit', 0),
      });
    }

    // Reminder toggles: BP/weight reminders aren't functionally scheduled in
    // cloud C1 (the push relay is blind), but the Reminders section in Settings
    // is always visible and not feature-gated. Echo success instead of falling
    // through to the unmapped-route 404, which api.js turns into a user-facing
    // "Error:" alert + toggle revert. The reminder status stubs still report
    // disabled, so the toggle resets on reload — honest for a not-yet-wired
    // feature, and no error surfaces.
    if ((path === '/api/bp/reminder/toggle' || path === '/api/weight/reminder/toggle') && method === 'POST') {
      return { enabled: !!(body && body.enabled) };
    }

    const stubKey = `${method} ${path}`;
    const stub = STUBS[stubKey];
    if (stub) {
      debugOnce(stubKey, 'stub response');
      return stub();
    }

    console.warn(`[cloud shim] unmapped route (C2 discovery): ${method} ${path}`);
    // A thrown non-GET is turned into a blocking "Error:" alert by api.js
    // (apiCall catch → safeAlert). Writes the always-visible Settings surface
    // can still reach an unmapped route from — the Test-BP button
    // (POST /api/bp/reminder/test), journey targets (unported, C2d) — guard a
    // falsy result and revert or no-op honestly. So resolve null for writes to
    // a not-yet-wired route instead of alerting the user; reads keep throwing
    // so apiCall's offline/empty-state handling is unchanged.
    if (method !== 'GET') return null;
    throw apiError(404, `Not found: ${method} ${path}`);
  }

  targetWindow.offlineAwareApiCall = shimCall;
  return shimCall;
}
