// The apiCall shim: installs into the window.offlineAwareApiCall seam that
// web/static/js/core/api.js already delegates through (api.js:203), rerouting
// every BP/weight call site to the runtime-agnostic web/domain/ modules
// instead of the Go server. See docs/cloud-mode.md "C1 shim architecture".
import { createBPDomain } from '../../domain/bp.js';
import { createWeightDomain } from '../../domain/weight.js';
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

  // Feature flags enabling only the sections C1 ported (Today/BP/Weight/
  // Settings) — the bottom nav filters everything else before mount
  // (CLAUDE.md rule 6). Field names match internal/server/settings_handlers.go
  // getFeatureMap().
  const FEATURES = {
    food: false,
    bp: true,
    weight: true,
    medication: false,
    workout: false,
    health: false,
    gamification: false,
    weekly_digest: false,
  };

  // Mirrors handleBootstrap's shape (internal/server/settings_handlers.go)
  // closely enough for applyBootstrapPayload to hydrate the Today/BP/Weight
  // caches with real data — everything gated behind a disabled feature flag
  // above is simply omitted, which applyBootstrapPayload already treats as
  // "leave that cache alone".
  async function bootstrapPayload() {
    const [readings, goal, stats, logs, weightGoal, weightUnit] = await Promise.all([
      bp.list({ days: 60, limit: 0 }),
      bp.getGoal(),
      bp.getStats(),
      weight.list({ days: 35, limit: 0 }),
      weight.getGoal(),
      readWeightUnit(),
    ]);
    return {
      cursor: 0,
      needs_first_run: false,
      features: FEATURES,
      bp: { readings, goal, stats },
      weight: { logs, goal: weightGoal },
      settings: {
        food_targets: { calories: 0, carbs: 0, protein: 0, fat: 0 },
        bp_reminder_status: { enabled: false, preferred_reminder_hour: 20 },
        weight_reminder_status: { enabled: false, preferred_reminder_hour: 9 },
        timezone: timeZone,
        weight_unit_preference: weightUnit,
        dismissed_tz_suggestion: '',
      },
    };
  }

  // Stubs for boot-path endpoints the frontend calls unconditionally
  // regardless of which nav section is open (auth check, settings bundle).
  // Each one logs once at debug so gaps are discoverable without spamming
  // the console on every poll.
  const STUBS = {
    'GET /auth/status': () => ({ authenticated: true, method: 'cookie' }),
    'GET /api/bootstrap': bootstrapPayload,
    'GET /api/init': () => ({ features: FEATURES }),
    'GET /api/settings': async () => {
      const { settings, features } = await bootstrapPayload();
      return { ...settings, features };
    },
    'GET /api/settings/features': () => FEATURES,
    'GET /api/bp/reminder/status': () => ({ enabled: false, preferred_reminder_hour: 20 }),
    'GET /api/weight/reminder/status': () => ({ enabled: false, preferred_reminder_hour: 9 }),
    'GET /api/food/settings/targets': () => ({ calories: 0, carbs: 0, protein: 0, fat: 0 }),
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

    if (path === '/api/settings/weight-unit' && method === 'PATCH') {
      const unit = body && body.unit === 'lb' ? 'lb' : 'kg';
      await writeWeightUnit(unit);
      return { unit };
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
    // (apiCall catch → safeAlert). Every write the always-visible C1 Settings
    // surface can still reach an unmapped route from — the feature toggles
    // (POST /api/settings/features/*), the Test-BP button
    // (POST /api/bp/reminder/test), tab-order, journey targets — guards a falsy
    // result and reverts or no-ops honestly. So resolve null for writes to a
    // not-yet-wired route instead of alerting the user; reads keep throwing so
    // apiCall's offline/empty-state handling is unchanged.
    if (method !== 'GET') return null;
    throw apiError(404, `Not found: ${method} ${path}`);
  }

  targetWindow.offlineAwareApiCall = shimCall;
  return shimCall;
}
