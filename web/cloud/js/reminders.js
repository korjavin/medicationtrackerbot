// Shim-layer glue for the medication reminder horizon (C2b Task 5): reads
// raw medication/intake/tzplan records off the injected records port,
// computes the horizon via web/domain/reminders.js, and uploads it through
// the existing blind push relay (pushSchedule, reused as-is). Debounced so a
// burst of mutations (e.g. confirm-schedule touching several intakes) only
// triggers one upload.
//
// apishim.js calls scheduleReminderRecompute after the medreminderpref
// toggle (wired now) and cloud-boot.js calls it once on unlock; the
// per-mutation call sites for intake/medication/tzplan writes are added in
// Task 7 alongside the route table that wires those domains into the shim in
// the first place — this module only ships the reusable recompute+upload
// primitive.
import { createRemindersDomain } from '../../domain/reminders.js';
import { recordsPort } from './sync.js';
import { pushSchedule, sendTestPush } from './push.js';

export { sendTestPush };

const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';
const TZPLAN_RECORD_TYPE = 'tzplan';
const TZPLAN_RECORD_ID = 'tzplan-current';
const BP_RECORD_TYPE = 'bp';
const WEIGHT_RECORD_TYPE = 'weight';
const DEBOUNCE_MS = 2000;

const timers = new Map();

function defaultTimeZone() {
  return (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
}

export async function computeReminderEntries(ctx, { records: recordsOverride, timeZone: tzOverride } = {}) {
  const records = recordsOverride || recordsPort(ctx);
  const timeZone = tzOverride || defaultTimeZone();
  const now = () => Date.now();
  const remindersDomain = createRemindersDomain({ records, now });

  const [medications, intakes, tzplans, bps, weights] = await Promise.all([
    records.list(MEDICATION_RECORD_TYPE),
    records.list(INTAKE_RECORD_TYPE),
    records.list(TZPLAN_RECORD_TYPE),
    records.list(BP_RECORD_TYPE),
    records.list(WEIGHT_RECORD_TYPE),
  ]);
  const tzPlan = tzplans.find((r) => r.recordId === TZPLAN_RECORD_ID && !r.deleted) || null;

  return remindersDomain.buildHorizon({
    medications: medications.filter((m) => !m.deleted),
    intakes: intakes.filter((i) => !i.deleted),
    bps: bps.filter((b) => !b.deleted),
    weights: weights.filter((w) => !w.deleted),
    timeZone,
    tzPlan,
  });
}

// getDeliveryPref/setDeliveryPref back the cloud notification settings' channel
// + verbosity controls (bd med-76c.1); apishim.js routes the settings writes here.
export function remindersDomain(ctx, { records: recordsOverride } = {}) {
  return createRemindersDomain({ records: recordsOverride || recordsPort(ctx), now: () => Date.now() });
}

export async function recomputeAndPush(ctx, opts = {}) {
  const [entries, pref] = await Promise.all([
    computeReminderEntries(ctx, opts),
    remindersDomain(ctx, opts).getDeliveryPref(),
  ]);
  await pushSchedule(ctx, entries, pref);
}

// scheduleReminderRecompute debounces recomputeAndPush per ctx (keyed by
// ctx.accountId, falling back to ctx itself — same identity assumption
// sync.js's other per-account caches already make).
export function scheduleReminderRecompute(ctx, opts = {}, debounceMs = DEBOUNCE_MS) {
  const key = (ctx && ctx.accountId) || ctx;
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    timers.delete(key);
    recomputeAndPush(ctx, opts).catch((e) => console.error('[reminders] recompute/push failed', e));
  }, debounceMs);
  timers.set(key, timer);
}
