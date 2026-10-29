// Applies sealed inbound Telegram events through the normal JS domain layer
// (bd med-76c.2, part 2). The relay could not apply these itself — it cannot
// write ciphertext it cannot produce — so it sealed the user's intent and an
// unlocked client replays it here.
//
// Two event kinds:
//
//   intake_slot_action — a Confirm/Snooze tap. Its callback_data is slot-scoped
//     ("s:<slotUnix>"), because a cloud dose reminder bundles every medication
//     due at one instant into a single message (web/domain/reminders.js groups
//     targets bySlot). So "Confirm" means "I took the meds due at 08:00", and
//     expanding the slot to its intakes happens HERE, on an unlocked client
//     that can actually see which meds those are.
//
//   tg_command — the RAW text of a data command (/bp 120 80), sealed unparsed
//     because the relay is forbidden from understanding it (bd med-eas.29.2).
//     Parsing happens here via web/domain/tgcommand.js, and the write goes
//     through the same domain modules the UI calls. Once the write is in the
//     vault we ask the relay to edit its "⏳ Queued" placeholder into a
//     confirmation WE composed — the relay forwards that string verbatim, the
//     same contract it already has for outbound reminder text.
import { createIntakeDomain, dosesAtInstant } from '../../domain/medintake.js';
import { createBPDomain } from '../../domain/bp.js';
import { createWeightDomain } from '../../domain/weight.js';
import { createNotesDomain } from '../../domain/notes.js';
import { createRemindersDomain } from '../../domain/reminders.js';
import { createSettingsDomain } from '../../domain/settings.js';
import { createFoodDomain } from '../../domain/food.js';
import { createFoodAIDomain } from '../../domain/foodai.js';
import { createActivityAIDomain } from '../../domain/activityai.js';
import { createVitalsDomain } from '../../domain/vitals.js';
import { createWorkoutDomain } from '../../domain/workout.js';
import { parseCommand } from '../../domain/tgcommand.js';
import { createAIClient } from './aiclient.js';
import { createFoodDbClient } from './fooddb.js';
import { createApiRouter } from './apishim.js';
import { materializing } from './materialize-gate.js';
import { cancelMedRefire, rearmMedRefire } from './reminders.js';
import { createDispatcher } from './mcp-responder.js';
import { createTGAgent } from './tg-agent.js';
import { recordsPort, ORIGIN_EXTERNAL, deviceValues } from './sync.js';

export const INTAKE_SLOT_ACTION = 'intake_slot_action';
export const TG_COMMAND = 'tg_command';
export const TG_PHOTO = 'tg_photo';
export const TG_TEXT = 'tg_text';
export const VITALS_IMPORT = 'vitals_import';
export const WORKOUT_SESSION_ACTION = 'workout_session_action';
export const MEASURE_REMINDER_ACTION = 'measure_reminder_action';

// A once-marker per free-text event. Unlike /bp or /food, the agent's tool
// writes get fresh (non-deterministic) record ids, so a re-drain — the barrier
// re-runs apply() whenever the ops flush failed (offline, quota, seq clash) —
// would double-write AND re-bill the provider. A deterministic marker written
// before the agent runs makes that re-drain skip instead. ponytail: markers
// accumulate one per message; add a sweep only if that ever matters.
const TG_AGENT_MARKER_TYPE = 'tgagentrun';

// A marker without a reply younger than this may belong to a run still going in
// another tab of this device (drain rule 3 allows concurrent drainers), so the
// event stays queued instead of being retried under it (bd med-ramv).
const TG_AGENT_LEASE_MS = 2 * 60 * 1000;

// The free-text run in flight on this page — drains are serial per page, so
// one slot is enough. The agent router's records port reads it to flag the
// marker `wrote` before the first tool write (see createInboxRouter).
let currentTGRun = null;

// A single user-scoped freeform note the free-text agent reads into its prompt
// and appends durable phrasing mappings to (bd med-vcv.3). Singleton vault
// record, same shape as reminderdeliverypref. Cap on char count (not bytes) to
// stay browser-global-free — no TextEncoder/Buffer; oldest whole lines drop
// first. ponytail: bounded text note, no compaction/embeddings — revisit only
// if 4096 chars ever proves too tight.
const TG_PREFS_TYPE = 'tgprefs';
const TG_PREFS_RECORD_ID = 'tgprefs';
const TG_PREFS_MAX_CHARS = 4096;

async function readTGPrefs(records) {
  const all = await records.list(TG_PREFS_TYPE);
  const rec = all.find((r) => r.recordId === TG_PREFS_RECORD_ID && !r.deleted);
  return (rec && rec.note) || '';
}

async function appendTGPref(records, line, now) {
  const clean = String(line || '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return;
  const prev = await readTGPrefs(records);
  let note = prev ? `${prev}\n${clean}` : clean;
  // Drop WHOLE oldest lines from the front until under the cap.
  while (note.length > TG_PREFS_MAX_CHARS) {
    const nl = note.indexOf('\n');
    if (nl < 0) { note = note.slice(note.length - TG_PREFS_MAX_CHARS); break; }
    note = note.slice(nl + 1);
  }
  await records.put(TG_PREFS_TYPE, { recordId: TG_PREFS_RECORD_ID, clientTs: now(), deleted: false, note });
}

// makeTGPrefsPort is the `prefs` port createTGAgent consumes: get() reads the
// note into the prompt, append(line) records a durable phrasing mapping. One
// factory so the applier and its integration test share the real vault boundary.
export function makeTGPrefsPort(records, now) {
  return {
    get: () => readTGPrefs(records),
    append: (line) => appendTGPref(records, line, now),
  };
}

// A rolling conversation window for the free-text agent (bd med-48x). Each
// Telegram message is its own sealed event drained by applyTGText, so without a
// durable transcript the agent is amnesiac — "and last week?" refers to nothing.
// Singleton vault record, same shape as tgprefs: one row holding the last few
// turns, pruned by BOTH count and age on read AND on write (a tab can sit idle
// for hours, so a read-side prune is what makes the 1h window real).
//
// Only the FINAL plain-text (user, assistant) pair is stored, never the
// tool-call rounds: an assistant message carrying tool_calls must be immediately
// followed by its matching role:'tool' replies or the provider 400s the request.
const TG_CHAT_TYPE = 'tgchat';
const TG_CHAT_RECORD_ID = 'tgchat';
const TG_CHAT_MAX_TURNS = 5;
const TG_CHAT_MAX_AGE_MS = 60 * 60 * 1000;

// Sorted by ts rather than by append order: each turn is aged by its message's
// OWN send time, so a backlog drain can append a turn older than one already
// stored. Without the sort that turn reads last in the prompt and the count
// prune would drop the wrong end.
function pruneTurns(turns, nowMs) {
  return turns
    .filter((t) => t && typeof t.ts === 'number' && t.ts >= nowMs - TG_CHAT_MAX_AGE_MS)
    .sort((a, b) => a.ts - b.ts)
    .slice(-TG_CHAT_MAX_TURNS);
}

async function readTGChat(records, atMs) {
  const all = await records.list(TG_CHAT_TYPE);
  const rec = all.find((r) => r.recordId === TG_CHAT_RECORD_ID && !r.deleted);
  return pruneTurns((rec && Array.isArray(rec.turns)) ? rec.turns : [], atMs);
}

async function appendTGChatTurn(records, user, assistant, atMs) {
  const turns = pruneTurns([...await readTGChat(records, atMs), { ts: atMs, user: String(user || ''), assistant: String(assistant || '') }], atMs);
  await records.put(TG_CHAT_TYPE, { recordId: TG_CHAT_RECORD_ID, clientTs: atMs, deleted: false, turns });
}

// makeTGHistoryPort is the `history` port createTGAgent consumes: get(atMs)
// returns the surviving turns oldest-first for the prompt, append(user,
// assistant, atMs) records one completed exchange. atMs is the SENT time of the
// message being handled (the drain clock only stands in when a caller has none),
// so a backlog drain ages each turn by when it was written, not by when the tab
// happened to open.
export function makeTGHistoryPort(records, now) {
  return {
    get: (atMs) => readTGChat(records, atMs || now()),
    append: (user, assistant, atMs) => appendTGChatTurn(records, user, assistant, atMs || now()),
  };
}

// Telegram's editMessageText caps at 4096; the relay's EditReply rejects >1000
// runes (and empty). Keep a margin so an agent answer never trips it.
const MAX_REPLY_RUNES = 900;

function truncateRunes(s, n) {
  const runes = [...s];
  if (runes.length <= n) return s;
  return `${runes.slice(0, n - 1).join('')}…`;
}

const INTAKE_RECORD_TYPE = 'intake';


// Mirrors DEFAULT_SNOOZE_MINUTES in web/domain/medintake.js (and the server's
// own default). Not imported because that module does not export it.
const DEFAULT_SNOOZE_MINUTES = 10;

function defaultTimeZone() {
  return (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
}

// A re-drained event finds its intakes already TAKEN, and the domain's confirm()
// throws rather than double-decrement inventory. That throw is the idempotency
// guard doing its job, not a failure — swallow it so the event still gets acked,
// but only when the dose really IS settled (TAKEN/SKIPPED) at that id (bd
// med-944k): a not_pending on a dose still open is a bug, and swallowing it is
// how a tap used to vanish. Anything else propagates and leaves the event
// queued for the next drain.
//
// Keyed on the domain's structured `code`, not its message text.
async function isAlreadyApplied(err, intake, intakeId) {
  if (!err || err.code !== 'not_pending') return false;
  const row = await intake.getIntake(intakeId);
  return !!row && (row.status === 'TAKEN' || row.status === 'SKIPPED');
}

// The domain refused a tap older than the dose's last explicit action (bd
// med-944k): the reminder is out of date, never silently dropped.
function isStaleCallback(err) {
  return !!err && err.code === 'stale_callback';
}

// The receipt for a tap that names a dose the vault no longer has at that
// instant (bd med-wi09.4): a tz change or schedule edit moved it, or the med is
// gone. Nothing is guessed — the app shows the timeline at that med (MT6).
export const OUT_OF_DATE_TEXT = 'This reminder is out of date — open the app to log it.';

// The receipt lines for a Confirm tap's settled doses (bd med-944k). A tap that
// records nothing must say so on the message — the relay's static "✅
// Confirmed — waiting for your device" is otherwise left standing over a dose
// still Due. Only a dose already TAKEN reads as done; one marked skipped in the
// app says why it was not recorded; anything else still open after the tap
// (no write landed) is plainly "not recorded", and so is a tap older than the
// dose's last in-app action, saying why. Generic verbosity carries no counts.
function intakeReceiptLines({ confirmed, already, skipped, stale, notRecorded }, verbosity) {
  const generic = verbosity === 'generic';
  const meds = (n) => `${n} medication${n === 1 ? '' : 's'}`;
  const lines = [];
  if (confirmed) lines.push(confirmationText({ kind: 'intake' }, { confirmed }, verbosity));
  if (already) lines.push(generic ? '✅ Already recorded.' : `✅ Already taken: ${meds(already)}.`);
  if (skipped) lines.push(generic ? '⚠️ Not recorded: marked skipped in the app.' : `⚠️ Not recorded: ${meds(skipped)} marked skipped in the app.`);
  if (stale) lines.push(generic ? '⚠️ Not recorded: changed in the app after this tap.' : `⚠️ Not recorded: ${meds(stale)} changed in the app after this tap.`);
  if (notRecorded) lines.push('⚠️ Not recorded — open the app to mark it taken.');
  return lines;
}

// applyIntakeSlotAction confirms (or snoozes) the meds a slot reminder named.
//
// Identity rides on the EVENT (med-kbpf): the relay stores the medication ids
// the client uploaded with the reminder row and seals them into the tap, so this
// no longer reconstructs "which meds did that message name" from a vault
// side-table (the deleted `slotmeds` records — every reconstruction failure used
// to mean 6h of hourly nags for doses already taken).
//
// Per named med it resolves the dose EXACTLY (bd med-wi09.4): the stored row
// with the `intake-<medId>-<slotUnix>` id, else the projection's dose of that
// med at that very second (the regenerated/forecast dose with no row yet, or a
// stored row under another id — legacy/imported). Never a
// neighbouring dose: there is no band fallback. A tombstoned slot id is the
// user's deletion, so the tap is a silent no-op for that med. A med that
// resolves to nothing gets nothing applied: the reminder message becomes "out
// of date" and onOutOfDate queues the app's MT6 landing (that med, the
// reminder's own time, nothing preselected, nothing logged).
//
// atUnix is the SERVER's timestamp for the tap, so a Confirm tapped at 09:00
// records taken_at 09:00 even when the app first opens at noon — the backdating
// rule (docs/cloud-mode.md → drain protocol, rule 4).
//
// rearmRefire is injected by createInboxApplier (the only production caller),
// which passes the real rearmMedRefire. It defaults to a no-op rather than to
// rearmMedRefire so a direct call — every test in this module's suite — never
// reaches for an ambient fetch. There is no cancel here any more: the relay
// cancels the chain the instant the Confirm is tapped, and this only puts ONE
// re-fire back when a named dose is somehow still due afterwards.
export async function applyIntakeSlotAction(event, { intake, records, now = Date.now, verbosity = 'detailed', editReply = editTelegramReply, rearmRefire = () => {}, cancelRefire = () => {}, onOutOfDate = () => {} }) {
  const slotUnix = event.slot_unix;
  const slotMs = slotUnix * 1000;
  const atMs = event.at_unix * 1000;
  // confirm() backdates taken_at to atMs deterministically, so this instant is
  // stable across an at-least-once redelivery of the same tap — the receipt
  // recount below relies on it.
  const atIso = new Date(atMs).toISOString();

  // Compared as strings throughout: the relay round-trips the ids through a
  // decimal column, so a numeric recordId comes back as a number while an
  // imported vault could hold it as a string. One normalisation, no coercion.
  const named = (Array.isArray(event.medication_ids) ? event.medication_ids : [])
    .filter((id) => id !== null && id !== undefined && id !== '');

  // medId → the dose this slot names: the row the domain's own resolver
  // (intake.getIntake, the lookup confirm()/snooze() act through) returns for
  // the stored row with the exact slot id ('gone' when it is tombstoned), else
  // for the projection's dose of that med at this very second, else null.
  // Nothing stores a PENDING prediction (bd med-wi09.12), so the dose usually
  // has no row yet and getIntake hands back a virtual open row: confirm()/
  // snooze() write the evidence at that exact occId. The +999 covers a tz-plan
  // step that keeps its anchor's milliseconds (the occId floors).
  // dosesAtInstant reads lineage-safe (a cancelled dose never stands in for
  // its replacement) and narrows to the instant. Asking getIntake (bd
  // med-944k) keeps ONE verdict on "actionable": an id confirm() could not
  // resolve is unresolved here (out of date), never a swallowed not_pending,
  // and a stored PENDING prediction the projection no longer lists is null.
  const resolveNamed = async () => {
    const raw = records.listRaw ? await records.listRaw(INTAKE_RECORD_TYPE) : await records.list(INTAKE_RECORD_TYPE);
    const rows = await dosesAtInstant(intake, slotMs);
    const out = new Map();
    for (const medId of named) {
      const exactId = `intake-${medId}-${slotUnix}`;
      const stored = raw.find((i) => String(i.recordId) === exactId);
      if (stored && stored.deleted) { out.set(medId, 'gone'); continue; }
      const row = stored ? null : rows.find((r) => String(r.occId) === exactId)
        || rows.find((r) => String(r.medId) === String(medId));
      const id = stored ? exactId : row && String(row.occId);
      out.set(medId, (id && await intake.getIntake(id)) || null);
    }
    return out;
  };
  const isPending = (dose) => !!dose && dose !== 'gone' && dose.status === 'PENDING';
  // A Confirm acts on any open dose — UNTAKEN after an undo too (bd
  // med-944k); confirm() itself refuses a tap older than the undo. Snooze keeps
  // to PENDING as before.
  const isOpen = (dose) => isPending(dose) || (!!dose && dose !== 'gone' && dose.status === 'UNTAKEN');
  const actionable = event.action === 'confirm' ? isOpen : isPending;

  // Read through the replace gate, so a tap during a store replace fails and
  // stays queued.
  const before = await materializing(() => resolveNamed());

  // No identity: a reminder pushed by a pre-med-kbpf client, or a tap on a
  // message so old the relay's chain (and with it the row that named the meds)
  // is gone. Apply NOTHING rather than guess a band-wide set — the tap already
  // stopped the nagging server-side, so the cost is "confirm it in the app",
  // not six overnight nags. Still answer the message so the user is not left
  // looking at a spinner-less "Confirmed" that recorded nothing.
  if (!named.length) {
    console.warn('[inbox] intake slot tap carries no medication identity, nothing applied', slotUnix);
    try {
      await editReply(event.message_id, confirmationText({ kind: 'intake' }, { confirmed: 0 }, verbosity));
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
    return;
  }

  const unresolved = named.filter((medId) => before.get(medId) === null);

  const stale = new Set();
  let applied = 0;
  for (const medId of named) {
    const dose = before.get(medId);
    if (!actionable(dose)) continue;
    try {
      if (event.action === 'confirm') {
        // The reminder callback: confirm-or-create at the exact occId, rev
        // seen+1, only when the tap is newer than the dose's last explicit
        // action (else stale_callback → out of date below).
        await intake.confirm(dose.recordId, atMs);
      } else {
        // Snooze from the TAP, not from the drain. If that window already
        // elapsed while the app was closed, snoozing is meaningless — the
        // re-reminders it would have suppressed have already fired.
        const minutes = (atMs + DEFAULT_SNOOZE_MINUTES * 60_000 - now()) / 60_000;
        if (minutes <= 0) continue;
        await intake.snooze(dose.recordId, minutes);
      }
      applied += 1;
    } catch (e) {
      // A tap older than the last in-app action on that dose: not the newest
      // intent, so no write — the receipt says why.
      if (isStaleCallback(e)) { stale.add(medId); continue; }
      // A concurrent drainer settled it first; the receipt counts it.
      if (!(await isAlreadyApplied(e, intake, dose.recordId))) throw e;
    }
  }

  // The relay already cancelled this slot's re-fire chain when the button was
  // tapped (med-kbpf). Put ONE re-fire back only if a med the message NAMED
  // still has its dose open at this slot after all of the above. Snooze never
  // re-arms: the relay rescheduled the chain +1h itself, which is the point of
  // the tap. An unresolved med is not due at this slot — re-arming would only
  // repeat the stale reminder.
  //
  // When nothing is left due, cancel AGAIN from here. The tap-time cancel is
  // primary, but a tap that lands in the gap between the relay sending a
  // message and inserting its successor row finds nothing to cancel, and the
  // successor then carries the chain on. This idempotent backstop closes that
  // gap at drain latency. ponytail: a durable "confirmed" marker on the stem
  // would close it at tap time; add if the gap is ever hit in practice.
  const lines = [];
  if (event.action === 'confirm') {
    const after = await resolveNamed();
    // A dose the user re-opened in the app after this tap is theirs to act on,
    // not this reminder's chain to re-arm.
    const stillDue = named.filter((medId) => !stale.has(medId) && isOpen(after.get(medId)));
    if (stillDue.length) rearmRefire(slotMs, stillDue);
    else cancelRefire(slotMs);
    // Settle every resolved named med from the vault as it now stands, not
    // from this attempt's writes: an at-least-once redelivery after a partial
    // success re-runs with the earlier meds already TAKEN, so `applied` alone
    // would undercount. taken_at === atIso is exactly this tap's set; any
    // other TAKEN was taken before the tap; SKIPPED was skipped in the app; a
    // stale tap lost to a later in-app action; anything else still open
    // recorded nothing. A tombstoned slot is the user's deletion and stays
    // silent.
    const settled = { confirmed: 0, already: 0, skipped: 0, stale: 0, notRecorded: 0 };
    for (const medId of named) {
      const dose = after.get(medId);
      if (unresolved.includes(medId) || dose === 'gone') continue;
      if (dose && dose.status === 'TAKEN') settled[dose.taken_at === atIso ? 'confirmed' : 'already'] += 1;
      else if (stale.has(medId)) settled.stale += 1;
      else if (dose && dose.status === 'SKIPPED') settled.skipped += 1;
      else settled.notRecorded += 1;
    }
    // Edit the original reminder message to a receipt and drop its buttons
    // (the edit sends no reply_markup — bug 1) — whenever the drain recorded
    // nothing, too (bd med-944k: never a silent ack). The one skip is a
    // redelivery or double-tap of a tap that already landed whole (nothing
    // applied now, every med confirmed at this tap's instant): that receipt
    // is already on the message. message_id is absent when Telegram omitted
    // cq.Message for an old message → editReply is a safe no-op.
    const landedWhole = applied === 0 && !unresolved.length && settled.confirmed > 0 && !settled.already && !settled.skipped && !settled.stale && !settled.notRecorded;
    if (!landedWhole) lines.push(...intakeReceiptLines(settled, verbosity));
    // Every named slot tombstoned: still answer the message.
    if (!landedWhole && !lines.length && !unresolved.length) lines.push(confirmationText({ kind: 'intake' }, { confirmed: 0 }, verbosity));
  } else if (applied > 0) {
    lines.push(verbosity === 'generic' ? '⏰ Snoozed.' : '⏰ Snoozed — will remind you again shortly.');
  }
  if (unresolved.length) lines.push(OUT_OF_DATE_TEXT);
  if (lines.length) {
    try {
      await editReply(event.message_id, lines.join('\n'));
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  }
  if (unresolved.length) onOutOfDate({ medId: String(unresolved[0]), scheduled: new Date(slotMs).toISOString(), count: unresolved.length });
}

// SNOOZE_MINUTES_BY_ACTION maps a workout Snooze button to its duration. Skip
// carries no duration.
const SNOOZE_MINUTES_BY_ACTION = { snooze1h: 60, snooze2h: 120 };

// applyWorkoutSessionAction drains a Telegram workout Snooze/Skip tap onto the
// deterministic session-<groupId>-<date> slot (find-or-create — the tap can land
// before the session is materialized). It reconciles local state; the relay's
// own re-fire (server side) handles re-delivering the snoozed reminder.
export async function applyWorkoutSessionAction(event, { workout, editReply = editTelegramReply }) {
  const groupId = event.group_id;
  const date = event.date;
  let text;
  if (event.action === 'skip') {
    await workout.skipScheduledSession({ groupId, date });
    text = '⏭️ Skipped.';
  } else {
    const minutes = SNOOZE_MINUTES_BY_ACTION[event.action];
    if (!minutes) {
      console.warn('[inbox] ignoring unknown workout action', event.action);
      return;
    }
    await workout.snoozeScheduledSession({ groupId, date, minutes });
    text = '⏰ Snoozed.';
  }
  try {
    await editReply(event.message_id, text);
  } catch (e) {
    console.warn('[inbox] could not update the Telegram reply', e);
  }
}

// applyMeasureReminderAction drains a Telegram BP/weight reminder Snooze/Skip
// tap onto the SAME reminder-pref mute the app's own Snooze/Mute buttons write —
// there is one implementation of "muted until". BP and weight share this one
// handler; event.measure picks the setter. The reminders domain is built on the
// tap time (now pinned to at_unix), so the mute instant is deterministic across
// an at-least-once redelivery. Snooze → snoozed_until (+1h, matching the
// "Snooze 1h" button label and the server relay re-fire — NOT the in-app
// button's default 2h); Skip → dont_remind_until (+24h). The relay's own
// re-fire/cancel (server side) keeps its horizon in step; this just reconciles
// local pref state.
const MEASURE_SNOOZE_MS = 60 * 60 * 1000; // "Snooze 1h" button
export async function applyMeasureReminderAction(event, { reminders, editReply = editTelegramReply }) {
  const bp = event.measure === 'bp';
  let text;
  if (event.action === 'skip') {
    await (bp ? reminders.dontBugBPReminder() : reminders.dontBugWeightReminder());
    text = '⏭️ Skipped.';
  } else if (event.action === 'snooze') {
    await (bp ? reminders.snoozeBPReminder(MEASURE_SNOOZE_MS) : reminders.snoozeWeightReminder(MEASURE_SNOOZE_MS));
    text = '⏰ Snoozed.';
  } else {
    console.warn('[inbox] ignoring unknown measure action', event.action);
    return;
  }
  try {
    await editReply(event.message_id, text);
  } catch (e) {
    console.warn('[inbox] could not update the Telegram reply', e);
  }
}

// editTelegramReply asks the relay to rewrite the "⏳ Queued" placeholder into
// `text`. This adds no trust: WE composed `text` from vault data the relay
// cannot read, and it forwards the string verbatim — the same contract as the
// outbound reminder text it already relays (docs/cloud-mode.md → Inbound
// plaintext). Best-effort: a failed edit must never fail the drain, because the
// record is already in the vault and the receipt is cosmetic.
// trialConsentScope asks the relay to hang an "Allow trial AI" button off the
// edited message, deep-linking to the in-app consent dialog for that scope
// (med-eas.61). The relay only builds the link; the grant is a vault write the
// user makes in the app, so the one tap stays an explicit affirmative act.
async function editTelegramReply(messageId, text, { fetchImpl = fetch, trialConsentScope = '' } = {}) {
  if (!messageId || !text) return;
  try {
    const res = await fetchImpl('/api/telegram/reply-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: messageId, text, trial_consent_scope: trialConsentScope }),
    });
    if (!res.ok) console.warn('[inbox] could not update the Telegram reply', res.status);
  } catch (e) {
    console.warn('[inbox] could not update the Telegram reply', e);
  }
}

// The trial gate refused (aiclient.js): the user has no key of their own, the
// operator's trial IS available, they simply never allowed the scope. Every
// drain path answers the same way — one short line plus the relay's "Allow
// trial AI" button, which deep-links to the in-app consent dialog — so nobody
// is sent hunting through Settings at first use (med-eas.61). `no_api_key` gets
// no button: there is no trial to allow.
function replyTrialConsent(reply, what, err) {
  return reply(
    `🔑 ${what} needs your OK to use the trial AI — tap below (or add your own OpenAI key in Settings).`,
    { trialConsentScope: err.scope },
  );
}

// Confirmations respect the SAME verbosity the user picked for outbound
// reminders (web/domain/reminders.js getDeliveryPref). "generic" exists so no
// health value ever crosses Telegram — honouring it here too, or a user who
// chose generic reminders would still get "Recorded BP 120/80" echoed back.
function confirmationText(intent, result, verbosity) {
  // A write that recorded nothing never reads as success, generic or not (bd
  // med-944k, Argus 6065); these texts carry no health value.
  if (intent.kind === 'intake' && !(result && result.confirmed)) return 'ℹ️ Nothing was due — no medications to confirm.';
  if (intent.kind === 'food' && !(result && result.items && result.items.length)) return 'ℹ️ Could not log any food from that.';
  if (verbosity === 'generic') return '✅ Recorded.';
  switch (intent.kind) {
    case 'bp': {
      const pulse = intent.pulse ? `, pulse ${intent.pulse}` : '';
      return `✅ Recorded BP ${intent.systolic}/${intent.diastolic}${pulse}.`;
    }
    case 'weight':
      return `✅ Recorded weight ${intent.weight} kg.`;
    case 'note':
      return '✅ Note saved.';
    case 'food': {
      const n = result.items.length;
      return `✅ Logged ${n} food item${n === 1 ? '' : 's'}.`;
    }
    case 'intake': {
      const n = result.confirmed;
      return `✅ Confirmed ${n} medication${n === 1 ? '' : 's'}.`;
    }
    case 'workout':
      return intent.name ? `✅ Logged workout: ${intent.name}.` : '✅ Workout logged.';
    case 'activity': {
      if (!result || !result.activity_name) return '✅ Cardio logged.';
      const dist = result.distance_m > 0 ? ` — ${(result.distance_m / 1000).toFixed(1)}km` : '';
      return `✅ Logged cardio: ${result.activity_name}${dist}.`;
    }
    default:
      return '✅ Recorded.';
  }
}

// The message the bot shows when it cannot act on a command. Composed HERE, not
// on the relay: the relay is forbidden from telling /bp apart from /bogus, so
// only the client knows which of these applies.
function refusalText(intent) {
  switch (intent.kind) {
    case 'invalid': return `⚠️ ${intent.hint}`;
    case 'unsupported': return `🚧 ${intent.command} isn't available over chat yet — open the app for that.`;
    case 'unknown': return `❓ I don't understand ${intent.command}. Send /help for the list.`;
    default: return '❓ I don\'t understand that. Send /help for the list.';
  }
}

// applyTGCommand parses the sealed raw text and writes it through the ordinary
// JS domain layer — the same modules the UI calls, so there is exactly one
// implementation of "what logging a BP means" (CLAUDE.md's no-duplicate-logic
// rule; med-07y's unification constraint).
//
// eventId makes the write idempotent. Re-draining after a crash between flush
// and ack must overwrite the same record, not append a second one — so the id
// is derived from the mailbox event, which is stable across retries. The intake
// path needs no id: its own PENDING check is the idempotency guard.
export async function applyTGCommand(event, eventId, { bp, weight, notes, intake, foodAI, activityAI, workout, records, verbosity = 'detailed', now = Date.now, editReply = editTelegramReply }) {
  // The receipt is cosmetic; the record is not. A Telegram outage must never
  // strand an event that already reached the vault, so the edit can never
  // reject out of here — not even an injected one.
  // ...rest, not (text, opts): a plain confirmation must call editReply with
  // exactly two arguments, the shape every other caller and stub expects.
  const reply = async (text, ...rest) => {
    try {
      await editReply(event.reply_message_id, text, ...rest);
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  };
  const intent = parseCommand(event.text);
  const recordId = `tg-${eventId}`;
  // at_unix is the message's OWN Telegram date (tgclient.Message.AtUnix — relay
  // clock only as a fallback, +5min skew cap), so a /bp sent at 09:00 is recorded
  // as measured at 09:00 whether it drains at noon or the webhook was retried
  // after relay downtime. Same backdating rule as a Confirm/Snooze tap (drain
  // rule 4), except a tap's at_unix IS the relay clock.
  const atIso = new Date(event.at_unix * 1000).toISOString();

  let result = null;
  switch (intent.kind) {
    case 'bp':
      await bp.create({ measured_at: atIso, systolic: intent.systolic, diastolic: intent.diastolic, pulse: intent.pulse }, { recordId });
      break;
    case 'weight':
      await weight.create({ measured_at: atIso, weight: intent.weight }, { recordId });
      break;
    case 'note':
      await notes.create({ content: intent.content }, { recordId });
      break;
    case 'food':
      // The NL parse runs HERE (unlocked client, user's own key), never on the
      // relay — the relay only ever sealed the raw text. Per-item ids derived
      // from the event id keep a re-drain idempotent (overwrite, not append).
      try {
        result = await foodAI.parseMealFromDescription(intent.text, {
          eatenAt: atIso,
          recordIdFor: (i) => `${recordId}-${i}`,
        });
      } catch (e) {
        // No key (and no trial) or ungranted trial consent is a permanent
        // condition for THIS message — reply and ack rather than re-queue
        // forever. Anything else (a provider hiccup, a transient write
        // failure) propagates so the next drain retries.
        if (e && e.code === 'no_api_key') {
          await reply('🔑 To log food by message, add an OpenAI key in Settings → Integrations (or the trial AI is unavailable right now).');
          return;
        }
        if (e && e.code === 'trial_consent_required') {
          await replyTrialConsent(reply, 'Logging food by message', e);
          return;
        }
        throw e;
      }
      break;
    case 'activity':
      // Same shape as /food: the NL parse runs HERE (unlocked client, user's own
      // key), never on the relay. createMiBand's deterministic recordId keeps a
      // re-drain overwriting the same mi-band row instead of appending.
      try {
        const parsed = await activityAI.parseActivityFromDescription(intent.text);
        result = await workout.createMiBand({ recordId, activityName: parsed.name, durationSec: parsed.durationSec, distanceM: parsed.distanceM });
      } catch (e) {
        if (e && e.code === 'no_api_key') {
          await reply('🔑 To log cardio by message, add an OpenAI key in Settings → Integrations (or the trial AI is unavailable right now).');
          return;
        }
        if (e && e.code === 'trial_consent_required') {
          await replyTrialConsent(reply, 'Logging cardio by message', e);
          return;
        }
        throw e;
      }
      break;
    case 'intake':
      result = await confirmDueIntakes({ intake, records, atMs: event.at_unix * 1000, now });
      break;
    case 'workout': {
      // "I did a workout" log: create a completed ad-hoc session through the
      // shared workout domain — the same path the app's ad-hoc button uses, so
      // there is one implementation of what logging a workout means. The
      // deterministic recordId keeps a re-drain overwriting the same session
      // instead of appending a second workout (drain idempotency, like /bp).
      // The domain is built on the message's SENT time (see createInboxApplier),
      // so the session lands on the day the message was sent (drain rule 4).
      const session = await workout.createAdHocSession({ recordId, notes: intent.name });
      await workout.setSessionStatus(session.id, 'completed');
      break;
    }
    default:
      // Nothing to write — but the user still gets an answer. The event is
      // acked either way; re-queuing a message we will never understand would
      // stall the mailbox forever.
      await reply(refusalText(intent));
      return;
  }

  await reply(confirmationText(intent, result, verbosity));
}

// fetchTelegramPhoto pulls the sealed photo's bytes through the account-scoped
// relay proxy (bd med-vcv.1). Only the file_id crosses — the relay resolves it
// with this account's bot token and streams the image back; it never sees the
// AI parse. Ambient same-origin session cookie authenticates, like every other
// drain-time relay call. Returns a Blob tagged with an image/* type so the
// aiClient's data-URL path accepts it.
async function fetchTelegramPhoto(fileId, mime, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`/api/telegram/photo?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) throw new Error(`photo fetch failed: ${res.status}`);
  const blob = await res.blob();
  if (blob && typeof blob.type === 'string' && blob.type.startsWith('image/')) return blob;
  return new Blob([blob], { type: mime || 'image/jpeg' });
}

// applyTGPhoto fetches a sealed photo and logs the meal the AI reads from it,
// through the SAME food-AI path the app's photo upload uses (no duplicate logic).
// Per the med-vcv design, every failure — an expired file_id, a missing key, a
// photo with no food — is answered and ACKED, never retried forever: a re-drain
// would re-pull the bytes and re-bill the provider for a result that will not
// improve. Idempotent on the happy path via per-item `tg-<eventId>-<i>` ids.
export async function applyTGPhoto(event, eventId, { foodAI, verbosity = 'detailed', now = Date.now, editReply = editTelegramReply, fetchPhoto = fetchTelegramPhoto }) {
  // ...rest, not (text, opts): a plain confirmation must call editReply with
  // exactly two arguments, the shape every other caller and stub expects.
  const reply = async (text, ...rest) => {
    try {
      await editReply(event.reply_message_id, text, ...rest);
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  };
  // Backdated to when the photo was SENT — at_unix is the message's own Telegram
  // date, not webhook arrival (drain rule 4) — like every other command.
  const atIso = new Date(event.at_unix * 1000).toISOString();

  let blob;
  try {
    blob = await fetchPhoto(event.file_id, event.mime);
  } catch (e) {
    // Do not log the file_id — it is message-derived. Ack (return) rather than
    // stall the mailbox on an expired handle.
    console.warn('[inbox] could not fetch the Telegram photo', e && e.message);
    await reply('📷 Couldn\'t fetch that photo — try sending it again.');
    return;
  }

  let result;
  try {
    result = await foodAI.parseMealFromPhoto(blob, {
      eatenAt: atIso,
      caption: event.caption,
      recordIdFor: (i) => `tg-${eventId}-${i}`,
    });
  } catch (e) {
    if (e && e.code === 'no_api_key') {
      await reply('🔑 To log food from a photo, add an OpenAI key in Settings → Integrations (or the trial AI is unavailable right now).');
      return;
    }
    if (e && e.code === 'trial_consent_required') {
      await replyTrialConsent(reply, 'Logging food from a photo', e);
      return;
    }
    console.warn('[inbox] could not parse the Telegram photo', e && e.code);
    await reply('📷 I couldn\'t spot any food in that photo.');
    return;
  }

  await reply(confirmationText({ kind: 'food' }, result, verbosity));
}

// applyTGText hands a free-text message to the drain-time AI agent (bd
// med-vcv.2): the agent runs an OpenAI tool-loop over the MCP catalog with the
// user's own key and returns a plain-text answer, which becomes the edited
// reply. A failed run is answered and acked, never re-run; only a run that was
// INTERRUPTED (no reply on its marker) before any tool write gets one retry —
// see the marker rule below (bd med-ramv).
export async function applyTGText(event, eventId, { agent, records, verbosity = 'detailed', now = Date.now, editReply = editTelegramReply }) {
  // ...rest, not (text, opts): a plain confirmation must call editReply with
  // exactly two arguments, the shape every other caller and stub expects.
  const reply = async (text, ...rest) => {
    try {
      await editReply(event.reply_message_id, text, ...rest);
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  };

  const markerId = `tgtext-${eventId}`;

  // At-most-once: if a prior drain already ran the agent for this event (even
  // one whose ops flush then failed and re-queued the event), do not run it
  // again — re-running a non-idempotent, billed loop is strictly worse than
  // trusting the pending ops to flush on their own. The marker is
  // deterministic, so writing it is itself idempotent, and it rides the same
  // pending batch as the agent's writes.
  //
  // But the marker is written BEFORE the agent runs, so this branch must still
  // ANSWER (bd med-3q8.3). Returning silently is what left "⏳ Queued" dangling
  // forever whenever a run was cut short between the marker and its reply — a
  // closed tab, a reload, a throw in the drain: the event then acked on the next
  // drain having said nothing. `marker.reply` is the text the completed run
  // sent; re-issuing it is a no-op server-side (Telegram's "message is not
  // modified", telegram.go EditReply). No text means the run never finished.
  const marker = (await records.list(TG_AGENT_MARKER_TYPE)).find((r) => !r.deleted && r.recordId === markerId);

  let attempts = 0;
  // Every terminal answer goes through here so the marker remembers it. Same
  // ...rest passthrough as `reply` — the trial-consent path carries a scope.
  const finalReply = async (text, ...rest) => {
    await records.put(TG_AGENT_MARKER_TYPE, {
      recordId: markerId,
      clientTs: now(),
      deleted: false,
      reply: text,
      replyScope: (rest[0] && rest[0].trialConsentScope) || '',
      ...(attempts ? { attempts } : {}),
    });
    await reply(text, ...rest);
  };

  if (marker) {
    if (marker.reply) {
      // replyScope rides along so a replayed trial-consent refusal keeps its
      // "Allow trial AI" button — the text says "tap below", so re-issuing it
      // button-less would point at nothing. Absent for every other answer,
      // which must stay a two-argument edit.
      await reply(marker.reply, ...(marker.replyScope ? [{ trialConsentScope: marker.replyScope }] : []));
      return;
    }
    // No reply: the run died before answering (iOS suspended the page, a reload,
    // a throw) — or it is still going in another tab. A marker from an older
    // bundle has no wrote/attempts and reads as "not wrote, never retried".
    // 1. Lease: the marker's clientTs is its (re)start time. Throwing leaves
    //    the event queued and un-acked for a later drain (drain rule 1).
    if (now() - (marker.clientTs || 0) < TG_AGENT_LEASE_MS) {
      throw new Error('free-text run may still be in progress in another tab');
    }
    // 2. Wrote: its tool writes are already pending and flush with this drain;
    //    a second run would double-write and re-bill. ponytail: a mixed "log X
    //    and tell me Y" loses Y — a read-only re-run is the upgrade if asked.
    if (marker.wrote === true) {
      await finalReply('✅ Done.');
      return;
    }
    // 4. Exhausted: honest terminal state, never "send it again".
    if ((marker.attempts || 0) >= 1) {
      await finalReply('🤖 I could not finish handling that message; nothing was saved.');
      return;
    }
    // 3. Retry once, exactly as a first run.
    attempts = 1;
  }
  const run = { markerId, attempts, wroteFlag: null };
  await records.put(TG_AGENT_MARKER_TYPE, { recordId: markerId, clientTs: now(), deleted: false, ...(attempts ? { attempts } : {}) });

  let answer;
  currentTGRun = run;
  try {
    answer = await agent.run(event.text, event.at_unix ? event.at_unix * 1000 : now());
  } catch (e) {
    if (e && e.code === 'no_api_key') {
      await finalReply('🔑 To chat with the assistant, add an OpenAI key in Settings → Integrations (or the trial AI is unavailable right now).');
      return;
    }
    if (e && e.code === 'trial_consent_required') {
      await replyTrialConsent(finalReply, 'Chatting with the assistant', e);
      return;
    }
    console.warn('[inbox] free-text agent failed', e && e.code);
    await finalReply('🤖 Something went wrong handling that — try again.');
    return;
  } finally {
    currentTGRun = null;
  }

  // Generic verbosity means no health value may cross Telegram (the same rule
  // reminders and command confirmations honour). A free-text answer can contain
  // readings the user asked to keep off chat, and we cannot reliably tell, so
  // fall back to a content-free ack.
  // ponytail: blanket-suppress under generic rather than scrubbing the answer —
  // safe over clever; a greeting gets a terse "Done." which is harmless.
  if (verbosity === 'generic') {
    await finalReply('✅ Done.');
    return;
  }

  const text = (answer || '').trim();
  await finalReply(text ? truncateRunes(text, MAX_REPLY_RUNES) : '✅ Done.');
}

// confirmDueIntakes confirms every PENDING dose due today up to `atMs` — the
// chat equivalent of tapping Confirm on the most recent reminder. Doses due
// later stay pending; confirming a dose you have not taken yet would be a lie
// the inventory count then inherits.
async function confirmDueIntakes({ intake, atMs }) {
  // Today's due doses only (intake.dueToday): an earlier day's missed dose is
  // not "my meds" now, and a later one has not been taken.
  const due = await materializing(() => intake.dueToday(atMs));

  let confirmed = 0;
  for (const i of due) {
    try {
      await intake.confirm(i.recordId, atMs);
      confirmed++;
    } catch (e) {
      // A dose acted on in the app after this message is not its to change.
      if (isStaleCallback(e)) continue;
      if (!(await isAlreadyApplied(e, intake, i.recordId))) throw e;
    }
  }
  return { confirmed };
}

// createInboxApplier returns the `apply` callback drainInbox expects: one
// decrypted event in, a domain write out. Unknown kinds are ignored rather than
// thrown — a newer relay may queue kinds this client predates, and stalling the
// whole drain on one of them would block the events it does understand.
//
// onOutOfDate defaults to the meds timeline's queued MT6 landing
// (features/meds.js, a classic-script global) when the app page has it: the
// drain often runs in the background, so it only queues the note and offers
// it in a toast — it never switches the open app away from what the user does.
const queueMedsOutOfDate = (info) => {
  if (typeof globalThis.queueMedsReminderOutOfDate === 'function') globalThis.queueMedsReminderOutOfDate(info);
};
// The free-text agent's router. canFloor false: the inbox drain may run before
// this page's first pull, so it never floors the account zone (bd
// med-wi09.19); the page's own router does once it has pulled.
//
// Its writes flag the running free-text marker `wrote` first (bd med-ramv):
// the marker put goes through the same deferred port, so it precedes the tool
// write in pending. Flag before write: a death between the two over-claims
// "Done." on the next drain; flag after would double-write on the retry.
// putIfAbsent does not flag: it is the read paths' derived materialization
// (CLAUDE.md rule 12), idempotent by construction, so a retry cannot double it
// — flagging it would turn an interrupted question into a bare "Done.".
export function createInboxRouter(ctx, { records, now, timeZone }) {
  const flagWrote = () => {
    const run = currentTGRun;
    if (!run) return undefined;
    run.wroteFlag = run.wroteFlag || records.put(TG_AGENT_MARKER_TYPE, {
      recordId: run.markerId, clientTs: now(), deleted: false, wrote: true, ...(run.attempts ? { attempts: run.attempts } : {}),
    });
    return run.wroteFlag;
  };
  const writing = (fn) => async (...args) => {
    await flagWrote();
    return fn(...args);
  };
  return createApiRouter(ctx, {
    records: { ...records, put: writing(records.put), del: writing(records.del) },
    now, timeZone, origin: ORIGIN_EXTERNAL, via: 'telegram', canFloor: async () => false,
  });
}

export function createInboxApplier(ctx, { records: recordsOverride, now = Date.now, editReply = editTelegramReply, rearmRefire = rearmMedRefire, cancelRefire = cancelMedRefire, onOutOfDate = queueMedsOutOfDate, foodAI: foodAIOverride, activityAI: activityAIOverride, agent: agentOverride, prefs: prefsOverride, history: historyOverride } = {}) {
  // A Telegram-drained /bp must repaint an open BP screen (med-d5t.10), so this
  // is explicitly external even though that is already the default. deferFlush:
  // an applied event's writes only queue to 'pending'; drainInbox pushes them
  // once (chunked) via its post-apply flushConfirmed barrier, so a bulk .nxk
  // vitals_import stops emitting one /api/sync/ops POST per record (med-0ol.2).
  const records = recordsOverride || recordsPort(ctx, ORIGIN_EXTERNAL, { deferFlush: true });
  const timeZone = defaultTimeZone();
  // via telegram: confirm() here is the reminder callback (an open dose, only
  // when the tap is newer than its last explicit action).
  // Built on the account's zone — the pinned settings.timezone, which a tz-plan
  // approval also moves (the tracked zone) — never the device clock: acted()
  // stamps it on every confirm, and that stamp is the day's evidence zone (bd
  // med-wi09.12 N3). Read per event; one domain per zone.
  let intakeFor = null;
  async function intakeDomain() {
    const general = await createSettingsDomain({ records, now, timeZone }).getGeneral().catch(() => null);
    const tz = (general && general.timezone) || timeZone;
    if (!intakeFor || intakeFor.tz !== tz) intakeFor = { tz, domain: createIntakeDomain({ records, now, timeZone: tz, via: 'telegram' }) };
    return intakeFor.domain;
  }

  // The /food chain mirrors apishim's createApiRouter: settings → foodDb → food →
  // aiClient → foodAI. All are pure over the ports the applier already has, so
  // the NL parse reuses exactly the UI's meal-logging path (no duplicate logic).
  // Tests inject foodAIOverride to stub the provider call.
  const foodAI = foodAIOverride || (() => {
    const settings = createSettingsDomain({ records, now, timeZone });
    const foodDb = createFoodDbClient({ settingsDomain: settings });
    const food = createFoodDomain({ records, now, timeZone, foodDb });
    return createFoodAIDomain({ aiClient: createAIClient({ settingsDomain: settings, deviceStore: deviceValues }), foodDomain: food, now });
  })();

  // The /activity chain: settings → aiClient → activityAI. The parsed activity
  // logs a manual mi-band row via the workout domain — the same createMiBand the
  // command bundle wires below. Tests inject activityAIOverride to stub the parse.
  const activityAI = activityAIOverride || (() => {
    const settings = createSettingsDomain({ records, now, timeZone });
    return createActivityAIDomain({ aiClient: createAIClient({ settingsDomain: settings, deviceStore: deviceValues }) });
  })();

  // The self-refining note port: the agent reads it into its prompt each turn
  // and appends durable phrasing mappings via remember_preference (med-vcv.3).
  // Tests inject prefsOverride to stub the vault boundary.
  const prefs = prefsOverride || makeTGPrefsPort(records, now);

  // The rolling transcript port: the agent reads the recent turns into its
  // prompt and appends each completed exchange (med-48x). Tests inject
  // historyOverride to stub the vault boundary.
  const history = historyOverride || makeTGHistoryPort(records, now);

  // The free-text agent routes through the SAME apishim router + MCP responder
  // the cloud UI and MCP connector use, so a message-driven write is one code
  // path with the app (med-vcv.2). Tests inject agentOverride to stub the loop.
  const agent = agentOverride || (() => {
    const settings = createSettingsDomain({ records, now, timeZone });
    const router = createInboxRouter(ctx, { records, now, timeZone });
    const dispatcher = createDispatcher({ router, now });
    const aiClient = createAIClient({ settingsDomain: settings });
    return createTGAgent({ chat: (a) => aiClient.chat(a), dispatcher, prefs, history });
  })();

  return async function apply(event, eventId) {
    if (!event) return;
    if (event.kind === VITALS_IMPORT) {
      // Server-parsed NXK streams sealed as one event (upload or Telegram .nxk).
      // Every stream upserts by a deterministic natural key, so the barrier's
      // replay-on-failed-flush is a no-op — no per-event marker needed. The
      // server already sent any user-facing ack (bot path), so there is no reply.
      const vitals = createVitalsDomain({ records, now, timeZone });
      await vitals.importSamples({
        sleep: event.sleep,
        hr: event.hr,
        spo2: event.spo2,
        stress: event.stress,
        daystats: event.daystats,
        workouts: event.workouts,
      });
      return;
    }
    if (event.kind === TG_COMMAND) {
      const reminders = createRemindersDomain({ records, now });
      const { verbosity } = await reminders.getDeliveryPref();
      // The workout domain stamps its ad-hoc session from its own clock, so
      // build it on the message's SENT time (drain rule 4) — a /workout texted at
      // 11pm and drained after midnight still lands on the day it was sent,
      // matching how /bp backdates via atIso.
      const sentMs = event.at_unix * 1000;
      await applyTGCommand(event, eventId, {
        bp: createBPDomain({ records, now, timeZone }),
        weight: createWeightDomain({ records, now, timeZone }),
        notes: createNotesDomain({ records, now }),
        intake: await intakeDomain(),
        foodAI,
        activityAI,
        workout: createWorkoutDomain({ records, now: () => sentMs, timeZone }),
        records,
        verbosity,
        now,
        editReply,
      });
      return;
    }
    if (event.kind === TG_PHOTO) {
      const reminders = createRemindersDomain({ records, now });
      const { verbosity } = await reminders.getDeliveryPref();
      await applyTGPhoto(event, eventId, { foodAI, verbosity, now, editReply });
      return;
    }
    if (event.kind === TG_TEXT) {
      const reminders = createRemindersDomain({ records, now });
      const { verbosity } = await reminders.getDeliveryPref();
      await applyTGText(event, eventId, { agent, records, verbosity, now, editReply });
      return;
    }
    if (event.kind === WORKOUT_SESSION_ACTION) {
      // The tap acts on the deterministic session-<groupId>-<date> slot; the
      // workout domain stamps snoozed_until from the server tap time (like meds),
      // so build it on that instant.
      const atMs = event.at_unix * 1000;
      await applyWorkoutSessionAction(event, {
        workout: createWorkoutDomain({ records, now: () => atMs, timeZone }),
        editReply,
      });
      return;
    }
    if (event.kind === MEASURE_REMINDER_ACTION) {
      // The tap mutes the shared BP/weight reminder pref; the reminders domain
      // stamps snoozed_until/dont_remind_until from the server tap time (like
      // meds), so build it on that instant.
      const atMs = event.at_unix * 1000;
      await applyMeasureReminderAction(event, {
        reminders: createRemindersDomain({ records, now: () => atMs }),
        editReply,
      });
      return;
    }
    if (event.kind !== INTAKE_SLOT_ACTION) {
      console.warn('[inbox] ignoring unknown event kind', event && event.kind);
      return;
    }
    if (event.action !== 'confirm' && event.action !== 'snooze') {
      console.warn('[inbox] ignoring unknown action', event.action);
      return;
    }
    const reminders = createRemindersDomain({ records, now });
    // verbosity only affects the cosmetic receipt text — never gate the confirm
    // data-write on this read: a rejected pref read falls back to generic.
    const { verbosity } = await reminders.getDeliveryPref().catch(() => ({ verbosity: 'generic' }));
    await applyIntakeSlotAction(event, { intake: await intakeDomain(), records, now, verbosity, editReply, rearmRefire, cancelRefire, onOutOfDate });
  };
}
