// Runtime-agnostic full-vault export/import for cloud mode (C2e Task 5). Pure
// transforms over the cloud record set — no window/document/fetch/IndexedDB —
// so the same source can later run inside the Go server via goja (C6). The
// cloud shell wires these to window.CloudVault (web/cloud/js/cloud-boot.js):
// exportAll reads every live record and calls recordsToVault; importAll calls
// vaultToRecords then replaceAllRecords + one forced snapshot upload.
//
// The canonical format is docs/vault-format.md — the same golden fixture
// (tests/fixtures/vault-v1.json) the Go exporter/importer target. This module
// is the inverse pair recordsToVault(records) <-> vaultToRecords(vault):
// round-tripping the fixture through both is identity on `data` (the Task 5
// contract, cloud.vault-roundtrip.test.js).
//
// Record-identity conventions encoded here (see docs/cloud-mode.md record
// inventory + the web/domain/*.js modules they mirror):
//   - medication: recordId IS the numeric id (medications.js reads
//     `id: record.recordId`); intake/tzplan FK refs use that number.
//   - foodproduct: recordId is a namespaced string (`foodproduct-<int>` on
//     import, `foodproduct_<ts>_<rand>` native) so a small bot id can't collide
//     with a numeric medication recordId in the shared `records` store; export
//     recovers the numeric id the vault format needs and foodlog.product_id
//     references the namespaced recordId.
//   - workout group/variant/exercise/library/session/miband/exerciselog: a
//     separate numeric body `id` (workout.js mintNumericId); recordId is a
//     distinct string. Scheduled sessions re-mint `session-<groupId>-<date>`,
//     rotation is one-per-group `rotation-<groupId>`.
//   - intake: scheduled slots re-mint `intake-<medId>-<slotUnixSeconds>`;
//     manual (taken_at == scheduled_at) mint `intake-manual-...`.
//   - vitals hr/spo2/stress are day-batched ({day, samples:[...]}); the vault
//     flattens them to per-sample arrays and this packs/unpacks by UTC day.
//   - weightgoal is append-only history (many rows), not a singleton — the
//     vault carries `weight.goals[]` oldest-first; only the newest is current.
//   - singletons: bpgoal, weight-unit, settings, features,
//     taborder, foodtargets, integrations, medreminderpref, bpreminderpref,
//     weightreminderpref, gamification, apitokens, tzplan-current.
//   - the active/pending tz plan stays at `tzplan-current` (what tzplan.js and
//     medintake.js look up by exact recordId); every older plan lands on a
//     `tzplanhistory-<idx>` recordId of the same `tzplan` type, ignored by
//     those readers and re-merged on export.
//   - timezone_history, gamification and api_tokens have no cloud consumer, so
//     imported entries land in passthrough `tzhistory` / `gamification` /
//     `apitokens` stores purely for backup fidelity. The reminder-pref bodies
//     likewise carry the bot-only snoozed_until / dont_remind_until fields
//     verbatim so a cloud round-trip doesn't drop them.
// The `nk` push key + device/voice plumbing are NOT vault-managed (see
// VAULT_MANAGED_TYPES); importAll preserves them across the replace. The two
// secret-bearing types (integrations, apitokens) are managed only when the
// vault actually carries them — see managedTypesForImport.

import { calculateBPCategory } from './bp.js';
import { calculateWeightTrend } from './weight.js';

export const VAULT_FORMAT = 'medtracker-vault';
export const VAULT_VERSION = 1;

// Every recordType this module reads on export / writes on import. importAll
// preserves records whose type is NOT here (nk, voiceprovisioning) so a replace
// never drops device or crypto state.
export const VAULT_MANAGED_TYPES = new Set([
  'medication', 'intake', 'restock',
  'bp', 'bpgoal',
  'weight', 'weightgoal', 'weightunitpref',
  'foodlog', 'foodproduct',
  'workoutgroup', 'workoutvariant', 'workoutexercise', 'exerciselibrary',
  'workoutrotation', 'workoutsession', 'exerciselog', 'miband',
  'sleep', 'daystats', 'hrsample', 'spo2sample', 'stresssample',
  'note',
  'tzplan', 'tzhistory',
  'settings', 'features', 'taborder', 'foodtargets', 'integrations', 'medreminderpref',
  'bpreminderpref', 'weightreminderpref', 'gamification', 'apitokens',
]);

// The tz-plan statuses bot mode treats as the single live plan
// (tz.GetLatestActiveOrPendingTransitionPlan). NOTIFIED is a real persistent
// state the scheduler writes and can sit in for up to 48h before auto-approve,
// so it must map back to the `tzplan-current` recordId that tzplan.js and
// medintake.js look up by exact id.
const ACTIVE_PLAN_STATUSES = new Set(['PENDING_APPROVAL', 'NOTIFIED', 'APPROVED']);

// managedTypesForImport narrows VAULT_MANAGED_TYPES for one vault file: the two
// secret-bearing blocks (settings.integrations, api_tokens) import with
// asymmetric semantics — absent means "the export was taken with
// include_secrets=0, leave the destination's values alone", so their record
// types must NOT be wiped by the replace. Mirrors importAPITokens /
// importSettings in internal/server/vault_import.go.
export function managedTypesForImport(vault) {
  const types = new Set(VAULT_MANAGED_TYPES);
  const data = (vault && vault.data) || {};
  if (!(data.settings && data.settings.integrations)) types.delete('integrations');
  if (!data.api_tokens) types.delete('apitokens');
  return types;
}

const META_FIELDS = new Set(['recordType', 'recordId', 'clientTs', 'deleted']);

// stripMeta returns the record body (everything except the sync bookkeeping
// fields). Optionally drops extra derived/minted fields not part of the vault.
function stripMeta(rec, drop = []) {
  const dropSet = new Set(drop);
  const out = {};
  for (const k of Object.keys(rec)) {
    if (META_FIELDS.has(k) || dropSet.has(k)) continue;
    out[k] = rec[k];
  }
  return out;
}

// toRFC3339 renders a ms epoch as second-precision UTC (dropping the .000 the
// bare toISOString() appends) so a tz-plan step round-trips byte-identical to
// the "2026-07-10T07:00:00Z" wire form. The tz-plan body stores ms (what
// planDosesWithTzPlan reads); the vault wants the string.
function toRFC3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// utcDay renders the UTC calendar day of an RFC3339 timestamp — the day-batch
// key for vitals samples (a fixed grid regardless of tz_offset, matching the
// fixture's 07-07/07-08 boundary split of Z-form sample times).
function utcDay(dateTime) {
  return new Date(Date.parse(dateTime)).toISOString().slice(0, 10);
}

function sortBy(arr, keyFn) {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Export: records -> vault
// ---------------------------------------------------------------------------

export function recordsToVault(records, { now, includeSecrets = true } = {}) {
  const byType = new Map();
  for (const rec of records) {
    if (rec.deleted) continue;
    const list = byType.get(rec.recordType);
    if (list) list.push(rec);
    else byType.set(rec.recordType, [rec]);
  }
  const pick = (type) => byType.get(type) || [];
  const singleton = (type, recordId) => pick(type).find((r) => r.recordId === recordId) || null;

  // --- medications ---
  const medications = {
    items: sortBy(pick('medication'), (r) => Number(r.recordId))
      .map((r) => ({ id: r.recordId, ...stripMeta(r) })),
    intakes: sortBy(pick('intake'), (r) => `${r.scheduled_at}-${r.medication_id}`)
      .map((r) => stripMeta(r)),
    restocks: sortBy(pick('restock'), (r) => r.restocked_at)
      .map((r) => stripMeta(r)),
  };

  // --- bp ---
  const bpGoal = singleton('bpgoal', 'bpgoal');
  const bp = {
    readings: sortBy(pick('bp'), (r) => r.measured_at)
      .map((r) => stripMeta(r, ['category'])),
    goal: bpGoal ? stripMeta(bpGoal) : null,
  };

  // --- weight ---
  const unitRec = singleton('weightunitpref', 'weight-unit');
  const weight = {
    logs: sortBy(pick('weight'), (r) => r.measured_at)
      .map((r) => stripMeta(r, ['weight_trend'])),
    // Append-only goal history, oldest first — not just the current goal.
    goals: sortBy(pick('weightgoal'), (r) => r.set_at).map((r) => stripMeta(r)),
    unit_pref: unitRec ? (unitRec.unit === 'lb' ? 'lb' : 'kg') : null,
  };

  // --- food ---
  // foodproduct recordIds are namespaced strings, so recover the plain number
  // the vault format (and bot mode's int64 id/product_id columns) require: parse
  // the `foodproduct-<int>` form, else assign a fresh id past the highest parsed
  // one (legacy native `foodproduct_<ts>_<rand>` products). foodlog.product_id is
  // remapped through the same map so references stay intact.
  const productList = pick('foodproduct');
  const productNumericId = new Map();
  let synthProductId = productList.reduce((m, r) => {
    const parsed = /^foodproduct-(\d+)$/.exec(String(r.recordId));
    return parsed ? Math.max(m, Number(parsed[1])) : m;
  }, 0);
  for (const r of productList) {
    const parsed = /^foodproduct-(\d+)$/.exec(String(r.recordId));
    productNumericId.set(r.recordId, parsed ? Number(parsed[1]) : (synthProductId += 1));
  }
  const productsByRecordId = new Map(productList.map((r) => [r.recordId, r]));
  const food = {
    logs: sortBy(pick('foodlog'), (r) => r.eaten_at).map((r) => {
      const body = stripMeta(r);
      const product = body.product_id != null ? productsByRecordId.get(body.product_id) : null;
      const out = {
        eaten_at: body.eaten_at,
        weight: body.weight,
        carbs: body.carbs,
        protein: body.protein,
        fat: body.fat,
        calories: body.calories,
        is_meal: !!(product && product.is_meal),
      };
      if (body.name) out.name = body.name;
      if (body.product_id != null) {
        const mapped = productNumericId.get(body.product_id);
        if (mapped != null) out.product_id = mapped;
      }
      return out;
    }),
    products: sortBy(productList, (r) => productNumericId.get(r.recordId))
      .map((r) => ({ id: productNumericId.get(r.recordId), ...stripMeta(r) })),
  };

  // --- workouts ---
  const workoutFK = (type, keyFn) => sortBy(pick(type), keyFn).map((r) => stripMeta(r));
  const workouts = {
    groups: workoutFK('workoutgroup', (r) => r.id),
    variants: workoutFK('workoutvariant', (r) => r.id),
    exercises: workoutFK('workoutexercise', (r) => r.id),
    library: workoutFK('exerciselibrary', (r) => r.id),
    rotations: sortBy(pick('workoutrotation'), (r) => r.group_id).map((r) => stripMeta(r)),
    sessions: workoutFK('workoutsession', (r) => r.id),
    exercise_logs: sortBy(pick('exerciselog'), (r) => `${r.session_id}-${r.logged_at}`)
      .map((r) => stripMeta(r, ['id'])),
    miband: sortBy(pick('miband'), (r) => r.source_start_ms)
      .map((r) => stripMeta(r, ['id'])),
  };

  // --- vitals ---
  const unpackSamples = (type) => {
    const out = [];
    for (const rec of pick(type)) {
      if (!Array.isArray(rec.samples)) continue;
      for (const s of rec.samples) out.push(s);
    }
    return sortBy(out, (s) => s.date_time);
  };
  const vitals = {
    sleep: sortBy(pick('sleep'), (r) => r.start_time).map((r) => stripMeta(r)),
    day_stats: sortBy(pick('daystats'), (r) => r.day).map((r) => stripMeta(r)),
    heart: unpackSamples('hrsample'),
    spo2: unpackSamples('spo2sample'),
    stress: unpackSamples('stresssample'),
  };

  // --- diary ---
  const diary = {
    notes: sortBy(pick('note'), (r) => r.created_at).map((r) => stripMeta(r)),
  };

  // --- tz (current plan + tzplanhistory-* merged back into one oldest-first list) ---
  const general = singleton('settings', 'settings');
  const tz = {
    current: general ? (general.timezone || null) : null,
    history: sortBy(pick('tzhistory'), (r) => r.changed_at).map((r) => stripMeta(r)),
    transition_plans: sortBy(pick('tzplan'), (r) => r.created_at).map(planToVault),
  };

  // --- settings ---
  const featuresRec = singleton('features', 'features');
  const taborderRec = singleton('taborder', 'taborder');
  const foodtargetsRec = singleton('foodtargets', 'foodtargets');
  const integrationsRec = singleton('integrations', 'integrations');
  const medreminderRec = singleton('medreminderpref', 'medreminderpref');
  const settings = {
    timezone: general ? (general.timezone || '') : '',
    dismissed_tz_suggestion: general ? (general.dismissed_tz_suggestion || '') : '',
    features: featuresRec ? { ...featuresRec.flags } : {},
    tab_order: taborderRec ? taborderRec.order : null,
    food_targets: foodtargetsRec
      ? {
        calories: foodtargetsRec.calories,
        carbs: foodtargetsRec.carbs,
        protein: foodtargetsRec.protein,
        fat: foodtargetsRec.fat,
      }
      : null,
    // Present-but-empty (not null) when there are no keys: `absent` is the only
    // value meaning "leave the destination alone". Mirrors bot mode, which
    // always emits the block under include_secrets=1.
    integrations: integrationsRec ? stripMeta(integrationsRec) : {},
    med_reminder_pref: medreminderRec ? { enabled: !!medreminderRec.enabled } : null,
  };
  const bpReminderRec = singleton('bpreminderpref', 'bpreminderpref');
  const weightReminderRec = singleton('weightreminderpref', 'weightreminderpref');
  if (bpReminderRec) settings.bp_reminder = reminderToVault(bpReminderRec);
  if (weightReminderRec) settings.weight_reminder = reminderToVault(weightReminderRec);
  // include_secrets=0: omit the block entirely (absent, not `null`/`{}` — only
  // absent means "leave the destination's provider keys alone" on import).
  if (!includeSecrets) delete settings.integrations;

  // --- gamification / api_tokens (passthrough; no cloud reader) ---
  const gamRec = singleton('gamification', 'gamification');
  const gamification = {
    targets: (gamRec && gamRec.targets) || [],
    ledger: (gamRec && gamRec.ledger) || [],
    state: (gamRec && gamRec.state) || null,
  };
  const tokensRec = singleton('apitokens', 'apitokens');

  const data = {
    medications, bp, weight, food, workouts, vitals, diary, tz, settings, gamification,
  };
  // Same rule as `integrations`: emit `[]` (not absent) so a restore can clear
  // stale tokens on the destination.
  if (includeSecrets) data.api_tokens = (tokensRec && tokensRec.tokens) || [];

  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    exported_at: toRFC3339(now ?? 0),
    data,
  };
}

// reminderToVault emits the four vault fields from a bp/weight reminder-pref
// record. snoozed_until / dont_remind_until have no cloud feature behind them —
// importAll writes them onto the body so they read back here unchanged.
function reminderToVault(rec) {
  return {
    enabled: !!rec.enabled,
    preferred_reminder_hour: rec.preferred_reminder_hour,
    snoozed_until: rec.snoozed_until ?? null,
    dont_remind_until: rec.dont_remind_until ?? null,
  };
}

function planToVault(rec) {
  const out = {};
  // Bot-mode plan id — carried verbatim so intake_log.tz_plan_id keeps
  // resolving after a cloud round-trip. Cloud-native plans have none.
  if (rec.id) out.id = rec.id;
  Object.assign(out, {
    old_tz: rec.old_tz,
    new_tz: rec.new_tz,
    status: rec.status,
    created_at: rec.created_at,
  });
  if (rec.approved_at) out.approved_at = rec.approved_at;
  // Passthrough bot-only plan metadata — no cloud reader, carried for fidelity.
  if (rec.notified_at) out.notified_at = rec.notified_at;
  out.plan_hash = rec.plan_hash || '';
  out.inputs_json = rec.inputs_json || '';
  if (rec.user_action) out.user_action = rec.user_action;
  out.steps = (Array.isArray(rec.steps) ? rec.steps : []).map((s) => ({
    medication_id: s.medicationId,
    med_name: s.medName,
    step_number: s.stepNumber,
    total_steps: s.totalSteps,
    scheduled_at: toRFC3339(s.scheduledAtMs),
    note: s.note,
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Import: vault -> records
// ---------------------------------------------------------------------------

export function vaultToRecords(vault, { now } = {}) {
  // Guard the destructive replace: importAll wipes the whole record store, so a
  // wrong/foreign/future file must be rejected BEFORE that (mirrors bot mode's
  // validateVault 400 in internal/server/vault_import.go). Without this, any
  // parseable JSON (an empty {}, another app's export, a v2 backup) silently
  // wipes every record and replaces it with nothing.
  if (!vault || vault.format !== VAULT_FORMAT || vault.version !== VAULT_VERSION) {
    throw new Error(
      `Not a ${VAULT_FORMAT} v${VAULT_VERSION} backup (got format ${JSON.stringify(vault && vault.format)}, version ${JSON.stringify(vault && vault.version)})`
    );
  }
  const nowMs = now ?? 0;
  const data = (vault && vault.data) || {};
  const out = [];
  let seq = 0;
  const mintNum = () => nowMs * 1000 + (seq += 1);
  const base = () => ({ clientTs: nowMs, deleted: false });
  // Meta fields are spread LAST: `body` comes verbatim from the file, and a
  // hand-edited or truncated vault must not be able to set recordId/recordType/
  // deleted from inside a domain object. A bad recordId is fatal downstream —
  // importAll's replaceAllRecords clears the store before put()ing, and an
  // undefined out-of-line key throws mid-transaction, leaving zero records — so
  // validate here, before anything destructive runs.
  const usedIds = new Set();
  const push = (recordType, recordId, body) => {
    const ok = (typeof recordId === 'string' && recordId !== '') || Number.isFinite(recordId);
    if (!ok) throw new Error(`Corrupt backup: ${recordType} entry has no usable id`);
    // Bot schemas allow rows that mint the same recordId (two workout_sessions
    // for one group+day). Suffix rather than silently overwrite.
    let unique = recordId;
    for (let n = 2; usedIds.has(`${recordType}:${unique}`); n += 1) unique = `${recordId}-${n}`;
    usedIds.add(`${recordType}:${unique}`);
    out.push({ ...body, recordType, recordId: unique, ...base() });
  };

  // --- medications (recordId IS the numeric id) ---
  const meds = data.medications || {};
  for (const item of meds.items || []) {
    const { id, ...body } = item;
    push('medication', id, body);
  }
  for (const it of meds.intakes || []) {
    const manual = it.taken_at != null && it.taken_at === it.scheduled_at;
    // A tz_step dose and its shadowed 'schedule' sibling legitimately share
    // (medication_id, scheduled_at) in bot mode, so the source must be part of
    // the id. 'schedule' keeps the bare form the live cloud readers look up.
    const scheduledMs = Date.parse(it.scheduled_at);
    // A missing/garbage scheduled_at would mint `intake-<med>-NaN`, which push()
    // accepts (non-empty string) and the live readers can never look up — the
    // dose silently disappears after the destructive replace. Fail the import.
    if (!Number.isFinite(scheduledMs)) {
      throw new Error(`Corrupt backup: intake has unparseable scheduled_at ${JSON.stringify(it.scheduled_at)}`);
    }
    const slot = `intake-${it.medication_id}-${Math.floor(scheduledMs / 1000)}`;
    const recordId = manual
      ? `intake-manual-${nowMs}-${seq += 1}`
      : (it.source && it.source !== 'schedule' ? `${slot}-${it.source}` : slot);
    push('intake', recordId, { ...it });
  }
  for (const r of meds.restocks || []) push('restock', mintNum(), { ...r });

  // --- bp ---
  const bp = data.bp || {};
  for (const r of bp.readings || []) {
    const category = r.ignore_calc ? '' : calculateBPCategory(r.systolic, r.diastolic);
    push('bp', `bp-${mintNum()}`, { ...r, category });
  }
  if (bp.goal) push('bpgoal', 'bpgoal', { ...bp.goal });

  // --- weight (compute the derived trend the same way weight.js create does) ---
  const weight = data.weight || {};
  const ascLogs = sortBy(weight.logs || [], (r) => r.measured_at);
  let prevTrend = null;
  for (const log of ascLogs) {
    const trend = calculateWeightTrend(log.weight, prevTrend);
    prevTrend = trend;
    push('weight', `weight-${mintNum()}`, { ...log, weight_trend: trend });
  }
  for (const g of weight.goals || []) push('weightgoal', `weightgoal-${mintNum()}`, { ...g });
  if (weight.unit_pref) push('weightunitpref', 'weight-unit', { unit: weight.unit_pref === 'lb' ? 'lb' : 'kg' });

  // --- food (products get a namespaced recordId so their small bot ids can't
  // collide with a numeric medication recordId in the shared `records` store;
  // logs reference that namespaced recordId) ---
  const food = data.food || {};
  for (const p of food.products || []) {
    const { id, ...body } = p;
    push('foodproduct', `foodproduct-${id}`, body);
  }
  for (const l of food.logs || []) {
    const { is_meal, ...body } = l; // is_meal is derived from the product on read
    const productId = body.product_id != null ? `foodproduct-${body.product_id}` : null;
    push('foodlog', `foodlog-${mintNum()}`, { ...body, product_id: productId });
  }

  // --- workouts (separate numeric body id + a distinct recordId) ---
  const workouts = data.workouts || {};
  for (const g of workouts.groups || []) push('workoutgroup', `group-${g.id}`, { ...g });
  for (const v of workouts.variants || []) push('workoutvariant', `variant-${v.id}`, { ...v });
  for (const e of workouts.exercises || []) push('workoutexercise', `exercise-${e.id}`, { ...e });
  for (const li of workouts.library || []) push('exerciselibrary', `library-${li.id}`, { ...li });
  for (const rot of workouts.rotations || []) push('workoutrotation', `rotation-${rot.group_id}`, { ...rot });
  for (const s of workouts.sessions || []) {
    const recordId = s.group_id === -1
      ? `session-adhoc-${s.id}`
      : `session-${s.group_id}-${String(s.scheduled_date).slice(0, 10)}`;
    push('workoutsession', recordId, { ...s });
  }
  for (const el of workouts.exercise_logs || []) push('exerciselog', `log-${mintNum()}`, { ...el, id: mintNum() });
  for (const w of workouts.miband || []) {
    // gps is 44% of a real vault (~77 MiB) and nothing renders it in either
    // mode, yet it rides in every snapshot and is structured-cloned on every
    // records.list(). Drop it at the door; bot mode's DB keeps the tracks.
    const { gps, ...rest } = w;
    // Deterministic natural key (source instant), matching the .nxk migration
    // path in vitals.js importSamples (`miband-${w.source_start_ms}`, id derived
    // from source_start_ms) so both cloud import paths converge on ONE record
    // per session instead of double-inserting — the client mirror of bot mode's
    // UNIQUE(source_start_ms). Was mintNum() (import-wall-clock). See med-1tj.
    push('miband', `miband-${w.source_start_ms}`, { ...rest, id: w.source_start_ms });
  }

  // --- vitals (pack the flat sample arrays back into day-batches) ---
  // With no clock (nowMs 0) the cutoff goes negative and every sample counts as
  // fresh — a caller that can't say when "now" is gets no downsampling rather
  // than a silently-collapsed history.
  const sampleCutoffMs = nowMs - DOWNSAMPLE_AFTER_MS;
  const vitals = data.vitals || {};
  for (const sl of vitals.sleep || []) {
    // Deterministic natural key (sleep-onset instant), matching the .nxk
    // migration path in vitals.js importSamples (start_time ms, day fallback for
    // an unparseable stamp) so both cloud import paths converge on ONE record
    // per night instead of double-inserting — the client mirror of bot mode's
    // UNIQUE(user_id, start_time). Was mintNum() (import-wall-clock). See med-1tj.
    const startMs = Date.parse(sl.start_time);
    const key = Number.isNaN(startMs) ? sl.day : startMs;
    push('sleep', `sleep-${key}`, { ...sl });
  }
  for (const ds of vitals.day_stats || []) push('daystats', `daystats-${ds.day}`, { ...ds });
  packSamples('hrsample', vitals.heart || [], push, sampleCutoffMs);
  packSamples('spo2sample', vitals.spo2 || [], push, sampleCutoffMs);
  packSamples('stresssample', vitals.stress || [], push, sampleCutoffMs);

  // --- diary (numeric-string recordId, as notes.js mints) ---
  for (const n of (data.diary || {}).notes || []) push('note', String(mintNum()), { ...n });

  // --- tz ---
  const tz = data.tz || {};
  let historyIdx = 0;
  for (const h of tz.history || []) push('tzhistory', `tzhistory-${historyIdx += 1}`, { ...h });
  // The newest active/pending plan keeps the `tzplan-current` recordId the live
  // readers look up (tzplan.js, medintake.js); older/finished plans are carried
  // as tzplanhistory-<idx> of the same type, invisible to those exact-id reads.
  const plans = sortBy(tz.transition_plans || [], (p) => p.created_at);
  let currentIdx = -1;
  plans.forEach((p, i) => {
    // Same active set as bot mode's GetLatestActiveOrPendingTransitionPlan.
    if (ACTIVE_PLAN_STATUSES.has(p.status)) currentIdx = i;
  });
  let planIdx = 0;
  plans.forEach((p, i) => {
    const recordId = i === currentIdx ? 'tzplan-current' : `tzplanhistory-${planIdx += 1}`;
    push('tzplan', recordId, planFromVault(p));
  });

  // --- settings ---
  const settings = data.settings || {};
  const generalBody = {};
  if (settings.timezone !== undefined || tz.current) generalBody.timezone = settings.timezone || tz.current || '';
  generalBody.dismissed_tz_suggestion = settings.dismissed_tz_suggestion || '';
  push('settings', 'settings', generalBody);
  if (settings.features) push('features', 'features', { flags: { ...settings.features } });
  if (settings.tab_order) push('taborder', 'taborder', { order: [...settings.tab_order] });
  if (settings.food_targets) push('foodtargets', 'foodtargets', { ...settings.food_targets });
  if (settings.integrations) push('integrations', 'integrations', { ...settings.integrations });
  if (settings.med_reminder_pref) push('medreminderpref', 'medreminderpref', { enabled: !!settings.med_reminder_pref.enabled });
  if (settings.bp_reminder) push('bpreminderpref', 'bpreminderpref', reminderFromVault(settings.bp_reminder));
  if (settings.weight_reminder) push('weightreminderpref', 'weightreminderpref', reminderFromVault(settings.weight_reminder));

  // --- gamification / api_tokens (passthrough singletons; absent api_tokens
  // leaves the destination's tokens alone — see managedTypesForImport) ---
  const gam = data.gamification;
  if (gam) {
    push('gamification', 'gamification', {
      targets: gam.targets || [], ledger: gam.ledger || [], state: gam.state || null,
    });
  }
  if (data.api_tokens) push('apitokens', 'apitokens', { tokens: [...data.api_tokens] });

  return out;
}

// reminderFromVault keeps the bot-only snoozed_until / dont_remind_until on the
// record body (no cloud reader touches them) so the next export round-trips.
function reminderFromVault(st) {
  return {
    enabled: !!st.enabled,
    preferred_reminder_hour: st.preferred_reminder_hour,
    snoozed_until: st.snoozed_until ?? null,
    dont_remind_until: st.dont_remind_until ?? null,
  };
}

function planFromVault(plan) {
  const body = {
    ...(plan.id ? { id: plan.id } : {}),
    old_tz: plan.old_tz,
    new_tz: plan.new_tz,
    status: plan.status,
    created_at: plan.created_at,
    steps: (Array.isArray(plan.steps) ? plan.steps : []).map((s) => ({
      medicationId: s.medication_id,
      medName: s.med_name,
      stepNumber: s.step_number,
      totalSteps: s.total_steps,
      scheduledAtMs: Date.parse(s.scheduled_at),
      note: s.note,
    })),
  };
  if (plan.approved_at) body.approved_at = plan.approved_at;
  if (plan.notified_at) body.notified_at = plan.notified_at;
  if (plan.plan_hash) body.plan_hash = plan.plan_hash;
  if (plan.inputs_json) body.inputs_json = plan.inputs_json;
  if (plan.user_action) body.user_action = plan.user_action;
  return body;
}

// Beyond this age, per-sample resolution is carried only to be discarded:
// vitals.js renders HOURLY buckets (bucketVitals) over a 7d/30d window, and
// avg7d/avg30d are means over that window. The UI window starts at
// todayStart - 29*DAY_MS, so 60d leaves a full month of margin as time passes.
const DOWNSAMPLE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// hourlyAverages collapses samples to one per UTC hour, value = round(mean).
// UTC-hour alignment matches bucketVitals (Go's time.Truncate(time.Hour)
// truncates the absolute instant, not the local wall clock), so bucketVitals
// over the downsampled samples reproduces exactly the same buckets it would
// have produced over the raw ones.
//
// The shape is unchanged — {date_time, tz_offset, value} — so vitals.js needs
// no change, no new record type, no vault-format bump. Two deliberate losses,
// both invisible: a bucket's min/max collapse to its mean (bucketVitals only
// ever surfaces min/max inside the 30d window, which stays raw), and a stress
// sample's `info` label is dropped (a text label has no mean).
//
// Idempotent: re-importing a cloud export re-buckets already-hourly samples to
// themselves — one sample per hour, mean of one value, date_time already at the
// hour start. A fixed point, so repeated import/export never drifts.
function hourlyAverages(samples) {
  const byHour = new Map();
  for (const s of samples) {
    const hour = Math.floor(Date.parse(s.date_time) / HOUR_MS) * HOUR_MS;
    const b = byHour.get(hour);
    if (b) {
      b.sum += s.value;
      b.count += 1;
    } else {
      byHour.set(hour, { sum: s.value, count: 1, tz_offset: s.tz_offset });
    }
  }
  return [...byHour.entries()].map(([hour, b]) => ({
    // Match the wire form of the samples we pass through untouched (no millis).
    date_time: new Date(hour).toISOString().replace('.000Z', 'Z'),
    tz_offset: b.tz_offset,
    value: Math.round(b.sum / b.count),
  }));
}

// packSamples groups the vault's flat per-sample array into one day-batched
// record per UTC calendar day ({day, samples:[...]}), the storage shape
// vitals.js readSamples expects. Samples within a batch stay ascending.
//
// Samples older than cutoffMs are hourly-averaged first: on a real 3-year
// archive the raw heart/spo2/stress streams are 105 MiB (57% of the vault) that
// the UI can never display. cutoffMs is relative to import time, not to the
// vault's exported_at.
function packSamples(recordType, samples, push, cutoffMs) {
  const fresh = [];
  const old = [];
  for (const s of samples) (Date.parse(s.date_time) >= cutoffMs ? fresh : old).push(s);

  const byDay = new Map();
  for (const s of [...hourlyAverages(old), ...fresh]) {
    const day = utcDay(s.date_time);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(s);
    else byDay.set(day, [s]);
  }
  for (const [day, daySamples] of byDay) {
    push(recordType, `${recordType}-${day}`, {
      day,
      samples: sortBy(daySamples, (s) => s.date_time).map((s) => ({ ...s })),
    });
  }
}
