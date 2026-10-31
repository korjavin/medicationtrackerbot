// The apiCall shim: installs into the window.offlineAwareApiCall seam that
// web/static/js/core/api.js already delegates through (api.js:203), rerouting
// every BP/weight call site to the runtime-agnostic web/domain/ modules
// instead of the Go server. See docs/cloud-mode.md "C1 shim architecture".
import { createBPDomain } from '../../domain/bp.js';
import { createWeightDomain } from '../../domain/weight.js';
import { createNotesDomain } from '../../domain/notes.js';
import { createSettingsDomain } from '../../domain/settings.js';
import { createVitalsDomain } from '../../domain/vitals.js';
import { createRemindersDomain, measureReminderStem } from '../../domain/reminders.js';
import { createMedicationsDomain } from '../../domain/medications.js';
import { createIntakeDomain, dosesAtInstant } from '../../domain/medintake.js';
import { createTzPlanDomain } from '../../domain/tzplan.js';
import { createFoodDomain } from '../../domain/food.js';
import { createFoodAIDomain } from '../../domain/foodai.js';
import { createExerciseTagDomain } from '../../domain/exercisetag.js';
import { createWorkoutSheetAIDomain } from '../../domain/workoutsheet.js';
import { createWorkoutShareDomain } from '../../domain/workout-share.js';
import { createWorkoutDomain } from '../../domain/workout.js';
import { createEquipmentDomain } from '../../domain/equipment.js';
import { createTrackersDomain } from '../../domain/trackers.js';
import { createGamificationDomain } from '../../domain/gamification.js';
import { createAnalysis } from '../../domain/analysis.js';
import { createBriefDomain } from '../../domain/brief.js';
import {
  MAX_LIMIT, clampLimit, clampDays, clampOffset, pageOf,
} from '../../domain/paginate.js';
import { USER_CONTENT_TYPES, userContentCount } from '../../domain/vault.js';
import { createGamificationNarrator } from './gamification-narrator.js';
import {
  recordsPort, getRecordsChangeCount, ORIGIN_UI, ORIGIN_EXTERNAL, deviceValues, hasCaughtUp, notifyRecordsChanged,
  pulledThisSession,
} from './sync.js';
import * as cloudReminders from './reminders.js';
import { createRxnormPort } from './rxnorm.js';
import { createAIClient } from './aiclient.js';
import { createFoodDbClient } from './fooddb.js';
import { createElevenLabsClient } from './elevenlabs-signed-url.js';
import { createElevenLabsAgentProvisioner } from './elevenlabs-agent.js';
import { createDispatcher } from './mcp-responder.js';
import { createVoiceLLMResponder } from './voice-llm-responder.js';
import { registerEgressHosts } from './egress-hosts.js';
import { materializing, materializationSettled, withMaterializationStopped } from './materialize-gate.js';

// Re-exported for the store replacers (cloud-boot.js, local-policy.js) and the
// tests; the guard itself is materialize-gate.js (bd med-o7zq.41).
export { materializationSettled, withMaterializationStopped };

// Clock-driven dose refresh (Archie 4934 point 3). Ledger v2 writes nothing
// when a dose comes due, so nothing would repaint a screen left open across
// it (Today's missed list, the Meds tab). Every projection names its next
// boundary (the earliest upcoming plannedAt, or a snooze's end) through the
// intake domain's onBoundary port; one timer per page fires there and
// invalidates the intake-derived caches exactly as an external intake write
// would, so every mounted surface re-reads. Module-level like the old sweep's
// handle: one shim per page load, a re-install re-arms the single timer.
// ponytail: setTimeout caps near 24.8 days; a longer wait fires early, and the
// re-read it causes simply re-arms.
const MAX_TIMER_MS = 2 ** 31 - 1;
let doseClock = { at: Infinity, handle: null, timers: null };
function armDoseClock(atMs, nowMs, timers, win) {
  if (!(atMs > nowMs)) return;
  if (doseClock.handle !== null && doseClock.at > nowMs && doseClock.at <= atMs) return;
  if (doseClock.handle !== null) doseClock.timers.clearTimeout(doseClock.handle);
  const handle = timers.setTimeout(() => {
    doseClock = { at: Infinity, handle: null, timers: null };
    notifyRecordsChanged(['intake'], ORIGIN_EXTERNAL, win);
  },Math.min(atMs - nowMs + 1, MAX_TIMER_MS));
  doseClock = { at: atMs, handle, timers };
}
// Test teardown: no dose timer outlives its suite (cf. bd med-tc1.3).
export function stopDoseClock() {
  if (doseClock.handle !== null) doseClock.timers.clearTimeout(doseClock.handle);
  doseClock = { at: Infinity, handle: null, timers: null };
}

// The only medication error code the UI branches on by HTTP status (meds.js's
// create/update flow shows a friendlier message for a 409 name+dosage clash);
// every other domain error surfaces via its .message through apiCallDirect's
// generic catch, so nothing else needs a status.
function withDuplicateStatus(err) {
  if (err && err.code === 'duplicate') err.status = 409;
  if (err && (err.code === 'invalid_count' || err.code === 'invalid_quantity')) err.status = 400;
  if (err && err.code === 'not_found') err.status = 404;
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

// pageParams is the bounded read of `limit`/`offset` for every list route
// (med-vgw). This router is the boundary the clamp belongs at: the cloud UI and
// mcp-responder.js both dispatch through it, while the domain list functions
// keep `limit <= 0 → everything` for their internal callers, which need whole
// windows to compute correct aggregates. web/domain/paginate.js has the full
// reasoning.
//
// `take` is `offset + limit`, i.e. what to ask the domain for so the page can
// be sliced out of it — the list functions cap from the top of an ordered list
// and have no offset of their own.
function pageParams(params, def, max) {
  const limit = clampLimit(params.get('limit'), def, max);
  const offset = clampOffset(params.get('offset'));
  return { limit, offset, take: offset + limit };
}

// Mirrors apiCallDirect's error shape (Error with .status) so apiCall's
// catch/alert/return-null behavior matches the real network path exactly.
function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// workoutReminderStem rebuilds the Telegram callback stem the reminder horizon
// put on this session's recurring reminder, so an in-app transition can end that
// chain (med-r3dm). It MUST match web/domain/reminders.js exactly:
// `w:<groupId>:<YYYYMMDD>` where the date is the scheduled_date prefix — that
// prefix IS the local calendar day (scheduledDateRFC), so read it as a string;
// going through UTC parts shifts the day in positive-offset zones.
//
// Returns '' when there is no chain to cancel: an ad-hoc session (group_id -1)
// carries no callback stem at all, since (groupId, date) isn't unique for it.
function workoutReminderStem(session) {
  if (!session || !(session.group_id > 0)) return '';
  const p = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(session.scheduled_date));
  return p ? `w:${session.group_id}:${p[1]}${p[2]}${p[3]}` : '';
}

const loggedOnce = new Set();
function debugOnce(key, ...args) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  console.debug(`[cloud shim] ${key}`, ...args);
}

// createApiRouter builds the domain instances and the method+path router over
// them, and assigns nothing — the MCP responder dispatches catalog ops through
// the same router the UI calls, so there is exactly one place that maps an HTTP
// route onto a web/domain/ module (med-csu.3). ctx is the sync engine context
// (accountId, kData, kMac) that recordsPort/writeRecord already expect. Tests
// inject an in-memory records port via opts.records to exercise the router
// without crypto/IndexedDB (see tests/helpers/cloud-shim-harness.js) — the port
// interface makes this a drop-in swap with zero router logic changes. opts.win
// is read-only here (the TZPlanBanner nudge below) and may be omitted entirely,
// which is what lets the MCP coverage sweep drive the router headlessly.
//
// The domain instances are hung off the returned function as `.domains` because
// installApiShim needs the very same instances for its window globals.
// The domain factories are pure over their injected ports (no module state), so
// installApiShim can safely build a SECOND router for the non-UI writers — which
// is exactly how each write's origin is known without threading a parameter
// through the domain layer.
//
// opts.origin labels every write this router makes (med-dvr). Default: external,
// so a new caller repaints. Only the UI passes ORIGIN_UI, to suppress the
// "New data is available" banner for the user's own action.
// opts.now/opts.timeZone override the clock the domain instances read, which is
// what lets a test drive the router across a date boundary deterministically.
// opts.via names the channel for intake merge ranking (bd med-wi09.11):
// 'mcp' for the MCP responder, 'telegram' for the chat agent; default app.
// opts.timeZone stands in for the DEVICE zone specifically: a settings.timezone
// the user pinned in Settings still wins over it (bd med-7ujt).
//
// Local-only mode (bd med-o7zq.2, web/cloud/js/local-boot.js) swaps the two
// things that assume an account, without touching the route table:
//   opts.recordsPort(origin) builds the per-origin records port in place of
//                 sync.js's recordsPort(ctx, origin) — the real durable store
//                 (localRecordsPort), so the gamification memo stays valid.
//   opts.effects  overrides the reminder relay side effects
//                 (scheduleReminderRecompute, sendTestPush, cancelMedRefire,
//                 cancelReminderRefire); omitted keys keep the cloud ones.
//   opts.rxnorm   the drug-name lookup port; null turns it off (the domain's
//                 no-op), which local mode does: the RxNav proxy is the
//                 operator's (bd med-o7zq.3, local-policy.js).
//   opts.operatorFoodDb  fooddb.js's operator food-DB port; omitted keeps the
//                 cloud's same-origin one (local mode: LOCAL_FOOD_DB, bd
//                 med-o7zq.20).
//   opts.protection  the W4 nudge's local half (local-policy.js
//                 LOCAL_PROTECTION, bd med-ta2n.4); omitted = never nudge.
//   opts.caughtUp async () => bool: has the mirror pulled the account yet?
//                 Until it has, /api/bootstrap omits needs_first_run,
//                 so W1 never runs on an empty mirror of an existing account
//                 (bd med-ejgf). Defaults to sync.js hasCaughtUp on the real
//                 sync store; any injected store (local mode, tests) has
//                 nothing to pull and is always caught up. cloud-boot.js
//                 passes its own through installApiShim: caught up AND the
//                 local → cloud move pickup settled (bd med-ydt2).
//   opts.onDoseBoundary(atMs)  the intake domain's onBoundary port; only the
//                 page's shim passes one (installApiShim's dose clock).
//   opts.canFloor async () => bool: may this router floor the account zone
//                 now (bd med-wi09.19)? Default on the real sync store:
//                 opts.caughtUp (so the local → cloud move pickup window
//                 blocks it too) AND a pull in THIS page load reached the tail
//                 (sync.js pulledThisSession), so an offline boot never floors
//                 against a stale mirror. An injected store defaults to opts.caughtUp;
//                 the inbox applier passes () => false. Local mode never floors.
export function createApiRouter(ctx, {
  records: recordsOverride, recordsPort: portFactory, effects, win, now: nowOverride, timeZone: timeZoneOverride, origin, via,
  rxnorm = createRxnormPort(), operatorFoodDb, protection, documentPolicy,
  caughtUp = (recordsOverride || portFactory) ? async () => true : hasCaughtUp, onDoseBoundary,
  canFloor = recordsOverride ? caughtUp : async () => (await caughtUp()) && pulledThisSession(),
} = {}) {
  const targetWindow = win || (typeof window !== 'undefined' ? window : undefined);
  const records = recordsOverride || (portFactory ? portFactory(origin) : recordsPort(ctx, origin));
  const reminderEffects = { ...cloudReminders, ...effects };
  const { sendTestPush, cancelMedRefire, cancelReminderRefire, rearmMedRefire } = reminderEffects;
  // Only the user's own writes may ask for notification permission (bd
  // med-ckm5.4): an agent's or the inbox drain's write must not open a sheet,
  // least of all right after launch.
  const scheduleReminderRecompute = origin === ORIGIN_UI
    ? (c, opts, debounceMs) => reminderEffects.scheduleReminderRecompute(c, { ...opts, askPermission: true }, debounceMs)
    : reminderEffects.scheduleReminderRecompute;
  // Gamification read-path memo signal (med-90w.2). Only valid when the real
  // sync-backed port is in use — a test recordsOverride is a fake NOT tracked by
  // getRecordsChangeCount, so pass null there to keep those reads always-fresh.
  const recordsChangeCount = recordsOverride ? null : getRecordsChangeCount;
  const now = nowOverride || (() => Date.now());
  // The DEVICE zone — only a fallback. A manually pinned settings.timezone (a
  // vault record, so only readable asynchronously) wins over it everywhere this
  // router does wall-clock math; see ensureTimeZone below (bd med-7ujt).
  const deviceTimeZone = timeZoneOverride
    || (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  // `let`, not `const`: every route handler below and every domain instance
  // reads through these bindings, so reassigning them in buildDomains() is what
  // makes the resolved zone reach the whole router without touching a single
  // domain module's signature (they all take timeZone as a captured string).
  // The relay's hourly re-fire chain for a dose slot (ReplaceSchedule keeps
  // it) after an app write: stopped once nothing in the slot is still due — a
  // snoozed dose is not due (bd med-4j49), its snooze-end reminder restarts
  // the chain naming every open dose of the slot. narrow (a snooze that left
  // slot-mates due): the pending re-fire keeps its time but names only them.
  async function reconcileMedChain(slotMs, narrow) {
    const due = (await intake.occurrences({ fromMs: slotMs, toMs: slotMs })).filter((r) => r.state === 'due');
    if (!due.length) cancelMedRefire(slotMs);
    else if (narrow) rearmMedRefire(slotMs, due.map((r) => r.medId), { keepFireAt: true });
  }
  let timeZone = deviceTimeZone;
  let bp; let weight; let notes; let settings; let vitals; let reminders;
  let medications; let intake; let tzplan; let foodDb; let food; let aiClient; let exerciseTag; let equipment; let trackers;
  let foodAI; let workout; let workoutSheetAI; let workoutShare; let gamification; let narrator; let analysis; let brief;
  function buildDomains(tz) {
    timeZone = tz;
    bp = createBPDomain({ records, now, timeZone });
    weight = createWeightDomain({ records, now, timeZone });
    notes = createNotesDomain({ records, now });
    // deviceTimeZone, NOT the resolved one: this domain's only use of the zone
    // is getGeneral()'s fallback for "no timezone pinned", which must stay the
    // device's — feeding it the resolved zone would make a later un-pinning
    // resolve to the old pin forever, and would make ensureTimeZone's
    // comparison below tautological.
    settings = createSettingsDomain({ records, now, timeZone: deviceTimeZone });
    vitals = createVitalsDomain({ records, now, timeZone });
    reminders = createRemindersDomain({ records, now });
    medications = createMedicationsDomain({
      records, now, timeZone, rxnorm,
    });
    intake = createIntakeDomain({ records, now, timeZone, via, onBoundary: onDoseBoundary });
    tzplan = createTzPlanDomain({ records, now, timeZone });
    foodDb = createFoodDbClient({ settingsDomain: settings, operatorFoodDb });
    food = createFoodDomain({
      records, now, timeZone, foodDb,
    });
    // One aiClient (reads the vault's unmasked openai record) shared by food AI
    // and the gamification narrator. With a BYO key both send device → the user's
    // own provider, never through /api; with NO key both fall back to the
    // operator-proxied trial path (POST /api/trial/openai), gated on an explicit
    // consent scope — `ai` for food, `tg` for the narrator. See
    // docs/cloud-mode.md → Privacy boundary (bd med-eas.80).
    aiClient = createAIClient({ settingsDomain: settings, deviceStore: deviceValues, documentPolicy });
    foodAI = createFoodAIDomain({ aiClient, foodDomain: food, now });
    workout = createWorkoutDomain({ records, now, timeZone });
    equipment = createEquipmentDomain({ records, now });
    trackers = createTrackersDomain({ records, now, timeZone });
    // LLM body-part tagging for exercise names the static catalog cannot
    // classify (custom / non-English names). Names only; `ai` consent scope.
    exerciseTag = createExerciseTagDomain({ aiClient, workoutDomain: workout });
    // Printed-sheet scan-back (bd med-qj4.9): the sheet photo plus the plan it
    // was printed from go to the vision provider; only parsed numbers land in
    // the vault, via the workout domain's own session writes. Same `ai`
    // consent scope as food photos.
    workoutSheetAI = createWorkoutSheetAIDomain({ aiClient, workoutDomain: workout, now });
    workoutShare = createWorkoutShareDomain({ workoutDomain: workout, equipmentDomain: equipment });
    gamification = createGamificationDomain({
      records, now, timeZone, getRecordsChangeCount: recordsChangeCount,
    });
    // Phase 6 AI narration layer — prose OVER the deterministic engine. Gets the
    // computed stats-JSON only (assembled below from the domain read-models) and
    // returns prose; any no-key/error path returns { text: null } so every
    // narrate route degrades to the deterministic card journey.js already shows.
    narrator = createGamificationNarrator({ aiClient });
    // Composite health analyses (analyze_cardiovascular / analyze_fitness) —
    // pure aggregation over the domains built above, served as cloud-only MCP
    // ops (docs/plans/20260717-cloud-analysis-pathb.md).
    analysis = createAnalysis({
      bp, vitals, medications, intake, food, weight, workout, notes, now, timeZone,
    });
    // Doctor-visit brief (med-5k6t.1) — a printable summary folded from the
    // domains above, nothing of its own. Rebuilt here so it follows the
    // resolved zone like they do.
    brief = createBriefDomain({
      bp, weight, vitals, notes, medications, intake, food, workout, trackers, settings, now,
    });
  }
  buildDomains(deviceTimeZone);

  // ensureTimeZone reads the pinned settings.timezone and rebuilds the domains
  // on it when it differs from the device zone. getGeneral() already falls back
  // to the injected zone when the record carries none, so an account that never
  // pinned a zone resolves to deviceTimeZone and nothing is rebuilt.
  //
  // Memoized against the records-change counter, NOT once-only: cloud-boot.js
  // installs the shim BEFORE
  // pullOnOpen has landed this account's records, so a once-only memo would pin
  // a freshly-unlocked device to its own zone for the whole session — exactly
  // the user this fix is for. Every sync pull and every local write bumps the
  // counter, so the first call after the pull re-reads. list('settings') is
  // itself memoized per record type in sync.js, so the re-read is nearly free.
  //
  // A test's injected records port is not tracked by the counter (see
  // recordsChangeCount above), so the memo is once-only there; shimCall's
  // re-arm after a settings/tz-plan write covers an in-tab change on that path.
  // ponytail: no cross-tab invalidation. Reload covers it.
  //
  // An account with no pin gets one zone (bd med-wi09.19), but never from a
  // request: a read must touch only what it serves (GET /api/brief reads its
  // selected domains only). The boot calls floorTimeZone() once a pull in this
  // page load has reached the tail (opts.canFloor); see its comment below.
  let tzReady = null;
  let tzStamp = -1;
  function ensureTimeZone() {
    const stamp = recordsChangeCount ? recordsChangeCount() : 0;
    if (!tzReady || tzStamp !== stamp) {
      tzStamp = stamp;
      tzReady = settings.getGeneral()
        // `tzStamp !== stamp` means a newer resolve superseded this one while
        // its read was in flight. Two reads are separate IDB transactions and
        // can settle out of order, so without this the older one could rebuild
        // to the pre-write zone and stick until the next counter bump.
        .then((general) => {
          if (tzStamp !== stamp) return;
          if (general && general.timezone && general.timezone !== timeZone) {
            buildDomains(general.timezone);
          }
        })
        .catch((e) => {
          // Clear the memo rather than leave it resolved: one transient read
          // failure (IndexedDB locked mid-unlock) must not pin the tab to the
          // device zone for the rest of the session.
          if (tzStamp === stamp) tzReady = null;
          console.error('[cloud shim] timezone resolve failed', e);
        });
    }
    return tzReady;
  }

  // PORTED_SET: the feature domains this shim can actually serve end-to-end
  // (records + domain module + shim routes wired). Clamped onto every read
  // of the features map so a stored/toggled flag for an unported domain
  // can never surface as enabled, per docs/cloud-mode.md "C2 shim architecture".
  // weekly_digest is ported cloud-side as a horizon producer (med-eas.58,
  // reminders.js computeDigestEntry) rather than an HTTP-served domain — it has
  // no nav tab and no /api routes, but the flag must persist + read back so the
  // Settings toggle drives the digest push. live_hr is the same shape: no nav
  // tab, no routes, just a persisted flag gating the experimental Vitals card
  // (med-byks.1 POC).
  const PORTED_SET = new Set(['bp', 'weight', 'health', 'medication', 'food', 'workout', 'gamification', 'weekly_digest', 'live_hr']);
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

  // edSafe is THE ED-safe rule (Miles 4148/4151): gamificationmode.ed_safe
  // alone, whatever the gamification (Journey) flag says — the Safety toggle is
  // its own Settings section. GET /api/weight/bmi and the Goal Line payload
  // (which Today's weight cells read) both route through it.
  async function edSafe() {
    return (await gamification.getMode()).ed_safe;
  }

  // bmiPayload backs GET /api/weight/bmi and the BMI fields of GET
  // /api/weight/goal (epic med-a6fb). The ED-safe decision is made here, once:
  // every surface (card, chart bands, nudge, goal warning, MCP) obeys it.
  // show_bmi=false nulls nothing: it is reported, and the Weight UI hides.
  async function bmiPayload() {
    const [ed, g] = await Promise.all([edSafe(), settings.getGeneral()]);
    const facts = ed
      ? { height_cm: null, latest_kg: null, bmi: null, band: null, borders_kg: null }
      : await weight.getBmi(g.height_cm);
    return {
      ...facts,
      height_unit: g.height_unit,
      show_bmi: g.show_bmi,
      nudge_dismissed: g.bmi_nudge_dismissed,
      ed_safe: ed,
      // The one flag the "Add your height" nudge reads (Iris 4160).
      nudge: g.height_cm === null && !g.bmi_nudge_dismissed && !ed && g.show_bmi,
    };
  }

  // goalLinePayload backs GET /api/gamification/goal-line and the bootstrap
  // warm. With Journey off it still carries ed_safe so Today hides its weight
  // cells (med-njny).
  async function goalLinePayload(flags) {
    if (!flags.gamification) return { enabled: false, ed_safe: await edSafe() };
    // getGoalLineCard = getGoalLine + `milestone` (the newest unacknowledged
    // goal milestone, materialized floored on this read — med-8tur.5).
    return gamification.getGoalLineCard({ features: flags });
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
      timezone_source: general.timezone_source,
      weight_unit_preference: weightUnit,
      dismissed_tz_suggestion: general.dismissed_tz_suggestion,
      // Body settings (med-a6fb): the Settings height field's read source —
      // reported as stored, never nulled by ED-safe (unlike /api/weight/bmi).
      height_cm: general.height_cm,
      height_unit: general.height_unit,
      show_bmi: general.show_bmi,
      bmi_nudge_dismissed: general.bmi_nudge_dismissed,
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
    const [readings, goal, stats, logs, weightGoal, settingsPart, firstRunComplete, synced] = await Promise.all([
      bp.list({ days: 60, limit: 0 }),
      bp.getGoal(),
      bp.getStats(),
      weight.list({ days: 35, limit: 0 }),
      weight.getGoal(),
      settingsResponse(),
      settings.getFirstRunComplete(),
      caughtUp(),
    ]);
    const payload = {
      cursor: 0,
      features: settingsPart.features,
      bp: { readings, goal, stats },
      weight: { logs, goal: weightGoal },
      settings: settingsPart.settings,
    };
    // Read from the vault on every call, never cached: WGFirstRun's _mounted
    // latch is module state lost on reload, so only a fresh `false` here keeps
    // the overlay from re-opening on the next page load. Omitted, not false,
    // before the first pull (opts.caughtUp): applyBootstrapPayload then leaves
    // the overlay alone, so a stale pre-pull answer arriving late can never
    // dismiss a W1 that cloud-boot's post-pull re-ask has mounted.
    if (synced) payload.needs_first_run = !firstRunComplete;
    // The Today Goal Line hero warms 'gamification_goal_line' from this
    // (auth-bootstrap.js applyBootstrapPayload). Byte-identical to a live GET
    // /goal-line (incl. the unacknowledged `milestone`, med-8tur.5); with
    // Journey off it is {enabled:false, ed_safe} so Today's weight cells obey
    // ED-safe on a cold start too (med-njny).
    payload.gamification_goal_line = await goalLinePayload(settingsPart.features);
    return payload;
  }

  // Stubs for boot-path endpoints the frontend calls unconditionally
  // regardless of which nav section is open (auth check, settings bundle).
  // Each one logs once at debug so gaps are discoverable without spamming
  // the console on every poll.
  const STUBS = {
    'GET /api/bootstrap': bootstrapPayload,
    'GET /api/init': async () => ({ features: clampFeatures(await settings.getFeatures()) }),
    'GET /api/settings': async () => {
      const { settings: settingsBlock, features } = await settingsResponse();
      return { ...settingsBlock, features };
    },
    'GET /api/bp/reminder/status': async () => reminders.getBPStatus(),
    'GET /api/weight/reminder/status': async () => reminders.getWeightStatus(),
  };

  // A reading logged IN THE APP satisfies today's measure reminder, so end that
  // reminder's Telegram chain — the same mechanism as an in-app dose confirm or
  // workout transition (med-9bmb). measureReminderStem returns '' (a no-op
  // cancel) when the reminder is off or today's slot has not fired yet.
  //
  // Awaited only to read the pref, and the whole thing is swallowed: the vault
  // row is already durable by the time we get here, so a failed pref read must
  // not reject the write and send the UI into an optimistic rollback + retry
  // (a duplicate reading). Same fire-and-forget contract as postRefire itself.
  //
  // `reading` is the created row, whose measured_at is what decides whether the
  // slot is actually satisfied — a backdated entry must leave tonight's reminder
  // alone.
  async function cancelMeasureRefire(prefix, getStatus, reading) {
    try {
      const measuredAt = Date.parse(reading && reading.measured_at);
      cancelReminderRefire(measureReminderStem(
        prefix, await getStatus(), timeZone, now(),
        // No parseable measured_at is the "taken right now" case, not a
        // backdate — the domain leaves the field alone when the caller omits it.
        Number.isFinite(measuredAt) ? measuredAt : now(),
      ));
    } catch (e) {
      console.warn('[cloud shim] measure refire cancel failed', prefix, e);
    }
  }

  // route is the table itself; shimCall (below) wraps it with the timezone
  // resolve and is what implements the window.offlineAwareApiCall(endpoint,
  // method, body, opts) contract (see api.js apiCall/apiCallDirect): resolves to
  // the parsed JSON payload, or throws an Error with .status on failure. Writes
  // resolve as soon as the domain call (and its underlying writeRecord) returns
  // — writeRecord's oplog flush already happens inline, matching the current
  // optimistic local-first UX.
  async function route(endpoint, method = 'GET', body = null, _opts = {}) {
    const { path, params } = parseQuery(endpoint);

    if (path === '/api/bp') {
      if (method === 'POST') {
        const res = await bp.create(body);
        await cancelMeasureRefire('bp', reminders.getBPStatus, res);
        // Cancelling only ends the chain already in the chat. The horizon the
        // relay still holds was computed BEFORE this reading, so it keeps every
        // upcoming slot the reading now satisfies (the 12h / 7d gates) — and
        // only the browser can recompute it. Every other mutating route already
        // does this; BP/weight were the outliers.
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
      if (method === 'GET') {
        const { limit, offset, take } = pageParams(params, 100);
        return pageOf(await bp.list({ days: intParam(params, 'days', 30), limit: take }), limit, offset);
      }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/bp\/([^/]+)$/.exec(path);
      if (m) { await bp.remove(m[1]); return true; }
    }
    if (method === 'PUT') {
      const m = /^\/api\/bp\/([^/]+)$/.exec(path);
      if (m) {
        const res = await bp.update(m[1], body);
        // An edit that moves a reading into today's slot satisfies it like a
        // new one: end the relay's re-fire chain, then recompute the horizon.
        await cancelMeasureRefire('bp', reminders.getBPStatus, res);
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    if (path === '/api/bp/goal' && method === 'GET') return bp.getGoal();
    if (path === '/api/bp/stats' && method === 'GET') return bp.getStats();

    if (path === '/api/weight') {
      if (method === 'POST') {
        const res = await weight.create(body, { replacesId: params.get('replaces') || undefined });
        await cancelMeasureRefire('wt', reminders.getWeightStatus, res);
        // See the BP route: the relay's horizon predates this reading, so the
        // weekly weight slots it satisfies are still queued there.
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
      if (method === 'GET') {
        const { limit, offset, take } = pageParams(params, 100);
        return pageOf(await weight.list({ days: intParam(params, 'days', 30), limit: take }), limit, offset);
      }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/weight\/([^/]+)$/.exec(path);
      if (m) { await weight.remove(m[1]); return true; }
    }
    if (path === '/api/weight/goal' && method === 'GET') {
      // The weight summary (MCP health.weight.goal.read) also carries
      // height_cm / bmi / bmi_band — omitted together when there is no height,
      // no weight log, or ED-safe (the same bmiPayload decision, med-a6fb.3).
      const [goal, b] = await Promise.all([weight.getGoal(), bmiPayload()]);
      return b.bmi === null ? goal : { ...goal, height_cm: b.height_cm, bmi: b.bmi, bmi_band: b.band };
    }
    if (path === '/api/weight/goal' && method === 'POST') {
      const res = await weight.setGoal(body);
      // The queued weigh-in push carries the goal's distance (Web Push only).
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
    }
    // BMI (epic med-a6fb). The ED-safe decision is made HERE, once: every
    // surface (card, chart bands, nudge, goal warning, MCP) obeys the payload.
    if (path === '/api/weight/bmi' && method === 'GET') return bmiPayload();
    if (path === '/api/weight/goals/history' && method === 'GET') {
      // max 200: the domain's own append-only-history cap, so a deeper offset
      // legitimately runs out of rows rather than being an error.
      const { limit, offset, take } = pageParams(params, 100, 200);
      return { goals: pageOf(await weight.listGoals(take), limit, offset) };
    }

    if (path === '/api/notes') {
      if (method === 'POST') return notes.create(body);
      if (method === 'GET') {
        // max 200: the per-op ceiling the catalog advertises for
        // health.notes.list. Where a route names a smaller max than MAX_LIMIT,
        // the router must enforce that one or mcp_help is describing a
        // different API than the one answering.
        const { limit, offset, take } = pageParams(params, 50, 200);
        return pageOf(await notes.list({
          days: intParam(params, 'days', undefined),
          limit: take,
          beforeId: params.get('before_id') || undefined,
        }), limit, offset);
      }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/notes\/([^/]+)$/.exec(path);
      if (m) { await notes.remove(m[1]); return true; }
    }

    // User trackers (med-1vy5). Ids are decoded: a check log id carries ':'.
    // Every write recomputes the horizon: a tracker reminder fires only while
    // its target is unmet (med-1vy5.5).
    const trackerWrite = async (p) => {
      const res = await p;
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
    };
    if (path === '/api/trackers') {
      if (method === 'GET') return trackers.list();
      if (method === 'POST') return trackerWrite(trackers.create(body));
    }
    if (path.startsWith('/api/trackers/')) {
      const seg = path.slice('/api/trackers/'.length).split('/').map(decodeURIComponent);
      const [id] = seg;
      if (seg.length === 1 && method === 'PUT') return trackerWrite(trackers.update(id, body));
      if (seg.length === 1 && method === 'DELETE') { await trackerWrite(trackers.archive(id)); return true; }
      if (seg.length === 2 && seg[1] === 'log' && method === 'POST') return trackerWrite(trackers.log(id, body || {}));
      if (seg.length === 3 && seg[1] === 'log' && method === 'DELETE') return trackerWrite(trackers.unlog(id, seg[2]));
      if (seg.length === 3 && seg[1] === 'days' && method === 'PUT') return trackerWrite(trackers.setDay(id, seg[2], body && body.done));
      if (seg.length === 2 && seg[1] === 'history' && method === 'GET') {
        return trackers.history(id, positiveIntParam(params, 'days', 30));
      }
    }

    if (path === '/api/settings/weight-unit' && method === 'PATCH') {
      const unit = body && body.unit === 'lb' ? 'lb' : 'kg';
      await writeWeightUnit(unit);
      // The queued goal-aware weigh-in push is worded in this unit.
      scheduleReminderRecompute(ctx, { records, timeZone });
      return { unit };
    }

    // Partial patch of the body settings (height_cm, height_unit, show_bmi,
    // bmi_nudge_dismissed — settings.js BODY_FIELDS); null resets a field.
    if (path === '/api/settings/body' && method === 'PATCH') return settings.setBodySettings(body);

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
        // The caller (bootstrap's tz prompt) reacts to the planner outcome.
        return { changed: res.changed, planCreated: res.planCreated };
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
        // workout/weekly_digest/gamification gate reminder-horizon kinds, so a
        // toggle must re-push immediately (acceptance: "toggle on → fires"),
        // not wait for the next unlock.
        if (feature === 'workout' || feature === 'weekly_digest' || feature === 'gamification') {
          scheduleReminderRecompute(ctx, { records, timeZone });
        }
        return { enabled };
      }
    }

    if (path === '/api/firstrun/complete' && method === 'POST') {
      await settings.setFirstRunComplete(true, body && body.picked);
      return { success: true };
    }

    // W3 Today "Start here" (bd med-ta2n.3): read on every Today render.
    if (path === '/api/today/start-here' && method === 'GET') {
      // vault.js userContentCount > 0, short-circuited: type by type
      // (medication, bp, … before the big sample histories), stop at the
      // first live record. Per type because list() rows carry no recordType.
      return settings.getStartHere({
        hasContent: async () => {
          for (const t of USER_CONTENT_TYPES) {
            if (t !== 'gamification' && (await records.list(t)).some((r) => !r.deleted)) return true;
          }
          return false;
        },
      });
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

    // Model-id suggestions for the Settings model combobox (bd med-byom).
    // Deliberately NOT a catalogued MCP op: it is a typing aid for a human
    // filling in a form, and it is the one route that makes the browser spend
    // the user's provider key on a call the user didn't ask an AI feature for.
    // Failures come back as a payload, never a throw — a missing list must
    // leave the field working as plain free text, not raise an error alert.
    if (path === '/api/settings/integrations/models' && method === 'GET') {
      try {
        const { models, cached } = await aiClient.listModels({
          scope: params.get('scope') === 'vision' ? 'vision' : 'text',
          refresh: params.get('refresh') === '1',
        });
        return { models, cached, error: '', code: '' };
      } catch (err) {
        return { models: [], cached: false, error: err.message || 'Could not load the model list.', code: err.code || 'failed' };
      }
    }

    // Trial-provider consent (bd med-yor.2). Deliberately NOT a catalogued
    // MCP op: consent is a human ceremony — an agent must not be able to
    // grant itself access to the operator's trial providers.
    if (path === '/api/settings/trial-consent') {
      if (method === 'GET') return settings.getTrialConsent();
      if (method === 'PATCH') return settings.setTrialConsent(body);
    }

    // Emergency Kit save state (bd med-ckm5.2): PUT by cloud-boot's drain of
    // the kit page's stash, GET by Settings. Not a catalogued MCP op: an agent
    // must not be able to mark a user's kit as saved.
    if (path === '/api/settings/emergency-kit') {
      if (method === 'GET') return settings.getEmergencyKit();
      if (method === 'PUT') return settings.setEmergencyKit(body);
    }

    // W4 protect-your-data nudge (bd med-ta2n.4): the Today card reads this
    // (and the Settings chip, med-ta2n.5). Only local mode injects
    // `protection`; an account is synced by definition and never nudges.
    if (path === '/api/protection/status' && method === 'GET') {
      if (!protection) {
        return {
          records: 0, firstRunAt: null, lastBackupAt: null, lastSavedAt: null, dismissedCount: 0, lastDismissedAt: null, synced: true, nudge: false,
        };
      }
      const lists = await Promise.all([...USER_CONTENT_TYPES].map((t) => records.list(t)));
      return settings.getProtectionStatus({
        records: userContentCount(lists.flat()),
        legacyDismissedAt: protection.legacyDismissedAt(targetWindow),
        savedAt: typeof protection.savedAt === 'function' ? protection.savedAt(targetWindow) : null,
      });
    }
    if (path === '/api/protection/dismiss' && method === 'POST' && protection) {
      await settings.dismissNudge();
      protection.recordWritten(targetWindow);
      return { success: true };
    }
    // Emergency Kit nudge (bd med-ta2n.15): an account only — local mode has
    // no kit, and its W4 card is the one that speaks there. POST {action:
    // 'later'|'never'}; the count is the shim's, not the caller's. Lazy and
    // type by type, stopping at atLeast: the domain asks only when the card
    // could show, and a saved kit (most accounts) reads no user type at all.
    if (path === '/api/protection/kit-nudge' && !protection) {
      const count = async (atLeast = Infinity) => {
        let n = 0;
        for (const t of USER_CONTENT_TYPES) {
          n += userContentCount(await records.list(t));
          if (n >= atLeast) break;
        }
        return n;
      };
      if (method === 'GET') return settings.getKitNudgeStatus({ count });
      if (method === 'POST') {
        await settings.setKitNudge(body && body.action, { count });
        return { success: true };
      }
    }

    // Reminder delivery pref (bd med-o7zq.3): the /api seam local-only mode's
    // lock-screen text choice uses (Settings → Reminders & notifications).
    // Cloud Settings binds the same record through reminders.js directly. A
    // change reschedules at once: the schedule is a replace-all of bodies
    // computed up front.
    if (path === '/api/settings/reminder-delivery') {
      if (method === 'GET') return reminders.getDeliveryPref();
      if (method === 'PUT') {
        // {floor}: a default, not a choice (med-5vy0) — stored at the floor
        // (Detailed clientTs 0, Generic clientTs 1) only when no pref exists (docs/cloud-mode.md guard 3). 'auto' is
        // the first run: Detailed when the vault already holds a medication
        // (an existing account keeps what it saw), else Generic.
        const floor = body && body.floor;
        const pref = floor
          ? await reminders.floorDeliveryPref(floor === 'auto'
            ? ((await records.list('medication')).some((m) => !m.deleted) ? 'detailed' : 'generic')
            : floor)
          : await reminders.setDeliveryPref(body || {});
        scheduleReminderRecompute(ctx, { records, timeZone }, 0);
        return pref;
      }
    }

    // The Telegram agent glossary note (bd med-vcv.4): Settings' full-replace
    // view over the same vault singleton the free-text agent reads/appends
    // to (inbox-apply.js's TG_PREFS_TYPE). PATCH always replaces `note`
    // whole — an absent/empty value clears it, matching the "" = cleared
    // convention every other settings field routed through this shim uses.
    if (path === '/api/settings/tgprefs') {
      if (method === 'GET') return { note: await settings.getTGPrefsNote() };
      if (method === 'PATCH') return { note: await settings.setTGPrefsNote(body && body.note) };
    }

    // Composite analyses — one call aggregating many domains, gated by the
    // vault's feature flags (a disabled section lands in the `warning` field).
    if ((path === '/api/health/cardiovascular-analysis' || path === '/api/health/fitness-analysis') && method === 'GET') {
      const opts = {
        from: params.get('start_date') || undefined,
        to: params.get('end_date') || undefined,
        days: intParam(params, 'days', undefined),
        excludeNotes: params.get('exclude_notes') === 'true',
        features: await settings.getFeatures(),
      };
      return path.endsWith('cardiovascular-analysis')
        ? analysis.cardiovascular(opts) : analysis.fitness(opts);
    }

    // Doctor-visit brief — one read assembling the printable appointment
    // summary. Cloud-only for now (the MCP registry op is med-5k6t.3), so
    // neither the catalog drift test nor the Go coverage guard applies.
    if (path === '/api/brief' && method === 'GET') {
      return brief.build({ days: params.get('days'), sections: params.get('sections') });
    }

    if (path === '/api/health/overview' && method === 'GET') return vitals.overview();
    if (path === '/api/health/sleep' && method === 'GET') {
      // The route's old default was limit=0, i.e. every sleep session ever
      // recorded on every call — the one list here that was unbounded by
      // default rather than only when asked to be.
      const { limit, offset, take } = pageParams(params, 100);
      return pageOf(await vitals.sleep({
        from: params.get('from') || undefined,
        to: params.get('to') || undefined,
        days: positiveIntParam(params, 'days', 90),
        limit: take,
      }), limit, offset);
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
    // The med editor's Rx chip + inline interaction warning, before Save.
    if (path === '/api/medications/rx-check' && method === 'GET') {
      return medications.rxCheck({
        name: params.get('name') || '',
        rxcui: params.get('rxcui') || '',
        excludeId: intParam(params, 'exclude_id', 0),
      });
    }
    // The Meds → Schedule tab's hour buckets and Upcoming list read this
    // instead of recomputing doses in the browser's own timezone (bd med-gut).
    if (path === '/api/medications/upcoming' && method === 'GET') {
      return intake.upcomingDoses({ days: clampDays(params.get('days'), 7, 30) });
    }
    // The one occurrence projection (bd med-wi09.1): every dose in [from, to]
    // with its state. Defaults: the last 24 h through the next 7 days.
    // status=due,snoozed (bd med-ry7b.3, the timeline's focus card) keeps only
    // those states and reaches back to the start of the ledger by default:
    // pending never expires (Archie 4709, no age cap).
    if (path === '/api/doses' && method === 'GET') {
      const nowMs = now();
      // ?at=<iso>: the doses planned at exactly that instant (a reminder's
      // slot), read lineage-safe (bd med-wi09.4).
      const atMs = Date.parse(params.get('at') || '');
      if (Number.isFinite(atMs)) return dosesAtInstant(intake, atMs);
      const isoParam = (name, fallback) => {
        const ms = Date.parse(params.get(name) || '');
        return Number.isFinite(ms) ? ms : fallback;
      };
      const states = (params.get('status') || '').split(',').filter(Boolean);
      return intake.occurrences({
        fromMs: isoParam('from', states.length ? 0 : nowMs - 24 * 3600_000),
        toMs: isoParam('to', nowMs + 7 * 24 * 3600_000),
        states: states.length ? states : null,
      });
    }
    // Explicit dose actions on explicit occIds (bd med-wi09.2): take / skip /
    // undo / edit_time / snooze. Per-day bulk is the same route with many ids.
    // One dose-action path for /api/doses/act and the legacy snooze route.
    const doseAct = async (args) => {
      const res = await intake.act(args).catch((err) => {
        if (err && err.code === 'bad_request') err.status = 400;
        throw err;
      });
      // A snooze uploads its snooze-end reminder at once, alongside the chain
      // cancel below: a 2s debounce dropped by a quick app close (cloud-boot.js)
      // would leave the dose with no reminder at all.
      scheduleReminderRecompute(ctx, { records, timeZone }, args.action === 'snooze' ? 0 : undefined);
      // A dose confirmed in the app never taps Telegram: reconcile the relay
      // chain for each acted slot (reconcileMedChain).
      if (['take', 'skip', 'snooze'].includes(args.action)) {
        for (const slotMs of new Set(res.doses.map((d) => Date.parse(d.scheduled_at)))) {
          await reconcileMedChain(slotMs, args.action === 'snooze');
        }
      }
      return res;
    };
    if (path === '/api/doses/act' && method === 'POST') {
      return doseAct({
        occIds: Array.isArray(body && body.occ_ids) ? body.occ_ids : [],
        action: body && body.action,
        takenAt: body && body.taken_at,
        minutes: body && body.minutes,
        until: body && body.until,
      });
    }
    // The legacy snooze route (MCP medications.snooze) is act's snooze on one
    // intake: the same not_due guard, 7-day bound and chain reconcile. Its
    // reply shape is kept; a refused dose throws its reason as before.
    if (path === '/api/medications/snooze' && method === 'POST') {
      const minutes = Number(body && body.duration_minutes);
      const res = await doseAct({
        occIds: [String(body && body.intake_id)],
        action: 'snooze',
        minutes: minutes > 0 ? minutes : undefined,
      });
      if (res.failed) {
        const err = new Error(`intake not snoozed: ${res.failures[0].reason}`);
        err.code = res.failures[0].reason;
        err.status = err.code === 'not_found' ? 404 : 409;
        throw err;
      }
      return { status: 'snoozed', snoozed_until: res.doses[0].snoozed_until };
    }
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
        '/api/medications/skip': () => intake.skip(body && body.intake_id),
        '/api/medications/confirm-schedule': () => intake.confirmSchedule({
          scheduledAt: body && body.scheduled_at,
          medicationIds: (body && body.medication_ids) || [],
          intakeIds: (body && body.intake_ids) || [],
          takenAt: body && body.taken_at,
        }),
      };
      const action = intakeActions[path];
      if (action) {
        const res = await action();
        // A dose confirmed in the app never taps Telegram, so tell the relay to
        // stop its server-owned re-fire chain for that slot (med-eas.74). Only
        // cancel once NOTHING is left due for the slot — a partial confirm (a
        // subset of the meds sharing a slot) must not silence the slot-wide
        // re-fire for meds still PENDING at the same instant.
        if (path === '/api/medications/confirm-schedule' && body && body.scheduled_at) {
          const slotMs = Date.parse(body.scheduled_at);
          if (Number.isFinite(slotMs)) await reconcileMedChain(slotMs, false);
          else cancelMedRefire(slotMs);
        }
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
        const res = await medications.restock(Number(m[1]), body && body.quantity, body && body.note).catch(withDuplicateStatus);
        scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    // A stock count (bd med-wi09.13, Update stock · Counted): the new
    // starting point of the med's stock ledger.
    if (method === 'POST') {
      const m = /^\/api\/medications\/([^/]+)\/stock-audit$/.exec(path);
      if (m) {
        const res = await medications.stockAudit(Number(m[1]), body && body.count).catch(withDuplicateStatus);
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
    if (path === '/api/tz-suggestion/should-prompt' && method === 'GET') {
      return tzplan.shouldPromptSuggestion(params.get('detected_tz') || '');
    }
    if (path === '/api/tz-suggestion/dismiss' && method === 'POST') return tzplan.recordDismissal(body && body.detected_tz);

    // --- Food logs + products (Task 2: C2c shim wiring). The frontend still
    // reaches the AI parser and the food DB browser-direct (CloudFoodAI /
    // CloudFoodSearch below); the two routes here exist for MCP, and they call
    // the very same domain instances, so neither the meal description nor the
    // search term ever crosses the relay (med-csu.3).
    // dry_run: true is the parse-only mode (med-xso6.17) — {status:'parsed',
    // items} with per-100g values and an `uncertain` flag, nothing saved.
    if (path === '/api/food/log/from-description' && method === 'POST') {
      const eatenAt = Date.parse((body && body.eaten_at) || '');
      return foodAI.parseMealFromDescription(body && body.description, {
        eatenAt: Number.isNaN(eatenAt) ? undefined : eatenAt,
        dryRun: !!(body && body.dry_run === true),
      });
    }
    // Bot mode streams NDJSON here and ignores the catalog's `limit`; the shim
    // resolves the whole array at once, matching the apiCall contract.
    if (path === '/api/food/products/search' && method === 'GET') {
      return food.search(params.get('q'), { remote: params.get('remote') === 'true' });
    }
    if (path === '/api/food/log/move' && method === 'POST') {
      return food.moveLogs((body && body.ids) || [], body && body.eaten_at);
    }
    if (path === '/api/food/log') {
      if (method === 'POST') return food.create(body);
      if (method === 'GET') {
        // No limit param: the response is meal groups carrying their logs, so
        // it grows with the window, not with a row count. `days` is the only
        // lever, hence the clamp (web/domain/paginate.js MAX_DAYS).
        return food.listGrouped({ date: params.get('date') || undefined, days: clampDays(params.get('days'), 1) });
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
    // Incomplete-day flag (med-0sgs): one entry per day in the window.
    if (path === '/api/food/days' && method === 'GET') {
      return food.dayStatuses({ date: params.get('date') || undefined, days: clampDays(params.get('days'), 1) });
    }
    if (method === 'PUT') {
      const m = /^\/api\/food\/days\/([^/]+)$/.exec(path);
      if (m) return food.setDayIncomplete(decodeURIComponent(m[1]), body && body.incomplete);
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
        offset: clampOffset(params.get('offset')),
        // max 100, matching bot mode exactly: handleGetFoodProducts ignores any
        // limit above 100 and falls back to its own 100 default.
        limit: clampLimit(params.get('limit'), 100, 100),
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
    // base path. rotation/state, rotation/initialize, exercises/unique and
    // sessions/schedule have no frontend caller but are catalogued MCP ops, so
    // they are routed too (med-csu.3). Intentionally NOT routed: the legacy
    // session/snooze + session/skip compat routes — these fall through to the
    // unmapped-route warning. The external Mi Notify webhook is likewise not an
    // apishim route, but mi-band ingestion is no longer unmapped: it arrives via
    // the server-side NXK parse→seal path (med-nzz) — a `.nxk` uploaded to
    // POST /api/vitals/import or sent to the cloud bot is parsed + sealed to the
    // inbox, then the vitals_import applier writes vault records at drain time.
    if (path === '/api/workout/groups' && method === 'GET') return workout.listGroups();
    if (path === '/api/workout/groups/create' && method === 'POST') {
      const res = await workout.createGroup(body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
    }
    if (path === '/api/workout/groups/update' && method === 'PUT') {
      await workout.updateGroup(intParam(params, 'id', 0), body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }
    if (path === '/api/workout/groups/delete' && method === 'DELETE') {
      // cancel_sessions=true (bd med-qop3) tombstones the group's open
      // sessions via deleteSession before the cascade; absent it stays the
      // legacy refusal. Reads strict 'true' like the other query booleans
      // (exclude_notes, archived) — the MCP dispatcher serializes boolean
      // true to exactly that.
      await workout.deleteGroup(intParam(params, 'id', 0), {
        cancelSessions: params.get('cancel_sessions') === 'true',
      });
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }

    if (path === '/api/workout/variants' && method === 'GET') {
      return workout.listVariants(intParam(params, 'group_id', 0));
    }
    // Variant + exercise writes feed the workout horizon: the resolved variant's
    // name (and its exercise list) is rendered into the queued recurring-reminder
    // text, and add/delete changes which variant resolveVariantId picks. Re-push
    // so the blind relay follows, like the group routes above.
    if (path === '/api/workout/variants/create' && method === 'POST') {
      const res = await workout.createVariant(body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
    }
    if (path === '/api/workout/variants/update' && method === 'PUT') {
      await workout.updateVariant(intParam(params, 'id', 0), body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }
    if (path === '/api/workout/variants/delete' && method === 'DELETE') {
      await workout.deleteVariant(intParam(params, 'id', 0));
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }

    if (path === '/api/workout/exercises' && method === 'GET') {
      return workout.listExercises(intParam(params, 'variant_id', 0));
    }
    if (path === '/api/workout/exercises/create' && method === 'POST') {
      const res = await workout.createExercise(body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
    }
    if (path === '/api/workout/exercises/update' && method === 'PUT') {
      await workout.updateExercise(intParam(params, 'id', 0), body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }
    if (path === '/api/workout/exercises/delete' && method === 'DELETE') {
      await workout.deleteExercise(intParam(params, 'id', 0));
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }

    // Portable plan share (bd med-uo64.1): export/import a whole plan as one
    // versioned JSON token. Import always creates a NEW group, so it touches
    // the workout reminder horizon exactly like the hand-created writes above.
    if (path === '/api/workout/plans/export' && method === 'GET') {
      return workoutShare.exportPlan(intParam(params, 'id', 0));
    }
    if (path === '/api/workout/plans/import' && method === 'POST') {
      const res = await workoutShare.importPlan(body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
    }

    // Library-backed lists: no natural row cap, so they get one. The default is
    // MAX_LIMIT rather than something smaller because these feed exercise
    // pickers that expect the whole library — bound the pathological case
    // without shortening any realistic one.
    if (path === '/api/workout/exercises/unique' && method === 'GET') {
      const { limit, offset } = pageParams(params, MAX_LIMIT);
      return pageOf(await workout.listUniqueExercises(), limit, offset);
    }

    // Progression preview (Phase 4): dry-run the opt-in progression rules over
    // each exercise's latest completed log — read-only, never writes back. This
    // is a cloud-only op (mcp-catalog.cloud-extra.js), no bot/Go counterpart.
    if (path === '/api/workout/progression-preview' && method === 'GET') {
      return workout.progressionPreview();
    }

    if (path === '/api/workout/rotation/state' && method === 'GET') {
      // handleGetRotationState 404s on a missing state (workout_handlers.go:367);
      // returning null here would hand an MCP agent `result: null` where bot mode
      // errors.
      const state = await workout.getRotationState(intParam(params, 'group_id', 0));
      if (!state) throw apiError(404, 'Rotation state not found');
      return state;
    }
    if (path === '/api/workout/rotation/initialize' && method === 'POST') {
      await workout.initializeRotation(
        Number(body && body.group_id) || 0,
        Number(body && body.starting_variant_id) || 0,
      );
      // Seeds the rotation cursor resolveVariantId reads — re-push so the queued
      // recurring reminder names the newly-selected variant.
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }

    if (path === '/api/workout/exercise-library' && method === 'GET') {
      const { limit, offset } = pageParams(params, MAX_LIMIT);
      return pageOf(await workout.listLibrary(), limit, offset);
    }
    if (path === '/api/workout/exercise-library/create' && method === 'POST') {
      return workout.createLibraryItem(body).catch(withDuplicateStatus);
    }
    if (path === '/api/workout/exercise-library/update' && method === 'PUT') {
      await workout.updateLibraryItem(intParam(params, 'id', 0), body).catch(withDuplicateStatus);
      return true;
    }
    if (path === '/api/workout/exercise-library/remove-alias' && method === 'POST') {
      return workout.removeLibraryAlias(intParam(params, 'id', 0), body && body.alias);
    }
    if (path === '/api/workout/exercise-library/auto-tag' && method === 'POST') {
      return exerciseTag.tagExercises(body && body.names);
    }
    if (path === '/api/workout/exercise-library/delete' && method === 'DELETE') {
      await workout.deleteLibraryItem(intParam(params, 'id', 0));
      return true;
    }
    if (path === '/api/workout/exercise-library/merge' && method === 'POST') {
      return workout.mergeLibraryItem(body).catch(withDuplicateStatus);
    }

    if (path === '/api/workout/sessions' && method === 'GET') {
      // max 500: the per-op ceiling workouts.sessions.list advertises.
      const { limit, offset, take } = pageParams(params, 30, 500);
      return pageOf(await workout.listSessions(take), limit, offset);
    }
    if (path === '/api/workout/sessions/next' && method === 'GET') return workout.getNext();
    // "Up next" rows of the live session (med-okwf.4). UI read only (no MCP op).
    if (path === '/api/workout/sessions/suggest-next' && method === 'GET') {
      return workout.suggestNextExercises({ session_id: params.get('session_id'), after: params.get('after') || '' });
    }
    if (path === '/api/workout/sessions/details' && method === 'GET') {
      return workout.getSessionDetails(intParam(params, 'id', 0));
    }
    if (path === '/api/workout/sessions/delete' && method === 'DELETE') {
      await workout.deleteSession(intParam(params, 'id', 0));
      // Deleting a planned ad-hoc session drops the reminder it emitted, and
      // deleting a materialized recurring session suppresses that day's fire
      // (bd med-w0fe) — re-push so the relay reflects the change (matches
      // session status above).
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }
    if (path === '/api/workout/sessions/status' && method === 'PUT') {
      // Go's handleUpdateSessionStatus writes an empty 200 body (apiCall -> true)
      // and 404s on a missing session. The {session, terminal} outcome is only
      // consumed server-side for notification cleanup, so don't leak it here.
      const outcome = await workout.setSessionStatus(intParam(params, 'id', 0), body && body.status);
      if (!outcome) throw apiError(404, 'session not found');
      // A skip/complete suppresses that day's recurring reminder — re-push so
      // the blind relay drops it (matches the bot cancelling on status change).
      // The re-push alone is not enough: ReplaceSchedule deliberately preserves
      // relay-owned re-fires, and it never touches the message already in the
      // chat. Kill the chain explicitly (med-r3dm).
      cancelReminderRefire(workoutReminderStem(outcome.session));
      scheduleReminderRecompute(ctx, { records, timeZone });
      return true;
    }
    // med-8j5w.1: the session-header gym switch. Affects future equipment
    // resolutions for this session only (no retroactive re-propagation).
    if (path === '/api/workout/sessions/location' && method === 'PUT') {
      const session = await workout.setSessionLocation(intParam(params, 'id', 0), body ? body.location_id : null);
      if (!session) throw apiError(404, 'session not found');
      return session;
    }
    if (path === '/api/workout/sessions/schedule' && method === 'POST') {
      const res = await workout.schedulePlannedAdHocSession(body);
      scheduleReminderRecompute(ctx, { records, timeZone });
      return res;
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
        // start/skip/preskip take the session out of 'pending', so its Telegram
        // reminder is answered and must go (med-r3dm). These actions return void,
        // so read the session BEFORE the write — group_id/scheduled_date don't
        // change (next-variant replaces the slot in place, keeping its recordId
        // and numeric id — bd med-8j12, bd med-qhpu). snooze
        // (the chain re-fires on purpose), cancel-preskip (back to pending) and
        // next-variant (same slot, new variant) deliberately keep it.
        //
        // startSession may re-key onto TODAY's slot when the tapped session is a
        // future one (med-gmyf), so the stem cancelled here is the tapped day's,
        // not the started one's. That is a no-op rather than a bug: a future day
        // has no sent message and no relay re-fire (both only exist after a send),
        // and CancelRelayRefire only touches relay-origin rows, so the client's
        // scheduled push for that day survives. The re-key path also implies today
        // had no live pending reminder for the group — getNext would have surfaced
        // today's occurrence instead of a future one if it had.
        const answersReminder = action === 'start' || action === 'skip' || action === 'preskip';
        const details = answersReminder ? await workout.getSessionDetails(id) : null;
        let startedId;
        if (action === 'start') startedId = await workout.startSession(id);
        else if (action === 'snooze') await workout.snoozeSession(id, body && body.minutes);
        else if (action === 'skip') await workout.skipSession(id);
        else if (action === 'preskip') await workout.preSkipSession(id);
        else if (action === 'cancel-preskip') await workout.cancelPreSkipSession(id);
        else await workout.nextVariant(id);
        if (details) cancelReminderRefire(workoutReminderStem(details.session));
        // start/snooze/skip change the session's status, which the horizon uses
        // to suppress the recurring reminder — re-push so the relay follows.
        scheduleReminderRecompute(ctx, { records, timeZone });
        // start may run a different session than the tapped one (re-key onto
        // today, or ad-hoc) — name it so the caller opens the right one.
        return startedId != null ? { session_id: startedId } : true;
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
    // Remove one planned exercise from THIS session only (records it in the
    // session's exercise_snapshot); the variant keeps it for future sessions.
    // Cloud-only: no Go route and no registry op, so neither the catalog drift
    // test nor the internal/server coverage guard applies.
    if (path === '/api/workout/sessions/planned-exercise/delete' && method === 'POST') {
      await workout.removePlannedExercise(body);
      return true;
    }

    if (path === '/api/workout/stats' && method === 'GET') return workout.getStats({ range: params.get('range') });

    // Per-exercise history (Phase 3): completed logs for one exercise, each with
    // its session date + per-set array, newest-first. UI read only (no MCP op) —
    // the client folds est-1RM/PRs/series over the sets via workout-analysis.js.
    if (path === '/api/workout/exercises/history' && method === 'GET') {
      return workout.listExerciseLogsByName(params.get('name') || '', { limit: clampLimit(params.get('limit'), 500) });
    }
    // Every distinct exercise in history, resolved through library names +
    // aliases, with log counts (med-l5yr.1) — feeds the library merge UI. UI
    // read only (no MCP op).
    if (path === '/api/workout/exercises/names' && method === 'GET') return workout.listExerciseNames();
    // Weight sanity baseline (med-l5yr.5): what a set of `name` in log
    // `log_id` (a new log: session `session_id`) is judged on; the session
    // view runs weight-sanity.js over its sets with it. UI read only (no MCP op).
    if (path === '/api/workout/exercises/weight-check' && method === 'GET') {
      return workout.exerciseWeightBaseline(params.get('name') || '', params.get('session_id') || '', params.get('log_id') || '');
    }

    // Editor weight suggestion (med-73o): the next target for an exercise NAME
    // under a training goal, derived by the progression engine from that name's
    // most recent completed log. UI read only (no MCP op — an agent gets the
    // same math, plan-wide, from workouts.progression_preview). null = no
    // history, and the editor leaves the weight field blank.
    if (path === '/api/workout/exercises/suggest-target' && method === 'GET') {
      return workout.suggestExerciseTarget({
        exercise_name: params.get('name') || '',
        goal: params.get('goal') || '',
        // med-h5u3: the live session asks by plan row (goal/rule/equipment)
        // and its own session (excluded from history, its gym for loads).
        exercise_id: params.get('exercise_id') || '',
        session_id: params.get('session_id') || '',
      });
    }

    if (path === '/api/workout/miband' && method === 'GET') {
      const { limit, offset, take } = pageParams(params, 100);
      return pageOf(await workout.listMiBand(take), limit, offset);
    }
    if (method === 'PATCH') {
      const m = /^\/api\/workout\/miband\/([^/]+)$/.exec(path);
      if (m) { await workout.updateMiBand(Number(m[1]), body); return true; }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/workout\/miband\/([^/]+)$/.exec(path);
      if (m) { await workout.deleteMiBand(Number(m[1])); return true; }
    }

    // --- Equipment inventory (med-niix.1): the list alone, no link to
    // exercises (that is med-niix.5). REST shape: collection GET/POST plus
    // :id GET/PUT/DELETE; unknown numeric ids read as 404 and write as
    // no-ops, mirroring the workout domain's findByNumericId contract.
    if (path === '/api/workout/equipment' && method === 'GET') return equipment.listEquipment();
    if (path === '/api/workout/equipment' && method === 'POST') return equipment.createEquipment(body);
    if (method === 'GET') {
      const m = /^\/api\/workout\/equipment\/([^/]+)$/.exec(path);
      if (m) {
        const item = await equipment.getEquipment(Number(m[1]));
        if (!item) throw apiError(404, 'Equipment not found');
        return item;
      }
    }
    if (method === 'PUT') {
      const m = /^\/api\/workout\/equipment\/([^/]+)$/.exec(path);
      if (m) { await equipment.updateEquipment(Number(m[1]), body); return true; }
    }
    if (method === 'DELETE') {
      const m = /^\/api\/workout\/equipment\/([^/]+)$/.exec(path);
      if (m) { await equipment.deleteEquipment(Number(m[1])); return true; }
    }

    // --- Workout locations / gyms (med-8j5w.1): same REST shape as equipment,
    // plus the active-gym singleton. The equipment list above stays unfiltered;
    // consumers scope it via the domain's inventoryAt.
    if (path === '/api/workout/locations/active' && method === 'GET') return equipment.getActiveLocation();
    if (path === '/api/workout/locations/active' && method === 'PUT') {
      return equipment.setActiveLocation(body ? body.location_id : null);
    }
    // Share a gym (med-8j5w.3): portable v1 token, import = a NEW location.
    if (path === '/api/workout/locations/import' && method === 'POST') return workoutShare.importLocation(body);
    {
      const m = /^\/api\/workout\/locations\/(\d+)\/export$/.exec(path);
      if (m && method === 'GET') return workoutShare.exportLocation(Number(m[1]));
    }
    if (path === '/api/workout/locations' && method === 'GET') return equipment.listLocations();
    if (path === '/api/workout/locations' && method === 'POST') return equipment.createLocation(body);
    {
      const m = /^\/api\/workout\/locations\/(\d+)$/.exec(path);
      if (m && method === 'GET') {
        const loc = await equipment.getLocation(Number(m[1]));
        if (!loc) throw apiError(404, 'Location not found');
        return loc;
      }
      if (m && method === 'PUT') { await equipment.updateLocation(Number(m[1]), body); return true; }
      if (m && method === 'DELETE') { await equipment.deleteLocation(Number(m[1])); return true; }
    }

    // --- Gamification: Discovery Atlas POC (Phase 1). The substrate routes
    // (journey/insights/gauges/weekly-review) return {enabled:false} stubs in
    // cloud mode — the HP/levels/rings engine is a later phase (med-eyb). Only
    // the Atlas is live: getAtlas() recomputes discovery cards client-side from
    // vault records (zero server-side health reads), and /atlas/seen persists
    // reveal-once flags. journey.js renders the feed above the (empty) substrate.
    // The payload also carries the Journey's "since you last looked" strip
    // (whats_new).
    if (path === '/api/gamification/atlas' && method === 'GET') return gamification.getAtlas();
    if (path === '/api/gamification/atlas/seen' && method === 'POST') {
      return gamification.markDiscoverySeen(body && body.id);
    }
    // Goal Line (med-8tur.1, docs/gamification.md §0.3.1): the weight goal on
    // the trend + workout/BP facts, recomputed client-side from vault records.
    // A UI-only route like /atlas — deliberately NOT a registry
    // op (agents already reach weight/workout/BP through their own ops). Gated
    // on the gamification flag (its card lives on Today); the
    // workout/BP rows carry their own feature_on from the same flag map.
    if (path === '/api/gamification/goal-line' && method === 'GET') {
      return goalLinePayload(clampFeatures(await settings.getFeatures()));
    }
    // Acknowledging a goal milestone is the user write that retires its line
    // on the Goal Line card; the record stays in the Journey keystones.
    const msAck = path.match(/^\/api\/gamification\/milestones\/([^/]+)\/ack$/);
    if (msAck && method === 'POST') return gamification.acknowledgeMilestone(decodeURIComponent(msAck[1]));
    // Self-Experiments (Phase 4): the flagship N-of-1 mechanic. listExperiments
    // recomputes the active trial's tracker + any un-acknowledged verdict from
    // vault records (persisting only the frozen verdict + lifecycle status);
    // startExperiment/cancelExperiment write the gamificationexperiment record.
    // Lever-template-only, max-1-concurrent, no-effect rewarded like effect,
    // recovery-mode-pause seam — all enforced in the pure domain module.
    if (path === '/api/gamification/experiments' && method === 'GET') return gamification.listExperiments();
    if (path === '/api/gamification/experiments' && method === 'POST') {
      return gamification.startExperiment(body && body.template_id, body || {});
    }
    const expMatch = path.match(/^\/api\/gamification\/experiments\/([^/]+)$/);
    if (expMatch && method === 'DELETE') {
      return gamification.cancelExperiment(decodeURIComponent(expMatch[1]));
    }
    // Narrative layer (Phase 5): chapters (opt-in 4-week arcs + written review),
    // traits (levers-only identity, held/dormant/rekindle), and the keystone
    // timeline (rare permanent real-outcome milestones). All recompute-on-read
    // from vault records; the journal singleton persists only the durable facts
    // (chapter enrollment + reviews, trait earned-timestamps, keystone entries).
    // Bot mode 404s these routes; journey.js then omits the cards.
    if (path === '/api/gamification/chapter') {
      if (method === 'GET') return gamification.getChapter();
      if (method === 'POST') return gamification.startChapter(body && body.theme_id);
      if (method === 'DELETE') return gamification.closeChapter();
    }
    if (path === '/api/gamification/traits' && method === 'GET') return gamification.getTraits();
    if (path === '/api/gamification/keystones' && method === 'GET') return gamification.getKeystones();

    // Substrate parity (Phase 2 / med-eyb): HP, rings, level, Health Score,
    // gauges, weekly review — all recomputed client-side from vault records by
    // web/domain/gamification.js (zero server-side health reads). These replace
    // the Phase-1 {enabled:false} stubs and reproduce the Go read-model shapes
    // (internal/server/gamification_handlers.go) so today.js rings + journey.js
    // render unchanged. Levels are DISPLAY-ONLY here — nothing gates on them.
    if (method === 'GET' && path === '/api/gamification/summary') return gamification.getSummary();
    if (method === 'GET' && path === '/api/gamification/rings') return gamification.getRings();
    if (method === 'GET' && path === '/api/gamification/journey') return gamification.getJourney();
    if (method === 'GET' && path === '/api/gamification/gauges') return gamification.getGauges();
    if (method === 'GET' && path === '/api/gamification/weekly-review') {
      return gamification.getWeeklyReview({ features: clampFeatures(await settings.getFeatures()) });
    }
    // The weekly review's choice (med-8tur.4, docs/gamification.md §0.3.4): the
    // user write of next week's intention / cadence / pause. A weigh-in cadence
    // pick IS the weigh-in reminder's cadence (daily is opt-in here), and a
    // pause silences that week's weigh-in nudges — so the horizon recomputes.
    // Only an explicit weigh_in in the request touches the reminder pref.
    // ponytail: the pref is global, so a Sunday pick (next week's plan) moves
    // it now and it outlives the week; per-week cadence if that ever matters.
    if (method === 'POST' && path === '/api/gamification/week-plan') {
      const res = await gamification.putWeekPlan(body || {});
      if (res.ok) {
        const asked = body && body.cadence && body.cadence.weigh_in;
        if (asked) await reminders.setWeightCadence(asked);
        scheduleReminderRecompute(ctx, { records, timeZone });
      }
      return res;
    }
    // Gamification mode (med-8tur.12, docs/gamification.md §0.5): per-mechanic
    // switches (experiments / traits / narration) + the ED-safe toggle. UI-only
    // like /goal-line. ED-safe changes the weigh-in push and digest text, so a
    // write recomputes the reminder horizon.
    if (path === '/api/gamification/mode') {
      if (method === 'GET') return gamification.getMode();
      if (method === 'PUT') {
        const res = await gamification.putMode(body || {});
        if (res.ok !== false) scheduleReminderRecompute(ctx, { records, timeZone });
        return res;
      }
    }
    if (path === '/api/gamification/targets') {
      if (method === 'GET') return gamification.getTargets();
      if (method === 'PUT' || method === 'POST') return gamification.putTargets(body || {});
    }
    // The personal-insight ladder is retired in the discovery frame (§3.1) — its
    // two shipped insights re-render as ordinary Atlas cards, so /insights stays
    // disabled and journey.js omits the legacy insight card.
    if (method === 'GET' && path === '/api/gamification/insights') return { enabled: false };

    // AI narration (Phase 6) — OPT-IN, BYO-key prose OVER the deterministic
    // engine. GET /narrate is a cheap capability probe (NO LLM call) so the
    // Journey narrator card only mounts in cloud mode; bot mode 404s it and the
    // card is omitted. The POST routes compute the deterministic stats-JSON
    // HERE from the domain read-models (never the client) and hand only those
    // already-computed summaries to the user's own provider via the narrator —
    // raw vault records never cross the boundary. No key / any provider error
    // returns { text: null } and journey.js keeps its deterministic cards.
    // The narration switch (gamificationmode, med-8tur.12) turns the probe off
    // and every POST into the same {text:null} a missing key produces.
    if (path === '/api/gamification/narrate' && method === 'GET') {
      return { enabled: (await gamification.getMode()).narration };
    }
    if (path.startsWith('/api/gamification/narrate/') && method === 'POST'
      && !(await gamification.getMode()).narration) return { text: null };
    if (path === '/api/gamification/narrate/weekly' && method === 'POST') {
      // The goal recap (med-8tur.8): the completed-week review — its weight row
      // is the Goal Line as of the reviewed Sunday — under the same feature
      // flags the /weekly-review route uses.
      const review = await gamification.getWeeklyReview({ features: clampFeatures(await settings.getFeatures()) });
      return narrator.narrateWeekly({ review });
    }
    if (path === '/api/gamification/narrate/chapter' && method === 'POST') {
      return narrator.narrateChapter(await gamification.getChapter());
    }
    if (path === '/api/gamification/narrate/experiments' && method === 'POST') {
      const [experiments, atlas] = await Promise.all([
        gamification.listExperiments(), gamification.getAtlas({ whatsNew: false }),
      ]);
      return narrator.suggestExperiments({ experiments, atlas });
    }
    if (path === '/api/gamification/narrate/workout' && method === 'POST') {
      return narrator.narrateWorkout(await workout.getStats());
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
    // `noRoute` distinguishes this from the domain 404s above (session /
    // rotation state not found), which are real answers, not missing wiring —
    // mcp-responder's dispatch keys off the flag, not off the status.
    const err = apiError(404, `Not found: ${method} ${path}`);
    err.noRoute = true;
    throw err;
  }

  // Writes under /api/settings and /api/tz-plan are the only in-tab way the
  // pinned zone changes. On the real records port the change counter already
  // catches them; this re-arm is what covers an injected (test/headless) port,
  // which the counter does not track.
  const TZ_WRITING_PATH = /^\/api\/(settings|tz-plan)\b/;

  // ponytail: a rebuild triggered by a concurrent zone change can land between
  // two awaits of an in-flight handler, serving one request across both zones.
  // Needs a real zone change concurrent with a read, and the next request is
  // consistent; add a rebuild latch if that ever shows up in practice.
  async function shimCall(endpoint, method = 'GET', body = null, opts = {}) {
    await ensureTimeZone();
    const result = await route(endpoint, method, body, opts);
    if (method !== 'GET' && TZ_WRITING_PATH.test(endpoint)) {
      tzReady = null;
      await ensureTimeZone();
    }
    return result;
  }

  // A getter, not a snapshot: buildDomains() replaces the instances, so a
  // property read must land on the current set.
  Object.defineProperty(shimCall, 'domains', {
    enumerable: true,
    get: () => ({
      bp, weight, notes, settings, food, foodAI, workoutSheetAI, foodDb, intake, tzplan, vitals, now, aiClient,
    }),
  });
  shimCall.ensureTimeZone = ensureTimeZone;
  // floorTimeZone (bd med-wi09.19): with neither a pin nor a floor stored,
  // floor the zone this device's dose evidence is in (intake.evidenceZone: the
  // zone every device already projects past days in; its own zone when nothing
  // was logged) as the account's (settings.ensureTimeZoneFloor, clientTs 0,
  // putIfAbsent). Only when opts.canFloor says so: not before a pull in this
  // page load reached the tail or while a move pickup is pending, so an
  // offline-booted or freshly unlocked device never floors over an account
  // another device already floored; a race that slips through is settled by
  // sync's tzfloor reducer. Local-only mode (portFactory) never floors: one
  // device, nothing to keep in step, and it keeps following the device zone.
  // Resolves true when it wrote a floor.
  shimCall.floorTimeZone = async () => {
    if (portFactory || !(await canFloor())) return false;
    if ((await settings.getGeneral()).timezone_source !== 'device') return false;
    await settings.ensureTimeZoneFloor(await intake.evidenceZone());
    tzReady = null;
    await ensureTimeZone();
    return true;
  };
  return shimCall;
}

// installApiShim wires the router to window.offlineAwareApiCall (the seam
// web/static/js/core/api.js delegates through) plus the browser-direct globals
// that bypass /api entirely, and writes the ledger cut. Signature
// and return value unchanged: it resolves to the router itself.
// now/timeZone are forwarded straight to createApiRouter (both routers, so the
// two agree on the clock) — the same test-only override it documents, reachable
// from the shim-contract harness so a suite can pin the wall clock.
// recordsPort/effects/rxnorm/operatorFoodDb are createApiRouter's local-mode
// swaps, forwarded to both routers; registerEgress replaces the server-side
// egress allowlist upload (local mode tells the iOS shell instead, which
// serves its own CSP).
export function installApiShim(ctx, {
  records, recordsPort: portFactory, effects, rxnorm, operatorFoodDb, protection, registerEgress = registerEgressHosts,
  registerEgressTimeoutMs = 15000,
  win, now: nowOverride, timeZone: timeZoneOverride, caughtUp, documentPolicy,
  // Read at call time so a test's fake timers apply.
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
} = {}) {
  const targetWindow = win || (typeof window !== 'undefined' ? window : undefined);
  const clockNow = nowOverride || (() => Date.now());
  const onDoseBoundary = (atMs) => armDoseClock(atMs, clockNow(), timers, targetWindow);
  // Two routers over the same records store, differing only in the origin they
  // stamp on writes (med-dvr):
  //
  //   shimCall  — the UI seam (offlineAwareApiCall / apiCallDirect). Its writes
  //               must NOT raise "New data is available": the screen that made
  //               them has already repainted.
  //   bgCall    — everything else that writes from inside this tab: the voice
  //               agent's MCP dispatcher, the browser-direct food-AI client, and
  //               the ledger-cut write. None of these is a user action on
  //               the current screen, so all of them must repaint it.
  //
  // A test's injected `records` port carries its own origin and is shared by
  // both, which keeps the harness a drop-in swap.
  // rxnorm: undefined takes the router's default port; null turns it off.
  const shared = {
    recordsPort: portFactory, effects, rxnorm, operatorFoodDb, protection, now: nowOverride, timeZone: timeZoneOverride, win, caughtUp,
    onDoseBoundary, documentPolicy: documentPolicy ? Object.freeze({ origins: documentPolicy.origins, origin: documentPolicy.origin }) : undefined,
  };
  const shimCall = createApiRouter(ctx, { records, origin: ORIGIN_UI, ...shared });
  const bgCall = records ? shimCall : createApiRouter(ctx, { origin: ORIGIN_EXTERNAL, ...shared });
  // Snapshotted on purpose — every use below reads integrations or a product
  // search, never the wall clock, so these survive a buildDomains() rebuild when
  // the pinned settings.timezone resolves (bd med-7ujt). Anything TIME-sensitive
  // must go through `.domains` at call time, the way the ledger-cut write
  // does below.
  const {
    settings, foodDb, now, aiClient,
  } = shimCall.domains;
  const {
    food, foodAI, workoutSheetAI,
  } = bgCall.domains;

  // Task 4's frontend bypass guards (photo.js/log.js/products.js — raw fetch
  // to the AI + search endpoints) call these directly, entirely outside the
  // router's route table: the AI provider call and the food-DB search both go
  // straight from the browser, never through any /api surface.
  targetWindow.CloudFoodAI = foodAI;
  targetWindow.CloudWorkoutSheetAI = workoutSheetAI;
  // remoteConfigured lets products.js distinguish "no food DB configured" from
  // "no matches" — without it an unconfigured operator renders as an empty
  // result set and the user blames the search (med-1j1). remoteHint says why
  // (local mode: the trial is off, or today's lookups are spent).
  targetWindow.CloudFoodSearch = {
    search: food.search, remoteConfigured: foodDb.remoteConfigured, remoteHint: foodDb.remoteHint,
  };
  // Voice: elevenlabs-call.js's fetchSignedURL() branches on
  // window.__MEDTRACKER_CLOUD__ to mint the signed URL browser-direct here
  // (BYO ElevenLabs key from the vault; never crosses /api).
  targetWindow.CloudElevenLabs = createElevenLabsClient({ settingsDomain: settings });
  // Auto-provisioning: creates the ElevenLabs client tools + a MedTracker agent
  // from code (browser-direct with the vault key) so the user configures only
  // the API key. elevenlabs-call.js calls provision() before minting the
  // signed URL. See web/cloud/js/elevenlabs-agent.js.
  // The agent's LLM is the voice relay on this account subdomain (bd med-h849):
  // the existing /api/* forward reaches internal/cloudserver/voice_llm_relay.go.
  targetWindow.CloudElevenLabsAgent = createElevenLabsAgentProvisioner({
    settingsDomain: settings,
    llmURL: `${targetWindow.location.origin}/api/voice-llm`,
    productName: targetWindow.document.querySelector('meta[name="medtracker-product-name"]')?.content || undefined,
  });
  // Voice MCP tools: elevenlabs-call.js registers mcp_help/mcp_call clientTools
  // (cloud only) that dispatch straight into this in-tab catalog — through this
  // very router, no relay/crypto (the relay responder in mcp-responder.js only
  // exists in the Claude-connector-elected tab and builds its own router over
  // the same records port, so this is the clean reuse seam).
  targetWindow.CloudMCPDispatcher = createDispatcher({ router: bgCall, now });
  // Voice LLM relay (bd med-h849.2): the ElevenLabs agent's completions come
  // back to this tab over /api/voice-llm/device and go to the user's own AI
  // (vault key, or the trial proxy) via aiClient.chatStream. elevenlabs-call.js
  // start()s it before minting the signed URL and stop()s it on hang-up.
  targetWindow.CloudVoiceLLM = createVoiceLLMResponder({ aiClient });

  // Ledger v2 activation (bd med-wi09.12): no dose sweep, no timer — doses are
  // derived (the projection regenerates them from the ledger cut). On install
  // this client writes the ledgercut singleton (floored, put-if-absent), whose
  // first op sets the account's cut and arms the server's writer gate against
  // pre-v2 bundles. Skipped during a store replace (materialize-gate.js); the
  // next page load writes it.
  materializing(async () => {
    try {
      await bgCall.domains.intake.ensureLedgerCut();
    } catch (e) {
      console.error('[cloud shim] ledger cut write failed', e);
    }
  }).catch(() => {});

  // Egress allowlist (CSP scoping). Tell the server which provider HOSTNAMES
  // this account connects to browser-direct so /'s connect-src can be scoped to
  // exactly them + api.elevenlabs.io instead of a wildcard https: (which lets
  // on-origin XSS exfil the DEK anywhere). Hostnames only — never keys or
  // health data. See docs/cloud-crypto.md.
  const boundFetch = typeof targetWindow.fetch === 'function'
    ? targetWindow.fetch.bind(targetWindow) : undefined;
  let lastEgressHosts = null; // comma-joined last-registered set, for change detection
  let registration = Promise.resolve({ state: 'pending' });
  function registerCurrentEgress() {
    // Serial registration prevents an older slow upload from replacing the
    // newest saved host set after its registration was reported successful.
    registration = registration.then(() => {
      const controller = new AbortController();
      let timer;
      const work = Promise.resolve().then(() => registerEgress({ settings, fetchImpl: boundFetch, signal: controller.signal }));
      // Cloud fetch is abortable. The native callback has no cancellation/
      // deadline contract and retains reload authority until real settlement.
      const outcome = registerEgressTimeoutMs > 0 ? Promise.race([
        work,
        new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, registerEgressTimeoutMs); }),
      ]) : work;
      return outcome.then((result) => {
        const hosts = Array.isArray(result) ? result : result?.hosts;
        if (!Array.isArray(hosts)) return { state: 'failed' };
        const key = hosts.join(',');
        if (lastEgressHosts !== null && key !== lastEgressHosts && !result?.reloading) {
          targetWindow.SyncManager?.showToast?.('New provider saved — reload to apply it on this device', 'info');
        }
        lastEgressHosts = key;
        return { state: result?.reloading ? 'reloading' : 'registered' };
      }).catch(() => ({ state: 'failed' })).finally(() => clearTimeout(timer));
    });
  }
  registerCurrentEgress();

  // A provider URL change (Settings → Integrations save) must re-scope the CSP.
  // The save flows through offlineAwareApiCall as PATCH /api/settings/integrations,
  // so wrap the router: re-register the hosts and — only if the host set actually
  // changed — hint that the new allowlist applies on the next document load.
  async function offlineAwareApiCall(endpoint, method = 'GET', body = null, opts = {}) {
    const result = await shimCall(endpoint, method, body, opts);
    if (method === 'PATCH' && String(endpoint).split('?')[0] === '/api/settings/integrations') {
      registerCurrentEgress();
    }
    return result;
  }
  // Getter, mirroring shimCall.domains — a snapshot here would pin the pre-
  // timezone-resolve instances for every consumer of the installed seam.
  Object.defineProperty(offlineAwareApiCall, 'domains', { enumerable: true, get: () => shimCall.domains });
  offlineAwareApiCall.ensureTimeZone = shimCall.ensureTimeZone;
  // Direct in-memory UI port: raw draft keys never enter core/api's network
  // fallback, write queue, route logging or API cache. Old/missing shims simply
  // have no Check capability; existing AI operations remain unchanged.
  offlineAwareApiCall.aiKeyCheckPermission = (args) => aiClient.keyCheckPermission(args);
  offlineAwareApiCall.checkAIKey = (args) => aiClient.checkKey(args);
  offlineAwareApiCall.aiProviderRegistration = () => registration;
  // The boot's account-zone floor (bd med-wi09.19), on the background router so
  // a floor that moves the zone repaints the open screens.
  offlineAwareApiCall.floorTimeZone = bgCall.floorTimeZone;
  // One sleep model, no stress (bd med-0xad.4, vitals.js unifyLegacy): the
  // boot calls it (local-boot.js after the leave pickup; cloud-boot.js only
  // once a pull in this page load reached the tail, sync.js
  // pulledThisSession: a stale mirror would convert a partial night at a
  // later now() and outrank the full one). A no-op once nothing legacy is
  // left; skipped during a store replace (importAll runs its own).
  offlineAwareApiCall.unifyLegacy = () => materializing(() => bgCall.domains.vitals.unifyLegacy());

  targetWindow.offlineAwareApiCall = offlineAwareApiCall;
  return offlineAwareApiCall;
}
