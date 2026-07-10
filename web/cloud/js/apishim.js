// The apiCall shim: installs into the window.offlineAwareApiCall seam that
// web/static/js/core/api.js already delegates through (api.js:203), rerouting
// every BP/weight call site to the runtime-agnostic web/domain/ modules
// instead of the Go server. See docs/cloud-mode.md "C1 shim architecture".
import { createBPDomain } from '../../domain/bp.js';
import { createWeightDomain } from '../../domain/weight.js';
import { createNotesDomain } from '../../domain/notes.js';
import { createSettingsDomain } from '../../domain/settings.js';
import { createVitalsDomain } from '../../domain/vitals.js';
import { createRemindersDomain } from '../../domain/reminders.js';
import { createMedicationsDomain } from '../../domain/medications.js';
import { createIntakeDomain } from '../../domain/medintake.js';
import { createTzPlanDomain } from '../../domain/tzplan.js';
import { createFoodDomain } from '../../domain/food.js';
import { createFoodAIDomain } from '../../domain/foodai.js';
import { createWorkoutDomain } from '../../domain/workout.js';
import { recordsPort } from './sync.js';
import { scheduleReminderRecompute, sendTestPush } from './reminders.js';
import { createRxnormPort } from './rxnorm.js';
import { createAIClient } from './aiclient.js';
import { createFoodDbClient } from './fooddb.js';
import { createElevenLabsClient } from './elevenlabs-signed-url.js';
import { createElevenLabsAgentProvisioner } from './elevenlabs-agent.js';
import { createDispatcher } from './mcp-responder.js';

// materializeTimerHandle is module-level (not per-shim-instance) because the
// production invariant is "one shim installed per page load"; re-installing
// (as every shim-mode test case does) simply clears and restarts the single
// sweep instead of stacking a new setInterval on top of the previous one.
const MATERIALIZE_INTERVAL_MS = 60_000;
let materializeTimerHandle;

// The only medication error code the UI branches on by HTTP status (meds.js's
// create/update flow shows a friendlier message for a 409 name+dosage clash);
// every other domain error surfaces via its .message through apiCallDirect's
// generic catch, so nothing else needs a status.
function withDuplicateStatus(err) {
  if (err && err.code === 'duplicate') err.status = 409;
  throw err;
}

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

// Some Go handlers guard their `days` parse with `err == nil && d > 0`, so a
// non-positive value falls back to the default window rather than being used
// (handleListSleepLogs, handleGetFoodLogs, handleGetFoodStats). Left to
// intParam, `days=0` would reach the domain module and yield an empty (or, for
// negative days, a future) window — silently no data where bot mode returns the
// default window. Others (bp, weight, intake history) deliberately let
// non-positive through to mean "unbounded"; those keep intParam.
function positiveIntParam(params, name, fallback) {
  const n = intParam(params, name, fallback);
  return n > 0 ? n : fallback;
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
  const reminders = createRemindersDomain({ records, now });
  const medications = createMedicationsDomain({
    records, now, timeZone, rxnorm: createRxnormPort(),
  });
  const intake = createIntakeDomain({ records, now, timeZone });
  const tzplan = createTzPlanDomain({ records, now, timeZone });
  const food = createFoodDomain({
    records, now, timeZone, foodDb: createFoodDbClient({ settingsDomain: settings }),
  });
  const foodAI = createFoodAIDomain({
    aiClient: createAIClient({ settingsDomain: settings }), foodDomain: food, now,
  });
  const workout = createWorkoutDomain({ records, now, timeZone });

  // Task 4's frontend bypass guards (photo.js/log.js/products.js — raw fetch
  // to the AI + search endpoints) call these directly, entirely outside the
  // shimCall route table below: the AI provider call and the food-DB search
  // both go straight from the browser, never through any /api surface.
  targetWindow.CloudFoodAI = foodAI;
  targetWindow.CloudFoodSearch = { search: food.search };
  // Voice: elevenlabs-call.js's fetchSignedURL() branches on
  // window.__MEDTRACKER_CLOUD__ to mint the signed URL browser-direct here
  // (BYO ElevenLabs key from the vault; never crosses /api).
  targetWindow.CloudElevenLabs = createElevenLabsClient({ settingsDomain: settings });
  // Auto-provisioning: creates the ElevenLabs client tools + a MedTracker agent
  // from code (browser-direct with the vault key) so the user configures only
  // the API key. elevenlabs-call.js calls provision() before minting the
  // signed URL. See web/cloud/js/elevenlabs-agent.js.
  targetWindow.CloudElevenLabsAgent = createElevenLabsAgentProvisioner({ settingsDomain: settings });
  // Voice MCP tools: elevenlabs-call.js registers mcp_help/mcp_call clientTools
  // (cloud only) that dispatch straight into this in-tab catalog — same
  // bp/weight/notes instances above, no relay/crypto (the relay responder in
  // mcp-responder.js only exists in the Claude-connector-elected tab and builds
  // its own instances, so this is the clean reuse seam).
  targetWindow.CloudMCPDispatcher = createDispatcher({ bp, weight, notes });

  // Due-dose materialization + tz-plan status refresh: neither domain module
  // owns a timer (Task 3/4's modules stay pure functions of their inputs), so
  // the shim runs both once on install and again every MATERIALIZE_INTERVAL_MS.
  async function runMaterializationSweep() {
    try {
      await intake.materializeDueDoses();
      await tzplan.refreshPlanStatus();
    } catch (e) {
      console.error('[cloud shim] materialization sweep failed', e);
    }
  }
  clearInterval(materializeTimerHandle);
  runMaterializationSweep();
  materializeTimerHandle = setInterval(runMaterializationSweep, MATERIALIZE_INTERVAL_MS);

  // PORTED_SET: the feature domains this shim can actually serve end-to-end
  // (records + domain module + shim routes wired). Clamped onto every read
  // of the features map so a stored/toggled flag for an unported domain
  // (food/workout/gamification/weekly_digest — C2c/d) can never surface as
  // enabled, per docs/cloud-mode.md "C2 shim architecture".
  const PORTED_SET = new Set(['bp', 'weight', 'health', 'medication', 'food', 'workout']);
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

  // settingsResponse builds the {settings, features} subset shared by
  // GET /api/settings and the bootstrap payload — the settings-only reads,
  // without the heavy bp/weight aggregate reads that /api/settings discards.
  async function settingsResponse() {
    const [weightUnit, features, foodTargets, tabOrder, general, bpStatus, weightStatus] = await Promise.all([
      readWeightUnit(),
      settings.getFeatures(),
      settings.getFoodTargets(),
      settings.getTabOrder(),
      settings.getGeneral(),
      reminders.getBPStatus(),
      reminders.getWeightStatus(),
    ]);
    const block = {
      food_targets: foodTargets,
      bp_reminder_status: bpStatus,
      weight_reminder_status: weightStatus,
      timezone: general.timezone,
      weight_unit_preference: weightUnit,
      dismissed_tz_suggestion: general.dismissed_tz_suggestion,
    };
    if (tabOrder) block.tab_order = tabOrder;
    return { settings: block, features: clampFeatures(features) };
  }

  // Mirrors handleBootstrap's shape (internal/server/settings_handlers.go)
  // closely enough for applyBootstrapPayload to hydrate the Today/BP/Weight
  // caches with real data — everything gated behind a clamped-off feature
  // flag is simply omitted, which applyBootstrapPayload already treats as
  // "leave that cache alone".
  async function bootstrapPayload() {
    const [readings, goal, stats, logs, weightGoal, settingsPart, firstRunComplete] = await Promise.all([
      bp.list({ days: 60, limit: 0 }),
      bp.getGoal(),
      bp.getStats(),
      weight.list({ days: 35, limit: 0 }),
      weight.getGoal(),
      settingsResponse(),
      settings.getFirstRunComplete(),
    ]);
    return {
      cursor: 0,
      // Read from the vault on every call, never cached: WGFirstRun's _mounted
      // latch is module state lost on reload, so only a fresh `false` here keeps
      // the overlay from re-opening on the next page load.
      needs_first_run: !firstRunComplete,
      features: settingsPart.features,
      bp: { readings, goal, stats },
      weight: { logs, goal: weightGoal },
      settings: settingsPart.settings,
    };
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
      const { settings: settingsBlock, features } = await settingsResponse();
      return { ...settingsBlock, features };
    },
    'GET /api/bp/reminder/status': async () => reminders.getBPStatus(),
    'GET /api/weight/reminder/status': async () => reminders.getWeightStatus(),
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
    if (path === '/api/weight/goal' && method === 'POST') return weight.setGoal(body);

    if (path === '/api/notes') {
      if (method === 'POST') return notes.create(body);
      if (method === 'GET') {
        return notes.list({
          days: intParam(params, 'days', undefined),
          limit: intParam(params, 'limit', 50),
          beforeId: params.get('before_id') || undefined,
        });
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
      // Mirrors handleUpdateSettings: a timezone change goes through the tz
      // transition planner (proposeTimezoneChange), not a bare setTimezone —
      // gradual-shift medications may need a plan staged instead of an
      // immediate write (Task 4).
      if (body && body.timezone) {
        const res = await tzplan.proposeTimezoneChange(body.timezone);
        scheduleReminderRecompute(ctx, { records, timeZone });
        // A medium/strict-policy med stages a PENDING_APPROVAL plan without
        // moving the clock. bootstrap.js already ran TZPlanBanner.refresh()
        // before this POST, so without a re-refresh the plan stays hidden
        // (no Telegram channel in cloud mode) and the stored tz still differs
        // → every boot re-prompts. Surface it now.
        if (res && res.planCreated && targetWindow && targetWindow.TZPlanBanner
            && typeof targetWindow.TZPlanBanner.refresh === 'function') {
          targetWindow.TZPlanBanner.refresh();
        }
      }
      return true;
    }

    if (path === '/api/settings/features' && method === 'GET') return clampFeatures(await settings.getFeatures());

    if (method === 'POST') {
      const m = /^\/api\/settings\/features\/([^/]+)$/.exec(path);
      if (m) {
        const feature = m[1];
        const enabled = !!(body && body.enabled);
        // The UI (settings.js toggleFeatureSetting) applies the *requested*
        // value optimistically and feeds it straight into nav filtering, so
        // reporting success for an unported feature would surface a tab whose
        // routes this shim can't serve until the next reload re-clamps it off.
        // Reject an unported enable *before* persisting: otherwise setFeature
        // would push `true` to the encrypted vault + every device, the UI would
        // revert only its DOM toggle, and a later phase adding the feature to
        // PORTED_SET would silently auto-enable it. GET/bootstrap clamp reads.
        if (enabled && !PORTED_SET.has(feature)) return null;
        await settings.setFeature(feature, enabled);
        return { enabled };
      }
    }

    if (path === '/api/firstrun/complete' && method === 'POST') {
      await settings.setFirstRunComplete(true);
      return { success: true };
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
        days: positiveIntParam(params, 'days', 90),
        limit: intParam(params, 'limit', 0),
      });
    }

    // --- Medications + intake state machine (Task 7: C2b shim wiring) ---
    if (path === '/api/medications') {
      if (method === 'GET') return medications.list({ archived: params.get('archived') === 'true' });
      if (method === 'POST') {
        const res = await medications.create(body).catch(withDuplicateStatus);
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    if (path === '/api/medications/next-intake' && method === 'GET') return intake.nextIntake();
    if (path === '/api/inventory/low' && method === 'GET') return medications.listLowStock();
    if (path === '/api/history' && method === 'GET') {
      return intake.history({ days: intParam(params, 'days', 3), medId: intParam(params, 'med_id', 0) });
    }
    if (method === 'POST') {
      // Literal action paths under /api/medications/ — checked before the
      // {id} regexes below so an action name is never mistaken for an id.
      const intakeActions = {
        '/api/medications/trigger-next-intake': () => intake.triggerNextIntake(),
        '/api/medications/log-past': () => intake.logPast(body && body.medication_id, Date.parse(body && body.taken_at)),
        '/api/medications/cancel-intake': () => intake.cancelIntakes((body && body.intake_ids) || []),
        '/api/medications/delete-intake': () => intake.deleteFutureIntakes((body && body.intake_ids) || []),
        '/api/medications/snooze': () => intake.snooze(body && body.intake_id, body && body.duration_minutes),
        '/api/medications/skip': () => intake.skip(body && body.intake_id),
        '/api/medications/confirm-schedule': () => intake.confirmSchedule({
          scheduledAt: body && body.scheduled_at,
          medicationIds: (body && body.medication_ids) || [],
          intakeIds: (body && body.intake_ids) || [],
        }),
      };
      const action = intakeActions[path];
      if (action) {
        const res = await action();
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    if (path === '/api/intakes/update' && method === 'POST') {
      const res = await intake.updateIntakes((body && body.updates) || []);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
    }
    if (method === 'POST') {
      const m = /^\/api\/medications\/([^/]+)\/restock$/.exec(path);
      if (m) {
        const res = await medications.restock(Number(m[1]), body && body.quantity, body && body.note);
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    if (method === 'GET') {
      const m = /^\/api\/medications\/([^/]+)\/restocks$/.exec(path);
      if (m) return medications.listRestocks(Number(m[1]));
    }
    if (method === 'POST') {
      const m = /^\/api\/medications\/([^/]+)$/.exec(path);
      if (m) {
        const res = await medications.update(Number(m[1]), body).catch(withDuplicateStatus);
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/medications\/([^/]+)$/.exec(path);
      if (m) { await medications.remove(Number(m[1])); return true; }
    }

    // --- TZ transition plan + suggestion (Task 7) ---
    if (path === '/api/tz-plan/current' && method === 'GET') return tzplan.getCurrentPlan();
    if (method === 'POST') {
      const m = /^\/api\/tz-plan\/[^/]+\/(approve|reject)$/.exec(path);
      if (m) {
        const res = m[1] === 'approve' ? await tzplan.approvePlan() : await tzplan.rejectPlan();
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    if (path === '/api/tz-suggestion/dismiss' && method === 'POST') return tzplan.recordDismissal(body && body.detected_tz);

    // --- Food logs + products (Task 2: C2c shim wiring). The NDJSON search
    // route (food_handlers.go handleSearchFoodProducts) has no apiCall-shaped
    // caller — products.js streams it via raw fetch, guarded separately
    // (Task 4) — so it is intentionally not routed here.
    if (path === '/api/food/log') {
      if (method === 'POST') return food.create(body);
      if (method === 'GET') {
        return food.listGrouped({ date: params.get('date') || undefined, days: positiveIntParam(params, 'days', 1) });
      }
    }
    if (method === 'PUT') {
      const m = /^\/api\/food\/log\/([^/]+)$/.exec(path);
      if (m) return food.update(m[1], body);
    }
    if (method === 'DELETE') {
      const m = /^\/api\/food\/log\/([^/]+)$/.exec(path);
      if (m) { await food.remove(m[1]); return true; }
    }
    if (path === '/api/food/stats' && method === 'GET') {
      return food.stats({ date: params.get('date') || undefined, days: positiveIntParam(params, 'days', 7) });
    }
    if (path === '/api/food/products/from-logs' && method === 'POST') {
      return food.createMealFromLogs(body && body.name, (body && body.log_ids) || []);
    }
    if (path === '/api/food/products' && method === 'GET') {
      const isMealParam = params.get('is_meal');
      return food.listProducts({
        isMeal: isMealParam ? isMealParam === 'true' : undefined,
        q: params.get('q') || undefined,
        offset: intParam(params, 'offset', 0),
        limit: intParam(params, 'limit', 100),
        sort: params.get('sort') || undefined,
      });
    }
    if (method === 'PUT') {
      const m = /^\/api\/food\/products\/([^/]+)$/.exec(path);
      if (m) return food.updateProduct(m[1], body);
    }
    if (method === 'DELETE') {
      const m = /^\/api\/food\/products\/([^/]+)$/.exec(path);
      if (m) { await food.removeProduct(m[1]); return true; }
    }

    // --- Workouts: groups/variants/exercises/library CRUD, next-workout +
    // rotation engine, session lifecycle, exercise logs, stats, mi-band
    // (Task 6: C2d shim wiring). Unlike bp/weight/food, the CRUD routes use
    // separate /create, /update, /delete literal paths with a query-param
    // `?id=` (workout_crud_handlers.go's style), not a combined GET+POST
    // base path. Intentionally NOT routed (no apiCall-shaped frontend
    // caller — MCP/bot-only, per the plan): rotation/state,
    // rotation/initialize, exercises/unique, sessions/schedule, the legacy
    // session/snooze + session/skip compat routes, and the external Mi
    // Notify webhook — these fall through to the unmapped-route warning.
    if (path === '/api/workout/groups' && method === 'GET') return workout.listGroups();
    if (path === '/api/workout/groups/create' && method === 'POST') return workout.createGroup(body);
    if (path === '/api/workout/groups/update' && method === 'PUT') {
      await workout.updateGroup(intParam(params, 'id', 0), body);
      return true;
    }
    if (path === '/api/workout/groups/delete' && method === 'DELETE') {
      await workout.deleteGroup(intParam(params, 'id', 0));
      return true;
    }

    if (path === '/api/workout/variants' && method === 'GET') {
      return workout.listVariants(intParam(params, 'group_id', 0));
    }
    if (path === '/api/workout/variants/create' && method === 'POST') return workout.createVariant(body);
    if (path === '/api/workout/variants/update' && method === 'PUT') {
      await workout.updateVariant(intParam(params, 'id', 0), body);
      return true;
    }
    if (path === '/api/workout/variants/delete' && method === 'DELETE') {
      await workout.deleteVariant(intParam(params, 'id', 0));
      return true;
    }

    if (path === '/api/workout/exercises' && method === 'GET') {
      return workout.listExercises(intParam(params, 'variant_id', 0));
    }
    if (path === '/api/workout/exercises/create' && method === 'POST') return workout.createExercise(body);
    if (path === '/api/workout/exercises/update' && method === 'PUT') {
      await workout.updateExercise(intParam(params, 'id', 0), body);
      return true;
    }
    if (path === '/api/workout/exercises/delete' && method === 'DELETE') {
      await workout.deleteExercise(intParam(params, 'id', 0));
      return true;
    }

    if (path === '/api/workout/exercise-library' && method === 'GET') return workout.listLibrary();
    if (path === '/api/workout/exercise-library/create' && method === 'POST') {
      return workout.createLibraryItem(body);
    }
    if (path === '/api/workout/exercise-library/update' && method === 'PUT') {
      await workout.updateLibraryItem(intParam(params, 'id', 0), body);
      return true;
    }
    if (path === '/api/workout/exercise-library/delete' && method === 'DELETE') {
      await workout.deleteLibraryItem(intParam(params, 'id', 0));
      return true;
    }

    if (path === '/api/workout/sessions' && method === 'GET') {
      return workout.listSessions(intParam(params, 'limit', 30));
    }
    if (path === '/api/workout/sessions/next' && method === 'GET') return workout.getNext();
    if (path === '/api/workout/sessions/details' && method === 'GET') {
      return workout.getSessionDetails(intParam(params, 'id', 0));
    }
    if (path === '/api/workout/sessions/delete' && method === 'DELETE') {
      await workout.deleteSession(intParam(params, 'id', 0));
      return true;
    }
    if (path === '/api/workout/sessions/status' && method === 'PUT') {
      return workout.setSessionStatus(intParam(params, 'id', 0), body && body.status);
    }
    if (path === '/api/workout/sessions/adhoc' && method === 'POST') {
      const session = await workout.createAdHocSession();
      return { session, group_name: 'Ad-hoc Workout', variant_name: '' };
    }
    if (method === 'POST') {
      const m = /^\/api\/workout\/sessions\/([^/]+)\/(start|snooze|skip|preskip|cancel-preskip|next-variant)$/.exec(path);
      if (m) {
        const id = Number(m[1]);
        const action = m[2];
        if (action === 'start') await workout.startSession(id);
        else if (action === 'snooze') await workout.snoozeSession(id, body && body.minutes);
        else if (action === 'skip') await workout.skipSession(id);
        else if (action === 'preskip') await workout.preSkipSession(id);
        else if (action === 'cancel-preskip') await workout.cancelPreSkipSession(id);
        else await workout.nextVariant(id);
        return true;
      }
    }

    if (path === '/api/workout/sessions/logs/create' && method === 'POST') return workout.createLog(body);
    if (path === '/api/workout/sessions/logs/update' && method === 'POST') {
      await workout.updateLog(body && body.id, body);
      return true;
    }
    if (path === '/api/workout/sessions/logs/delete' && method === 'DELETE') {
      await workout.deleteLog(intParam(params, 'id', 0));
      return true;
    }

    if (path === '/api/workout/stats' && method === 'GET') return workout.getStats();

    if (path === '/api/workout/miband' && method === 'GET') {
      return workout.listMiBand(intParam(params, 'limit', 100));
    }
    if (method === 'PATCH') {
      const m = /^\/api\/workout\/miband\/([^/]+)$/.exec(path);
      if (m) { await workout.updateMiBand(Number(m[1]), body); return true; }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/workout\/miband\/([^/]+)$/.exec(path);
      if (m) { await workout.deleteMiBand(Number(m[1])); return true; }
    }

    if (path === '/api/bp/reminder/toggle' && method === 'POST') {
      const status = await reminders.setBPEnabled(!!(body && body.enabled));
      scheduleReminderRecompute(ctx, { records, timeZone });
      return status;
    }
    if (path === '/api/weight/reminder/toggle' && method === 'POST') {
      const status = await reminders.setWeightEnabled(!!(body && body.enabled));
      scheduleReminderRecompute(ctx, { records, timeZone });
      return status;
    }

    // Snooze (2h) / don't-bug (24h) mute the schedule without touching the
    // enable flag, mirroring bp_handlers.go + weight_handlers.go. In cloud mode
    // the horizon is precomputed and already sitting in the relay's queue, so
    // the mute only takes effect once a horizon omitting the muted targets is
    // re-uploaded. That re-upload is fired undebounced but NOT awaited: the mute
    // is already durable in the vault, and a snooze tapped on a flaky connection
    // must still succeed — the next unlock re-uploads the horizon anyway.
    // Response bodies match bot mode so shared callers can't tell them apart.
    if (method === 'POST') {
      const reminderActions = {
        '/api/bp/reminder/snooze': [reminders.snoozeBPReminder, 'BP reminder snoozed for 2 hours'],
        '/api/bp/reminder/dontbug': [reminders.dontBugBPReminder, 'BP reminders disabled for 24 hours'],
        '/api/weight/reminder/snooze': [reminders.snoozeWeightReminder, 'Weight reminder snoozed for 2 hours'],
        '/api/weight/reminder/dontbug': [reminders.dontBugWeightReminder, 'Weight reminders disabled for 24 hours'],
      };
      const action = reminderActions[path];
      if (action) {
        const [mutate, message] = action;
        await mutate();
        scheduleReminderRecompute(ctx, { records, timeZone }, 0);
        return { status: 'success', message };
      }
    }

    // Bot mode fans a BP test card out through every notifier; cloud has no
    // server-side notifier and no way to compose a payload it can read, so the
    // honest equivalent is the encrypted this-device-only push the Settings
    // test button already uses.
    if (path === '/api/bp/reminder/test' && method === 'POST') {
      await sendTestPush(ctx);
      return { status: 'sent' };
    }

    // Medication reminders are functionally wired in cloud mode (Task 5): the
    // toggle actually gates whether computeReminderHorizon's med portion gets
    // uploaded to the blind push relay, unlike the bp/weight stubs above.
    if (path === '/api/medication/reminder/status' && method === 'GET') return reminders.getStatus();
    if (path === '/api/medication/reminder/toggle' && method === 'POST') {
      const status = await reminders.setEnabled(!!(body && body.enabled));
      scheduleReminderRecompute(ctx, { records, timeZone });
      return status;
    }

    const stubKey = `${method} ${path}`;
    const stub = STUBS[stubKey];
    if (stub) {
      debugOnce(stubKey, 'stub response');
      return stub();
    }

    console.warn(`[cloud shim] unmapped route (C2 discovery): ${method} ${path}`);
    // Unmapped writes throw like unmapped reads. Resolving null here used to
    // make every unshimmed write (Test-BP, journey targets) look like it
    // succeeded while doing nothing; a thrown error routes into the caller's
    // existing failure path (api.js apiCall → safeAlert / toast) instead.
    throw apiError(404, `Not found: ${method} ${path}`);
  }

  targetWindow.offlineAwareApiCall = shimCall;
  return shimCall;
}
