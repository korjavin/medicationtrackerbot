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
import { createRemindersDomain, formatWeeklyDigest, nextWeeklyDigestFireUnix } from '../../domain/reminders.js';
import { createSettingsDomain } from '../../domain/settings.js';
import { createGamificationDomain } from '../../domain/gamification.js';
import { recordsPort } from './sync.js';
import { pushSchedule, sendTestPush } from './push.js';

export { sendTestPush };

const MEDICATION_RECORD_TYPE = 'medication';
const INTAKE_RECORD_TYPE = 'intake';
const TZPLAN_RECORD_TYPE = 'tzplan';
const TZPLAN_RECORD_ID = 'tzplan-current';
const BP_RECORD_TYPE = 'bp';
const WEIGHT_RECORD_TYPE = 'weight';
const WORKOUT_GROUP_RECORD_TYPE = 'workoutgroup';
const WORKOUT_VARIANT_RECORD_TYPE = 'workoutvariant';
const WORKOUT_EXERCISE_RECORD_TYPE = 'workoutexercise';
const WORKOUT_ROTATION_RECORD_TYPE = 'workoutrotation';
const WORKOUT_SESSION_RECORD_TYPE = 'workoutsession';
const DEBOUNCE_MS = 2000;

const timers = new Map();

function defaultTimeZone() {
  return (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
}

export async function computeReminderEntries(ctx, { records: recordsOverride, timeZone: tzOverride } = {}) {
  const records = recordsOverride || recordsPort(ctx);
  const now = () => Date.now();
  const remindersDomain = createRemindersDomain({ records, now });
  // A manually pinned settings.timezone beats both the caller's zone and the
  // device's — same precedence apishim's router applies (bd med-7ujt). This is
  // resolved HERE rather than trusted from opts because cloud-boot.js and the
  // inbox drain both call recomputeAndPush(ctx) with no zone at all, and the
  // horizon they push is exactly the wall-clock-sensitive output. getGeneral()
  // falls back to the injected zone when no record pins one, so this is a
  // no-op for an account that never set it.
  const settingsDomain = createSettingsDomain({ records, now, timeZone: tzOverride || defaultTimeZone() });
  const [features, general] = await Promise.all([
    settingsDomain.getFeatures(),
    settingsDomain.getGeneral(),
  ]);
  const timeZone = general.timezone;

  const [
    medications, intakes, tzplans, bps, weights,
    workoutGroups, workoutVariants, workoutExercises, workoutRotations, workoutSessions,
  ] = await Promise.all([
    records.list(MEDICATION_RECORD_TYPE),
    records.list(INTAKE_RECORD_TYPE),
    records.list(TZPLAN_RECORD_TYPE),
    records.list(BP_RECORD_TYPE),
    records.list(WEIGHT_RECORD_TYPE),
    records.list(WORKOUT_GROUP_RECORD_TYPE),
    records.list(WORKOUT_VARIANT_RECORD_TYPE),
    records.list(WORKOUT_EXERCISE_RECORD_TYPE),
    records.list(WORKOUT_ROTATION_RECORD_TYPE),
    records.list(WORKOUT_SESSION_RECORD_TYPE),
  ]);
  const tzPlan = tzplans.find((r) => r.recordId === TZPLAN_RECORD_ID && !r.deleted) || null;

  const entries = await remindersDomain.buildHorizon({
    medications: medications.filter((m) => !m.deleted),
    intakes: intakes.filter((i) => !i.deleted),
    bps: bps.filter((b) => !b.deleted),
    weights: weights.filter((w) => !w.deleted),
    workoutGroups: workoutGroups.filter((r) => !r.deleted),
    workoutVariants: workoutVariants.filter((r) => !r.deleted),
    workoutExercises: workoutExercises.filter((r) => !r.deleted),
    workoutRotations: workoutRotations.filter((r) => !r.deleted),
    workoutSessions: workoutSessions.filter((r) => !r.deleted),
    workoutEnabled: features.workout,
    timeZone,
    tzPlan,
  });

  const digest = await computeDigestEntry(records, timeZone, now(), features);
  if (digest) entries.push(digest);
  return entries;
}

// Weekly-digest horizon entry (med-eas.58): gated on both the weekly_digest
// feature flag and gamification being on (mirrors the bot's both-on gate,
// weekly_digest.go). The review is anchored on now-24h so it reports the week
// ending at recompute time; unlike the bot (which recomputes AT Sunday 19:00),
// a mid-week recompute forward-schedules a snapshot that can be up to a week
// stale by the time it fires — an accepted blind-relay limitation, self-healing
// for active users. Forward-dated + replace-all means the next Sunday 19:00 is
// re-derived on each recompute — no last-sent state. Both-on gate + failure
// isolation live here: a digest-compute error must NOT reject computeReminderEntries
// (that would strand the already-built medication/BP/weight/workout horizon and
// stop replace-all propagation). The bot isolates weekly_digest as a best-effort
// checker for the same reason — its failure never affects other reminders.
async function computeDigestEntry(records, timeZone, now, features) {
  if (!features.weekly_digest || !features.gamification) return null;

  try {
    const gamification = createGamificationDomain({ records, now: () => now - 86400000, timeZone });
    const review = await gamification.getWeeklyReview();

    return {
      fireAtUnix: nextWeeklyDigestFireUnix(now, timeZone),
      kind: 'digest',
      text: formatWeeklyDigest(review),
      genericText: 'Your weekly summary is ready',
    };
  } catch (e) {
    console.error('[reminders] digest compute failed', e);
    return null;
  }
}

// getDeliveryPref/setDeliveryPref back the cloud notification settings' channel
// + verbosity controls (bd med-76c.1); apishim.js routes the settings writes here.
export function remindersDomain(ctx, { records: recordsOverride } = {}) {
  return createRemindersDomain({ records: recordsOverride || recordsPort(ctx), now: () => Date.now() });
}

export async function recomputeAndPush(ctx, opts = {}) {
  const domain = remindersDomain(ctx, opts);
  const [entries, pref] = await Promise.all([
    computeReminderEntries(ctx, opts),
    domain.getDeliveryPref(),
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

// postRefire is the one request shape both re-fire controls make: a med slot
// stem, session-authed, 204 on success.
//
// A miss is NOT cheap, which is why the response is checked rather than only the
// rejection: the relay's chain re-fires hourly until its 6h cap, so one
// swallowed 5xx on an evening slot is ~6 overnight Telegram nags. A rejected
// fetch or a non-2xx is retried ONCE — the realistic failure is a reverse-proxy
// blip (the same 502/503/504-as-offline case the SW and auth paths already
// assume), and a 404 (no Telegram configured) or a 4xx is not going to change on
// a second attempt, so the retry is bounded at one and a final failure only
// warns. Fire-and-forget: the vault write is already durable, so a failure here
// never blocks the confirm.
// ponytail: one retry, no backoff queue. Persist + replay on next unlock if
// stray nags survive this.
function postRefire(path, callback, extra, fetchImpl) {
  if (!callback) return;
  // Resolved HERE, not as a `fetchImpl = fetch` default parameter: that default
  // is evaluated synchronously at call time, so an environment with no global
  // fetch threw a ReferenceError straight through this fire-and-forget helper
  // and into the caller's already-durable vault write. `f` being undefined
  // instead lands in the try below, which is what fire-and-forget means.
  const f = fetchImpl || globalThis.fetch;
  const post = () => f(`/api/telegram/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback, ...extra }),
  }).then((res) => {
    if (!res || !res.ok) throw new Error(`${path} HTTP ${res && res.status}`);
  });
  const warn = (e) => console.warn(`[reminders] ${path} failed, the relay may keep nagging`, callback, e);
  // The try guards a fetch that throws SYNCHRONOUSLY (an environment with no
  // global fetch at all) — this is fire-and-forget and must never escape into
  // the caller, which is in the middle of an already-durable vault write.
  try {
    post().catch(() => post()).catch(warn);
  } catch (e) {
    warn(e);
  }
}

// medStem builds the "s:<slotUnix>" callback stem for a dose slot instant in ms,
// or "" when the instant is not a usable slot.
function medStem(slotMs) {
  const slotUnix = Math.floor(slotMs / 1000);
  return Number.isFinite(slotUnix) && slotUnix > 0 ? `s:${slotUnix}` : '';
}

// cancelMedRefire tells the relay to drop its server-owned re-fire chain for a
// med dose slot the user just confirmed IN THE APP. A PWA confirm produces no
// Telegram tap, so the relay would otherwise keep nagging hourly (med-eas.74).
// A Telegram tap needs no call: the relay cancels that chain itself (med-kbpf).
// slotMs is the dose slot instant (scheduled_at) in ms; the relay keys re-fires
// by the "s:<slotUnix>" callback stem.
export function cancelMedRefire(slotMs, { fetchImpl } = {}) {
  cancelReminderRefire(medStem(slotMs), { fetchImpl });
}

// cancelReminderRefire is the general form: it ends the reminder chain for ANY
// stem the relay knows — med "s:<slotUnix>", workout "w:<groupId>:<YYYYMMDD>",
// measure "bp:|wt:<slotUnix>". The server drops the pending re-fire and deletes
// the message still live in the chat, so an in-app workout complete/skip/start no
// longer leaves its reminder sitting there with buttons (med-r3dm). Empty stem =
// no chain to cancel (an ad-hoc session carries no callback), so it no-ops.
export function cancelReminderRefire(stem, { fetchImpl } = {}) {
  postRefire('cancel-refire', stem, {}, fetchImpl);
}

// rearmMedRefire puts ONE re-fire back for a slot whose Telegram Confirm the
// drain could only partly apply — a named dose that is still PENDING after the
// tap (med-kbpf). medIds names those doses so a tap on the re-fired message
// still resolves by identity. The relay no-ops it past its 6h cap.
export function rearmMedRefire(slotMs, medIds = [], { fetchImpl } = {}) {
  postRefire('rearm-refire', medStem(slotMs), { med_ids: (medIds || []).join(',') }, fetchImpl);
}

// Drops a pending debounced recompute for `ctx` without running it. A live page
// never needs this — the timer is short and a reload kills it — but anything
// that tears an account context down while a write is still settling does: the
// timer would otherwise fire against a context nobody is using any more. The
// cloud shim test harness calls it on env teardown, where a stray 2s timer from
// one test fires into the next test's mocks (bd med-tc1.3).
export function cancelReminderRecompute(ctx) {
  const key = (ctx && ctx.accountId) || ctx;
  clearTimeout(timers.get(key));
  timers.delete(key);
}
