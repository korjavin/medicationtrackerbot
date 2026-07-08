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
//   - medication / foodproduct: recordId IS the numeric id (medications.js /
//     food.js read `id: record.recordId`); FK refs use that number.
//   - workout group/variant/exercise/library/session/miband/exerciselog: a
//     separate numeric body `id` (workout.js mintNumericId); recordId is a
//     distinct string. Scheduled sessions re-mint `session-<groupId>-<date>`,
//     rotation is one-per-group `rotation-<groupId>`.
//   - intake: scheduled slots re-mint `intake-<medId>-<slotUnixSeconds>`;
//     manual (taken_at == scheduled_at) mint `intake-manual-...`.
//   - vitals hr/spo2/stress are day-batched ({day, samples:[...]}); the vault
//     flattens them to per-sample arrays and this packs/unpacks by UTC day.
//   - singletons: bpgoal, weightgoal, weight-unit, settings, features,
//     taborder, foodtargets, integrations, medreminderpref, tzplan-current.
//   - timezone_history has no cloud consumer, so imported entries land in a
//     passthrough `tzhistory` store purely for backup fidelity.
// The `nk` push key + device/reminder plumbing are NOT vault-managed (see
// VAULT_MANAGED_TYPES); importAll preserves them across the replace.

import { calculateBPCategory } from './bp.js';
import { calculateWeightTrend } from './weight.js';

export const VAULT_FORMAT = 'medtracker-vault';
export const VAULT_VERSION = 1;

// Every recordType this module reads on export / writes on import. importAll
// preserves records whose type is NOT here (nk, bpreminderpref,
// weightreminderpref, voiceprovisioning) so a replace never drops device or
// crypto state.
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
]);

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

export function recordsToVault(records, { now } = {}) {
  const byType = new Map();
  for (const rec of records) {
    if (rec.deleted) continue;
    const list = byType.get(rec.recordType);
    if (list) list.push(rec);
    else byType.set(rec.recordType, [rec]);
  }
  const pick = (type) => byType.get(type) || [];
  const singleton = (type, recordId) => pick(type).find((r) => recordId === undefined || r.recordId === recordId) || null;

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
  const weightGoal = sortBy(pick('weightgoal'), (r) => r.set_at).slice(-1)[0] || null;
  const unitRec = singleton('weightunitpref', 'weight-unit');
  const weight = {
    logs: sortBy(pick('weight'), (r) => r.measured_at)
      .map((r) => stripMeta(r, ['weight_trend'])),
    goal: weightGoal ? stripMeta(weightGoal) : null,
    unit_pref: unitRec ? (unitRec.unit === 'lb' ? 'lb' : 'kg') : null,
  };

  // --- food ---
  const productsById = new Map(pick('foodproduct').map((r) => [r.recordId, r]));
  const food = {
    logs: sortBy(pick('foodlog'), (r) => r.eaten_at).map((r) => {
      const body = stripMeta(r);
      const product = body.product_id != null ? productsById.get(body.product_id) : null;
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
      if (body.product_id != null) out.product_id = body.product_id;
      return out;
    }),
    products: sortBy(pick('foodproduct'), (r) => Number(r.recordId))
      .map((r) => ({ id: r.recordId, ...stripMeta(r) })),
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

  // --- tz ---
  const general = singleton('settings', 'settings');
  const planRec = singleton('tzplan', 'tzplan-current');
  const tz = {
    current: general ? (general.timezone || null) : null,
    history: sortBy(pick('tzhistory'), (r) => r.changed_at).map((r) => stripMeta(r)),
    transition_plan: planRec ? planToVault(planRec) : null,
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
    integrations: integrationsRec ? stripMeta(integrationsRec) : null,
    med_reminder_pref: medreminderRec ? { enabled: !!medreminderRec.enabled } : null,
  };

  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    exported_at: toRFC3339(now ?? 0),
    data: {
      medications, bp, weight, food, workouts, vitals, diary, tz, settings,
    },
  };
}

function planToVault(rec) {
  const out = {
    old_tz: rec.old_tz,
    new_tz: rec.new_tz,
    status: rec.status,
    created_at: rec.created_at,
  };
  if (rec.approved_at) out.approved_at = rec.approved_at;
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
  const push = (recordType, recordId, body) => out.push({
    recordType, recordId, ...base(), ...body,
  });

  // --- medications (recordId IS the numeric id) ---
  const meds = data.medications || {};
  for (const item of meds.items || []) {
    const { id, ...body } = item;
    push('medication', id, body);
  }
  for (const it of meds.intakes || []) {
    const manual = it.taken_at != null && it.taken_at === it.scheduled_at;
    const recordId = manual
      ? `intake-manual-${nowMs}-${seq += 1}`
      : `intake-${it.medication_id}-${Math.floor(Date.parse(it.scheduled_at) / 1000)}`;
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
  if (weight.goal) push('weightgoal', `weightgoal-${mintNum()}`, { ...weight.goal });
  if (weight.unit_pref) push('weightunitpref', 'weight-unit', { unit: weight.unit_pref === 'lb' ? 'lb' : 'kg' });

  // --- food (products keep their numeric id as recordId; logs reference it) ---
  const food = data.food || {};
  for (const p of food.products || []) {
    const { id, ...body } = p;
    push('foodproduct', id, body);
  }
  for (const l of food.logs || []) {
    const { is_meal, ...body } = l; // is_meal is derived from the product on read
    push('foodlog', `foodlog-${mintNum()}`, { ...body, product_id: body.product_id ?? null });
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
  for (const w of workouts.miband || []) push('miband', `miband-${mintNum()}`, { ...w, id: mintNum() });

  // --- vitals (pack the flat sample arrays back into day-batches) ---
  const vitals = data.vitals || {};
  for (const sl of vitals.sleep || []) push('sleep', `sleep-${mintNum()}`, { ...sl });
  for (const ds of vitals.day_stats || []) push('daystats', `daystats-${ds.day}`, { ...ds });
  packSamples('hrsample', vitals.heart || [], push);
  packSamples('spo2sample', vitals.spo2 || [], push);
  packSamples('stresssample', vitals.stress || [], push);

  // --- diary (numeric-string recordId, as notes.js mints) ---
  for (const n of (data.diary || {}).notes || []) push('note', String(mintNum()), { ...n });

  // --- tz ---
  const tz = data.tz || {};
  let historyIdx = 0;
  for (const h of tz.history || []) push('tzhistory', `tzhistory-${historyIdx += 1}`, { ...h });
  if (tz.transition_plan) push('tzplan', 'tzplan-current', planFromVault(tz.transition_plan));

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

  return out;
}

function planFromVault(plan) {
  const body = {
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
  return body;
}

// packSamples groups the vault's flat per-sample array into one day-batched
// record per UTC calendar day ({day, samples:[...]}), the storage shape
// vitals.js readSamples expects. Samples within a batch stay ascending.
function packSamples(recordType, samples, push) {
  const byDay = new Map();
  for (const s of samples) {
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
