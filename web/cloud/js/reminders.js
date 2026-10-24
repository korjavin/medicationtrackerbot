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
import {
  createRemindersDomain, formatWeeklyDigest, nextWeeklyDigestFireUnix, formatWeighInPushText,
} from '../../domain/reminders.js';
import { createSettingsDomain } from '../../domain/settings.js';
import { createGamificationDomain } from '../../domain/gamification.js';
import { recordsPort } from './sync.js';
import { pushSchedule, sendTestPush } from './push.js';
import { KIND_SECTION, reminderDeeplink } from './reminder-deeplink.js';

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
const WEIGHT_UNIT_RECORD_TYPE = 'weightunitpref';
const WEEK_PLAN_RECORD_TYPE = 'gamificationweek';
const TRACKER_RECORD_TYPE = 'tracker';
const TRACKER_LOG_RECORD_TYPE = 'trackerlog';
const DEBOUNCE_MS = 2000;

const timers = new Map();
const askPending = new Set(); // keys whose coalesced calls include a UI-origin askPermission

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
    weekPlans, trackers, trackerLogs,
  ] = await Promise.all([
    records.list(MEDICATION_RECORD_TYPE),
    // RAW, tombstones included: a dose slot deleted on purpose must suppress
    // its "Time to take" push, and a tombstone is the only trace it leaves
    // (bd med-x7x2, the intake twin of the workout case below).
    // computeReminderHorizon filters the live rows itself.
    records.listRaw(INTAKE_RECORD_TYPE),
    records.list(TZPLAN_RECORD_TYPE),
    records.list(BP_RECORD_TYPE),
    records.list(WEIGHT_RECORD_TYPE),
    records.list(WORKOUT_GROUP_RECORD_TYPE),
    records.list(WORKOUT_VARIANT_RECORD_TYPE),
    records.list(WORKOUT_EXERCISE_RECORD_TYPE),
    records.list(WORKOUT_ROTATION_RECORD_TYPE),
    // RAW, tombstones included: a deleted workout day must suppress its
    // recurring reminder, and a tombstone is the only trace it leaves
    // (bd med-w0fe). buildHorizon filters the live rows itself.
    records.listRaw(WORKOUT_SESSION_RECORD_TYPE),
    // A week paused in the weekly review sends no weigh-in nudges (med-8tur.4).
    records.list(WEEK_PLAN_RECORD_TYPE),
    records.list(TRACKER_RECORD_TYPE),
    records.list(TRACKER_LOG_RECORD_TYPE),
  ]);
  const tzPlan = tzplans.find((r) => r.recordId === TZPLAN_RECORD_ID && !r.deleted) || null;
  const weighInPushText = await computeWeighInPushText(records, remindersDomain, timeZone, now, features);

  const entries = await remindersDomain.buildHorizon({
    medications: medications.filter((m) => !m.deleted),
    intakes,
    bps: bps.filter((b) => !b.deleted),
    weights: weights.filter((w) => !w.deleted),
    workoutGroups: workoutGroups.filter((r) => !r.deleted),
    workoutVariants: workoutVariants.filter((r) => !r.deleted),
    workoutExercises: workoutExercises.filter((r) => !r.deleted),
    workoutRotations: workoutRotations.filter((r) => !r.deleted),
    workoutSessions,
    workoutEnabled: features.workout,
    timeZone,
    tzPlan,
    weighInPushText,
    weighInPausedWeeks: weekPlans.filter((w) => !w.deleted && w.paused).map((w) => w.week),
    trackers: trackers.filter((r) => !r.deleted),
    trackerLogs: trackerLogs.filter((r) => !r.deleted),
  });

  const digest = await computeDigestEntry(records, timeZone, now(), features);
  if (digest) entries.push(digest);
  return entries;
}

// Read inside each failure-isolated helper below, never in the shared
// Promise.all: a unit-read failure must not strand the whole horizon.
async function weightUnit(records) {
  const u = (await records.list(WEIGHT_UNIT_RECORD_TYPE)).filter((r) => !r.deleted).sort((a, b) => b.clientTs - a.clientTs)[0];
  return u && u.unit === 'lb' ? 'lb' : 'kg';
}

// Weekly-digest horizon entry (med-eas.58): gated on both the weekly_digest
// feature flag and gamification being on (mirrors the bot's both-on gate,
// weekly_digest.go). The review reads as of the Monday after the fire instant,
// so its "most recently completed week" (med-8tur.4) is the week the Sunday
// digest closes — with the data known at recompute time; a mid-week recompute
// forward-schedules a snapshot that can miss the rest of the week — an
// accepted blind-relay limitation, self-healing for active users. Forward-dated + replace-all means the next Sunday 19:00 is
// re-derived on each recompute — no last-sent state. Both-on gate + failure
// isolation live here: a digest-compute error must NOT reject computeReminderEntries
// (that would strand the already-built medication/BP/weight/workout horizon and
// stop replace-all propagation). The bot isolates weekly_digest as a best-effort
// checker for the same reason — its failure never affects other reminders.
async function computeDigestEntry(records, timeZone, now, features) {
  if (!features.weekly_digest || !features.gamification) return null;

  try {
    const fireAtUnix = nextWeeklyDigestFireUnix(now, timeZone);
    const gamification = createGamificationDomain({ records, now: () => fireAtUnix * 1000 + 86400000, timeZone });
    const [review, unit] = await Promise.all([gamification.getWeeklyReview({ features }), weightUnit(records)]);

    return {
      fireAtUnix,
      kind: 'digest',
      // Goal reading on the Web Push body only (push.js pushText); the
      // Telegram text stays goal-free like the weigh-in push (med-8tur.6).
      text: formatWeeklyDigest(review, unit, { goalFree: true }),
      pushText: formatWeeklyDigest(review, unit),
      genericText: 'Your weekly summary is ready',
    };
  } catch (e) {
    console.error('[reminders] digest compute failed', e);
    return null;
  }
}

// Goal-aware weigh-in body (med-8tur.6, docs/gamification.md §0.3.3): the Goal
// Line read on the same getGoalLine the Today hero uses, so the push and the
// card never disagree. Gated on weight + gamification and on the weight reminder
// being on (no point reading the Goal Line for a reminder that never fires).
// Failure-isolated like computeDigestEntry: a throw falls back to the goal-free
// text instead of stranding the whole horizon.
async function computeWeighInPushText(records, remindersDomain, timeZone, now, features) {
  if (!features.weight || !features.gamification) return null;
  try {
    if (!(await remindersDomain.getWeightStatus()).enabled) return null;
    const gamification = createGamificationDomain({ records, now, timeZone });
    // Only the goal block is used: switch the lever rows + adherence read off.
    const [line, unit] = await Promise.all([
      gamification.getGoalLine({ features: { weight: true } }), weightUnit(records),
    ]);
    return formatWeighInPushText(line.goal, unit);
  } catch (e) {
    console.error('[reminders] weigh-in goal text failed', e);
    return null;
  }
}

// getDeliveryPref/setDeliveryPref back the cloud notification settings' channel
// + verbosity controls (bd med-76c.1); apishim.js routes the settings writes here.
export function remindersDomain(ctx, { records: recordsOverride } = {}) {
  return createRemindersDomain({ records: recordsOverride || recordsPort(ctx), now: () => Date.now() });
}

// opts.relay === false is local-only mode (bd med-o7zq.3, local-policy.js):
// there is no relay, so nothing is uploaded and the device's own scheduler is
// the only delivery. The delivery channel is ignored there (an imported cloud
// vault may say "telegram only", which would schedule nothing), and the bodies
// follow the verbosity pref, because the lock screen is the only place they
// show: generic (the default) carries no medication or tracker names.
//
// Account mode: the lock-screen pref governs web push and the shell rows too
// (med-5vy0). An account with medications and no stored pref is floored to
// Detailed first, so an upgrade changes nothing silently.
export async function recomputeAndPush(ctx, opts = {}) {
  const domain = remindersDomain(ctx, opts);
  if (opts.relay !== false) await floorExistingAccountPref(ctx, opts, domain);
  const [entries, pref] = await Promise.all([
    computeReminderEntries(ctx, opts),
    domain.getDeliveryPref(),
  ]);
  if (opts.askPermission) askPermissionIfNeeded(ctx, opts, entries, pref);
  if (opts.relay === false) {
    await scheduleLocalNotifications(entries, { delivery: 'webpush' }, { generic: pref.lockscreen === 'generic' });
    return;
  }
  // The relay upload is started first and never waits on the device: a slow
  // or hung bridge call must not delay Telegram or the other devices.
  const local = scheduleLocalNotifications(entries, pref, { generic: pref.lockscreen === 'generic' });
  await pushSchedule(ctx, entries, pref);
  await local; // never rejects, bounded by LOCAL_SCHEDULE_TIMEOUT_MS
}

// Never sinks the schedule: a failed floor leaves the read default in place.
async function floorExistingAccountPref(ctx, opts, domain) {
  try {
    const meds = await (opts.records || recordsPort(ctx)).list(MEDICATION_RECORD_TYPE);
    if (meds.some((m) => !m.deleted)) await domain.floorDeliveryPref('detailed');
  } catch (e) {
    console.error('[reminders] delivery pref floor failed', e);
  }
}

// bd med-ckm5.4 (kit O3): a schedule after the user's own write that would
// notify this device asks for the permission in context
// (features/notify-permission.js: once per device, only while it is
// 'default'). askPermission comes only from the UI-origin apishim router (any
// UI write, Settings toggles included); boot, sync drains, agents and
// Settings' direct recomputes never pass it, so the app never asks at launch.
// A new grant re-runs the schedule now. Fire-and-forget: the sheet waits on
// the user.
function askPermissionIfNeeded(ctx, opts, entries, pref) {
  const asker = globalThis.NotifyPermission;
  if (typeof asker?.maybeAsk !== 'function') return;
  let shell = false;
  try { shell = globalThis.LocalNotifications?.isSupported?.() === true; } catch { /* native/ stub */ }
  // Local-only mode has no relay, so only the app shell's own scheduler delivers.
  if (opts.relay === false && !shell) return;
  if (!localNotificationItems(entries, opts.relay === false ? {} : pref).length) return;
  const { askPermission, ...rest } = opts;
  Promise.resolve(asker.maybeAsk())
    .then((granted) => { if (granted === true) scheduleReminderRecompute(ctx, rest, 0); })
    .catch((e) => console.error('[reminders] permission ask failed', e));
}

// iOS app shell only (bd med-w6gx.5): WKWebView has no Web Push, so the same
// horizon is also handed to the device's own scheduler. On the web
// LocalNotifications reports unsupported (or is absent) and this returns before
// doing anything. Runs alongside pushSchedule and never throws: an offline PUT
// must not cost the device its reminders. The relay upload is unchanged — it
// still serves Telegram and the account's other devices.
const LOCAL_NOTIFICATION_CAP = 64; // iOS keeps at most 64 pending local notifications
const LAPSE_TEXT = 'Open the app to keep reminders running'; // sw.js STALE_SYNC_WARNING's words

// The earliest reminders that fit the cap, the last slot kept for a lapse notice
// right after them: the device-side twin of the relay's dry-queue warning
// (same lapse semantics — the next open refreshes all of it). Telegram-only
// delivery schedules nothing on the device, as it sends no Web Push on the web.
// generic: bodies are the entries' name-free genericText (the lock-screen
// privacy pref, both modes since med-5vy0); otherwise the full text.
export function localNotificationItems(entries, pref = {}, nowUnix = Math.floor(Date.now() / 1000), { generic = false } = {}) {
  if (pref.delivery === 'telegram') return [];
  const items = entries
    .filter((e) => e.fireAtUnix > nowUnix)
    .sort((a, b) => a.fireAtUnix - b.fireAtUnix)
    .slice(0, LOCAL_NOTIFICATION_CAP - 1)
    .map((e) => ({
      fireAtUnix: e.fireAtUnix,
      title: 'Med Tracker',
      body: ((generic ? e.genericText : e.pushText) || e.text || '').replace(/\*\*/g, ''),
      section: KIND_SECTION[e.kind] || 'today', // for shells before bd med-w6gx.20, which ignore url
      url: reminderDeeplink(e), // the tap target: the take sheet for a dose, else the section
    }));
  if (items.length) {
    items.push({ fireAtUnix: items[items.length - 1].fireAtUnix + 60, title: 'Med Tracker', body: LAPSE_TEXT, section: 'today', url: '/?tab=today' });
  }
  return items;
}

// Serialized like push.js pushChains: each schedule is a replace-all, so two in
// flight could interleave (Swift removes, then adds one by one) or let an older
// horizon land last. One chain is enough — the device has one schedule.
let localChain = Promise.resolve();
// A bridge call that never answers must not wedge every later schedule.
const LOCAL_SCHEDULE_TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`local notification schedule timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function scheduleLocalNotifications(entries, pref, opts) {
  const local = globalThis.LocalNotifications;
  let supported = false;
  try { supported = local?.isSupported?.() === true; } catch { /* native/ stub: not registered */ }
  if (!supported) return Promise.resolve();
  const items = localNotificationItems(entries, pref, undefined, opts);
  localChain = localChain
    .then(() => withTimeout(local.schedule(items), LOCAL_SCHEDULE_TIMEOUT_MS))
    .then((scheduled) => recordLocalSchedule({ ok: true, items: items.length, scheduled }))
    .catch((e) => {
      recordLocalSchedule({ ok: false, items: items.length, error: (e && e.message) || String(e) });
      console.error('[reminders] local notification schedule failed', e);
    });
  return localChain;
}

// The outcome of the last device schedule, for local mode's Settings card
// (bd med-o7zq.9): { ok: true, items, scheduled } (scheduled = the count the
// shell replied, ios/App/Notifications.swift schedule) or { ok: false, items,
// error }. One listener (local-policy.js); the cloud sets none.
let localScheduleListener = null;
function recordLocalSchedule(result) {
  try { localScheduleListener?.({ ...result, at: Date.now() }); } catch { /* a UI listener never fails the schedule */ }
}
export function onLocalScheduleResult(fn) {
  localScheduleListener = fn;
}

// scheduleReminderRecompute debounces recomputeAndPush per ctx (keyed by
// ctx.accountId, falling back to ctx itself — same identity assumption
// sync.js's other per-account caches already make).
export function scheduleReminderRecompute(ctx, opts = {}, debounceMs = DEBOUNCE_MS) {
  const key = (ctx && ctx.accountId) || ctx;
  clearTimeout(timers.get(key));
  // askPermission is sticky across coalesced calls: a later non-UI recompute
  // must not drop an earlier UI save's in-context notification ask.
  if (opts.askPermission) askPending.add(key);
  const timer = setTimeout(() => {
    timers.delete(key);
    const ask = askPending.delete(key);
    recomputeAndPush(ctx, ask ? { ...opts, askPermission: true } : opts).catch((e) => console.error('[reminders] recompute/push failed', e));
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
  askPending.delete(key);
}
