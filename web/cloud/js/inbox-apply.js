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
import { createIntakeDomain } from '../../domain/medintake.js';
import { createBPDomain } from '../../domain/bp.js';
import { createWeightDomain } from '../../domain/weight.js';
import { createNotesDomain } from '../../domain/notes.js';
import { createRemindersDomain } from '../../domain/reminders.js';
import { createSettingsDomain } from '../../domain/settings.js';
import { createFoodDomain } from '../../domain/food.js';
import { createFoodAIDomain } from '../../domain/foodai.js';
import { createVitalsDomain } from '../../domain/vitals.js';
import { createWorkoutDomain } from '../../domain/workout.js';
import { parseCommand } from '../../domain/tgcommand.js';
import { createAIClient } from './aiclient.js';
import { createFoodDbClient } from './fooddb.js';
import { createApiRouter } from './apishim.js';
import { createDispatcher } from './mcp-responder.js';
import { createTGAgent } from './tg-agent.js';
import { recordsPort, ORIGIN_EXTERNAL } from './sync.js';
import { getSlotMedications } from './push.js';
import { minDoseIntervalMs } from '../../domain/medschedule.js';

export const INTAKE_SLOT_ACTION = 'intake_slot_action';
export const TG_COMMAND = 'tg_command';
export const TG_PHOTO = 'tg_photo';
export const TG_TEXT = 'tg_text';
export const VITALS_IMPORT = 'vitals_import';

// A once-marker per free-text event. Unlike /bp or /food, the agent's tool
// writes get fresh (non-deterministic) record ids, so a re-drain — the barrier
// re-runs apply() whenever the ops flush failed (offline, quota, seq clash) —
// would double-write AND re-bill the provider. A deterministic marker written
// before the agent runs makes that re-drain skip instead. ponytail: markers
// accumulate one per message; add a sweep only if that ever matters.
const TG_AGENT_MARKER_TYPE = 'tgagentrun';

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

// Telegram's editMessageText caps at 4096; the relay's EditReply rejects >1000
// runes (and empty). Keep a margin so an agent answer never trips it.
const MAX_REPLY_RUNES = 900;

function truncateRunes(s, n) {
  const runes = [...s];
  if (runes.length <= n) return s;
  return `${runes.slice(0, n - 1).join('')}…`;
}

const INTAKE_RECORD_TYPE = 'intake';
const MEDICATION_RECORD_TYPE = 'medication';

// How far a single dose's instant may drift between push (computeReminderHorizon)
// and drain (materializeDueDoses) and still be treated as the SAME dose by a
// Confirm/Snooze tap. Set to the deterministic dose-clustering window
// (CLUSTER_WINDOW_MS = 10min, medintake.js): triggerNext/confirmSchedule store a
// clustered dose's scheduled_at at clusterEarliestMs — up to 10min before its own
// slot — which is the drift that leaves meds unconfirmed under an exact match (the
// reported "4 meds, only 2 confirmed" bug). Deliberately NOT a wider band: the
// callback carries only the slot (callback_data is 64-byte limited; med IDs can't
// be embedded), so drift and a genuinely different dose are indistinguishable by
// time alone. A different dose is ≥ the med's minDoseInterval (hours) away — far
// outside 10min — so this band can NEVER confirm a dose the user didn't take. A
// larger drift (a DST/tz-plan step, a big schedule edit) falls OUT of the band:
// that dose stays PENDING and is re-reminded — a safe false-negative, chosen over
// a false-positive (recording a med as taken when it wasn't is worse for meds).
// Distinct instants are already separate messages (computeReminderHorizon groups
// bySlot on exact scheduledAtMs).
const SLOT_DRIFT_BAND_MS = 10 * 60 * 1000; // = CLUSTER_WINDOW_MS (medintake.js)

// Mirrors DEFAULT_SNOOZE_MINUTES in web/domain/medintake.js (and the server's
// own default). Not imported because that module does not export it.
const DEFAULT_SNOOZE_MINUTES = 10;

function defaultTimeZone() {
  return (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
}

// A re-drained event finds its intakes already TAKEN, and the domain's confirm()
// throws rather than double-decrement inventory. That throw is the idempotency
// guard doing its job, not a failure — swallow it so the event still gets acked.
// Anything else propagates and leaves the event queued for the next drain.
//
// Keyed on the domain's structured `code`, not its message text.
function isAlreadyApplied(err) {
  return !!err && err.code === 'not_pending';
}

// nearestPendingByMed picks a med's single PENDING intake closest to the slot
// within `bandMs`. Nearest-wins guards the rare case where both an on-slot and a
// drifted intake of the same med sit inside the band — we act on one, not both.
//
// ponytail: known false-positive ceiling. At drain time a dose is only its
// {status, scheduled_at} — the instant the reminder named is NOT carried (the
// callback is slot-only, and carrying it end-to-end is the fix med-eas.67
// deliberately rejected). So if the exact on-slot dose was already handled via
// another channel AND a *different* dose of this same multi-daily med drifted
// into `bandMs`, we confirm that other instant. The two cases are
// indistinguishable here, so this is accepted rather than fixed. Requires a
// narrow conjunction (multi-daily med + drift ≥ interval−band + on-slot dose
// handled out-of-band + a stale reminder tap); upgrade path is instant-carrying.
function nearestPendingByMed(intakes, medId, slotMs, bandMs) {
  let best = null;
  let bestDelta = Infinity;
  for (const i of intakes) {
    if (i.deleted || i.status !== 'PENDING' || i.medication_id !== medId) continue;
    const delta = Math.abs(Date.parse(i.scheduled_at) - slotMs);
    if (delta <= bandMs && delta < bestDelta) { best = i; bestDelta = delta; }
  }
  return best;
}

// getSlotMedicationsSafe reads the push-time slot→medIds map (device-local), but
// a Confirm drain must never fail on a missing/unavailable device store: any
// throw (no IndexedDB, a store read error) is treated as "no map" so the ±band
// fallback takes over — the load-bearing medication-safety guard. Silent: a
// mapless slot (every legacy reminder, and a cross-device gap) is the EXPECTED
// fallback, not an error to log on every such tap.
async function getSlotMedicationsSafe(getSlotMeds, slotUnix) {
  try {
    return await getSlotMeds(slotUnix);
  } catch {
    return null;
  }
}

// applyIntakeSlotAction confirms (or snoozes) the meds a slot reminder named.
//
// It resolves the slot to intakes by IDENTITY when the push-time slot→medIds map
// is present (getSlotMeds): for each NAMED med it acts on that med's nearest
// PENDING dose within the med's OWN minDoseInterval of the slot. Scoping the
// wider interval to the reminder's own named meds is what makes it safe — we only
// ever touch a dose the reminder explicitly told the user about, so no false
// positive, even when a course/tz-plan dose drifted HOURS off its clock slot
// (bd med-eas.67). With no stored map (a legacy reminder, a cross-device gap) it
// falls back to the fixed ±SLOT_DRIFT_BAND_MS match, unchanged.
//
// atUnix is the SERVER's timestamp for the tap, so a Confirm tapped at 09:00
// records taken_at 09:00 even when the app first opens at noon — the backdating
// rule (docs/cloud-mode.md → drain protocol, rule 4).
export async function applyIntakeSlotAction(event, { intake, records, now = Date.now, verbosity = 'detailed', editReply = editTelegramReply, getSlotMeds = getSlotMedications }) {
  const slotMs = event.slot_unix * 1000;
  const atMs = event.at_unix * 1000;

  // The tap may name a slot whose intakes were never materialized (the app has
  // not been open since it came due). Materializing first is what makes them
  // exist to confirm; it is idempotent via the deterministic intake id.
  await intake.materializeDueDoses();

  const intakes = await records.list(INTAKE_RECORD_TYPE);
  const medicationIds = await getSlotMedicationsSafe(getSlotMeds, event.slot_unix);

  // medById + each med's own drift band (minDoseInterval) are needed by both the
  // identity selection and the receipt count, so build them once.
  const medById = new Map();
  if (medicationIds) {
    for (const m of await records.list(MEDICATION_RECORD_TYPE)) medById.set(m.recordId, m);
  }
  const medBandMs = (medId) => {
    const med = medById.get(medId);
    return med ? minDoseIntervalMs(med.schedule, med.tz_shift_policy) : 0;
  };

  // atSlot: the PENDING intakes this tap acts on.
  //   identity — one per NAMED med, its nearest due dose within that med's band.
  //   fallback — every PENDING intake within the fixed ±SLOT_DRIFT_BAND_MS (why a
  //   fixed band and not the per-med interval when the med set is unknown:
  //   see SLOT_DRIFT_BAND_MS).
  let atSlot;
  if (medicationIds) {
    atSlot = [];
    for (const medId of medicationIds) {
      const hit = nearestPendingByMed(intakes, medId, slotMs, medBandMs(medId));
      if (hit) atSlot.push(hit);
    }
  } else {
    atSlot = intakes.filter((i) => !i.deleted && i.status === 'PENDING'
      && Math.abs(Date.parse(i.scheduled_at) - slotMs) <= SLOT_DRIFT_BAND_MS);
  }

  let applied = 0;
  for (const i of atSlot) {
    try {
      if (event.action === 'confirm') {
        await intake.confirm(i.recordId, atMs);
      } else {
        // Snooze from the TAP, not from the drain. If that window already
        // elapsed while the app was closed, snoozing is meaningless — the
        // re-reminders it would have suppressed have already fired.
        const minutes = (atMs + DEFAULT_SNOOZE_MINUTES * 60_000 - now()) / 60_000;
        if (minutes <= 0) continue;
        await intake.snooze(i.recordId, minutes);
      }
      applied += 1;
    } catch (e) {
      if (!isAlreadyApplied(e)) throw e;
    }
  }

  // Edit the original reminder message to a receipt and drop its buttons (the
  // edit sends no reply_markup — bug 1). Only when we actually applied something:
  // an at-least-once redelivery (flush-false re-queues the event, inbox.js:174)
  // or a double-tap re-runs this with every intake already TAKEN/snoozed
  // (applied === 0), and editing then would clobber the good "✅ Confirmed N"
  // receipt with "ℹ️ Nothing was due". message_id is also absent when Telegram
  // omitted cq.Message for an old message → editReply is a safe no-op.
  if (applied > 0) {
    let text;
    if (event.action === 'confirm') {
      // Count every intake THIS tap confirmed, not just the writes from the final
      // attempt: an at-least-once redelivery after a partial success re-runs with
      // the earlier meds already TAKEN (filtered out of the loop), so `applied`
      // alone would undercount the receipt ("Confirmed 1" when 2 were taken).
      // confirm() backdates taken_at to atMs deterministically, identical across
      // retries, so intakes taken at this instant are exactly this tap's set.
      // Identity: count DISTINCT named meds confirmed (not band-matched rows), so
      // the receipt matches "every med the reminder named" — the reported
      // "Confirmed 4" vs 3-taken mismatch. Fallback: band-matched rows, unchanged.
      const atIso = new Date(atMs).toISOString();
      const taken = (await records.list(INTAKE_RECORD_TYPE)).filter((i) =>
        !i.deleted && i.status === 'TAKEN' && i.taken_at === atIso);
      let confirmed;
      if (medicationIds) {
        const named = new Set(medicationIds);
        const distinct = new Set();
        for (const i of taken) {
          if (named.has(i.medication_id)
            && Math.abs(Date.parse(i.scheduled_at) - slotMs) <= medBandMs(i.medication_id)) {
            distinct.add(i.medication_id);
          }
        }
        confirmed = distinct.size;
      } else {
        confirmed = taken.filter((i) =>
          Math.abs(Date.parse(i.scheduled_at) - slotMs) <= SLOT_DRIFT_BAND_MS).length;
      }
      text = confirmationText({ kind: 'intake' }, { confirmed }, verbosity);
    } else {
      text = verbosity === 'generic' ? '⏰ Snoozed.' : '⏰ Snoozed — will remind you again shortly.';
    }
    try {
      await editReply(event.message_id, text);
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  }
}

// editTelegramReply asks the relay to rewrite the "⏳ Queued" placeholder into
// `text`. This adds no trust: WE composed `text` from vault data the relay
// cannot read, and it forwards the string verbatim — the same contract as the
// outbound reminder text it already relays (docs/cloud-mode.md → Inbound
// plaintext). Best-effort: a failed edit must never fail the drain, because the
// record is already in the vault and the receipt is cosmetic.
async function editTelegramReply(messageId, text, { fetchImpl = fetch } = {}) {
  if (!messageId || !text) return;
  try {
    const res = await fetchImpl('/api/telegram/reply-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: messageId, text }),
    });
    if (!res.ok) console.warn('[inbox] could not update the Telegram reply', res.status);
  } catch (e) {
    console.warn('[inbox] could not update the Telegram reply', e);
  }
}

// Confirmations respect the SAME verbosity the user picked for outbound
// reminders (web/domain/reminders.js getDeliveryPref). "generic" exists so no
// health value ever crosses Telegram — honouring it here too, or a user who
// chose generic reminders would still get "Recorded BP 120/80" echoed back.
function confirmationText(intent, result, verbosity) {
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
      const n = result && result.items ? result.items.length : 0;
      if (!n) return 'ℹ️ Could not log any food from that.';
      return `✅ Logged ${n} food item${n === 1 ? '' : 's'}.`;
    }
    case 'intake': {
      const n = result && result.confirmed;
      if (!n) return 'ℹ️ Nothing was due — no medications to confirm.';
      return `✅ Confirmed ${n} medication${n === 1 ? '' : 's'}.`;
    }
    case 'workout':
      return intent.name ? `✅ Logged workout: ${intent.name}.` : '✅ Workout logged.';
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
export async function applyTGCommand(event, eventId, { bp, weight, notes, intake, foodAI, workout, records, verbosity = 'detailed', now = Date.now, editReply = editTelegramReply }) {
  // The receipt is cosmetic; the record is not. A Telegram outage must never
  // strand an event that already reached the vault, so the edit can never
  // reject out of here — not even an injected one.
  const reply = async (text) => {
    try {
      await editReply(event.reply_message_id, text);
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  };
  const intent = parseCommand(event.text);
  const recordId = `tg-${eventId}`;
  // at_unix is the SERVER's timestamp for when the message arrived, so a /bp
  // sent at 09:00 and drained at noon is recorded as measured at 09:00 — the
  // same backdating rule the Confirm/Snooze tap follows (drain rule 4).
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
          await reply('🔑 To log food by message with the trial AI, allow it first in Settings → Integrations (or add your own OpenAI key).');
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
      // The domain is built on the arrival clock (see createInboxApplier), so
      // the session lands on the day the message was sent (drain rule 4).
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
  const reply = async (text) => {
    try {
      await editReply(event.reply_message_id, text);
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  };
  // Backdated to when the photo arrived (drain rule 4), like every other command.
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
      recordIdFor: (i) => `tg-${eventId}-${i}`,
    });
  } catch (e) {
    if (e && e.code === 'no_api_key') {
      await reply('🔑 To log food from a photo, add an OpenAI key in Settings → Integrations (or the trial AI is unavailable right now).');
      return;
    }
    if (e && e.code === 'trial_consent_required') {
      await reply('🔑 To log food from a photo with the trial AI, allow it first in Settings → Integrations (or add your own OpenAI key).');
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
// reply. Like every inbound kind the failure posture is answer-and-ack, never
// retry — the agent may have already written through its tools, and a re-drain
// would re-run a non-deterministic loop and re-bill the provider.
export async function applyTGText(event, eventId, { agent, records, verbosity = 'detailed', now = Date.now, editReply = editTelegramReply }) {
  const reply = async (text) => {
    try {
      await editReply(event.reply_message_id, text);
    } catch (e) {
      console.warn('[inbox] could not update the Telegram reply', e);
    }
  };

  // At-most-once: if a prior drain already ran the agent for this event (even
  // one whose ops flush then failed and re-queued the event), skip — re-running
  // a non-idempotent, billed loop is strictly worse than trusting the pending
  // ops to flush on their own. The marker is deterministic, so writing it is
  // itself idempotent, and it rides the same pending batch as the agent's writes.
  const marked = (await records.list(TG_AGENT_MARKER_TYPE)).some((r) => !r.deleted && r.recordId === `tgtext-${eventId}`);
  if (marked) return;
  await records.put(TG_AGENT_MARKER_TYPE, { recordId: `tgtext-${eventId}`, clientTs: now(), deleted: false });

  let answer;
  try {
    answer = await agent.run(event.text);
  } catch (e) {
    if (e && e.code === 'no_api_key') {
      await reply('🔑 To chat with the assistant, add an OpenAI key in Settings → Integrations (or the trial AI is unavailable right now).');
      return;
    }
    if (e && e.code === 'trial_consent_required') {
      await reply('🔑 To chat with the assistant via the trial AI, allow it first in Settings → Integrations (or add your own OpenAI key).');
      return;
    }
    console.warn('[inbox] free-text agent failed', e && e.code);
    await reply('🤖 Something went wrong handling that — try again.');
    return;
  }

  // Generic verbosity means no health value may cross Telegram (the same rule
  // reminders and command confirmations honour). A free-text answer can contain
  // readings the user asked to keep off chat, and we cannot reliably tell, so
  // fall back to a content-free ack.
  // ponytail: blanket-suppress under generic rather than scrubbing the answer —
  // safe over clever; a greeting gets a terse "Done." which is harmless.
  if (verbosity === 'generic') {
    await reply('✅ Done.');
    return;
  }

  const text = (answer || '').trim();
  await reply(text ? truncateRunes(text, MAX_REPLY_RUNES) : '✅ Done.');
}

// confirmDueIntakes confirms every PENDING dose already due at `atMs` — the
// chat equivalent of tapping Confirm on the most recent reminder. Doses due
// later stay pending; confirming a dose you have not taken yet would be a lie
// the inventory count then inherits.
async function confirmDueIntakes({ intake, records, atMs, now }) {
  await intake.materializeDueDoses();
  const due = (await records.list(INTAKE_RECORD_TYPE)).filter((i) => !i.deleted
    && i.status === 'PENDING'
    && Date.parse(i.scheduled_at) <= atMs);

  let confirmed = 0;
  for (const i of due) {
    try {
      await intake.confirm(i.recordId, atMs);
      confirmed++;
    } catch (e) {
      if (!isAlreadyApplied(e)) throw e;
    }
  }
  return { confirmed };
}

// createInboxApplier returns the `apply` callback drainInbox expects: one
// decrypted event in, a domain write out. Unknown kinds are ignored rather than
// thrown — a newer relay may queue kinds this client predates, and stalling the
// whole drain on one of them would block the events it does understand.
export function createInboxApplier(ctx, { records: recordsOverride, now = Date.now, editReply = editTelegramReply, foodAI: foodAIOverride, agent: agentOverride, prefs: prefsOverride } = {}) {
  // A Telegram-drained /bp must repaint an open BP screen (med-d5t.10), so this
  // is explicitly external even though that is already the default. deferFlush:
  // an applied event's writes only queue to 'pending'; drainInbox pushes them
  // once (chunked) via its post-apply flushConfirmed barrier, so a bulk .nxk
  // vitals_import stops emitting one /api/sync/ops POST per record (med-0ol.2).
  const records = recordsOverride || recordsPort(ctx, ORIGIN_EXTERNAL, { deferFlush: true });
  const timeZone = defaultTimeZone();
  const intake = createIntakeDomain({ records, now, timeZone });

  // The /food chain mirrors apishim's createApiRouter: settings → foodDb → food →
  // aiClient → foodAI. All are pure over the ports the applier already has, so
  // the NL parse reuses exactly the UI's meal-logging path (no duplicate logic).
  // Tests inject foodAIOverride to stub the provider call.
  const foodAI = foodAIOverride || (() => {
    const settings = createSettingsDomain({ records, now, timeZone });
    const foodDb = createFoodDbClient({ settingsDomain: settings });
    const food = createFoodDomain({ records, now, timeZone, foodDb });
    return createFoodAIDomain({ aiClient: createAIClient({ settingsDomain: settings }), foodDomain: food, now });
  })();

  // The self-refining note port: the agent reads it into its prompt each turn
  // and appends durable phrasing mappings via remember_preference (med-vcv.3).
  // Tests inject prefsOverride to stub the vault boundary.
  const prefs = prefsOverride || makeTGPrefsPort(records, now);

  // The free-text agent routes through the SAME apishim router + MCP responder
  // the cloud UI and MCP connector use, so a message-driven write is one code
  // path with the app (med-vcv.2). Tests inject agentOverride to stub the loop.
  const agent = agentOverride || (() => {
    const settings = createSettingsDomain({ records, now, timeZone });
    const router = createApiRouter(ctx, { records, now, timeZone, origin: ORIGIN_EXTERNAL });
    const dispatcher = createDispatcher({ router, now });
    const aiClient = createAIClient({ settingsDomain: settings });
    return createTGAgent({ chat: (a) => aiClient.chat(a), dispatcher, prefs });
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
      // build it on the arrival time (drain rule 4) — a /workout texted at 11pm
      // and drained after midnight still lands on the day it was sent, matching
      // how /bp backdates via atIso.
      const arrivalMs = event.at_unix * 1000;
      await applyTGCommand(event, eventId, {
        bp: createBPDomain({ records, now, timeZone }),
        weight: createWeightDomain({ records, now, timeZone }),
        notes: createNotesDomain({ records, now }),
        intake,
        foodAI,
        workout: createWorkoutDomain({ records, now: () => arrivalMs, timeZone }),
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
    await applyIntakeSlotAction(event, { intake, records, now, verbosity, editReply });
  };
}
